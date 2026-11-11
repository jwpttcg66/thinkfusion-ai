import type { SelectorProfile } from '../../../shared/selectors';
import type { ProviderProfile } from './types';

/**
 * Gemini's chat page: everything a driver needs to know about `gemini.google.com`.
 *
 * Four things here were measured against the live page rather than guessed, and
 * each of them costs a round trip to rediscover:
 *
 * 1. **The composer is a Quill editor, not a plain contenteditable.**
 *    `<rich-textarea>` wraps `div.ql-editor[contenteditable="true"]`. Targeting
 *    the wrapper fails the fill path (it is a custom element with no editable
 *    surface), so the selector names `.ql-editor` and keeps the wrapper only as
 *    a last resort.
 *
 * 2. **The send control does not exist until there is text.** On an idle page
 *    the toolbar holds 「上传和工具」and 「语音输入」 and nothing else; the
 *    moment the composer has a character, a `button[aria-label="发送"]`
 *    appears in their place. That is why `hasSendButton` is false on a fresh
 *    page and why the driver's Enter path — not the click — is the primary one
 *    here. Measured: `button.type` is `submit`, so a click is still valid when
 *    text is present.
 *
 * 3. **The label is localised.** `?hl=zh` gives 「发送」, the default gives
 *    「Send」. Both are listed, and the unlabelled `button.send-button` stays as
 *    the fallback for a third locale — a send list with only one language on it
 *    turns "the user changed their site language" into "the app stopped
 *    working".
 *
 * 4. **A new chat is called 「reset」.** The control carries
 *    `data-test-id="reset-button"` (both the sidebar row and the collapsed
 *    icon button), which is the kind of promise the site keeps across
 *    redesigns — unlike the class names in this file.
 */

const GEMINI_HOSTS: ReadonlySet<string> = new Set([
  'gemini.google.com',
  // Sign-in. Google's account flow never leaves its own hosts, but it does
  // leave gemini.google.com, and a view that cannot reach the IdP cannot log in
  // at all — which is the state this channel starts in.
  'accounts.google.com',
  'consent.google.com',
  'myaccount.google.com',
  'ogs.google.com',
  'www.google.com'
]);

const GEMINI_SELECTORS: SelectorProfile = {
  input: [
    // The editor itself. `rich-textarea` is only the wrapper.
    'rich-textarea div.ql-editor[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div.text-input-field_textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'rich-textarea'
  ],
  sendButton: [
    'button[aria-label="发送"]',
    'button[aria-label="Send"]',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button.send-button'
  ],
  stopButton: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
  newChatButton: [
    '[data-test-id="reset-button"]',
    'a[data-test-id="new-chat-button"]',
    'button[aria-label*="新对话"]',
    'button[aria-label*="New chat"]'
  ],
  /**
   * One element per answer.
   *
   * `model-response` is Gemini's own custom element per turn — one per reply,
   * not one per markdown block, which is what "a new answer appeared" needs
   * counted. `message-content` is the inner renderer and is kept as the
   * fallback for a page that has not yet upgraded the outer element.
   */
  assistant: ['model-response', 'model-response message-content', '.model-response-text'],
  passwordField: ['input[type="password"]']
};

/**
 * What to cut out of an answer bubble.
 *
 * Gemini renders its thinking in a `model-thoughts` element *inside* the same
 * `model-response`, so `innerText` on the bubble returns the trace followed by
 * the reply. Cutting is guarded by "does the selector match anything", so on a
 * reply with no thinking panel these entries cost nothing.
 */
const GEMINI_REASONING = ['model-thoughts', '.thoughts', '.thoughts-content'];

/**
 * How this page says "you are not signed in".
 *
 * Signed out, Gemini is still usable: the composer takes a question and the
 * answer comes back. What is missing is everything that needs an account —
 * history, and the heavier models behind 「登录 解锁更多使用权限」. So this is a
 * hint, not a gate: the status says the page works and that signing in unlocks
 * the rest.
 *
 * Measured on a clean profile (`gemini.google.com/app?hl=zh`, no cookies): the
 * only visible sign-in affordance is a plain `<button>登录</button>` inside a
 * `gem-button`, with no `data-test-id` and no `aria-label`. So the label is what
 * is matched — see `GEMINI_SIGNED_OUT_TEXT` — and this selector list is left for
 * the sidebar row, which exists but is hidden behind the collapsed nav.
 *
 * `[data-test-id="signed-out-disclaimer"]` used to be listed here and is *not*:
 * measured on the same page, that element is the terms-and-privacy paragraph
 * （「须遵守《Google 条款》…」）, and it stays on screen after signing in. It
 * reported 未登录 for an account that was logged in — a channel described as
 * something it is not, which is the one thing a status must never do.
 */
const GEMINI_SIGNED_OUT = ['[data-test-id="sidenav-error-action-link"]'];

/**
 * The label on that button, in the two languages the app is used in.
 *
 * Exact match, and only on controls: the same characters appear inside the
 * sidebar's 「登录即可保存活动记录」 sentence, which is a hint rather than a
 * button and would otherwise be counted twice.
 */
const GEMINI_SIGNED_OUT_TEXT = ['登录', 'Sign in'];

/**
 * The other shape of "not signed in": a redirect instead of a guest page.
 *
 * Measured twice on clean profiles minutes apart — `/app` sometimes answers
 * with a working guest page, sometimes with `/signin?continue=…`. The redirect
 * has no composer, so without this it reads as a broken profile.
 */
const GEMINI_SIGNED_OUT_PATHS = ['/signin'];

export const GEMINI_PROFILE: ProviderProfile = {
  id: 'gemini',
  label: 'Gemini',
  selectors: GEMINI_SELECTORS,
  hosts: GEMINI_HOSTS,
  /** 提问气泡：Gemini 自己的 <user-query>。 */
  user: ['user-query', 'user-query .query-text', '.query-text'],
  reasoning: GEMINI_REASONING,
  signedOut: GEMINI_SIGNED_OUT,
  signedOutText: GEMINI_SIGNED_OUT_TEXT,
  signedOutPaths: GEMINI_SIGNED_OUT_PATHS,
  // Measured: signed out, a question typed into this page came back as "18" in
  // one `model-response` turn. The account buys history and the heavier models,
  // not the ability to ask.
  guestUsable: true
};
