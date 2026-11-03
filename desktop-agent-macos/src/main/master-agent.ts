import type { ChannelPhase, ConversationStatus, Synthesis } from '../shared/conversation';
import type { IntentKind } from '../shared/intent';
import { isMultiChannel } from '../shared/intent';
import { buildConversationPrompt } from '../shared/prompts';
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
 * - A plain question goes to one agent. Asking three and synthesising is slower
 *   and noisier for "what does SETNX do", and the disagreement it produces is
 *   about wording, not about the answer.
 * - Research and comparison fan out, because there the disagreement *is* the
 *   product.
 *
 * Not implemented, and deliberately so: the debate round. The design is written
 * down (`buildChallengePrompt`, `AskStage = 'challenge'`), and the rule-based
 * synthesizer already finds the disputes it would be aimed at — but the round
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
  intent: Exclude<IntentKind, 'workspace'>;
  followup: boolean;
  /** Agents this conversation has already spoken to; they keep their page thread. */
  known: ReadonlySet<string>;
}

export interface ResearchOutcome {
  answers: SubAgentAnswer[];
  synthesis: Synthesis | null;
  /** One line per agent that produced nothing, so the reason survives. */
  failures: string[];
}

/** No agent could take the question at all. Distinct from "all of them failed". */
export class NoUsableAgentError extends Error {
  constructor() {
    super('没有可用的通道：请先在右侧页面登录 DeepSeek 或 ChatGPT。');
    this.name = 'NoUsableAgentError';
  }
}

export class MasterAgent {
  constructor(private readonly pool: SubAgentPool) {}

  async research(request: ResearchRequest, sink: ResearchSink): Promise<ResearchOutcome> {
    const usable = await this.pool.available();
    const multi = isMultiChannel(request.intent);
    const participants = multi ? usable : usable.slice(0, 1);

    if (participants.length === 0) throw new NoUsableAgentError();

    sink.status(multi ? 'collecting' : 'thinking');

    const round = await this.ask(participants, request, sink);

    if (sink.cancelled()) return { answers: round.answers, synthesis: null, failures: round.failures };

    // An agent that could not reset was still asked: an answer carrying old
    // context beats no answer, but a wrong answer that looks fresh is worse than
    // a slow one, so the drift is stated rather than hidden.
    if (round.resetFailures.length > 0) {
      sink.note(`以下通道没能开新会话，回答可能带着网页里的旧上下文：${round.resetFailures.join('；')}`);
    }

    if (round.answers.length === 0) {
      // The per-agent reason is the only useful part. "所有通道都没有给出回答"
      // on its own was wrong often enough to mislead: the pages were logged in
      // and working, and the cause was a timeout on an answer still being written.
      const why = round.failures.length > 0 ? `\n${round.failures.join('\n')}` : '';
      throw new Error(`所有通道都没有给出回答。${why}`.trim());
    }

    // Two or more answers is the only case where synthesis means anything. With
    // one, the honest output is the answer itself.
    if (round.answers.length < 2) {
      return { answers: round.answers, synthesis: null, failures: round.failures };
    }

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
    return { answers: round.answers, synthesis, failures: round.failures };
  }

  // -------------------------------------------------------------------------

  private async ask(
    participants: SubAgent[],
    request: ResearchRequest,
    sink: ResearchSink
  ): Promise<{
    answers: SubAgentAnswer[];
    messageIds: Map<string, string>;
    failures: string[];
    resetFailures: string[];
  }> {
    const answers: SubAgentAnswer[] = [];
    const messageIds = new Map<string, string>();
    const failures: string[] = [];
    const resetFailures: string[] = [];

    await Promise.all(
      participants.map(async agent => {
        if (sink.cancelled()) return;

        // The first time this conversation talks to this agent, give the page a
        // fresh session — otherwise the thread a user opens later is an
        // unrelated history with today's question glued onto the end. A
        // follow-up deliberately skips this: the page's own history is the
        // context that makes it a follow-up. Gated per agent rather than per
        // turn, so an agent that failed last turn still starts clean when retried.
        const fresh = !request.known.has(agent.id);
        if (fresh) {
          sink.phase(agent.id, 'resetting');
          const reset = await this.pool.newConversation(agent.id);
          if (!reset.ok) resetFailures.push(`${agent.label}：${reset.detail ?? '未能开新会话'}`);
          if (sink.cancelled()) return;
        }

        const prompt = buildConversationPrompt({
          question: request.question,
          intent: request.intent,
          first: fresh,
          followup: request.followup
        });

        sink.join(agent.id);
        sink.phase(agent.id, 'asking');
        try {
          const answer = await this.pool.ask(agent.id, {
            question: prompt,
            stage: request.followup ? 'followup' : 'initial'
          });
          if (sink.cancelled()) return;
          messageIds.set(agent.id, sink.record(answer));
          answers.push(answer);
          sink.phase(agent.id, 'answered');
        } catch (error) {
          // One agent failing is a fact to display, not a reason to abort: the
          // other answers are still worth having.
          const detail = describeAgentError(error, agent.id);
          failures.push(`${agent.label}：${detail}`);
          sink.phase(agent.id, error instanceof PageBusyError ? 'busy' : 'failed', detail);
        }
      })
    );

    return { answers, messageIds, failures, resetFailures };
  }
}

function describeAgentError(error: unknown, agentId: string): string {
  if (error instanceof PageBusyError) return '通道正在处理上一个问题，本次跳过';
  if (error instanceof PageUnavailableError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `${agentId}: ${message}`;
}
