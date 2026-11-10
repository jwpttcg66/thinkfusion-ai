import { randomUUID } from 'node:crypto';
import { features, jaccard } from '../../shared/synthesizer';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import { buildGraph } from './argument-graph';
import { analyseRound, challengesFor } from './claims';
import { appendEvent } from './events';
import { buildEvidence } from './evidence';
import { judgeDebate } from './judges';
import { debateMetrics, roundProgress } from './metrics';
import { PROMPT_VERSION, renderInstructions } from './prompts';
import { applyDecisions, revisionOf } from './revision';
import { DebateStore } from './store';
import { orderDisputes } from './strategies';
import {
  kindFor,
  normalizeLeadMode,
  planLead,
  roleFor as roleForPlan,
  speakersFor,
  type DebateCandidate,
  type LeadPlan
} from './lead';
import {
  normalizeDebateConfig,
  type DebateConfig,
  type DebateDispute,
  type DebateMessage,
  type DebateMessageKind,
  type DebatePhase,
  type DebateRevision,
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
  /**
   * 当前真正可用的成员（含类型与不可用的原因）。主进程用 health() 算好，
   * 同步喂进来；不传时按 participants 全是可用的本地成员兜底，老测试照跑。
   */
  candidates?: () => readonly DebateCandidate[];
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

  /**
   * 立即返回 running 状态，执行在后台；UI 靠 get() 轮询、stop() 中止。
   *
   * `plan` 由主进程算好传进来：谁此刻真的可用、谁主导，需要 health() 这类
   * 运行时信息，不该由编排器猜。不传时按 participants 全是可用的本地成员
   * 兜底，纯逻辑测试照跑。
   */
  start(
    question: string,
    configInput: Partial<DebateConfig>,
    conversationId?: string,
    plan?: LeadPlan
  ): DebateState {
    const config = normalizeDebateConfig(configInput);
    const candidates = this.deps.candidates?.() ?? config.participants.map(id => ({
      id, label: id, type: 'local' as const, available: true
    }));
    const selection = this.deps.eligible?.(config.participants) ?? config.participants;
    const effectivePlan = plan ?? planLead({
      mode: normalizeLeadMode(config.leadMode),
      strategy: config.strategy,
      candidates,
      selected: selection,
      leadAgentId: config.leadAgentId
    });
    // 归属规则：只有一个可用成员也照常开，由它分饰质疑与修正（自辩），
    // plan.warnings 里如实写明，不再拿「不足两位」跳过整场。
    if (effectivePlan.participants.length === 0) {
      throw new Error('辩论至少需要一个可用参与成员');
    }
    const effectiveConfig: DebateConfig = { ...config, participants: [...effectivePlan.participants] };
    const at = this.now();
    const state: DebateState = {
      debateId: randomUUID(),
      conversationId,
      question,
      config: effectiveConfig,
      lead: effectivePlan.lead,
      plan: effectivePlan,
      status: 'running',
      rounds: [],
      minorities: [],
      disputes: [],
      // 版本跟着这场辩论落盘：以后升级模板，老记录仍看得出当时用的哪一版。
      promptVersion: PROMPT_VERSION,
      createdAt: at,
      updatedAt: at
    };
    // 事件流从创建那一刻开始记（AC-14）。此时还没有任何发言，所以这条
    // 事件只说明「谁、什么时候、按什么配置起了这场辩论」。
    appendEvent(state, {
      type: 'session.created',
      key: 'session.created',
      at,
      detail: `${String(effectivePlan.participants.length)} 位参与者，最多 ${String(effectiveConfig.maxRounds)} 轮`
    });
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

  remove(debateId: string): void {
    this.stopped.add(debateId);
    this.generation.delete(debateId);
    this.store.remove(debateId);
  }

  stop(debateId: string): DebateState | null {
    this.stopped.add(debateId);
    const state = this.store.get(debateId);
    if (!state || state.status !== 'running') return state;
    state.status = 'stopped';
    state.stopReason = '用户中止';
    state.updatedAt = this.now();
    appendEvent(state, { type: 'session.stopped', key: 'session.stopped', at: state.updatedAt, detail: '用户中止' });
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
    // 多次恢复要各自留下一条：序号取自现有恢复事件的条数，所以不重复、
    // 也不会把第二次恢复吞掉。
    const resumes = (state.events ?? []).filter(event => event.type === 'session.resumed').length;
    appendEvent(state, { type: 'session.resumed', key: `session.resumed:${String(resumes + 1)}`, at: state.updatedAt });
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
    const budget = budgetOf(state.config);
    // 预算从这一次运行开始算，不从创建时间算：恢复一场放了两小时的辩论，
    // 不该一进来就说「超时」。
    const deadline = budget.totalMs ? this.now() + budget.totalMs : Number.POSITIVE_INFINITY;

    try {
      while (current() && state.rounds.length < state.config.maxRounds) {
        if (this.now() >= deadline) {
          state.stopReason = `超出时间预算（${Math.round((budget.totalMs ?? 0) / 1000)} 秒），停在 ${state.rounds.length} 轮`;
          break;
        }
        const { round, disputes, revisions } = await this.runRound(state, state.rounds.length, deadline);
        // resume 之后旧 generation 的 run 必须立刻退出，不能把上一代的发言
        // 写进新状态。但用户 stop 时 generation 不变，那一轮的发言要留下：
        // 决策 6 要求原始回答不可丢失，喊停不该抹掉已经说出口的话。
        if (this.generation.get(state.debateId) !== generation) return;
        // 决策写回主张状态：改的是「被质疑的那几句」，可能在更早的那一轮里。
        applyDecisions(state.rounds, revisions);
        state.rounds.push(round);
        state.disputes = [...(state.disputes ?? []), ...disputes];
        state.revisions = [...(state.revisions ?? []), ...revisions];
        // 每条修订独立记一条事件：它是「观点因为证据变了」的最小单位，
        // 事后要能按 revisionId 找到对应的那次改口。
        for (const revision of revisions) {
          appendEvent(state, {
            type: 'revision.recorded',
            key: `revision:${revision.revisionId}`,
            at: revision.createdAt,
            roundIndex: revision.roundIndex,
            detail: `${revision.agentId}：${revision.decision ?? '未写明'}`
          });
        }
        state.minorities = collectMinorities(state.rounds);
        // 证据与论证图每轮重算：主张状态会被后面的决策改写，重算才能保证
        // 图里的 `status` 与主张本身一致；条数很小，代价可以忽略。
        state.evidence = buildEvidence(state);
        state.graph = buildGraph(state);
        state.updatedAt = this.now();
        if (!this.persist(state)) {
          // 用户中止：已经说出口的话保留，但仍然给一个结论，别让记录停在半场。
          this.conclude(state);
          this.store.save(state);
          return;
        }

        if (!current()) return;
        // 归属规则下计划总会给至少一位交锋成员；这条只兜住旧记录（旧计划的
        // 后续轮次名单可能为空）。没人接第二棒就别空转。
        if (state.plan.debaters.length === 0) {
          state.status = 'completed';
          state.stopReason = '只有第一轮独立回答：计划里没有后续交锋成员';
          break;
        }
        if (state.config.convergenceStop && round.converged) {
          state.status = 'completed';
          state.stopReason = '观点已收敛，没有新的质疑';
          break;
        }
        // 回应阶段跑完，既没人改口、也没有新争议：再跑一轮只是重复。
        // 与「收敛」分开写，因为判据不同——收敛看文字像不像，这里看决定。
        if (state.config.convergenceStop && round.phase === 'response' && !progressed(revisions, disputes)) {
          state.status = 'completed';
          state.stopReason = '回应里没有新的修订，也没有新的争议';
          break;
        }
        // 成本优化（Phase 5）：连续两轮什么新东西都没有，再跑下去只是把同样
        // 的话换个说法。默认关闭——「打满 N 轮」是调用方的预期，由它决定
        // 要不要为省一次调用改掉这个预期。
        if (state.config.earlyStopOnStall && stalledTwice(state)) {
          state.status = 'completed';
          state.stopReason = '连续两轮没有新增证据或实质修订，提前收尾';
          break;
        }
      }
      if (!current()) {
        // resume 之后旧 generation 的 run 必须退出，不能把结论写到新状态上。
        if (this.generation.get(state.debateId) === generation) {
          this.conclude(state);
          this.store.save(state);
        }
        return;
      }
      if (state.status === 'running') {
        state.status = 'completed';
        state.stopReason = state.stopReason ?? `已达到 ${state.config.maxRounds} 轮上限`;
      }
      // 结论永远落在最后一轮之后：读的是全部发言与证据，不是最后一句。
      this.conclude(state);
      if (state.status === 'completed') {
        appendEvent(state, {
          type: 'session.completed',
          key: 'session.completed',
          at: this.now(),
          detail: state.stopReason
        });
      }
      state.updatedAt = this.now();
      this.persist(state);
    } catch (error) {
      state.status = 'cancelled';
      state.stopReason = error instanceof Error ? error.message : String(error);
      state.updatedAt = this.now();
      appendEvent(state, {
        type: 'session.cancelled',
        key: 'session.cancelled',
        at: state.updatedAt,
        detail: state.stopReason
      });
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
      // stop() 写的是磁盘上那份的事件；这里手里是另一个对象，补一条同 key
      // 的事件（幂等）再存，别让这次保存把它覆盖掉。
      appendEvent(state, {
        type: 'session.stopped',
        key: 'session.stopped',
        at: external.updatedAt,
        detail: external.stopReason
      });
    }
    this.store.save(state);
    return state.status !== 'stopped';
  }

  /**
   * 跑裁判，把结论写进这一场。
   *
   * 纯规则、不调模型：不会因为某位裁判模型不可用而让一场辩论没有结论，
   * 也不额外占预算。模型裁决那条路在 `judge/engine.ts`（会话级），两者
   * 互不替代，`backend` 字段分别写着 `rules` / `model`。
   */
  private conclude(state: DebateState): void {
    const run = judgeDebate(state, { at: this.now() });
    state.judgments = run.judgments;
    state.verdict = run.verdict;
    // 图要带上判断节点，所以结论之后再建一次。
    state.graph = buildGraph(state);
    // 指标跟着结论一起落盘：它要读的就是最后一轮的证据与修订。
    state.metrics = debateMetrics(state);
    appendEvent(state, {
      type: 'verdict.recorded',
      key: `verdict:${run.verdict.verdictId}`,
      at: run.verdict.createdAt,
      detail: run.verdict.verdict
    });
  }

  private async runRound(
    state: DebateState,
    index: number,
    deadline: number
  ): Promise<{ round: DebateRound; disputes: DebateDispute[]; revisions: DebateRevision[] }> {
    const phase = phaseFor(index);
    appendEvent(state, {
      type: 'round.started',
      key: `round.started:${String(index)}`,
      at: this.now(),
      roundIndex: index,
      detail: phase
    });
    const round: DebateRound = {
      index,
      phase,
      messages: [],
      startedAt: this.now(),
      converged: false,
      failures: []
    };
    const previous = state.rounds.at(-1)?.messages ?? [];
    const seed = state.config.seed;
    // 会话执行阶段发起辩论时，第一轮读的是网页已经给出的回答 + 主导人指定
    // 的辩题；独立辩论没有 seed，仍然是各自独立给观点。
    const context = index === 0 && seed
      ? [
          `【网页通道已经给出的回答】\n${seed.positions.join('\n\n')}`,
          seed.topics.length > 0 ? `【要辩清楚的议题】\n- ${seed.topics.join('\n- ')}` : ''
        ].filter(Boolean)
      : previous.map(message => message.text);
    const kind: DebateMessageKind = kindFor(index);
    // 会话内网页主导：第一轮的观点在提问阶段已经由全部网页通道给出，直接
    // 落盘即可，不再把同一句用户原话重问一遍（那会多出一轮页面生成，还让
    // 辩论建立在第二份答案上）。后续交锋由主导人一个页面承担：网页彼此看
    // 不到回答，三个页面各写一轮只是三份独立文本，却要按最慢的一个计时。
    const seeded = index === 0
      ? seededWebPositions(state, speakersFor(state.plan, index), this.now())
      : [];
    const speakers = seeded.length > 0
      ? []
      : webLeadSpeakers(state, index, speakersFor(state.plan, index));
    const budget = budgetOf(state.config);
    // 从这一轮开始就记住还在等谁，界面才能在第一条发言回来之前显示「等待 X 发言」。
    round.pending = [...speakers];
    /**
     * 挑战指向具体两句。
     *
     * 上一轮结束后算出的争议是「谁的哪一句」对「谁的哪一句」，这一轮就照着
     * 这几条问，而不是「请逐条质疑上一轮」。只在上一轮真的算出争议时才有；
     * 没有就照旧给通用指令，不硬造。
     */
    const challenges = index === 0
      ? []
      : challengesFor(
          orderDisputes(
            (state.disputes ?? []).filter(dispute => dispute.roundIndex === index - 1),
            state.config.strategy
          ),
          state.rounds.at(-1)?.claims ?? []
        );
    // 谁被质疑了哪几句：回应阶段要把决策写回这几条主张。
    const targetsByAgent = targetsOf(state, index);

    const results = await mapLimit(speakers, budget.maxConcurrency, async agentId => {
      const role = roleForPlan(state.plan, agentId, index, state.config.strategy);
      // 自辩（本机只有一个本地模型）时上一轮全是自己的发言，也得有个
      // 明确的质疑对象，否则 targetMessageId 悄悄变 undefined。
      const targetMessageId =
        previous.find(message => message.agentId !== agentId)?.messageId ?? previous[0]?.messageId;
      const isWebOnly = state.plan.webOnly.includes(agentId);
      const task: SubAgentTask = {
        // 第一轮仍是用户原话（提问链路硬规则）。后续轮次里网页成员不能收
        // context / system，交锋材料只能拼进这一条用户消息——归属规则要求
        // 网页主导完全由网页完成，不靠本地模型补位。
        question: isWebOnly && index > 0
          ? webDebateQuestion(state.question, context, kind)
          : state.question,
        stage: index === 0 ? 'initial' : 'followup',
        context: !isWebOnly && context.length > 0 ? context : undefined,
        system: isWebOnly ? undefined : renderInstructions(state.config.strategy, kind, role, state.lead, {
          seeded: index === 0 && Boolean(seed?.positions.length),
          challenges
        })
      };
      const startedAt = this.now();
      try {
        const answer = await this.askWithin(agentId, task, budget.stageTimeoutMs, deadline);
        round.pending = round.pending?.filter(id => id !== agentId);
        const endedAt = this.now();
        const message: DebateMessage = {
          messageId: randomUUID(),
          roundIndex: index,
          agentId,
          role,
          kind,
          text: answer.text,
          ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
          targetMessageId,
          threadUrl: answer.threadUrl,
          // 页面读到的引用链接跟着发言一起落盘：证据要能回答「这条来源
          // 是谁在第几轮给的」，而不是事后再去翻页面。没有链接就不写这个
          // 字段（写 undefined 会让 JSON 往返后少一个键，比对时对不上）。
          ...(answer.citations && answer.citations.length > 0 ? { citations: answer.citations } : {}),
          createdAt: endedAt,
          startedAt,
          endedAt
        };
        return { ok: true as const, message };
      } catch (error) {
        return { ok: false as const, failure: { agentId, detail: error instanceof Error ? error.message : String(error) } };
      }
    });

    round.messages.push(...seeded);
    for (const result of results) {
      if (result.ok) round.messages.push(result.message);
      else round.failures.push(result.failure);
    }
    round.endedAt = this.now();
    round.converged = index > 0 && converged(previous, round.messages);
    // 结构化那一层只做一遍：发言已经是最终文本（存原文、不摘要），切句和
    // 争议检测都基于它，失败成员的缺席不影响已有发言。
    const analysis = analyseRound(round.messages, index);
    round.claims = analysis.claims;

    // 回应阶段才产生修订记录：质疑轮里没人做决定，那边不该凭空多出五条。
    const revisions: DebateRevision[] = phase !== 'response'
      ? []
      : round.messages
          .map(message =>
            revisionOf({
              messageId: message.messageId,
              agentId: message.agentId,
              roundIndex: index,
              before: positionOf(state, message.agentId),
              after: message.text,
              targetClaimIds: targetsByAgent.get(message.agentId) ?? [],
              now: this.now()
            })
          )
          // 并发完成顺序不定，落盘顺序按参与者排，读起来才是稳定的。
          .sort((a, b) => a.agentId.localeCompare(b.agentId));

    appendEvent(state, {
      type: 'round.finished',
      key: `round.finished:${String(index)}`,
      at: round.endedAt ?? this.now(),
      roundIndex: index,
      detail: `${String(round.messages.length)} 条发言，${String(round.failures.length)} 位失败`
    });

    return { round, disputes: analysis.disputes, revisions };
  }

  /** 单次调用超时，以及整场预算见底时立刻放弃——不拖着整轮等一个不会来的回答。 */
  private async askWithin(
    agentId: string,
    task: SubAgentTask,
    stageTimeoutMs: number,
    deadline: number
  ): Promise<SubAgentAnswer> {
    const remaining = deadline - this.now();
    const timeoutMs = Math.max(1, Math.min(stageTimeoutMs, remaining));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.deps.ask(agentId, task),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`超过单次调用时限 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 轮次 → 步骤：第一轮独立表态，第二轮质疑，第三轮之后都是回应。 */
function phaseFor(index: number): DebatePhase {
  return index === 0 ? 'analysis' : index === 1 ? 'challenge' : 'response';
}

/** 单次调用 60 秒、同时问 3 位，是任务书第 10 节的默认值，不是硬编码常量。 */
const DEFAULT_STAGE_TIMEOUT_MS = 60_000;
const DEFAULT_CONCURRENCY = 3;

function budgetOf(config: DebateConfig): { stageTimeoutMs: number; totalMs?: number; maxConcurrency: number } {
  return {
    stageTimeoutMs: config.budget?.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
    totalMs: config.budget?.totalMs,
    maxConcurrency: config.budget?.maxConcurrency ?? DEFAULT_CONCURRENCY
  };
}

/**
 * 这一轮里，每位参与者被点到了哪几句。
 *
 * 用「最近一轮出现争议的那一轮」，而不是死盯上一轮：争议在独立表态那轮就
 * 算出来了，中间隔着的质疑轮里双方只是在吵架，不会再产出可判定的 conflict。
 * 只看 index-1 会让回应轮永远拿不到目标（第一版就是这么错的）。
 *
 * 只认 claimId 属于这位自己的句子：把对方的主张记到自己名下，状态回写就会改错人。
 */
function targetsOf(state: DebateState, index: number): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  const earlier = (state.disputes ?? []).filter(dispute => dispute.roundIndex < index);
  if (earlier.length === 0) return targets;
  const latest = Math.max(...earlier.map(dispute => dispute.roundIndex));
  const owner = new Map((state.rounds[latest]?.claims ?? []).map(claim => [claim.claimId, claim.agentId]));
  for (const dispute of earlier) {
    if (dispute.roundIndex !== latest) continue;
    for (const agentId of dispute.agents) {
      const own = dispute.claimIds.filter(claimId => owner.get(claimId) === agentId);
      if (own.length === 0) continue;
      targets.set(agentId, [...(targets.get(agentId) ?? []), ...own]);
    }
  }
  return targets;
}

/**
 * 这位在更早轮次里说过的那段话，用作修订记录的「改之前」。
 *
 * 取最近一次**表态**（position）或上一次**回应**（revision），跳过质疑轮：
 * 质疑轮里他说的是「你哪里不对」，不是他自己的主张，拿它当 before，
 * 修订记录就成了「质疑 → 修正」的对照，读不出原来的立场变了没有。
 */
function positionOf(state: DebateState, agentId: string): string {
  for (let index = state.rounds.length - 1; index >= 0; index -= 1) {
    const messages = state.rounds[index].messages.filter(
      message => message.agentId === agentId && message.kind !== 'question'
    );
    if (messages.length > 0) return messages[messages.length - 1].text;
  }
  return '';
}

/** 回应阶段有没有实质进展：有人改口，或者冒出新的争议。 */
function progressed(revisions: readonly DebateRevision[], disputes: readonly DebateDispute[]): boolean {
  if (disputes.length > 0) return true;
  return revisions.some(
    revision => revision.decision === 'accept' || revision.decision === 'revise' || revision.decision === 'withdraw'
  );
}

/**
 * 最后两轮都没有进展。
 *
 * 首轮不算：第一轮本来就没有「新证据」这回事。只看最后两轮，是成本优化
 * 而不是「一场辩论只要有一轮没进展就停」——中间一轮没进展很正常。
 */
function stalledTwice(state: DebateState): boolean {
  const tail = state.rounds.slice(-2);
  return tail.length === 2 && tail.every(round => round.index > 0 && roundProgress(state, round).stalled);
}

/** 限并发地跑一批任务，保持入参顺序。用于「同时问 3 位」这条预算。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
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
 * 会话内网页主导：把提问阶段已经拿到的回答作为第一轮发言落盘。
 *
 * 只在「结构化 seed + 这一场是网页归属」时生效。手工辩论面板没有 seed，
 * 本地/云端主导的 plan.webOnly 为空，两条路都照旧由成员自己给观点。
 * 注入的不是本轮新生成的网页内容，所以不写 threadUrl / citations。
 */
function seededWebPositions(
  state: DebateState,
  speakers: readonly string[],
  at: number
): DebateMessage[] {
  if (state.plan.webOnly.length === 0) return [];
  const entries = state.config.seed?.entries ?? [];
  const seen = new Set<string>();
  const messages: DebateMessage[] = [];
  for (const entry of entries) {
    if (!speakers.includes(entry.agentId) || seen.has(entry.agentId)) continue;
    seen.add(entry.agentId);
    messages.push({
      messageId: randomUUID(),
      roundIndex: 0,
      agentId: entry.agentId,
      role: roleForPlan(state.plan, entry.agentId, 0, state.config.strategy),
      kind: 'position',
      text: entry.text,
      createdAt: at,
      startedAt: at,
      endedAt: at
    });
  }
  return messages;
}

/** 有基准观点可注入的网页主导，质疑与回应只交给主辩那一个页面。 */
function webLeadSpeakers(state: DebateState, index: number, speakers: readonly string[]): string[] {
  if (index === 0 || state.plan.webOnly.length === 0 || !state.config.seed?.entries?.length) {
    return [...speakers];
  }
  const lead = state.plan.lead.agentId;
  return lead && speakers.includes(lead) ? [lead] : [...speakers];
}

/** 页面会把这条用户消息回显进转录：拼接越长越难剥干净，生成也越慢。 */
const WEB_CONTEXT_CHARS = 1800;

function webContextText(context: readonly string[]): string {
  const items = context.filter(Boolean);
  if (items.length === 0) return '';
  const per = Math.max(240, Math.floor(WEB_CONTEXT_CHARS / items.length));
  return items.map(item => (item.length > per ? `${item.slice(0, per)}…` : item)).join('\n\n');
}

/**
 * 网页交锋消息（归属规则，2026-11-06）。
 *
 * 页面彼此看不到回答，也不接 context / system，所以质疑与修正只能把材料
 * 拼进这一条用户消息。第一轮不走这条：那时页面收到的仍是用户原话。
 * 文案刻意短——页面会把用户消息回显进转录，套话越长越难剥干净。
 */
function webDebateQuestion(
  question: string,
  context: readonly string[],
  kind: DebateMessageKind
): string {
  const views = webContextText(context);
  return [
    `【问题】${question}`,
    views ? `【观点】${views}` : '',
    kind === 'question'
      ? '【回应】指出上面哪一句证据不足或推理不成立，只写那一句和理由。'
      : '【回应】看过质疑后，说明结论是否修改；不改就写明为什么不改。'
  ].filter(Boolean).join('\n\n');
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
