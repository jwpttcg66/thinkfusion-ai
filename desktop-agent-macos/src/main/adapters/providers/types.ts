import type { SelectorProfile } from '../../../shared/selectors';

/**
 * What one AI site needs in order to be driven.
 *
 * This is the whole per-site surface: a name, the markup guesses, and the exact
 * hosts it is allowed to be. Everything else — the probe, the send path, waiting
 * for an answer, stripping our own echoed prompt — is shared, which is why
 * adding a site is a file in this directory rather than a fork of the driver.
 *
 * What it is deliberately *not*: an agent. A profile has no identity in a
 * research round, no session, and no opinion; the agent that speaks for this
 * site is a `ProviderSubAgent` built on top of it. Keeping the two apart is what
 * lets a site be swapped without changing who said what.
 */
export interface ProviderProfile {
  /** Stable id, shared with the source store and the message records. */
  id: string;
  label: string;
  /** Built-in selectors. A learned profile is merged on top of these at call time. */
  selectors: SelectorProfile;
  /** Exact hosts, never suffixes: `chat.deepseek.com.evil.test` must not match. */
  hosts: ReadonlySet<string>;
  /**
   * Subtrees that are part of the assistant's message but are not the answer.
   *
   * The reasoning trace is the reason this exists. A site that shows "thinking"
   * inline puts it in the same bubble as the reply, so `innerText` on the bubble
   * returns the model talking to itself followed by the answer — and that trace
   * would then be shipped to the synthesiser as if the site had said it. The
   * prose has to be separable without knowing the site's class names, so a
   * profile lists what to cut instead.
   *
   * Cutting is a last resort, never the first: if removing these leaves nothing,
   * the untrimmed text is used, because a noisy answer still beats no answer.
   */
  reasoning?: readonly string[];
  /**
   * Subtrees that only exist while the site considers you signed out.
   *
   * Not the same thing as a password field. A site that keeps its composer
   * usable for guests (Gemini does) has no password field when signed out, so
   * "no password field" reads as logged in — and the failure is an answer that
   * never comes. Listing the site's own sign-in control is the only honest
   * signal, and it has to be exact: 「登录」 also labels a sidebar row for an
   * account that is already signed in.
   */
  signedOut?: readonly string[];
  /**
   * The words the site puts on its sign-in control, when that control has no
   * hook to select it by.
   *
   * Gemini is the case: measured on the guest page, the only visible sign-in
   * affordance is `<button class="mdc-button …">登录</button>` — no
   * `data-test-id`, no `aria-label`, nothing stable to query. The one hook that
   * *looked* right, `[data-test-id="signed-out-disclaimer"]`, turned out to be
   * the terms-and-privacy paragraph, which stays on screen after you sign in —
   * so it reported 未登录 for an account that was logged in.
   *
   * Matching is exact and limited to controls, so the same word inside a
   * sentence ("登录以保存活动记录") does not count.
   */
  signedOutText?: readonly string[];
  /**
   * Paths that mean the site has taken the page into its sign-in flow.
   *
   * The second shape of the same state. Gemini answers a request for `/app`
   * with either a usable signed-out page or a redirect to `/signin?continue=…`,
   * depending on how it feels about the session — measured both, on clean
   * profiles, minutes apart. The redirect has no composer at all, so without
   * this the status reads "未找到输入框，页面结构可能已变化" over a page that is
   * working exactly as designed.
   *
   * Paths only, no domains: the host has already been checked against `hosts`.
   */
  signedOutPaths?: readonly string[];
  /**
   * The site's own words for 「this conversation is out of context」.
   *
   * A chat site stops accepting questions in a thread once the context window
   * is full, and it says so with a banner. That banner is not an answer, and
   * re-asking into the same thread can only fail again — the only way forward
   * is a fresh thread. Knowing the wording is what lets the driver tell that
   * state apart from an ordinary quiet page.
   *
   * Declared per site because it is copy, not markup, and every site writes its
   * own. Only listed where it has actually been seen: a guessed phrase is worse
   * than none, because it can match an answer that merely discusses the topic.
   */
  contextLimit?: readonly string[];
  /**
   * Can the page still answer while signed out?
   *
   * False for every channel that treats a signed-out session as a dead end —
   * ChatGPT and Kimi stop working, DeepSeek redirects to its sign-in page. True
   * only for Gemini, which answers guests and reserves just the history and the
   * heavier models for an account: calling that unusable would drop a channel
   * that answers, so the sign-in state becomes a hint instead of a gate.
   */
  guestUsable?: boolean;
  /**
   * 站点自己弹出来的纯提示层上，「我知道了」这类关闭按钮的**精确文案**。
   *
   * 和 `signedOut` 不是一回事：登录着也会弹，例如 Kimi 在排队高峰弹出
   * 「和Kimi聊天的人太多了，订阅会员可进入优先队列」。这层 `.modal-mask`
   * 盖住整页，输入框照样能写字、发送键照样是亮的，但点下去什么也不发生——
   * 真机上表现为「三家问了，两家回答，Kimi 白等 180 秒」，而应用侧只看到
   * 输入框里原话还在，报一个看不出原因的 ANSWER_TIMEOUT。
   *
   * 只在「页面上有可见的 modal/mask/dialog」且按钮文案**完全相等**时才点，
   * 避免误关别的东西。关闭纯提示不触碰账号、不触碰历史会话，也不需要用户
   * 介入；这正是用户会自己点的那一下。
   */
  dismissText?: readonly string[];
  /**
   * 路径前缀：站点把页面转到这些地址，就等于「这一问不会被接受」。
   *
   * 2026-11-07 真机实测，Kimi 在排队高峰把提问直接转到
   * `/membership/pricing?from=paywall_unknown`：登录态还在、账号没错，但页面
   * 连输入框都没有了。不认这个状态，驱动会照常填字、点发送、按回车、再点，
   * 20 秒后报「SEND_UNCONFIRMED（输入框仍保留 35 字）」，或者干脆白等 180 秒
   * 报 ANSWER_TIMEOUT——用户看到的都是「又失败了」，真正的原因（站点要求会员
   * 或正在排队）一个字也没有。认出来就该立刻停，并把这句话原样告诉用户。
   *
   * 和 `signedOutPaths` 分开：那个是「没登录」，这个是「登录了也用不了」，
   * 给出的出路完全不同。
   */
  blockedPaths?: readonly string[];
}
