import { randomUUID } from 'node:crypto';
import { digestCitations } from '../../../shared/evidence';
import type { ChatPageDriver } from './page-driver';
import { ContextLimitError } from './page-driver';
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
        // 上下文满不是不可用：页面的输入框还在，换一条会话就能答。但这是一件
        // 用户看得见的事实（下一条问题会落到一条新会话里），所以如实报上去。
        contextFull: status.contextFull === true,
        // 未登录且站点不给访客用：页面自己的说明写的是「仍可使用」（那是给
        // Gemini 那种访客可用的站点的），放在这里会让人以为还能问。
        detail:
          !status.loggedIn && this.spec.guestUsable !== true
            ? `${this.label} 未登录：在右侧这条通道的页面里登录一次`
            : status.detail
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        loggedIn: false,
        pageReady: false,
        generating: false,
        contextFull: false,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async ask(input: AdapterAsk): Promise<AdapterAnswer> {
    if (this.inFlight.size > 0) throw new PageBusyError(this.id);

    const status = await this.status();
    if (!status.pageReady) throw new PageUnavailableError(this.id, status.detail ?? '页面未就绪');
    // 未登录且这个站点不给访客用（Kimi 就是这样：输入框还在、发送键还亮着，
    // 字也写得进去，点了却什么都不会发生）。状态里那句「仍可使用」是写给
    // Gemini 这种访客可用的站点的，放在这里会把人引到错误的方向——真正该做的
    // 只有一件事：在这条通道的页面里登录一次。
    if (!this.usable(status)) {
      throw new PageUnavailableError(
        this.id,
        status.loggedIn
          ? (status.detail ?? '页面未就绪')
          : `${this.label} 未登录：先在右侧这条通道的页面里登录一次，再问。`
      );
    }

    const requestId = randomUUID();
    this.inFlight.add(requestId);
    try {
      // 站点自己说过这条会话装不下更多上下文了（ChatGPT 的「上下文窗口已达
      // 上限」）。它不会把输入框拿走，只会把这一问退回来——所以先换一条会话，
      // 再问。留在原会话里问，等来的只有同一面墙。
      let note = '';
      if (status.contextFull === true) note = await this.resetThread();

      try {
        return await this.askOnce(input, requestId, note);
      } catch (error) {
        if (!(error instanceof ContextLimitError)) throw error;

        // 横幅是发送之后才出现的：站点在服务端把这一问退了回来，页面从头到尾
        // 没有给出回答。同一条会话再发一次只会再退一次，所以换会话重问一次。
        // 只重一次——第二次还满，就是真的满了，如实失败。
        note = await this.resetThread();
        const retried = randomUUID();
        this.inFlight.add(retried);
        try {
          return await this.askOnce(input, retried, note);
        } finally {
          this.inFlight.delete(retried);
        }
      }
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  /**
   * 换一条会话，换不了就当场说清楚。
   *
   * 这里不吞失败。会话满的时候「就在这条会话里继续问」不是一个选择：它只会
   * 再撞一次同一面墙，然后以三分钟超时收场，而真正的原因在这一步就已经知道
   * 了。所以宁愿现在告诉用户：会话满了，自动开新会话也没成功，请手动点一次。
   */
  private async resetThread(): Promise<string> {
    const result = await this.newConversation();
    if (!result.ok) {
      throw new PageUnavailableError(
        this.id,
        `${this.label} 这条会话的上下文已满，自动开新会话也没成功（${result.detail ?? '原因未知'}）。` +
          '在右侧页面点一次「新对话」，再问一次。'
      );
    }
    // 换会话之后原来的地址不再是我们回答过的地方，留着只会在下一次重置时
    // 拿一条过期地址去比对。
    this.lastThreadUrl = '';
    return '上下文已满，已自动开新会话后重问';
  }

  /** One attempt: ask in whatever thread the page is on now, and read the answer. */
  private async askOnce(
    input: AdapterAsk,
    requestId: string,
    note: string
  ): Promise<AdapterAnswer> {
    // Taken before the question: a site that never puts the id in its address
    // bar (Kimi) is identified by the row its sidebar gains, and that only
    // works against a list from before the ask.
    const baseline = await this.spec.adapter.threadCandidates();
    const { snapshotBefore } = await this.spec.adapter.sendMessage(input.question, requestId);
    let firstTokenAt: number | undefined;
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
      input.question,
      at => { firstTokenAt = at; },
      input.onPartial
    );
    const threadUrl = (await this.spec.adapter.settledUrl(baseline, input.question)) || undefined;
    // Kept for the next reset: starting a new conversation has to prove it
    // left *this* address, and that is the one signal which does not depend
    // on how the site happens to render its messages today.
    if (threadUrl) this.lastThreadUrl = threadUrl;
    // 读引用链接放在答案之后：它只补来源元数据，读不到就是没有，
    // 不影响这次回答已经成立。走同一个 `assistant` 选择器，所以
    // 「能读到答案、读不到链接」只说明链接真的不存在。
    // 可选调用：测试里的脚本化驱动没有 DOM，也就没有这一步。
    const citations = await this.spec.adapter.citations?.();
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
      ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
      // Read after the answer, because that is when the site has settled on a
      // thread id. Deleting the conversation later needs exactly this address
      // to find the row again.
      threadUrl,
      ...(digest && digest.citations.length > 0 ? { citations: digest.citations } : {}),
      ...(citations?.url ? { pageUrl: citations.url } : {}),
      attribution: {
        requestId,
        note: note ? `${note}；气泡增量 + 连续三次稳定` : '气泡增量 + 连续三次稳定'
      }
    };
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
