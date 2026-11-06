import type { SelectorProfile } from '../../../shared/selectors';
import type { ProviderProfile } from './types';

/**
 * ChatGPT's markup, as a selector profile.
 *
 * The probe already falls back to structure when selectors miss, so this is an
 * optimisation rather than a requirement: `#prompt-textarea` and
 * `[data-testid="send-button"]` are exact and stable, and using them stops the
 * "bottom-most editable field" heuristic from picking a sidebar search box.
 *
 * Everything site-specific about a provider is this file plus its host list.
 * Nothing above the adapter layer knows either exists — the agent that speaks
 * for ChatGPT is a `ProviderSubAgent` like any other, and it would not notice if
 * this profile were replaced by a different one tomorrow.
 */
export const CHATGPT_HOSTS: ReadonlySet<string> = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'chat.openai.com'
]);

export const CHATGPT_SELECTORS: SelectorProfile = {
  input: [
    '#prompt-textarea',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[data-id]',
    'textarea'
  ],
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[data-testid*="send"]'
  ],
  stopButton: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
  newChatButton: [
    '[data-testid="create-new-chat-button"]',
    'a[data-testid="create-new-chat-button"]',
    'button[aria-label*="New chat"]',
    'a[aria-label*="New chat"]',
    'a[href="/"][aria-label]'
  ],
  assistant: ['[data-message-author-role="assistant"]', 'article .markdown', '[class*="markdown"]'],
  passwordField: ['input[type="password"]']
};

export const CHATGPT_PROFILE: ProviderProfile = {
  id: 'chatgpt',
  label: 'ChatGPT',
  selectors: CHATGPT_SELECTORS,
  hosts: CHATGPT_HOSTS,
  /**
   * 实测截图（2026-11-06）：一条横幅，标题「上下文窗口已达上限」，正文讲
   * 「开启新聊天，并带入自动生成的当前对话摘要；或升级套餐…」，下面两个按钮
   * 「新聊天」「升级至 Go」。
   *
   * 只收标题这一句。正文那句「继续当前对话」出现在回答里也说得通，标题这种
   * 短断言不会——探测又是按「短块」判的，所以取窄不取宽。
   */
  contextLimit: ['上下文窗口已达上限', '上下文长度已达上限', 'context window is full', 'context limit reached']
};
