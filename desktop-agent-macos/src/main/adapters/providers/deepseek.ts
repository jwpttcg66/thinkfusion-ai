import type { SelectorProfile } from '../../../shared/selectors';
import type { ProviderProfile } from './types';

/**
 * DeepSeek's chat page: the markup, and the only host it is allowed to be.
 *
 * The selectors were tuned against this page first, which is why the generic
 * driver's structural fallbacks are shaped the way they are — but they are this
 * site's guess, not a universal truth, so they live here rather than in the
 * driver. A second site is a second file in this directory and nothing else.
 */

import { isAllowedHostUrl } from '../browser/page-driver';
/**
 * All DOM knowledge lives in this one place.
 *
 * Ordered most specific first; the first list with a visible hit wins. Every
 * list is a guess about markup we do not own, so each role also has a
 * structural fallback in the probe script — the selectors decide *which* node
 * when they match, the fallback keeps the app working when they do not.
 *
 * Stop-button selectors are deliberately narrow: a broad `[class*="stop"]`
 * matches chrome that is always present, which would report "generating"
 * forever. Generation state is advisory anyway (see `waitForAnswer`), so a
 * missing stop button must never break the loop.
 */
export const DEEPSEEK_SELECTORS: SelectorProfile = {
  input: [
    '#chat-input',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
    'textarea'
  ],
  sendButton: [
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'div[role="button"][aria-label*="发送"]',
    '[data-testid*="send"]',
    'button[type="submit"]'
  ],
  stopButton: [
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop"]',
    '[aria-label*="停止生成"]',
    '[title*="停止"]'
  ],
  /**
   * The "start a new chat" control.
   *
   * Kept apart from `sendButton` because it is a navigation, not a submission:
   * a wrong guess here throws away the conversation the user is reading, and a
   * wrong guess in the send list merely fails to send. The script therefore
   * only clicks something it can identify by label or by an exact text match.
   */
  newChatButton: [
    'button[aria-label*="新对话"]',
    'a[aria-label*="新对话"]',
    '[role="button"][aria-label*="新对话"]',
    '[aria-label*="New chat"]',
    'button[class*="new-chat"]',
    'a[class*="new-chat"]'
  ],
  assistant: ['[data-message-author-role="assistant"]', '.ds-markdown', '[class*="markdown"]'],
  passwordField: ['input[type="password"]']
};

/** Exact host, never a suffix: `chat.deepseek.com.evil.test` must not match. */
export const DEEPSEEK_HOSTS: ReadonlySet<string> = new Set(['chat.deepseek.com']);

/**
 * How this page says "you are not signed in".
 *
 * Measured: asking for `/` while signed out lands on `/sign_in`, which has no
 * composer and no password field until the 密码登录 tab is clicked. Without this
 * the page was described as 已登录 with 「未找到输入框，页面结构可能已变化」 —
 * two wrong statements at once, about a page that was working exactly as
 * designed. The path is the only signal that is true before anything is typed.
 */
const DEEPSEEK_SIGNED_OUT_PATHS = ['/sign_in'];

export const DEEPSEEK_PROFILE: ProviderProfile = {
  id: 'deepseek',
  label: 'DeepSeek',
  selectors: DEEPSEEK_SELECTORS,
  hosts: DEEPSEEK_HOSTS,
  /** 提问气泡（保存对话时排序用）；站点没暴露就只列回答。 */
  user: ['[data-message-author-role="user"]', '.ds-message-user', '[class*="user-message"]'],
  signedOutPaths: DEEPSEEK_SIGNED_OUT_PATHS,
  // 2026-11-07 真机：连续提问后出现点图验证，页面上写的是
  // 「点击图中最小的蓝色三棱柱」，换一次会换成红色/圆柱体。
  challengeText: ['点击图中最', '请完成安全验证', '拖动滑块', '验证你是人类']
};

export function isAllowedDeepSeekUrl(raw: string): boolean {
  return isAllowedHostUrl(raw, DEEPSEEK_HOSTS);
}
