import { SELECTORS } from '../deepseek-adapter';

/**
 * ChatGPT's markup, as a selector profile.
 *
 * The probe already falls back to structure when selectors miss, so this is an
 * optimisation rather than a requirement: `#prompt-textarea` and
 * `[data-testid="send-button"]` are exact and stable, and using them stops the
 * "bottom-most editable field" heuristic from picking a sidebar search box.
 *
 * Everything site-specific about a channel is this file plus its host list.
 * Nothing above the channel layer knows either exists.
 */
export const CHATGPT_HOSTS: ReadonlySet<string> = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'chat.openai.com'
]);

export const CHATGPT_SELECTORS: typeof SELECTORS = {
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
