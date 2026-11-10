import type { ChannelPhase, ConversationStatus, Synthesis } from '../shared/conversation';
import { synthesize } from '../shared/synthesizer';
import { PageBusyError, PageUnavailableError } from './adapters/browser/types';
import type { SubAgent, SubAgentAnswer, SubAgentPool, SubAgentTask } from './agents/types';

/**
 * The Master Agent: who joins a round, and when the round is over.
 *
 * One decision, made here and nowhere else. A participant that could decide for
 * itself whether to ask someone else — or whether to keep going — would spend
 * the user's time and the pages' rate limits without anyone counting. So the
 * Master picks the participants, hands each one a task, and stops.
 *
 * Two rules, both learned from what the app used to do:
 *
 * - **Every channel that is switched on gets asked.** The rule used to be "a
 *   plain question goes to one agent, research fans out", and it was wrong in
 *   the way that is hardest to notice: three pages were open, the strip said
 *   three were ready, and one of them answered while the other two sat there —
 *   the pane then reported a single answer as if that were the product. The
 *   fan-out is the product: what one model says is not a cross-check.
 * - **The question goes out verbatim.** No role line, no per-intent preamble,
 *   no "you are my research partner" wrapping. Two reasons, both measured: the
 *   page echoes what we send, so any wrapper becomes text the app has to strip
 *   back out before it can trust an answer; and a wrapper is a fixed prompt the
 *   user never wrote and cannot see themselves writing. The channel answers the
 *   user's question, or it is the wrong channel.
 *
 * Not implemented, and deliberately so: the debate round. The rule-based
 * synthesizer already finds the disputes it would be aimed at, but the round
 * itself is later work. Until it exists, a disagreement is reported as a
 * disagreement, which is honest, instead of being papered over by a second pass
 * nobody asked for.
 */

/** Where the Master writes; the conversation runner owns the store and the events. */
export interface ResearchSink {
  /** This agent is about to be asked; it is now part of the conversation. */
  join(agentId: string): void;
  /** Record one answer to the user's question. Returns its message id. */
  record(answer: SubAgentAnswer): string;
  /** Something happened to one participant; the strip above the pane shows it. */
  phase(agentId: string, phase: ChannelPhase, detail?: string): void;
  /**
   * 流式增量：正文 / 推理 / 网页改写（reset）。没有流式能力的通道不会调用。
   * 由 ConversationRunner 转成 `answer.delta` 事件，主进程不关心界面。
   */
  delta?(agentId: string, chunk: { text?: string; reasoning?: string; reset?: boolean; done?: boolean }): void;
  /** A sentence for the conversation itself, not for one agent. */
  note(text: string): void;
  status(status: ConversationStatus): void;
  cancelled(): boolean;
}

export interface ResearchRequest {
  question: string;
  followup: boolean;
  /**
   * Agents that already hold this conversation on their page.
   *
   * Named for what it decides: whether the page has to be reset. A channel that
   * was asked and failed last turn is not in here — its page never received
   * this conversation's thread, so the follow-up has to start it clean.
   */
  continuing: ReadonlySet<string>;
}

/**
 * What happened to one channel in one turn.
 *
 * One shape for all of them, so the runner can report without inferring from
 * whether an answer happens to be in a list. Every channel that was handed the
 * question ends up as exactly one of these.
 */
export type ChannelOutcome =
  | { kind: 'answered'; agentId: string; label: string; answer: SubAgentAnswer; resetFailure?: string }
  | { kind: 'unanswered'; agentId: string; label: string; phase: 'failed' | 'busy'; detail: string }
  /** The user stopped the turn while this channel was still being prepared. */
  | { kind: 'cancelled'; agentId: string; label: string };

export interface ResearchOutcome {
  answers: SubAgentAnswer[];
  synthesis: Synthesis | null;
  /** One line per agent that produced nothing, so the reason survives. */
  failures: string[];
  /** The same per-channel results, structured — see `ChannelOutcome`. */
  channels: ChannelOutcome[];
  /** 每个回答落库后的消息 id，Phase I 的融合报告靠它跳回原话。 */
  messageIds?: ReadonlyMap<string, string>;
}

/**
 * No agent could take the question at all. Distinct from "all of them failed".
 *
 * The site names come from the pool, not from this file. The message used to
 * read "请先在右侧页面登录 DeepSeek 或 ChatGPT" — a list that goes stale the
 * first time a third site is added, and stale in the worst way: it names sites
 * the user has already logged into and omits the one they haven't.
 *
 * 现在又多了本地和云端两种来源，那句「去右侧页面登录」对它们完全是误导：
 * 云端模型没有页面，缺的是 API Key；本地模型缺的是 Ollama 进程。所以这句
 * 报错改成按来源分组，原因用各自的 `health().detail`（“还没有配置 API Key”
 * “连不上 http://127.0.0.1:11434”），再给一句能照着做的话。
 */
export interface UnusableMember {
  label: string;
  detail?: string;
  source: 'web' | 'local' | 'cloud';
}

export class NoUsableAgentError extends Error {
  constructor(roster: readonly UnusableMember[]) {
    const web = roster.filter(item => item.source === 'web');
    const models = roster.filter(item => item.source !== 'web');
    const hints: string[] = [];
    if (models.some(item => item.source === 'cloud')) {
      hints.push('云端模型要先去「研究设置 → 执行模式 → 云端服务」填 API Key');
    }
    if (models.some(item => item.source === 'local')) {
      hints.push('本地模型要先启动 Ollama');
    }
    let message: string;
    if (roster.length === 0) {
      message = '没有可用的通道：请先在设置里打开至少一个 AI 站点。';
    } else if (models.length === 0) {
      message = `没有可用的通道：请先在右侧页面登录 ${web.map(item => item.label).join(' 或 ')}。`;
    } else {
      // 逐个带原因：只说「不可用」会让人以为是网络问题，实际多半是没配 Key。
      const list = roster
        .map(item => (item.detail ? `${item.label}（${item.detail}）` : item.label))
        .join('、');
      message = `没有可用的通道：${list}。${hints.join('；')}。`;
    }
    super(message);
    this.name = 'NoUsableAgentError';
  }
}

/** 名单里每个人此刻为什么不能问。只在「一个都问不了」的失败路径上调用。 */
export async function describeUnusable(roster: readonly SubAgent[]): Promise<UnusableMember[]> {
  return Promise.all(roster.map(async agent => {
    let detail: string | undefined;
    try {
      detail = (await agent.health()).detail;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    return { label: agent.label, detail, source: agent.sourceType ?? 'web' as const };
  }));
}

export class MasterAgent {
  constructor(private readonly pool: SubAgentPool) {}

  async research(request: ResearchRequest, sink: ResearchSink): Promise<ResearchOutcome> {
    const participants = await this.pool.available();

    // 名单之外还有开关开着的通道时，把它们为什么没被问写成可见的失败。
    // 这里曾经是静默的：页面未就绪或上一轮的 generating 还没回落时，通道
    // 直接从这一轮消失，状态条永远停在「待命」，用户只看到少了两家回答。
    const skipped: ChannelOutcome[] = [];
    if (participants.length > 0) {
      const chosen = new Set(participants.map(agent => agent.id));
      for (const agent of await this.pool.all()) {
        if (chosen.has(agent.id) || sink.cancelled()) continue;
        let detail: string;
        try {
          detail = (await agent.health()).detail ?? '页面未就绪，或上一轮的回答还没落定';
        } catch (error) {
          detail = error instanceof Error ? error.message : String(error);
        }
        sink.phase(agent.id, 'failed', `本轮未参与提问：${detail}`);
        skipped.push({
          kind: 'unanswered',
          agentId: agent.id,
          label: agent.label,
          phase: 'failed',
          detail: `本轮未参与提问：${detail}`
        });
      }
    }

    if (participants.length === 0) {
      // 用户要知道每个来源具体缺什么，所以原因来自各自的 health()，
      // 不是把注册表里的名字拼成一句「请去登录」。
      throw new NoUsableAgentError(await describeUnusable(await this.pool.all()));
    }

    sink.status(participants.length > 1 ? 'collecting' : 'thinking');
    // 通道条一开始就要齐：join 若跟在每人 ask 前面，慢的那家在条上会晚出现，
    // 看起来像「这一轮没问它」。名单先入条，再各自进入提问中。
    for (const agent of participants) sink.join(agent.id);

    const round = await this.ask(participants, request, sink);
    const base: ResearchOutcome = {
      answers: round.answers,
      messageIds: round.messageIds,
      synthesis: null,
      failures: [...round.channels, ...skipped]
        .filter((item): item is Extract<ChannelOutcome, { kind: 'unanswered' }> => item.kind === 'unanswered')
        .map(item => `${item.label}：${item.detail}`),
      channels: [...round.channels, ...skipped]
    };

    if (sink.cancelled()) return base;

    // An agent that could not reset was still asked: an answer carrying old
    // context beats no answer, but a wrong answer that looks fresh is worse than
    // a slow one, so the drift is stated rather than hidden.
    const resetFailures = round.channels.flatMap(item =>
      item.kind === 'answered' && item.resetFailure ? [`${item.label}：${item.resetFailure}`] : []
    );
    if (resetFailures.length > 0) {
      sink.note(`以下通道没能开新会话，回答可能带着网页里的旧上下文：${resetFailures.join('；')}`);
    }

    if (round.answers.length === 0) {
      // The per-agent reason is the only useful part. "所有通道都没有给出回答"
      // on its own was wrong often enough to mislead: the pages were logged in
      // and working, and the cause was a timeout on an answer still being written.
      const why = base.failures.length > 0 ? `\n${base.failures.join('\n')}` : '';
      throw new Error(`所有通道都没有给出回答。${why}`.trim());
    }

    // Two or more answers is the only case where synthesis means anything. With
    // one, the honest output is the answer itself.
    if (round.answers.length < 2) return base;

    sink.status('synthesizing');
    const synthesis = synthesize(
      round.answers.map(answer => ({
        channelId: answer.agentId,
        messageId: round.messageIds.get(answer.agentId) ?? '',
        text: answer.text
      }))
    );

    // The runner marks the conversation answered once the synthesis message is
    // written. Not here: a status that flips before its own last message lands
    // is how a pane ends up showing "已回答" above an empty card.
    return { ...base, synthesis };
  }

  // -------------------------------------------------------------------------

  /**
   * Ask everyone at once, and describe what happened to each of them.
   *
   * Results are put back into roster order afterwards. Completion order would
   * make the answer cards and the synthesis read differently from one turn to
   * the next for reasons the user cannot see.
   */
  private async ask(
    participants: SubAgent[],
    request: ResearchRequest,
    sink: ResearchSink
  ): Promise<{
    answers: SubAgentAnswer[];
    messageIds: Map<string, string>;
    channels: ChannelOutcome[];
  }> {
    const messageIds = new Map<string, string>();
    const channels: ChannelOutcome[] = [];
    const positions = new Map(participants.map((agent, index) => [agent.id, index]));

    await Promise.all(
      participants.map(async agent => {
        const outcome = await this.askOne(agent, request, sink, messageIds);
        if (outcome) channels.push(outcome);
      })
    );

    channels.sort((a, b) => (positions.get(a.agentId) ?? 0) - (positions.get(b.agentId) ?? 0));
    const answers = channels
      .filter((item): item is Extract<ChannelOutcome, { kind: 'answered' }> => item.kind === 'answered')
      .map(item => item.answer);

    return { answers, messageIds, channels };
  }

  /**
   * 有流式就流式，没有就整段问。
   *
   * 增量按 50ms 合批：云端 SSE 是逐 token 的，直接 per-chunk 发会把 IPC 打成
   * 洪水。合批只影响显示，最终消息、用量与首 token 时间仍来自完整回答。
   */
  private async askStreaming(
    agent: SubAgent,
    task: SubAgentTask,
    sink: ResearchSink
  ): Promise<SubAgentAnswer> {
    if (!this.pool.askStream || !sink.delta) return this.pool.ask(agent.id, task);

    let text = '';
    let reasoning = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (!text && !reasoning) return;
      sink.delta?.(agent.id, { ...(text ? { text } : {}), ...(reasoning ? { reasoning } : {}) });
      text = '';
      reasoning = '';
    };
    const onDelta = (chunk: { text?: string; reasoning?: string; reset?: boolean }) => {
      if (chunk.reset) {
        flush();
        sink.delta?.(agent.id, { text: chunk.text ?? '', reset: true });
        return;
      }
      text += chunk.text ?? '';
      reasoning += chunk.reasoning ?? '';
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, 50);
    };

    try {
      const answer = await this.pool.askStream(agent.id, task, onDelta);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
      sink.delta?.(agent.id, { done: true });
      return answer;
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
      sink.delta?.(agent.id, { done: true });
      throw error;
    }
  }

  /**
   * One channel: reset (only when it does not already hold this conversation),
   * ask, and record.
   *
   * The reset is gated per agent, not per turn, because "does this page hold
   * this conversation" is a fact about the page. A channel that failed last
   * turn does not hold it, so it starts clean this turn instead of inheriting
   * whatever unrelated history its page was left on.
   */
  private async askOne(
    agent: SubAgent,
    request: ResearchRequest,
    sink: ResearchSink,
    messageIds: Map<string, string>
  ): Promise<ChannelOutcome | null> {
    if (sink.cancelled()) return null;

    let resetFailure: string | undefined;
    if (!request.continuing.has(agent.id)) {
      sink.phase(agent.id, 'resetting');
      const reset = await this.pool.newConversation(agent.id);
      if (!reset.ok) resetFailure = reset.detail ?? '未能开新会话';
      if (sink.cancelled()) return { kind: 'cancelled', agentId: agent.id, label: agent.label };
    }

    sink.join(agent.id);
    sink.phase(agent.id, 'asking');
    try {
      const task = {
        // Verbatim. `request.question` is the text the user typed — nothing
        // is prepended, prefixed, or wrapped for this channel.
        question: request.question,
        stage: (request.followup ? 'followup' : 'initial') as 'followup' | 'initial'
      };
      const answer = await this.askStreaming(agent, task, sink);
      if (sink.cancelled()) return { kind: 'cancelled', agentId: agent.id, label: agent.label };
      messageIds.set(agent.id, sink.record(answer));
      sink.phase(agent.id, 'answered');
      return { kind: 'answered', agentId: agent.id, label: agent.label, answer, resetFailure };
    } catch (error) {
      // One agent failing is a fact to display, not a reason to abort: the
      // other answers are still worth having.
      const phase = error instanceof PageBusyError ? 'busy' : 'failed';
      const detail = describeAgentError(error, agent.id);
      sink.phase(agent.id, phase, detail);
      return { kind: 'unanswered', agentId: agent.id, label: agent.label, phase, detail };
    }
  }
}

function describeAgentError(error: unknown, agentId: string): string {
  if (error instanceof PageBusyError) return '通道正在处理上一个问题，本次跳过';
  if (error instanceof PageUnavailableError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `${agentId}: ${message}`;
}
