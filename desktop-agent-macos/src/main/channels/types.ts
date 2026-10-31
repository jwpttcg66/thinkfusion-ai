/**
 * One AI, reachable one way.
 *
 * The interface is this small on purpose, and the important part is what it
 * does *not* contain: `ask()` returns a string. There is no `payload`, no
 * `structured`, no `data`. The previous build asked every model to emit a JSON
 * plan on every turn, and the result was a chat page that could not hold a
 * normal conversation — it was busy solving our format problem instead of the
 * user's question.
 *
 * Keeping the return type narrow means that mistake cannot be reintroduced by
 * a future channel without changing this file and arguing for it.
 */

import type { ChannelStatus } from '../../shared/conversation';

export type { ChannelStatus };

export type AskStage = 'initial' | 'followup' | 'challenge' | 'synthesis';

export interface AskInput {
  /** The user's own words, or one question derived from them. Never a rewritten task spec. */
  question: string;
  stage: AskStage;
  timeoutMs?: number;
}

export interface ChannelAnswer {
  channelId: string;
  text: string;
  receivedAt: number;
  /** How this text was recognised as *this turn's* answer. Debugging breadcrumb. */
  attribution: { requestId: string; note: string };
}

/**
 * What a channel can say about starting a fresh session on its side.
 *
 * `ok: false` is not an error: a page that keeps its old thread is still worth
 * asking, and the caller records the drift rather than dropping the answer.
 */
export interface NewSessionResult {
  ok: boolean;
  detail?: string;
}

export interface AiChannel {
  readonly id: string;
  readonly label: string;
  status(): Promise<ChannelStatus>;
  ask(input: AskInput): Promise<ChannelAnswer>;
  /**
   * Give this channel a fresh session, so the page and the conversation are the
   * same thread. Called once per conversation, never for a follow-up.
   */
  newConversation?(): Promise<NewSessionResult>;
  /** Drop a pending wait; the underlying page keeps generating. */
  cancel(requestId: string): void;
}

/**
 * The channel already has a request in flight.
 *
 * Not an error to retry blindly: a web page has exactly one writer, so a second
 * question sent now would land in the middle of the first one's answer and both
 * would be misread.
 */
export class ChannelBusyError extends Error {
  constructor(readonly channelId: string) {
    super(`通道 ${channelId} 正在处理上一个问题`);
    this.name = 'ChannelBusyError';
  }
}

/** Logged out, page gone, or the probe cannot find a composer. */
export class ChannelUnavailableError extends Error {
  constructor(readonly channelId: string, detail: string) {
    super(`通道 ${channelId} 不可用：${detail}`);
    this.name = 'ChannelUnavailableError';
  }
}
