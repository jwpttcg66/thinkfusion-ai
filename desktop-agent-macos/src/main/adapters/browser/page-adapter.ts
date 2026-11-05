import { randomUUID } from 'node:crypto';
import { digestCitations } from '../../../shared/evidence';
import type { ChatPageDriver } from './page-driver';
import type { ChannelStatus } from '../../../shared/conversation';
import {
  PageBusyError,
  PageUnavailableError,
  type AdapterAnswer,
  type AdapterAsk,
  type BrowserAdapter,
  type DeleteThreadResult,
  type NewSessionResult
} from './types';

/**
 * A chat page, driven.
 *
 * Everything that knows about DOM — selectors, probing, waiting for the bubble
 * to settle, stripping our own echoed prompt — stays behind this class. Callers
 * get text, or an error that says which of the three things went wrong.
 *
 * The class underneath is `ChatPageDriver`: probe, send, wait, echo stripping,
 * and nothing about any particular site. Which markup it answers to, and which
 * hosts it may be, arrive as options from `adapters/providers/`.
 *
 * This is the *only* file in the app that a new AI site needs a variant of, and
 * even then it is usually just a selector profile (see
 * `adapters/providers/chatgpt.ts`) rather than a subclass.
 */
export class PageBrowserAdapter implements BrowserAdapter {
  private inFlight = new Set<string>();

  /**
   * The address this channel last answered in.
   *
   * Kept because "start a new conversation" needs to prove it left that place,
   * and the site's own markup cannot be relied on to say so: ChatGPT no longer
   * ships any stable hook on its messages, so a message count of zero there
   * means "nothing to count", not "nothing on screen".
   */
  private lastThreadUrl = '';

  constructor(
    private readonly spec: {
      id: string;
      label: string;
      adapter: ChatPageDriver;
      /** Page-driven answers are slow; a question deserves more than a socket timeout. */
      timeoutMs?: number;
      /**
       * Can this channel answer while signed out? Comes from the site's profile;
       * false is the default because for most sites it cannot.
       */
      guestUsable?: boolean;
    }
  ) {}

  get id(): string {
    return this.spec.id;
  }

  get label(): string {
    return this.spec.label;
  }

  /** Signed in, or a site that showed it answers guests too. */
  private usable(status: { loggedIn: boolean }): boolean {
    return status.loggedIn || this.spec.guestUsable === true;
  }

  async status(): Promise<ChannelStatus> {
    try {
      const status = await this.spec.adapter.getStatus();
      // Signed out is not automatically unusable: Gemini answers guests and
      // only the history / heavier models need an account. That exception is
      // declared per site (`guestUsable`), not assumed here — a signed-out
      // ChatGPT is still a dead end.
      const available = status.pageReady && !status.generating && this.usable(status);
      return {
        id: this.id,
        label: this.label,
        available,
        loggedIn: status.loggedIn,
        pageReady: status.pageReady,
        generating: status.generating,
        detail: status.detail
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        loggedIn: false,
        pageReady: false,
        generating: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async ask(input: AdapterAsk): Promise<AdapterAnswer> {
    if (this.inFlight.size > 0) throw new PageBusyError(this.id);

    const status = await this.status();
    if (!status.pageReady) throw new PageUnavailableError(this.id, status.detail ?? '页面未就绪');
    if (!this.usable(status)) throw new PageUnavailableError(this.id, status.detail ?? '未登录');

    const requestId = randomUUID();
    this.inFlight.add(requestId);
    try {
      // Taken before the question: a site that never puts the id in its address
      // bar (Kimi) is identified by the row its sidebar gains, and that only
      // works against a list from before the ask.
      const baseline = await this.spec.adapter.threadCandidates();
      const { snapshotBefore } = await this.spec.adapter.sendMessage(input.question, requestId);
      const text = await this.spec.adapter.waitForAnswer(
        requestId,
        snapshotBefore,
        // Long enough for a slow page, short enough that a broken one becomes a
        // visible failure instead of a conversation that never settles.
        //
        // Ninety seconds used to be the number, and it was measured against a
        // plain chat answer. A page that decides to search the web first spends
        // that long collecting sources before it writes a word: a real DeepSeek
        // answer that opened thirteen pages finished well after the old limit,
        // so the app declared failure while the answer was still being written.
        // Three minutes covers a search-backed answer and still ends.
        input.timeoutMs ?? this.spec.timeoutMs ?? 180_000,
        input.question
      );
      const threadUrl = (await this.spec.adapter.settledUrl(baseline, input.question)) || undefined;
      // Kept for the next reset: starting a new conversation has to prove it
      // left *this* address, and that is the one signal which does not depend
      // on how the site happens to render its messages today.
      if (threadUrl) this.lastThreadUrl = threadUrl;
      // 读引用链接放在答案之后：它只补来源元数据，读不到就是没有，
      // 不影响这次回答已经成立。走同一个 `assistant` 选择器，所以
      // 「能读到答案、读不到链接」只说明链接真的不存在。
      const citations = await this.spec.adapter.citations();
      const digest = citations
        ? digestCitations(
            citations.links.map(link => ({
              url: link.url,
              anchorText: link.text,
              title: link.title || citations.title,
              pageUrl: citations.url,
              sourceId: this.id,
              fetchedAt: Date.now()
            })),
            { cap: 12, pageUrl: citations.url, sourceId: this.id, now: Date.now() }
          )
        : null;
      return {
        agentId: this.id,
        text,
        receivedAt: Date.now(),
        // Read after the answer, because that is when the site has settled on a
        // thread id. Deleting the conversation later needs exactly this address
        // to find the row again.
        threadUrl,
        ...(digest && digest.citations.length > 0 ? { citations: digest.citations } : {}),
        ...(citations?.url ? { pageUrl: citations.url } : {}),
        attribution: { requestId, note: '气泡增量 + 连续三次稳定' }
      };
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  /**
   * Start a new chat on the page.
   *
   * Never throws: the caller has to be able to ask the question anyway, and a
   * page that cannot reset is a fact to display, not a reason to lose the
   * answer. The detail says which of the two things happened.
   */
  async newConversation(): Promise<NewSessionResult> {
    try {
      const result = await this.spec.adapter.newConversation(this.lastThreadUrl || undefined);
      return result.ok ? { ok: true } : { ok: false, detail: result.detail ?? '未能开新会话' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Delete this conversation on the site itself.
   *
   * The page may currently be showing something else entirely — another
   * conversation, or the new-chat screen — which is why the address is passed
   * in rather than read from the page. Never throws: the local row is already
   * gone by the time this is called, and the detail is what the user needs in
   * order to remove it by hand.
   */
  async deleteConversation(threadUrl: string): Promise<DeleteThreadResult> {
    try {
      return await this.spec.adapter.deleteConversation(threadUrl);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  cancel(requestId: string): void {
    this.spec.adapter.cancelWait(requestId);
  }
  cancelAll(): void {
    for (const requestId of this.inFlight) this.spec.adapter.cancelWait(requestId);
    this.inFlight.clear();
  }
}
