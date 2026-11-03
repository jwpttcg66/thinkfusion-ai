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
  hosts: CHATGPT_HOSTS
};
