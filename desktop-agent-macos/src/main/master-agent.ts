import type { ChannelPhase, ConversationStatus, Synthesis } from '../shared/conversation';
import { synthesize } from '../shared/synthesizer';
import { PageBusyError, PageUnavailableError } from './adapters/browser/types';
import type { SubAgent, SubAgentAnswer, SubAgentPool } from './agents/types';

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
 */
export class NoUsableAgentError extends Error {
  constructor(labels: readonly string[]) {
    super(
      labels.length > 0
        ? `没有可用的通道：请先在右侧页面登录 ${labels.join(' 或 ')}。`
        : '没有可用的通道：请先在设置里打开至少一个 AI 站点。'
    );
    this.name = 'NoUsableAgentError';
  }
}

export class MasterAgent {
  constructor(private readonly pool: SubAgentPool) {}

  async research(request: ResearchRequest, sink: ResearchSink): Promise<ResearchOutcome> {
    const participants = await this.pool.available();

    if (participants.length === 0) {
      // The user needs to know which pages to log into, so the message is built
      // from the pool's own roster rather than a list baked into this file.
      throw new NoUsableAgentError((await this.pool.all()).map(agent => agent.label));
    }

    sink.status(participants.length > 1 ? 'collecting' : 'thinking');

    const round = await this.ask(participants, request, sink);
    const base: ResearchOutcome = {
      answers: round.answers,
      messageIds: round.messageIds,
      synthesis: null,
      failures: round.channels
        .filter((item): item is Extract<ChannelOutcome, { kind: 'unanswered' }> => item.kind === 'unanswered')
        .map(item => `${item.label}：${item.detail}`),
      channels: round.channels
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
      const answer = await this.pool.ask(agent.id, {
        // Verbatim. `request.question` is the text the user typed — nothing
        // is prepended, prefixed, or wrapped for this channel.
        question: request.question,
        stage: request.followup ? 'followup' : 'initial'
      });
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
