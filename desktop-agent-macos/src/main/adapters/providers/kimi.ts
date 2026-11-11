import type { SelectorProfile } from '../../../shared/selectors';
import type { ProviderProfile } from './types';

/**
 * Kimi's chat page: everything a driver needs to know about `kimi.com`.
 *
 * Two things here are shaped by the page rather than by preference, and both
 * cost a round trip to discover:
 *
 * 1. **The send control is a `div`, not a `button`.** It carries no `role`, no
 *    `aria-label` and no `data-testid` — its whole identity is the class
 *    `send-button-container`. Every generic heuristic looks for a button, so on
 *    this page the structural fallback would find the composer toolbar's upload
 *    control first and click that instead. Measured live: the fallback picks
 *    `toolkit-trigger-btn` (「上传文件」).
 *
 * 2. **The same element becomes the stop control while it generates**, by
 *    gaining the class `stop` (`send-button-container disabled stop`). That is
 *    why the send list excludes `.stop`: clicking a stop button does not send
 *    anything, and the driver would report a submit that never happened.
 *
 * The composer is a Lexical editor (`data-lexical-editor="true"`), which accepts
 * `insertText` through `execCommand` exactly like a plain contenteditable — the
 * fill path needs no special case for it.
 */

const KIMI_HOSTS: ReadonlySet<string> = new Set([
  'kimi.com',
  'www.kimi.com',
  'kimi.moonshot.cn'
]);

const KIMI_SELECTORS: SelectorProfile = {
  input: [
    'div.chat-input-editor[contenteditable="true"]',
    '.chat-input-editor[role="textbox"]',
    '.chat-input-editor',
    'div[contenteditable="true"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"]'
  ],
  sendButton: [
    // Generation state is a class on the same node, so the send list must say
    // what it is *not*. Without `:not(.stop)` a click during an answer would be
    // reported as "sent" while the page was actually asked to stop.
    '.send-button-container:not(.stop)',
    // Kept as a cheaper future-proofing: if Kimi ever labels the control, this
    // starts matching and the class-based guess stops being load-bearing.
    'button[aria-label*="发送"]',
    '[aria-label*="发送"]'
  ],
  stopButton: ['.send-button-container.stop'],
  newChatButton: [
    'a[data-testid="sidebar-new-chat"]',
    'a.new-chat-btn',
    'a[aria-label*="新建会话"]',
    '[aria-label*="新建会话"]'
  ],
  /**
   * One element per answer — the whole bubble, not its markdown parts.
   *
   * Counting by bubble is what makes "a new answer appeared" reliable: a single
   * reply can contain several markdown blocks (one before a tool call, one
   * after), and counting those would both over-count messages and hand the
   * driver only the last fragment. The reasoning is cut separately, below.
   */
  assistant: ['.chat-content-item-assistant', 'div.segment.segment-assistant'],
  passwordField: ['input[type="password"]']
};

/**
 * What to cut out of an answer bubble.
 *
 * `.toolcall-flow` holds the "思考已完成" panel and the tool-call summary;
 * the tail is a layout spacer, and the actions row is the copy/share buttons.
 * What remains is the reply itself (verified live: bubble text goes from
 * 「思考已完成 / 用户要求只回答一个数字… / 2」 to「2」).
 */
const KIMI_REASONING = ['.toolcall-flow', '.toolcall-rollup__tail', '.segment-assistant-actions'];

export const KIMI_PROFILE: ProviderProfile = {
  id: 'kimi',
  label: 'Kimi',
  selectors: KIMI_SELECTORS,
  hosts: KIMI_HOSTS,
  /** 提问气泡；站点改版时匹配不到就只列回答。 */
  user: ['.chat-content-item-user', '[class*="chat-content-item-user"]'],
  reasoning: KIMI_REASONING,
  /**
   * 未登录的三个现场，全部实测过：
   *
   * 1. `.login-button`（侧栏底部「登录」）；
   * 2. `.next-sidebar-history-list__login`（「登录以同步历史会话」）；
   * 3. `.login-modal-next-mask`（点发送时弹出来的手机号登录层）。
   *
   * 为什么必须认出来：Kimi 未登录时**输入框和发送键都还在、键还是亮的**，字也
   * 能写进去，但点了没有任何反应——页面什么都没发生，字还留在框里。不认这个
   * 状态，界面就会把这条通道当成「已登录、页面就绪」照常去问：填字、点发送、
   * 按回车、再点一次，二十秒后报「SEND_UNCONFIRMED（输入框仍保留 N 字）」，
   * 真正的原因（这条通道要重新登录）一个字都没有。实测两次，用户看到的就是
   * 「又失败了」。
   *
   * 弹层关着时要么不在 DOM 里、要么量出来 0×0，探针的可见性判断会把它排除；
   * 登录着时前两个也从渲染里消失，所以不会误报。
   */
  signedOut: [
    '.login-modal-next-mask',
    'button.login-button',
    '.next-sidebar-history-list__login'
  ],
  /**
   * 已登录状态下的排队提示，2026-11-07 真机实测：
   *
   * 页面弹出 `.modal-mask` + `.modal-container`，正文是「和Kimi聊天的人太多了，
   * 订阅会员可进入优先队列」，两个按钮「我知道了」「去升级」。这层盖住整页：
   * 输入框能写、发送键亮着，但点击被吃掉，原话一直留在框里。那一轮三家通道
   * 都问了，只有 Gemini / ChatGPT 回答，Kimi 白等 180 秒后报 ANSWER_TIMEOUT，
   * 失败理由里一个字都没提到弹层。点一下「我知道了」后遮罩消失，发送键正常。
   *
   * 只关纯提示，不点「去升级」——那会把用户带进付费流程。
   */
  dismissText: ['我知道了'],
  /**
   * 排队高峰时站点直接把提问转到付费页，2026-11-07 真机连测三轮都是这个地址：
   * `https://www.kimi.com/membership/pricing?from=paywall_unknown`。
   * 这时页面连输入框都没有，任何发送尝试都注定失败；必须先说清楚是站点
   * 要求会员/正在排队，而不是让用户对着「发送未确认」猜。
   */
  blockedPaths: ['/membership/pricing']
};
