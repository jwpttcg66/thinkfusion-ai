import { randomUUID } from 'node:crypto';
import { features, jaccard } from '../../shared/synthesizer';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import { DebateStore } from './store';
import {
  normalizeDebateConfig,
  type DebateConfig,
  type DebateMessage,
  type DebateMessageKind,
  type DebateRole,
  type DebateRound,
  type DebateState
} from './types';

/**
 * 多轮辩论的调度器。决策 2：独立子系统，不进 MasterAgent 或 Synthesis。
 *
 * 与网页提问链路的边界写在这里：**辩论的结构化指令只走 `SubAgentTask.system`**
 * （本地/云端 API 的 system 轮次），`question` 永远是用户原话；网页通道忽略
 * system，所以即便被选进来，页面上也不会出现「请质疑以下观点」这类包装话术。
 * 这也是为什么辩论的参与者默认取能接受 system 的成员——见 `eligible()`。
 */
export interface DebateDeps {
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
  now?: () => number;
  /** 单场辩论的成员名单，由调用方按 Provider 能力决定。 */
  eligible?: (agentIds: readonly string[]) => string[];
}

const SIMILAR = 0.34;
const CONVERGED = 0.9;

export class DebateOrchestrator {
  private readonly stopped = new Set<string>();
  /**
   * 每次 start/resume 递增。中止后立刻恢复时，上一轮 run 还没退出，
   * 没有这个代号它会在下一轮继续写盘，把刚恢复的状态覆盖回去。
   */
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly store: DebateStore,
    private readonly deps: DebateDeps
  ) {}

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  /** 立即返回 running 状态，执行在后台；UI 靠 get() 轮询、stop() 中止。 */
  start(question: string, configInput: Partial<DebateConfig>, conversationId?: string): DebateState {
    const config = normalizeDebateConfig(configInput);
    // 只留能接受 system 指令的成员：网页通道会把指令丢掉，让它参与辩论
    // 只会得到一遍又一遍对原问题的独立回答，看起来像辩论其实没有交锋。
    const participants = this.deps.eligible?.(config.participants) ?? config.participants;
    if (participants.length < 2) throw new Error('辩论至少需要两个参与成员');
    const effectiveConfig: DebateConfig = { ...config, participants };
    const at = this.now();
    const state: DebateState = {
      debateId: randomUUID(),
      conversationId,
      question,
      config: effectiveConfig,
      status: 'running',
      rounds: [],
      minorities: [],
      createdAt: at,
      updatedAt: at
    };
    this.store.save(state);
    this.stopped.delete(state.debateId);
    void this.launch(state);
    return state;
  }

  get(debateId: string): DebateState | null {
    return this.store.get(debateId);
  }

  list(): DebateState[] {
    return this.store.list();
  }

  stop(debateId: string): DebateState | null {
    this.stopped.add(debateId);
    const state = this.store.get(debateId);
    if (!state || state.status !== 'running') return state;
    state.status = 'stopped';
    state.stopReason = '用户中止';
    state.updatedAt = this.now();
    this.store.save(state);
    return state;
  }

  /** 从中断处继续；已完成的轮次不会重跑，已产生的发言一条不丢。 */
  resume(debateId: string): DebateState | null {
    const state = this.store.get(debateId);
    if (!state || state.status === 'completed') return state;
    this.stopped.delete(debateId);
    state.status = 'running';
    state.stopReason = undefined;
    state.updatedAt = this.now();
    this.store.save(state);
    void this.launch(state);
    return state;
  }

  private launch(state: DebateState): Promise<void> {
    const generation = (this.generation.get(state.debateId) ?? 0) + 1;
    this.generation.set(state.debateId, generation);
    return this.run(state, generation);
  }

  /** 测试与 UI 都能用：等到终态，不靠猜时间。 */
  async waitFor(debateId: string, timeoutMs = 10_000): Promise<DebateState | null> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const state = this.store.get(debateId);
      if (!state || state.status !== 'running') return state;
      if (this.now() >= deadline) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  // -------------------------------------------------------------------------

  private async run(state: DebateState, generation: number): Promise<void> {
    const current = () =>
      this.generation.get(state.debateId) === generation && !this.stopped.has(state.debateId);

    try {
      while (current() && state.rounds.length < state.config.maxRounds) {
        const round = await this.runRound(state, state.rounds.length);
        // resume 之后旧 generation 的 run 必须立刻退出，不能把上一代的发言
        // 写进新状态。但用户 stop 时 generation 不变，那一轮的发言要留下：
        // 决策 6 要求原始回答不可丢失，喊停不该抹掉已经说出口的话。
        if (this.generation.get(state.debateId) !== generation) return;
        state.rounds.push(round);
        state.minorities = collectMinorities(state.rounds);
        state.updatedAt = this.now();
        if (!this.persist(state)) return;

        if (!current()) return;
        if (state.config.convergenceStop && round.converged) {
          state.status = 'completed';
          state.stopReason = '观点已收敛，没有新的质疑';
          break;
        }
      }
      if (!current()) return;
      if (state.status === 'running') {
        state.status = 'completed';
        state.stopReason = state.stopReason ?? `已达到 ${state.config.maxRounds} 轮上限`;
      }
      state.updatedAt = this.now();
      this.persist(state);
    } catch (error) {
      state.status = 'cancelled';
      state.stopReason = error instanceof Error ? error.message : String(error);
      state.updatedAt = this.now();
      this.store.save(state);
    }
  }

  /**
   * 写盘前看一眼外部状态：stop() 改的是磁盘上的副本，run 手里是另一个对象。
   * 只同步 status，不用外部 rounds 覆盖内存——那会丢掉刚完成的这一轮。
   * 返回 false 表示已经停了，run 该退出。
   */
  private persist(state: DebateState): boolean {
    const external = this.store.get(state.debateId);
    if (external?.status === 'stopped') {
      state.status = 'stopped';
      state.stopReason = external.stopReason;
    }
    this.store.save(state);
    return state.status !== 'stopped';
  }

  private async runRound(state: DebateState, index: number): Promise<DebateRound> {
    const round: DebateRound = {
      index,
      messages: [],
      startedAt: this.now(),
      converged: false,
      failures: []
    };
    const previous = state.rounds.at(-1)?.messages ?? [];
    const context = previous.map(message => message.text);
    const kind: DebateMessageKind = index === 0 ? 'position' : index === 1 ? 'question' : 'revision';

    const results = await Promise.all(
      state.config.participants.map(async (agentId, position) => {
        const role = roleFor(state.config.strategy, position, kind);
        const targetMessageId = previous.find(message => message.agentId !== agentId)?.messageId;
        const task: SubAgentTask = {
          // 用户问题原样。质疑/修正的对象走 context，指令走 system。
          question: state.question,
          stage: index === 0 ? 'initial' : 'followup',
          context: context.length > 0 ? context : undefined,
          system: instructions(state.config.strategy, kind, role)
        };
        try {
          const answer = await this.deps.ask(agentId, task);
          return {
            ok: true as const,
            message: {
              messageId: randomUUID(),
              roundIndex: index,
              agentId,
              role,
              kind,
              text: answer.text,
              targetMessageId,
              createdAt: this.now()
            } satisfies DebateMessage
          };
        } catch (error) {
          return { ok: false as const, failure: { agentId, detail: error instanceof Error ? error.message : String(error) } };
        }
      })
    );

    for (const result of results) {
      if (result.ok) round.messages.push(result.message);
      else round.failures.push(result.failure);
    }
    round.endedAt = this.now();
    round.converged = index > 0 && converged(previous, round.messages);
    return round;
  }
}

function roleFor(strategy: DebateConfig['strategy'], position: number, kind: DebateMessageKind): DebateRole {
  if (strategy !== 'adversarial') return 'peer';
  if (kind === 'revision') return position === 0 ? 'proposer' : 'critic';
  return position === 0 ? 'proposer' : 'critic';
}

/**
 * 指令只进 system 轮次，不拼进 question。文字刻意简短，不套角色扮演话术。
 */
function instructions(strategy: DebateConfig['strategy'], kind: DebateMessageKind, role: DebateRole): string[] {
  const lines: string[] = [];
  if (kind === 'position') lines.push('独立给出你对这个问题的观点，并说明成立的条件。');
  else if (kind === 'question') lines.push('逐条质疑其他回答里证据不足或推理跳跃的地方；指出具体是哪一句。');
  else lines.push('针对质疑逐条回应；可以修正观点，也可以说明为什么坚持，并给出条件。');
  if (strategy === 'adversarial') {
    lines.push(role === 'proposer' ? '你的职责是提出并维护主张。' : '你的职责是检验主张的漏洞。');
  }
  lines.push('保留有依据的不同意见，不要为了达成一致而放弃它。');
  return lines;
}

function converged(previous: DebateMessage[], current: DebateMessage[]): boolean {
  if (previous.length === 0 || current.length === 0) return false;
  return current.every(message => {
    const prior = previous.find(item => item.agentId === message.agentId);
    if (!prior) return false;
    const similarity = jaccard(features(prior.text), features(message.text));
    return similarity >= CONVERGED;
  });
}

/**
 * 少数派：与同一轮其他发言都不太像的那些。用规则版同一套 bigram 判据，
 * 不引入新模型；判断不了时宁可多保留，也不删。
 */
function collectMinorities(rounds: DebateRound[]): DebateMessage[] {
  const found: DebateMessage[] = [];
  const seen = new Set<string>();
  for (const round of rounds) {
    for (const message of round.messages) {
      if (seen.has(message.messageId)) continue;
      const others = round.messages.filter(item => item.messageId !== message.messageId);
      if (others.length === 0) continue;
      const maxSimilarity = Math.max(
        ...others.map(other => jaccard(features(message.text), features(other.text)))
      );
      if (maxSimilarity < SIMILAR) {
        seen.add(message.messageId);
        found.push(message);
      }
    }
  }
  return found;
}
