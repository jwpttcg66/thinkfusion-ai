import type { ChannelStatus } from '../../shared/conversation';
import type { AdapterAnswer, AskStage, NewSessionResult } from '../adapters/browser/types';

/**
 * A participant in the research, as opposed to the thing that types into a page.
 *
 * Two kinds are planned. Only the first exists today:
 *
 * - `provider` — one AI site (DeepSeek, ChatGPT, …). It speaks for that model
 *   and nothing else. Implemented by `ProviderSubAgent`.
 * - `specialist` — a role rather than a source: researcher, critic, reviewer.
 *   Not implemented, and deliberately so: a specialist would have to run on some
 *   provider anyway, and "the same model with a different role prompt" is not a
 *   second opinion. Shipping the type before the honesty would invite exactly
 *   that mistake, so the field is here and the implementations are not.
 *
 * What an agent owns: identity, its page session, its health record, and the
 * job it was given. What it does *not* own: who else is in the round, whether
 * the round happens at all, or how many rounds there are — that is the Master
 * Agent's budget to spend, and a participant that could spawn participants
 * would spend it forever.
 */

export type SubAgentKind = 'provider' | 'specialist';

export interface SubAgentIdentity {
  /** Stable id, shared with the source store and the message records. */
  id: string;
  label: string;
  kind: SubAgentKind;
  /** One line: what this agent is for, shown when a round is explained. */
  role: string;
}

export interface SubAgentTask {
  /** The exact text this agent should be sent. Composed by the caller. */
  question: string;
  stage: AskStage;
  /**
   * Set only for a challenge: the disagreement being adjudicated and the side
   * this agent is being asked to defend or drop. Kept on the task rather than
   * baked into the prompt so a later round can explain itself without parsing
   * the text it sent.
   */
  dispute?: { topic: string; stance: string; counter: string };
  timeoutMs?: number;
}

export interface SubAgentAnswer extends AdapterAnswer {
  stage: AskStage;
}

export interface SubAgent {
  readonly identity: SubAgentIdentity;
  readonly id: string;
  readonly label: string;
  /** Usable right now, from the adapter plus this agent's own failure record. */
  health(): Promise<ChannelStatus>;
  ask(task: SubAgentTask): Promise<SubAgentAnswer>;
  /** Give this agent's page a fresh thread. Called once per conversation. */
  newConversation?(): Promise<NewSessionResult>;
  cancel(requestId: string): void;
  /** Give up on whatever this agent is waiting for. See `BrowserAdapter.cancelAll`. */
  cancelAll?(): void;
}

/**
 * The narrow view the Master Agent needs.
 *
 * Declared here rather than importing the registry so the Master can be tested
 * against a hand-written object with four methods.
 */
export interface SubAgentPool {
  available(): Promise<SubAgent[]>;
  ask(agentId: string, task: SubAgentTask): Promise<SubAgentAnswer>;
  newConversation(agentId: string): Promise<NewSessionResult>;
  cancel(agentId: string, requestId: string): void;
}
