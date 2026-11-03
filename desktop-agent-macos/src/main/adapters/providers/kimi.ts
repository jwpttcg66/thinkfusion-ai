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
  reasoning: KIMI_REASONING
};
