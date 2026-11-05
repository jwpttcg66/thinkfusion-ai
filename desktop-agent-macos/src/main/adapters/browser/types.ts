import type { ChannelStatus } from '../../../shared/conversation';
import type { PageCitation } from '../../../shared/evidence';

/**
 * The layer that touches a web page.
 *
 * An adapter knows DOM: which element is the composer, how to tell a finished
 * answer from a half-written one, how to start a new thread. It knows nothing
 * about research, roles, or who is asking whom — that belongs to the agent that
 * owns it.
 *
 * The split is the whole point of this directory. A `ProviderSubAgent` is a
 * *participant*: it has an identity, a session, a health record, and a job in
 * the research. An adapter is a *driver*: it can be swapped for a different
 * site, or for a recorded fixture, without the participant noticing. Writing
 * the two as one class is how "which AI said this" and "which DOM selector did
 * we use" end up in the same file, and then in the same bug report.
 */

export type AskStage = 'initial' | 'followup' | 'challenge';

export interface AdapterAsk {
  /** The exact text to type into the page. Already composed by the caller. */
  question: string;
  stage: AskStage;
  timeoutMs?: number;
}

export interface AdapterAnswer {
  /** Whose page answered. Equal to the owning agent's id. */
  agentId: string;
  text: string;
  receivedAt: number;
  /**
   * The page's address once the answer had arrived.
   *
   * A chat site puts the thread id in its URL the moment the first message is
   * accepted, so this is what later identifies *this* conversation in the
   * site's sidebar. Recorded here because it is only knowable from the page.
   */
  threadUrl?: string;
  /**
   * The links the answer bubble displayed, if any.
   *
   * Provenance metadata, not part of the answer: an answer without links is
   * still a complete answer. Only web pages can have this — a local model has
   * no DOM to read.
   */
  citations?: PageCitation[];
  /** The page's address when the citations were read. */
  pageUrl?: string;
  /** How this text was recognised as *this turn's* answer. Debugging breadcrumb. */
  attribution: { requestId: string; note: string };
}

/**
 * What came of trying to delete the page's own copy of a conversation.
 *
 * `ok: false` is not a failure of the app's delete: the row is already gone
 * locally, and the detail is what the user needs in order to remove it in the
 * site by hand.
 */
export interface DeleteThreadResult {
  ok: boolean;
  detail?: string;
}

/**
 * What an adapter can say about starting a fresh session on its side.
 *
 * `ok: false` is not an error: a page that keeps its old thread is still worth
 * asking, and the caller records the drift rather than dropping the answer.
 */
export interface NewSessionResult {
  ok: boolean;
  detail?: string;
}

export interface BrowserAdapter {
  readonly id: string;
  readonly label: string;
  status(): Promise<ChannelStatus>;
  ask(input: AdapterAsk): Promise<AdapterAnswer>;
  /**
   * Give the page a fresh thread. Called once per conversation, never for a
   * follow-up.
   *
   * `leaving` is the address this channel answered in last time. A reset is
   * only real once the page is off that address, which is the one signal the
   * site's own markup cannot take away.
   */
  newConversation?(leaving?: string): Promise<NewSessionResult>;
  /**
   * Delete this conversation from the site itself.
   *
   * `threadUrl` is the address recorded when the answer arrived; the row is
   * found by that address, never by title. Optional because a signed-out page
   * has no sidebar to delete from — the caller then only resets the page and
   * says so.
   */
  deleteConversation?(threadUrl: string): Promise<DeleteThreadResult>;
  /** Drop a pending wait; the page keeps generating. */
  cancel(requestId: string): void;
  /**
   * Drop every wait this page currently has.
   *
   * What "停止" actually needs. The request id is only known once the answer
   * arrives, so cancelling mid-flight by id never worked — the adapter has to be
   * allowed to give up on whatever it is waiting for.
   */
  cancelAll?(): void;
}

/**
 * The page already has a request in flight.
 *
 * Not an error to retry blindly: a web page has exactly one writer, so a second
 * question sent now would land in the middle of the first one's answer and both
 * would be misread.
 */
export class PageBusyError extends Error {
  constructor(readonly agentId: string) {
    super(`页面 ${agentId} 正在处理上一个问题`);
    this.name = 'PageBusyError';
  }
}

/** Logged out, page gone, or the probe cannot find a composer. */
export class PageUnavailableError extends Error {
  constructor(
    readonly agentId: string,
    detail: string
  ) {
    super(`页面 ${agentId} 不可用：${detail}`);
    this.name = 'PageUnavailableError';
  }
}
