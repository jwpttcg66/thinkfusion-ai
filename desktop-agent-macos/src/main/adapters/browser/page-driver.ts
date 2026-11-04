import type { WebContentsView } from 'electron';
import type { DeepSeekDiagnostics, DeepSeekStatus, PageDiagnostics } from '../../../shared/contracts';

/**
 * Everything the adapter can say about the page.
 *
 * Deliberately not the whole `DeepSeekDiagnostics`: where the native view sits
 * is a fact about the window, not about the page, so the main process adds it.
 * Keeping the boundary here means the adapter never needs to know that a
 * `WebContentsView` exists.
 */
export type PageReport = Omit<DeepSeekDiagnostics, 'view' | 'dragging'>;
import { stripEcho, containsEcho, findIgnoringWhitespace } from '../../../shared/protocol';
import { cutSpeakerLabels, normalizeAnswerText, stripChrome } from '../../../shared/text';
import type { DiscoveredSelectors, SelectorProfile } from '../../../shared/selectors';

/**
 * Exact-host allow-list check.
 *
 * Exact, not suffix: `evil-chat.deepseek.com` ends with `deepseek.com` and is
 * not the site we mean. The same helper now backs every channel, because the
 * second site made "which host is this page allowed to be" a per-channel fact
 * rather than a constant.
 */
export function isAllowedHostUrl(raw: string, hosts: ReadonlySet<string>): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && hosts.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Does this URL sit under one of the site's sign-in routes?
 *
 * Path prefixes, not full matches: Gemini redirects to `/signin?continue=…`, so
 * the query is part of the address and the pathname is what is stable. The
 * prefix is matched on a segment boundary (`/signin` must not match
 * `/signinfo`), which is why the comparison is not a bare `startsWith`.
 */
function isUnderPath(raw: string, prefix: string): boolean {
  try {
    const path = new URL(raw).pathname.replace(/\/+$/, '');
    const base = prefix.replace(/\/+$/, '');
    return path === base || path.startsWith(`${base}/`);
  } catch {
    return false;
  }
}

/**
 * Bumped whenever the probe changes shape, so a stale report is identifiable.
 *
 * 5: the probe also reports `signedOut` — the site's own "you are a guest"
 * marker, which a password field does not cover.
 * 6: `signedOut` can also come from the text of the site's sign-in control,
 * and the probe is readable while the page is still loading.
 * 7: the transcript is read from the tallest scrollable container that holds
 * the composer, so a sidebar cannot be mistaken for an answer.
 */
export const PROBE_VERSION = '7';

/**
 * Shortest tail considered an answer while the page is still generating.
 *
 * Known furniture is removed by name (`stripChrome`), so this is only the
 * second guard. It applies while the page says it is still working, where a
 * short string is a status line ("思考中") rather than a result. Once the page
 * has stopped, the tail is whatever it left there.
 */
const MIN_TAIL_CHARS = 24;


export interface MessageSnapshot {
  messageCount: number;
  lastText: string;
  url: string;
  capturedAt: number;
  /** Page text with the composer removed: the cheapest reliable change signal. */
  conversationText: string;
  composerText: string;
}

/** One row of a site's conversation list, as the page draws it. */
export interface ThreadCandidate {
  href: string;
  title: string;
}

export interface PageProbe {
  url: string;
  title: string;
  /** Layout size of the page. Zero means the view was never given a real box. */
  viewportWidth: number;
  viewportHeight: number;
  hasPasswordField: boolean;
  /**
   * The page is showing its own 「登录」 call to action.
   *
   * A password field is not the only shape of "not signed in". Gemini lets you
   * type a question while signed out and then renders nothing at all — no
   * error, no prompt, an empty conversation. Without this flag the channel
   * reports `loggedIn: true` (there is no password field on that page) and the
   * only symptom is an answer that never arrives.
   */
  signedOut: boolean;
  hasInput: boolean;
  inputKind: string;
  hasSendButton: boolean;
  generating: boolean;
  messageCount: number;
  lastText: string;
  conversationText: string;
  composerText: string;
  selectorHits: Record<string, number>;
  chosen: Record<string, string>;
}

export interface SendOutcome {
  submitted: boolean;
  snapshotBefore: MessageSnapshot;
  method: string;
  signals: string[];
  waitedMs: number;
}

/**
 * Everything the adapter needs from a page, and nothing about Electron.
 *
 * The adapter's hard part is not the DOM, it is deciding *when* a page has
 * acknowledged a request and *which* text belongs to it. Those rules only fail
 * on timing, so they have to be runnable in a test with a scripted page —
 * which is why this seam exists instead of calling executeJavaScript inline.
 */
export interface PageDriver {
  url(): string;
  isDestroyed(): boolean;
  /**
   * Is the page still pulling resources?
   *
   * Needed because `executeJavaScript` is queued until the page stops loading —
   * a chat site whose analytics endpoint never answers leaves the page at
   * `readyState: "interactive"` for a minute, and every probe behind that queue
   * times out as "渲染进程可能卡住了" over a page that is drawing fine. Asking
   * the question up front turns that into a status that says what it is doing.
   */
  isLoading?(): boolean;
  probe(): Promise<PageProbe>;
  fill(text: string): Promise<{ ok: boolean; reason?: string; kind?: string }>;
  clickSend(): Promise<{ ok: boolean; reason?: string; label?: string }>;
  /**
   * Focus the composer and press a real Enter.
   *
   * Preferred over clicking: the page's send control is an unlabelled icon
   * button, and a wrong click silently changes the request instead of failing.
   */
  pressEnter(): Promise<void>;
  /**
   * Ask the page to start a new conversation, by clicking its own control.
   *
   * Optional, because a page whose markup offers no way to do it must still be
   * usable: a driver without this simply cannot reset, and the caller records
   * that the two sides drifted instead of refusing to ask.
   */
  newChat?(): Promise<{ ok: boolean; method?: string; reason?: string }>;
  /**
   * Navigate to the site root — a new conversation on every chat UI we drive.
   *
   * This is not a last resort. A collapsed sidebar has no new-chat control at
   * all (verified against chatgpt.com at a 599px pane), so for some pages this
   * is the *only* path. Slower than a click, and it is the one that cannot be
   * defeated by markup.
   */
  reloadHome?(): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Go to an address on this site, e.g. the thread a conversation was recorded
   * in. Used when the sidebar no longer lists that row without scrolling to it.
   */
  navigate?(url: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Delete a conversation from the site's own sidebar.
   *
   * Found by thread id, never by title. Declining is a valid answer: a page
   * with no sidebar (signed out) has nothing to delete from, and saying so is
   * better than clicking something that merely looks like a menu.
   */
  deleteChat?(threadUrl: string): Promise<{ ok: boolean; detail?: string }>;
  /**
   * Conversation links the page is listing right now (see `THREAD_LIST_SCRIPT`).
   *
   * Compared before and after an ask: the entry that was not there before is
   * the thread this conversation created. Never used as "the first row".
   */
  threadCandidates?(): Promise<ThreadCandidate[]>;
}

export const PROBE_SCRIPT = (
  selectors: SelectorProfile,
  reasoning: readonly string[] = [],
  signedOutSelectors: readonly string[] = [],
  signedOutText: readonly string[] = []
) => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const reasoning = ${JSON.stringify(reasoning)};
  const signedOutSelectors = ${JSON.stringify(signedOutSelectors)};
  const signedOutText = ${JSON.stringify(signedOutText)};

  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  const hits = {};
  const chosen = {};

  // First selector list that matches anything visible wins, and we record which
  // one it was: "the selector matched nothing" is the diagnosis we need most.
  const firstMatch = (role) => {
    const list = selectors[role] || [];
    for (const selector of list) {
      let nodes;
      try { nodes = [...document.querySelectorAll(selector)]; } catch { hits[role + ':' + selector] = -1; continue; }
      const hit = nodes.filter(visible);
      hits[role + ':' + selector] = hit.length;
      if (hit.length) {
        if (!chosen[role]) chosen[role] = selector;
        return hit;
      }
    }
    return [];
  };

  for (const role of Object.keys(selectors)) {
    for (const selector of selectors[role]) {
      if (hits[role + ':' + selector] !== undefined) continue;
      let count = 0;
      try { count = [...document.querySelectorAll(selector)].filter(visible).length; } catch { count = -1; }
      hits[role + ':' + selector] = count;
    }
  }

  const pickInput = () => {
    const matched = firstMatch('input');
    if (matched.length) return matched[matched.length - 1];
    // Structural fallback: the bottom-most editable field wide enough to be a
    // composer. Chat UIs put it at the bottom of the viewport, so this survives
    // a class rename that breaks every selector above.
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(visible)
      .filter((el) => el.getBoundingClientRect().width > 120)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    const hit = candidates[0];
    if (hit) chosen.input = 'structural:bottom-most-editable';
    return hit;
  };

  const composer = pickInput();

  const kindOf = (el) => {
    if (!el) return 'none';
    if (el instanceof HTMLTextAreaElement) return 'textarea';
    if (el instanceof HTMLInputElement) return 'input';
    if (el.getAttribute('contenteditable') === 'true') return 'contenteditable';
    return el.tagName.toLowerCase();
  };

  const composerText = composer
    ? (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : (composer.innerText || composer.textContent || ''))
    : '';

  const sendButtons = firstMatch('sendButton');
  let structuralSend = false;
  if (!sendButtons.length && composer) {
    // The send control is normally inside the composer's own toolbar; look up
    // the ancestor chain rather than guessing another class name.
    let scope = composer;
    for (let depth = 0; depth < 5 && scope; depth += 1) {
      scope = scope.parentElement;
      if (!scope) break;
      const buttons = [...scope.querySelectorAll('button, [role="button"]')].filter(visible);
      if (buttons.length) {
        hits['sendButton:structural'] = buttons.length;
        chosen.sendButton = 'structural:composer-toolbar';
        structuralSend = true;
        break;
      }
    }
  }

  const stopButtons = firstMatch('stopButton');

  // The site's own "you are not signed in" control. Declared by the profile,
  // never guessed: a 「登录」 label can also be a sidebar entry while logged in,
  // so only a hook the site reserves for the signed-out state belongs here.
  let signedOut = false;
  for (const selector of signedOutSelectors) {
    let nodes;
    try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
    if (nodes.some(visible)) { signedOut = true; break; }
  }

  // The same signal when the control has no hook to select it by: the site
  // labels its sign-in button 「登录」 (or 「Sign in」) and only shows it to
  // guests. Exact match on the control's own text, so a sentence that happens
  // to contain the word does not count.
  if (!signedOut && signedOutText.length) {
    const wanted = new Set(signedOutText);
    signedOut = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')].some(
      (el) => visible(el) && wanted.has((el.innerText || '').trim())
    );
  }

  // The answer, with the site's own noise cut out.
  //
  // A site that renders "thinking" inside the same bubble as the reply makes
  // innerText returns the model's reasoning followed by the answer, and that
  // trace is not something the site ever said to the user. The profile names the
  // subtrees to drop; nothing is guessed here.
  //
  // The clone has to be *visible* to measure: innerText on a
  // visibility:hidden subtree silently drops the very content we are trying
  // to keep (measured — the answer went from "2" to ""). It is therefore parked
  // off-screen at full size for the one read, then removed.
  const answerText = (el) => {
    const raw = (el.innerText || '').trim();
    if (!reasoning.length) return raw;
    let hasNoise = false;
    for (const selector of reasoning) {
      try { if (el.querySelector(selector)) { hasNoise = true; break; } } catch { /* a bad selector is not a reason to cut */ }
    }
    if (!hasNoise) return raw;
    const clone = el.cloneNode(true);
    clone.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;height:1600px;pointer-events:none;';
    document.body.appendChild(clone);
    let trimmed = '';
    try {
      for (const selector of reasoning) {
        try { clone.querySelectorAll(selector).forEach(node => node.remove()); } catch { /* keep going */ }
      }
      trimmed = (clone.innerText || '').trim();
    } finally {
      clone.remove();
    }
    // Cutting is a hypothesis. If it removed everything, the hypothesis was
    // wrong for this markup, and a noisy answer still beats an empty one.
    return trimmed.length ? trimmed : raw;
  };

  // Assistant text. The first list with hits wins, so a broad match cannot
  // shadow the specific one; the composer is excluded because it can contain
  // markdown-looking text.
  let assistantTexts = [];
  for (const selector of selectors.assistant) {
    let nodes;
    try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
    const texts = nodes
      .filter(visible)
      .filter((el) => !composer || !composer.contains(el))
      .map(answerText)
      .filter((text) => text.length > 0);
    if (texts.length) {
      assistantTexts = texts;
      chosen.assistant = selector;
      break;
    }
  }

  // Conversation text for change detection. Prefer the tallest scrollable
  // container *that contains the composer*: reading document.body.innerText on
  // a long conversation is both slower and noisier (sidebars, banners) than the
  // transcript itself.
  //
  // The composer is what makes the container the conversation. Without that
  // condition the tallest scroll container on kimi.com's start page is the
  // whole shell — sidebar included — and a send that never left the start page
  // produced an "answer" that was the sidebar's chat titles read out loud
  // （「3+5结果是多少… 升级套餐… 深度研究」）. The transcript is the one that
  // holds the box you type into.
  const tallestScrollable = (requireComposer) => {
    let root = null;
    let score = 0;
    for (const el of document.querySelectorAll('div, main, section')) {
      const holdsComposer = !!composer && el.contains(composer);
      if (requireComposer && !holdsComposer) continue;
      // The size floor is a guess at "this is a pane, not a widget". It does not
      // apply to a container that holds the composer: kimi.com's chat-box is
      // 230px tall on the start page, so the floor rejected it, nothing else
      // qualified, and the read fell back to the whole shell — sidebar and all.
      if (!holdsComposer) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 320 || rect.height < 240) continue;
      }
      if (el.scrollHeight - el.clientHeight <= 0) continue;
      if (el.scrollHeight > score) { score = el.scrollHeight; root = el; }
    }
    return root;
  };

  // Fall back to any container: on sites that pin the composer outside the
  // scroll area nothing contains it, and refusing to read would lose the
  // transcript entirely.
  const scrollRoot = tallestScrollable(true) || tallestScrollable(false);
  if (scrollRoot) chosen.conversation = 'structural:tallest-scroll-container';

  const rawText = ((scrollRoot || document.body).innerText || '').trim();
  const conversationText = (composerText
    ? rawText.split(composerText).join('')
    : rawText).slice(-120000);

  return {
    url: location.href,
    title: document.title,
    // A page that has never been given a real size measures 0 wide everywhere,
    // which is indistinguishable from "the markup changed" unless the viewport
    // itself is reported. This is the number that tells the two apart.
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    hasPasswordField: firstMatch('passwordField').length > 0,
    signedOut,
    hasInput: !!composer,
    inputKind: kindOf(composer),
    hasSendButton: sendButtons.length > 0 || structuralSend,
    generating: stopButtons.length > 0,
    messageCount: assistantTexts.length,
    lastText: assistantTexts.length ? assistantTexts[assistantTexts.length - 1].slice(0, 200000) : '',
    conversationText,
    composerText,
    selectorHits: hits,
    chosen
  };
})()`;

/**
 * Read the live DOM and propose a selector for each role.
 *
 * This is the "the site redesigned itself" path. The probe already has
 * structural fallbacks, so a class rename mostly keeps the app working — but
 * `assistant` has no fallback, and a renamed message container silently turns
 * every answer into "no new reply". Discovery is what turns that into a repair
 * the user can trigger instead of a bug report.
 *
 * Two rules make the output worth persisting:
 *
 * 1. **Prefer a promise the site made over a class name.** `data-testid`,
 *    `aria-label`, `name` and `id` survive redesigns; `.css-1x2y3z` does not.
 *    Class names that look like build hashes are rejected outright.
 * 2. **Every selector must match something visible right now.** A selector
 *    built from a detached node is a selector that will fail at question time,
 *    and failing later is worse than not learning it.
 *
 * Nothing here mutates the page. The caller validates the proposal against a
 * real probe before writing anything down.
 */
export const DISCOVER_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  /**
   * The cheap visibility test, for scans over thousands of nodes.
   *
   * 'visible' above reads the computed style and the rect, which forces a
   * synchronous layout per element. On a page with twenty thousand nodes that is
   * not a slow function, it is a frozen window — and a frozen window is what
   * this whole button exists to fix. 'checkVisibility' answers the same question
   * in one native call.
   */
  const shown = (el) => {
    if (!el || !(el instanceof Element)) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return true;
  };

  const count = (selector) => {
    try { return [...document.querySelectorAll(selector)].filter(visible).length; } catch { return 0; }
  };

  const unique = (selector) => count(selector) === 1;

  const escaped = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : null);

  const ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-id', 'name', 'aria-label', 'role'];

  const fromAttributes = (el) => {
    if (!el || !(el instanceof Element)) return null;
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (!value || value.length > 60) continue;
      if (value.includes('"') || value.includes('\\\\')) continue;
      const selector = '[' + attr + '="' + value + '"]';
      if (unique(selector)) return selector;
    }
    const id = el.id;
    if (id && id.length <= 40 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) {
      const selector = '#' + escaped(id);
      if (selector && unique(selector)) return selector;
    }
    return null;
  };

  // A build hash changes on every deploy — learning it would be learning the
  // thing that broke. Long names are usually utility soup rather than meaning.
  const looksGenerated = (name) => /[0-9a-f]{6,}/i.test(name) || name.length > 28;

  const fromClasses = (el) => {
    if (!el || !(el instanceof Element)) return null;
    const classes = [...el.classList]
      .filter((name) => name.length > 1 && !looksGenerated(name))
      .slice(0, 2);
    if (!classes.length) return null;
    const parts = classes.map((name) => escaped(name));
    if (parts.some((part) => !part)) return null;
    const selector = el.tagName.toLowerCase() + parts.map((part) => '.' + part).join('');
    return unique(selector) ? selector : null;
  };

  const describe = (el) => fromAttributes(el) || fromClasses(el);

  const labelOf = (el) =>
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.getAttribute('type'), (el.textContent || '').trim().slice(0, 20)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

  const editables = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter(visible)
    .filter((el) => el.getBoundingClientRect().width > 120);
  // Bottom-most: a chat composer sits at the bottom of the viewport, and the
  // sidebar's search box does not.
  editables.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  const input = editables[0] || null;

  let send = null;
  if (input) {
    let scope = input;
    for (let depth = 0; depth < 6 && scope && !send; depth += 1) {
      scope = scope.parentElement;
      if (!scope) break;
      const buttons = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
      if (!buttons.length) continue;
      send = buttons.find((el) => /send|发送|submit|提交/.test(labelOf(el))) || buttons[buttons.length - 1];
    }
  }

  const stop = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .find((el) => /stop|停止|abort/.test(labelOf(el))) || null;

  const newChat = [...document.querySelectorAll('a, button, [role="button"]')]
    .filter(visible)
    .find((el) => /new chat|新对话|新建对话/.test(labelOf(el))) || null;

  // The answer container, found by repetition rather than by name: whatever
  // holds prose and appears many times with the same shape is the transcript.
  // Counting by signature is what stops a one-off banner from being learned as
  // "the answer".
  //
  // Cost matters here and is not obvious. '[class*="message"]' matches thousands
  // of nodes on a real chat page, and both innerText and getBoundingClientRect
  // force a synchronous layout — reading them per node turned this into a
  // minute-long stall that looked exactly like a hung app. So: textContent for
  // the length test, only the last 400 matches, and one measurement for the
  // winner instead of one per group.
  let bestGroup = null;
  let bestSize = 0;
  for (const probe of ['[class*="markdown"]', '[class*="message"]', '[class*="prose"]', 'article', '[data-message-author-role]']) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(probe)].filter(shown); } catch { continue; }
    nodes = nodes.slice(-400);
    const groups = new Map();
    for (const el of nodes) {
      if (input && input.contains(el)) continue;
      if ((el.textContent || '').trim().length < 12) continue;
      const key = el.tagName + '|' + [...el.classList].join('.');
      const bucket = groups.get(key) || [];
      bucket.push(el);
      groups.set(key, bucket);
    }
    for (const bucket of groups.values()) {
      if (bucket.length <= bestSize) continue;
      bestSize = bucket.length;
      bestGroup = bucket;
    }
  }

  let assistant = null;
  if (bestGroup) {
    const selector = describe(bestGroup[bestGroup.length - 1]);
    const hits = selector ? count(selector) : 0;
    // A selector matching hundreds of nodes is a layout container, not a
    // message: it would report every edit on the page as a new answer.
    if (selector && hits >= 1 && hits <= 400) assistant = selector;
  }

  // The transcript container is deliberately NOT proposed here. Finding it
  // means scoring every scrollable box, which costs a layout pass per node, and
  // the probe already has a structural rule for it that a learned selector
  // would never replace.
  const proposed = {
    input: describe(input),
    sendButton: describe(send),
    stopButton: describe(stop),
    newChatButton: describe(newChat),
    assistant,
    conversation: null,
    passwordField: 'input[type="password"]'
  };

  const roles = {};
  for (const [role, selector] of Object.entries(proposed)) {
    roles[role] = selector ? { selector, hits: count(selector) } : null;
  }
  return { url: location.href, roles };
})()`;

const FILL_SCRIPT = (selectors: SelectorProfile, payload: string) => `(async () => {
  const selectors = ${JSON.stringify(selectors)};
  const value = ${payload};

  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const findInput = () => {
    for (const selector of selectors.input) {
      let nodes;
      try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
      const hit = nodes.filter(visible);
      if (hit.length) return hit[hit.length - 1];
    }
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(visible)
      .filter((el) => el.getBoundingClientRect().width > 120)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    return candidates[0] || null;
  };

  const target = findInput();
  if (!target) return { ok: false, reason: 'INPUT_NOT_FOUND' };

  target.focus();

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // A virtual DOM only notices a contenteditable edit through beforeinput /
    // input, and only trusts it if the DOM was mutated the way the browser
    // would mutate it. execCommand is deprecated but remains the only way to
    // produce an edit the framework accepts; fall back to a plain assignment
    // for pages that do not support it.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, value); } catch { inserted = false; }
    if (!inserted) {
      target.textContent = value;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  }
  target.dispatchEvent(new Event('change', { bubbles: true }));

  const isPlainField = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
  const readBack = () => (isPlainField
    ? target.value
    : (target.innerText || target.textContent || ''));

  let written = readBack();

  // A Lexical-based composer applies the edit on its own microtask queue, so
  // the DOM still reads empty on the tick that execCommand returned true.
  // Reporting INPUT_NOT_FILLED there refuses a fill that worked a frame later
  // (measured on kimi.com: the text showed up a few milliseconds after the
  // call returned, and the driver refused to send). Plain fields are exempt —
  // a value setter either took or it did not, so waiting would only hide a bug.
  if (!isPlainField && !written.trim()) {
    const deadline = Date.now() + 600;
    while (!written.trim() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      written = readBack();
    }
  }

  return {
    ok: written.trim().length > 0,
    reason: written.trim().length ? undefined : 'INPUT_NOT_FILLED',
    kind: target.tagName.toLowerCase()
  };
})()`;

const CLICK_SEND_SCRIPT = (selectors: SelectorProfile) => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const findComposer = () => {
    for (const selector of selectors.input) {
      let nodes;
      try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
      const hit = nodes.filter(visible);
      if (hit.length) return hit[hit.length - 1];
    }
    return null;
  };

  let button = null;
  for (const selector of selectors.sendButton) {
    let nodes;
    try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
    const hit = nodes.filter(visible).filter((el) => !el.hasAttribute('disabled'));
    if (hit.length) { button = hit[hit.length - 1]; break; }
  }

  if (!button) {
    const composer = findComposer();
    if (composer) {
      let scope = composer;
      for (let depth = 0; depth < 5 && scope && !button; depth += 1) {
        scope = scope.parentElement;
        if (!scope) break;
        const candidates = [...scope.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .filter((el) => !el.hasAttribute('disabled'));
        if (!candidates.length) continue;
        // The real send control is an unlabelled icon button, so it has to be
        // identified by shape and position. A plain "last button" guess would
        // sometimes click a mode toggle instead, silently changing the request.
        const score = (el) => {
          const cls = (el.className || '').toString().toLowerCase();
          let total = 0;
          if (/send|submit/.test(cls)) total += 4;
          if (/primary/.test(cls)) total += 2;
          if (/circle|round/.test(cls)) total += 1;
          return total;
        };
        candidates.sort((a, b) => {
          const diff = score(b) - score(a);
          if (diff !== 0) return diff;
          return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
        });
        button = candidates[0];
      }
    }
  }

  if (!button) return { ok: false, reason: 'SEND_BUTTON_NOT_FOUND' };
  button.click();
  return { ok: true, label: (button.className || '').toString().slice(0, 60) };
})()`;

const NEW_CHAT_SCRIPT = (selectors: SelectorProfile) => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const enabled = (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true';

  for (const selector of selectors.newChatButton || []) {
    let nodes;
    try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
    const hit = nodes.filter(visible).filter(enabled);
    if (hit.length) { hit[0].click(); return { ok: true, method: 'selector:' + selector }; }
  }

  // Fallback: match the label. The markup is not ours and the class names are
  // generated, but the words a user reads are stable and localized — so this is
  // an exact match on the whole label, never a substring. A substring match on
  // "新对话" would also hit "查看历史新对话".
  const LABELS = ['新对话', '新建对话', '新的对话', '开启新对话', 'new chat', 'new conversation'];
  const candidates = [...document.querySelectorAll('button, a, [role="button"]')]
    .filter(visible)
    .filter(enabled);
  for (const el of candidates) {
    const texts = [el.getAttribute('aria-label'), el.getAttribute('title'), el.innerText, el.textContent]
      .map((value) => (value || '').trim().toLowerCase())
      .filter((value) => value.length > 0 && value.length < 40);
    if (texts.some((value) => LABELS.includes(value))) {
      el.click();
      return { ok: true, method: 'label' };
    }
  }

  return { ok: false, reason: 'NEW_CHAT_BUTTON_NOT_FOUND' };
})()`;

/**
 * Every conversation link the page is currently listing, in DOM order.
 *
 * Taken before a question is asked and again after it is answered: the row that
 * appeared in between is the one this conversation created. That difference is
 * the only safe way to name a thread on a site that keeps its id out of the
 * address bar — Kimi does, and "the first row" would happily delete a
 * conversation the user started on their phone a minute earlier.
 */
const THREAD_LIST_SCRIPT = `(() => {
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  return [...document.querySelectorAll('a[href]')]
    .filter(visible)
    .map((a) => ({ href: a.href, title: (a.innerText || '').trim().slice(0, 80) }))
    .filter((row) => /\\/(chat\\/[^/?#]+|c\\/[^/?#]+|app\\/[^/?#]+)/.test(row.href))
    .filter((row) => !/\\/chat\\/history/.test(row.href))
    .slice(0, 60);
})()`;

/**
 * Delete *this* conversation from the site's own sidebar.
 *
 * The row is found by the thread id in the address recorded when the answer
 * arrived, never by its title: two conversations can be called the same thing,
 * and the wrong one cannot be brought back. When the id is not in the sidebar
 * the script returns `ok: false` without clicking anything — a delete that
 * guesses is worse than a delete that declines.
 *
 * Two shapes had to be handled, measured live:
 *   - Kimi  — row is `.next-sidebar-history-item`, its menu button carries
 *             `aria-label="更多"`, and the menu item is a span reading 删除;
 *   - ChatGPT — the menu button lives four levels above the link
 *             (`aria-label="聊天操作"`) and the trigger opens on *pointerdown*,
 *             so a plain `.click()` does nothing at all.
 * Hence the generic walk: go up from the link until a level exposes exactly one
 * menu-shaped button, then dispatch the full pointer sequence.
 */
const DELETE_CHAT_SCRIPT = (threadUrl: string) => `(async () => {
  const target = ${JSON.stringify(threadUrl)};
  const id = (() => {
    try {
      const path = new URL(target).pathname;
      const uuid = path.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      if (uuid) return uuid[0];
      const parts = path.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    } catch { return ''; }
  })();
  if (!id) return { ok: false, detail: '这个地址里没有会话编号' };

  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const label = (el) =>
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.className]
      .map((value) => (value || '').toString().trim())
      .filter(Boolean)
      .join(' ');

  const rowLink = () =>
    [...document.querySelectorAll('a[href]')]
      .filter(visible)
      .find((a) => (a.getAttribute('href') || '').includes(id)) || null;

  let link = rowLink();

  // A collapsed sidebar has no rows at all. Opening it is a click the user
  // would have made anyway, and it is the only way to reach the row.
  if (!link) {
    const opener = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .find((el) => /显示侧边栏|打开侧边栏|show sidebar|open sidebar/i.test(label(el)));
    if (opener) {
      opener.click();
      await sleep(1200);
      link = rowLink();
    }
  }
  if (!link) return { ok: false, detail: '侧栏里找不到这条会话，可能太旧或已被归档' };

  // Walk up to the smallest ancestor that owns a menu button. Smallest matters:
  // one level too high and every row in the list matches, which is how a delete
  // lands on somebody else's conversation.
  const MENU_WORDS = /聊天操作|更多|更多选项|操作|菜单|chat actions|more|options|menu/i;
  const menuButton = (() => {
    let node = link.parentElement;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const hits = [...node.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .filter((el) => MENU_WORDS.test(label(el)));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null;
      node = node.parentElement;
    }
    return null;
  })();
  if (!menuButton) return { ok: false, detail: '这条会话旁边没有「更多」菜单' };

  const rect = menuButton.getBoundingClientRect();
  const at = {
    bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
  };
  menuButton.dispatchEvent(new PointerEvent('pointerover', at));
  menuButton.dispatchEvent(new PointerEvent('pointerdown', at));
  menuButton.dispatchEvent(new MouseEvent('mousedown', at));
  menuButton.dispatchEvent(new PointerEvent('pointerup', at));
  menuButton.dispatchEvent(new MouseEvent('mouseup', at));
  menuButton.dispatchEvent(new MouseEvent('click', at));

  const findDeleteItem = () =>
    [...document.querySelectorAll('[role="menuitem"], [class*="menu-item"], [class*="MenuItem"]')]
      .filter(visible)
      .find((el) => /^(删除|删除聊天|delete|delete chat)$/i.test((el.innerText || '').trim()));

  let item = null;
  for (let wait = 0; wait < 8 && !item; wait += 1) {
    await sleep(200);
    item = findDeleteItem();
  }
  if (!item) return { ok: false, detail: '菜单里没有「删除」这一项' };

  // The text node is not always the click target: Kimi puts the word in a
  // span three levels inside the row that handles the click.
  let clickTarget = item;
  for (let depth = 0; depth < 3 && clickTarget; depth += 1) {
    if (clickTarget.matches('button, [role="menuitem"], [role="button"], a[href]')) break;
    clickTarget = clickTarget.parentElement;
  }
  clickTarget = clickTarget || item;

  clickTarget.dispatchEvent(new PointerEvent('pointerdown', at));
  clickTarget.dispatchEvent(new MouseEvent('click', at));
  // Some sites put the confirm one click later. Clicking it is safe even when
  // it never appears, because nothing is clicked unless the label says delete.
  // ChatGPT's confirm is 「删除聊天」, not 「删除」 — measured, after the first
  // version matched only the short word and left the dialog open.
  const CONFIRM = /^(删除|删除聊天|delete|delete chat|确定|确认|remove)$/i;
  for (let wait = 0; wait < 8; wait += 1) {
    await sleep(200);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="dialog"]')].filter(visible);
    let confirm = null;
    for (const dialog of dialogs) {
      confirm = [...dialog.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find((el) => CONFIRM.test((el.innerText || '').trim())) || null;
      if (confirm) break;
    }
    if (confirm) {
      const box = confirm.getBoundingClientRect();
      const point = { ...at, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      confirm.dispatchEvent(new PointerEvent('pointerdown', point));
      confirm.dispatchEvent(new MouseEvent('mousedown', point));
      confirm.dispatchEvent(new PointerEvent('pointerup', point));
      confirm.dispatchEvent(new MouseEvent('mouseup', point));
      confirm.dispatchEvent(new MouseEvent('click', point));
      break;
    }
  }

  // Evidence, not belief: a click is a request. The row is gone only when the
  // sidebar stops listing it.
  for (let wait = 0; wait < 15; wait += 1) {
    await sleep(200);
    if (!rowLink()) return { ok: true };
  }
  return { ok: false, detail: '点了删除，但侧栏里这条会话还在' };
})()`;

const FOCUS_SCRIPT = (selectors: SelectorProfile) => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  let target = null;
  for (const selector of selectors.input) {
    let nodes;
    try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
    const hit = nodes.filter(visible);
    if (hit.length) { target = hit[hit.length - 1]; break; }
  }
  if (!target) return false;
  target.focus();
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const end = target.value.length;
    target.setSelectionRange(end, end);
  } else {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return document.activeElement === target;
})()`;

/**
 * How long one call into a page may take before we stop waiting for it.
 *
 * `executeJavaScript` settles when the renderer answers. A renderer that is
 * navigating, crashed, or stuck in a long synchronous task never answers — and
 * these calls had no deadline of their own: the loops around them check *their*
 * clock between polls, so a poll that never returns stops the clock check from
 * ever running. That is how a conversation sat at 「提问中」 for minutes with
 * nothing on disk changing: the per-answer timeout lives inside `waitForAnswer`,
 * and the call that hung was the probe *before* it.
 *
 * Twenty seconds is a lot for a DOM read and far short of anything a user would
 * call "stuck". The abandoned promise is left to settle by itself; the point is
 * that the caller stops waiting.
 */
const PAGE_CALL_TIMEOUT_MS = 20_000;

export function callPage<T>(
  view: WebContentsView,
  label: string,
  script: string,
  timeoutMs = PAGE_CALL_TIMEOUT_MS
): Promise<T> {
  const contents = view.webContents;
  if (contents.isDestroyed()) return Promise.reject(new Error(`${label}：页面已关闭`));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(`${label}：页面 ${Math.round(timeoutMs / 1000)} 秒没有响应，渲染进程可能卡住了`)
      );
    }, timeoutMs);

    contents.executeJavaScript(script, true).then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value as T);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * A DOM read over the debugger protocol is a single round trip, so a short
 * deadline is enough — and it keeps one slow probe from stalling the 4-second
 * status poll.
 */
const DEBUGGER_PROBE_TIMEOUT_MS = 2_000;

/**
 * Read a page that has not finished loading.
 *
 * `executeJavaScript` is queued until the frame stops loading, and on Gemini
 * that queue is open for a minute: measured on a cold start, every probe timed
 * out for 62 seconds while the page was drawn, the composer was there and a
 * question would have worked. The channel said 「页面正在加载」 the whole time,
 * which is the display bug this exists to remove.
 *
 * The debugger protocol has no such queue — measured on the same page it
 * answered in 0–19ms while `isLoading()` was still true. So it is used for the
 * probe only, and only while a load is in progress: attach, ask, detach.
 *
 * `undefined` means "cannot answer this way" (already attached by the user's
 * DevTools, or the call failed), and the caller falls back to the normal path.
 */
async function probeWhileLoading(view: WebContentsView, script: string): Promise<PageProbe | undefined> {
  const contents = view.webContents;
  if (contents.isDestroyed() || contents.debugger.isAttached()) return undefined;
  try {
    contents.debugger.attach('1.3');
  } catch {
    return undefined;
  }
  try {
    const reply = (await Promise.race([
      contents.debugger.sendCommand('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true }),
      new Promise(resolve => setTimeout(() => resolve(null), DEBUGGER_PROBE_TIMEOUT_MS))
    ])) as { result?: { value?: PageProbe } } | null;
    return reply?.result?.value;
  } catch {
    return undefined;
  } finally {
    try {
      contents.debugger.detach();
    } catch {
      // A detach after a navigation can fail; nothing above depends on it.
    }
  }
}

/**
 * The one place that knows this is Electron.
 *
 * `selectors` may be a function. A learned selector only takes effect if the
 * next probe sees it, and the probe is built when the call is made — so the
 * driver has to resolve the profile at call time, not at construction time.
 * Passing the object directly (the default) still works, which is what the
 * tests rely on.
 */
export function createElectronDriver(
  view: WebContentsView,
  selectors: SelectorProfile | (() => SelectorProfile),
  reasoning: readonly string[] | (() => readonly string[]) = [],
  signedOutSelectors: readonly string[] | (() => readonly string[]) = [],
  signedOutText: readonly string[] | (() => readonly string[]) = []
): PageDriver {
  const profile = typeof selectors === 'function' ? selectors : () => selectors;
  const cut = typeof reasoning === 'function' ? reasoning : () => reasoning;
  const signedOut = typeof signedOutSelectors === 'function' ? signedOutSelectors : () => signedOutSelectors;
  const signedOutWords = typeof signedOutText === 'function' ? signedOutText : () => signedOutText;
  return {
    url: () => view.webContents.getURL(),
    isDestroyed: () => view.webContents.isDestroyed(),
    isLoading: () => view.webContents.isLoading(),
    probe: async () => {
      const script = PROBE_SCRIPT(profile(), cut(), signedOut(), signedOutWords());
      // A page that is still loading is not necessarily an unusable one: Gemini
      // draws its whole chat UI while a request keeps the load open, so the
      // status said 「页面正在加载」 over a page the user could already type in.
      // The debugger path reads it anyway; when it cannot, the normal call is
      // the fallback and the caller reports the wait honestly.
      if (view.webContents.isLoading()) {
        const early = await probeWhileLoading(view, script);
        if (early) return early;
      }
      return (await callPage(view, '读取页面状态', script)) as PageProbe;
    },
    fill: async text =>
      (await callPage(view, '写入输入框', FILL_SCRIPT(profile(), JSON.stringify(text)))) as {
        ok: boolean;
        reason?: string;
        kind?: string;
      },
    clickSend: async () =>
      (await callPage(view, '点击发送', CLICK_SEND_SCRIPT(profile()))) as {
        ok: boolean;
        reason?: string;
        label?: string;
      },
    pressEnter: async () => {
      // Focus inside the page first: the keystroke has to land in the composer,
      // and the DOM focus may have drifted since the fill.
      await callPage(view, '聚焦输入框', FOCUS_SCRIPT(profile()));
      view.webContents.focus();
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    },
    newChat: async () =>
      (await callPage(view, '开新会话', NEW_CHAT_SCRIPT(profile()))) as {
        ok: boolean;
        method?: string;
        reason?: string;
      },
    navigate: async (url: string) => {
      // Same deadline reasoning as `reloadHome`: a navigation legitimately takes
      // seconds, and a page that never finishes must not hold the delete open.
      try {
        await Promise.race([
          view.webContents.loadURL(url),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('打开这条会话超时：页面没有在 30 秒内加载完')), 30_000)
          )
        ]);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    deleteChat: async (threadUrl: string) =>
      (await callPage(view, '删除网页会话', DELETE_CHAT_SCRIPT(threadUrl))) as {
        ok: boolean;
        detail?: string;
      },
    threadCandidates: async () =>
      (await callPage(view, '读取会话列表', THREAD_LIST_SCRIPT)) as ThreadCandidate[],
    reloadHome: async () => {
      // The URL is already known to be an allowed host — the adapter checks
      // before it hands us the driver — so its origin is safe to navigate to.
      // A navigation is the one call here that legitimately takes seconds, so it
      // gets its own deadline rather than sharing the DOM one.
      try {
        await Promise.race([
          view.webContents.loadURL(new URL(view.webContents.getURL()).origin),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('重新加载超时：页面没有在 30 秒内完成加载')),
              30_000
            )
          )
        ]);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

/** Longest common prefix length, so appended page text can be isolated. */
function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/**
 * Whether the captured text looks like a finished answer.
 *
 * A streamed answer is a growing prefix, and a pause between bursts is
 * indistinguishable from the end of the message by timing alone. Content gives
 * a real signal: an answer that opened a JSON object but has not closed it is
 * still arriving. Accepting a prefix is what produced a 36-character "answer"
 * that parsed as nothing.
 */
export function answerLooksComplete(text: string): boolean {
  if (!text.includes('{')) return true; // prose answer; nothing more to wait for

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }

  return depth === 0 && !inString;
}

function diagnosticsOf(probe: PageProbe): PageDiagnostics {
  return {
    probeVersion: PROBE_VERSION,
    selectorHits: probe.selectorHits,
    chosen: probe.chosen,
    composerChars: probe.composerText.length,
    conversationChars: probe.conversationText.length
  };
}

export interface AdapterTuning {
  /** How long to wait for the page to acknowledge a submission. */
  confirmMs: number;
  /** Poll interval while waiting. */
  pollMs: number;
  /** How long the answer text must stay unchanged before it counts as final. */
  settleMs: number;
  /** When to try a real keystroke, after the click did nothing. */
  enterAfterMs: number;
  /** When to click a second time, after the keystroke also did nothing. */
  clickRetryAfterMs: number;
  /** How long a requested new conversation may take to actually clear the page. */
  newChatMs: number;
}

export const DEFAULT_TUNING: AdapterTuning = {
  confirmMs: 20000,
  pollMs: 700,
  settleMs: 2000,
  enterAfterMs: 3000,
  clickRetryAfterMs: 8000,
  newChatMs: 12000
};

/**
 * Cut the user's own message out of the transcript tail.
 *
 * The tail begins with the prompt: the page renders what we sent as a bubble,
 * and on a site with no assistant container that bubble is part of the
 * transcript we diff against. So the answer has to be found *behind* our own
 * words, and there are three ways to get past them — head, anywhere, and the
 * prompt's own ending. Each covers a different way the page can render it.
 *
 * Without this the tail kept our prompt, `containsEcho` rejected every
 * candidate, and the turn sat at 「提问中」 until the deadline: the page had
 * answered, and the app refused to look past its own question.
 */
function cutPrompt(text: string, prompt?: string): string {
  if (!prompt) return text;
  const asked = prompt.trim();

  // 1. At the head, whitespace-insensitive. This is the ordinary shape: the
  //    page echoes the question as a bubble and the tail starts with it.
  //    `stripEcho` refuses short strings on purpose, and a question can be
  //    short — the tail's first line is still ours either way.
  const head = findIgnoringWhitespace(text, asked);
  if (head && text.slice(0, head.start).trim().length === 0) return text.slice(head.end);

  // 2. Wherever it sits, for a page that put something in front of the bubble
  //    ("你说：…"). This is the path that needs the long-string guard.
  const stripped = stripEcho(text, prompt);
  if (stripped !== text) return stripped;

  // 3. The prompt's own ending, when the page reflowed its middle — a markdown
  //    list, a collapsed block — so the whole-string match fails while the last
  //    line, the question itself, is still on screen.
  const marker = asked.slice(-40);
  if (marker.replace(/\s+/g, '').length < 4) return text;
  const at = findIgnoringWhitespace(text, marker);
  return at ? text.slice(at.end) : text;
}

export class ChatPageDriver {
  private waits = new Map<string, AbortController>();
  private tuning: AdapterTuning = { ...DEFAULT_TUNING };
  private readonly hostsOf: () => ReadonlySet<string>;
  private readonly selectorsOf: () => SelectorProfile;
  private readonly reasoningOf: () => readonly string[];
  private readonly signedOutOf: () => readonly string[];
  private readonly signedOutPathsOf: () => readonly string[];
  /**
   * Public, because the callers that talk to the user about "this page" need a
   * name for it and must not supply their own. `AgentOrchestrator` used to write
   * "DeepSeek 未登录" over a driver that could be pointing at any site.
   */
  readonly siteLabel: string;

  /**
   * Everything site-specific arrives here; the driver itself knows no site.
   *
   * Three things differ between one chat page and another: which hosts it is
   * allowed to be, which selectors its markup answers to, and what to call it
   * when the status detail has to say whose page is broken. Everything else —
   * the probe, the send path, "is this answer mine", echo stripping — is
   * site-agnostic, which is why there is one driver and not one per site.
   *
   * `hosts` and `selectors` may both be functions, because both change while the
   * app runs: the address is editable, and a learned selector takes effect on
   * the next probe. A driver that captured either at construction would refuse
   * the URL the user just fixed, and report it as "当前页面不是允许的…页面" —
   * which reads like a network failure rather than a stale setting.
   */
  constructor(
    private readonly getDriver: () => PageDriver | null,
    options: {
      hosts: ReadonlySet<string> | (() => ReadonlySet<string>);
      siteLabel: string;
      selectors: SelectorProfile | (() => SelectorProfile);
      /**
       * Subtrees inside an answer bubble that are not the answer (see
       * `ProviderProfile.reasoning`). Resolved per call for the same reason as
       * `selectors`: this is site knowledge, and it can be repaired or replaced
       * while the app runs.
       */
      reasoning?: readonly string[] | (() => readonly string[]);
      /**
       * Selectors that mean "the page is offering a sign-in" (see
       * `ProviderProfile.signedOut`). Empty is a complete answer, not a missing
       * one: for most sites the password-field check already covers it.
       */
      signedOut?: readonly string[] | (() => readonly string[]);
      /**
       * Path prefixes that mean the site moved the page into its sign-in flow
       * (see `ProviderProfile.signedOutPaths`). Empty for every site that keeps
       * one address while signed out.
       */
      signedOutPaths?: readonly string[] | (() => readonly string[]);
    }
  ) {
    const hosts = options.hosts;
    this.hostsOf = typeof hosts === 'function' ? hosts : () => hosts;
    const selectors = options.selectors;
    this.selectorsOf = typeof selectors === 'function' ? selectors : () => selectors;
    const reasoning = options.reasoning ?? [];
    this.reasoningOf = typeof reasoning === 'function' ? reasoning : () => reasoning;
    const signedOut = options.signedOut ?? [];
    this.signedOutOf = typeof signedOut === 'function' ? signedOut : () => signedOut;
    const signedOutPaths = options.signedOutPaths ?? [];
    this.signedOutPathsOf =
      typeof signedOutPaths === 'function' ? signedOutPaths : () => signedOutPaths;
    this.siteLabel = options.siteLabel;
  }

  private isAllowed(url: string): boolean {
    return isAllowedHostUrl(url, this.hostsOf());
  }

  /** Test and shell hook: shorten the timings without touching the logic. */
  configure(tuning: Partial<AdapterTuning>) {
    this.tuning = { ...this.tuning, ...tuning };
  }

  private driver(): PageDriver {
    const driver = this.getDriver();
    if (!driver || driver.isDestroyed()) throw new Error(`${this.siteLabel} 页面尚未就绪`);
    const url = driver.url();
    if (!this.isAllowed(url)) throw new Error(`当前页面不是允许的 ${this.siteLabel} 页面：${url || '(空白)'}`);
    return driver;
  }

  async probe(): Promise<PageProbe> {
    const result = await this.driver().probe();
    if (!result || typeof result !== 'object') throw new Error('页面探测返回了意外结果');
    return result;
  }

  async getStatus(): Promise<DeepSeekStatus> {
    const url = this.getDriver()?.url() ?? '';
    if (!this.isAllowed(url)) {
      return {
        url,
        pageReady: false,
        loggedIn: false,
        hasInput: false,
        hasSendButton: false,
        generating: false,
        messageCount: 0,
        detail: url ? `页面不是 ${this.siteLabel}` : '页面尚未加载'
      };
    }
    // Loading is not the same as unusable, and it is no longer a reason to
    // answer without looking: `probe()` reads the page through the debugger
    // while a load is open. The flag is kept because it changes what "no
    // composer" means — on a half-drawn page it is "wait", not "the site
    // changed its markup".
    const loading = this.getDriver()?.isLoading?.() === true;
    try {
      const probe = await this.probe();
      // Three shapes of "not signed in": a password field (the site is asking
      // you to), the site's own signed-out marker (it is offering), and a
      // redirect into its sign-in route. The last two were measured on Gemini,
      // where the signed-out page is either usable with a hint or a `/signin`
      // page with no composer at all — the password-field check called both
      // logged in / broken respectively.
      const onSignInPath = this.signedOutPathsOf().some(prefix => isUnderPath(probe.url, prefix));
      const signedOut = probe.hasPasswordField || probe.signedOut || onSignInPath;
      const loggedIn = !signedOut;
      return {
        url: probe.url,
        pageReady: probe.hasInput,
        loggedIn,
        hasInput: probe.hasInput,
        hasSendButton: probe.hasSendButton,
        generating: probe.generating,
        messageCount: probe.messageCount,
        // Signed out is not the same as unusable: Gemini answers guests and
        // only the history/heavier models need an account. So the detail says
        // what is missing instead of pretending the page is broken — the
        // channel stays in the ready count either way.
        detail: !probe.hasInput
          ? loading
            ? '页面正在加载，加载完就能用'
            : signedOut
              ? `需要登录 ${this.siteLabel} 才能继续`
              : probe.viewportWidth === 0
                // Not a markup problem at all: with a 0x0 viewport every element
                // measures zero, so nothing is ever "visible". Saying the page
                // changed sent the last investigation in the wrong direction.
                ? '页面还没有分到尺寸（视口 0×0），右侧切换到这个页面一次即可'
                : '未找到输入框，页面结构可能已变化'
          : signedOut
            ? `未登录：仍可使用，登录后可保存记录并解锁更高模型`
            : undefined,
        diagnostics: diagnosticsOf(probe)
      };
    } catch (error) {
      return {
        url,
        pageReady: false,
        loggedIn: false,
        hasInput: false,
        hasSendButton: false,
        generating: false,
        messageCount: 0,
        // A probe that could not read the page while it was still loading is a
        // wait, not a fault: the debugger path is unavailable when the user has
        // DevTools open, and then `executeJavaScript` queues until the load
        // ends. Reporting the error text there blames the page for being slow.
        detail: loading ? '页面正在加载，加载完就能用' : error instanceof Error ? error.message : String(error)
      };
    }
  }

  /** Full report for the diagnostics panel: what was tried and what it found. */
  async diagnose(): Promise<PageReport> {
    const status = await this.getStatus();
    let probe: PageProbe | null = null;
    try {
      probe = await this.probe();
    } catch {
      probe = null;
    }
    return {
      probeVersion: PROBE_VERSION,
      url: status.url,
      title: probe?.title ?? '',
      status,
      selectors: this.selectorsOf() as unknown as Record<string, string[]>,
      probe: {
        hasInput: probe?.hasInput ?? false,
        inputKind: probe?.inputKind ?? 'none',
        hasSendButton: probe?.hasSendButton ?? false,
        generating: probe?.generating ?? false,
        messageCount: probe?.messageCount ?? 0,
        lastTextPreview: (probe?.lastText ?? '').slice(0, 400),
        selectorHits: probe?.selectorHits ?? {},
        chosen: probe?.chosen ?? {}
      }
    };
  }

  /** Capture the page *before* a request, so a stale answer can never be mistaken for the new one. */
  async snapshot(): Promise<MessageSnapshot> {
    const probe = await this.probe();
    return {
      messageCount: probe.messageCount,
      lastText: probe.lastText,
      url: probe.url,
      capturedAt: Date.now(),
      conversationText: probe.conversationText,
      composerText: probe.composerText
    };
  }

  /**
   * Start a fresh conversation on the page.
   *
   * Called once per conversation, before the first question, so the two sides
   * stay one-to-one: opening the page later must not show a thread that has
   * yesterday's question above today's answer. A follow-up deliberately skips
   * this — the page's own history *is* the context that makes it a follow-up.
   *
   * Three steps, in order of cost:
   *   1. Look. An empty transcript and an empty composer already *is* a new
   *      conversation, and typing into it is all a new conversation needs —
   *      which is the normal state of a page nobody has used yet. Resetting
   *      that would be a reload for nothing.
   *   2. Click the page's own control. Fast, but conditional on markup we do
   *      not own.
   *   3. Navigate to the site root. Always works, costs a page load, and is the
   *      only path on a page whose sidebar is collapsed (chatgpt.com at a
   *      narrow pane has no new-chat button at all — verified live).
   *
   * None of them is trusted on its own: a click is a request, and the only
   * evidence that the page really started over is an empty transcript.
   */
  async newConversation(): Promise<{ ok: boolean; method: string; detail?: string }> {
    const driver = this.driver();
    if (!driver.newChat && !driver.reloadHome) {
      return { ok: false, method: 'unsupported', detail: '该页面没有可用的「新对话」入口' };
    }

    // One look, no waiting: the page is either empty right now or it is not.
    if (await this.isEmptyNow(driver)) return { ok: true, method: 'already-empty' };

    const clicked: { ok: boolean; method?: string; reason?: string } = driver.newChat
      ? await driver.newChat().catch((error: unknown) => ({
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        }))
      : { ok: false, reason: 'NEW_CHAT_BUTTON_NOT_FOUND' };

    // Only wait after a click that reported success. A control that was never
    // found will not clear the page by itself, and waiting the full window for
    // it would delay the path that actually works.
    if (clicked.ok && (await this.pageIsEmpty(driver))) {
      return { ok: true, method: clicked.method ?? 'button' };
    }

    if (driver.reloadHome) {
      const reloaded = await driver.reloadHome();
      if (reloaded.ok && (await this.pageIsEmpty(driver))) return { ok: true, method: 'reload' };
      if (!reloaded.ok) {
        return { ok: false, method: 'reload', detail: `重新加载站点失败：${reloaded.reason ?? 'UNKNOWN'}` };
      }
    }

    return {
      ok: false,
      method: clicked.ok ? 'button' : 'none',
      detail: clicked.ok ? '页面没有清空，仍在原会话里' : `未找到「新对话」入口（${clicked.reason ?? 'UNKNOWN'}）`
    };
  }

  /**
   * Delete the site's own copy of a conversation.
   *
   * The address comes from the answer record, and the row is located by the id
   * inside it. If the sidebar does not list it — a long history that only
   * renders what has been scrolled to — the page is opened on that thread first
   * and the lookup is retried once. Anything else is reported, not retried:
   * a delete that keeps clicking is how the wrong row goes.
   */
  async deleteConversation(threadUrl: string): Promise<{ ok: boolean; detail?: string }> {
    const driver = this.driver();
    if (!driver.deleteChat) return { ok: false, detail: '该页面没有可用的删除入口' };
    if (!threadUrl) return { ok: false, detail: '没有记录这条会话在网页上的地址' };

    // A signed-out page has no history to delete from — Gemini still answers
    // guests, so this is a real state and not an edge case. There is nothing to
    // remove and nothing to report: returning a failure here made the caller
    // reset the page, and resetting a signed-out Gemini lands on Google's login
    // flow, which is a worse outcome than the thread that never existed.
    const status = await this.getStatus().catch(() => null);
    if (status && !status.loggedIn) {
      return { ok: true, detail: '未登录，站点不保存会话记录' };
    }

    const first = await driver.deleteChat(threadUrl).catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }));
    if (first.ok) return { ok: true };
    if (!driver.navigate || !/找不到这条会话/.test(first.detail ?? '')) return first;

    const opened = await driver.navigate(threadUrl);
    if (!opened.ok) return { ok: false, detail: `打不开这条会话：${opened.reason ?? 'UNKNOWN'}` };
    return driver.deleteChat(threadUrl).catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    }));
  }

  /** The page's address, or empty when it has not been created yet. */
  currentUrl(): string {
    try {
      return this.getDriver()?.url() ?? '';
    } catch {
      return '';
    }
  }

  /** Links the sidebar is listing right now. Empty when the page has none. */
  async threadCandidates(): Promise<ThreadCandidate[]> {
    try {
      return (await this.getDriver()?.threadCandidates?.()) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The address once it actually names a thread.
   *
   * Reading it the moment the answer settles is too early on the sites that
   * write their thread id *after the first reply*: Gemini's address went from
   * `/app` to `/app/<id>` a beat later.
   *
   * Kimi never writes it at all — the address stays `/` for the whole
   * conversation, and the id only exists in the sidebar's own link. There the
   * thread is identified by difference: `baseline` is the list as it was before
   * the question, and the row that appeared since is the one this conversation
   * created.
   *
   * Two new rows is not always somebody else: Kimi briefly lists the live
   * thread and then lists it again, and it also adds rows a beat after the
   * answer. So when the difference is ambiguous, the question itself breaks the
   * tie — a row whose title starts the way the question does is this one. If
   * even that is ambiguous, nothing is returned and the delete says it cannot
   * identify the thread. Guessing here deletes someone else's conversation.
   */
  async settledUrl(
    baseline: readonly ThreadCandidate[] = [],
    question = '',
    timeoutMs = 6000
  ): Promise<string> {
    const idOf = (url: string): string => {
      try {
        const segments = new URL(url).pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1] ?? '';
        return /^[0-9a-zA-Z-]{16,}$/.test(last) && /[0-9]/.test(last) ? last : '';
      } catch {
        return '';
      }
    };
    const named = (url: string) => idOf(url) !== '';
    const appeared = (list: readonly ThreadCandidate[]): string => {
      const known = new Set(baseline.map(row => idOf(row.href)).filter(Boolean));
      const fresh = new Map<string, ThreadCandidate>();
      for (const row of list) {
        const id = idOf(row.href);
        if (id && !known.has(id)) fresh.set(id, row);
      }
      if (fresh.size === 1) return [...fresh.values()][0].href;

      const head = question.trim().slice(0, 10);
      if (fresh.size > 1 && head.length >= 4) {
        const matching = [...fresh.values()].filter(row => row.title.includes(head));
        if (matching.length === 1) return matching[0].href;
      }
      return '';
    };

    const deadline = Date.now() + timeoutMs;
    let url = this.currentUrl();
    let tick = 0;
    while (Date.now() < deadline) {
      if (named(url)) return url;
      // The sidebar is read every other tick: it is an IPC round trip, and the
      // address catches the sites that do put the id there without one.
      if (tick % 2 === 0) {
        const fresh = appeared(await this.threadCandidates());
        if (fresh) return fresh;
      }
      await sleep(200);
      url = this.currentUrl();
      tick += 1;
    }

    const fresh = appeared(await this.threadCandidates());
    return fresh || url;
  }

  /** Is the page empty *right now*? One probe; a page mid-load counts as "no". */
  private async isEmptyNow(driver: PageDriver): Promise<boolean> {
    const probe = await driver.probe().catch(() => null);
    if (!probe) return false;
    return probe.messageCount === 0 && probe.composerText.trim().length === 0;
  }

  /** Zero bubbles and an empty composer: the only observable that means "new". */
  private async pageIsEmpty(driver: PageDriver): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.tuning.newChatMs) {
      await sleep(this.tuning.pollMs);
      if (await this.isEmptyNow(driver)) return true;
    }
    return false;
  }

  /**
   * Fill the composer, submit, and wait until the page proves it noticed.
   *
   * The previous version probed exactly once, 600ms after clicking, and
   * declared failure if nothing had changed by then — which is exactly what a
   * real submission looks like on a slow connection, so it reported
   * SEND_UNCONFIRMED for prompts the page had already accepted. It also claimed
   * in a comment to accept "the composer was cleared" without ever checking it.
   *
   * Submission is now a poll over four independent signals, with escalation only
   * while the composer still holds our text — a slow-but-successful send must
   * never be submitted twice.
   */
  async sendMessage(text: string, requestId: string): Promise<SendOutcome> {
    const before = await this.snapshot();
    const driver = this.driver();

    const filled = await driver.fill(text);
    if (!filled?.ok) {
      throw new Error(`无法写入输入框：${filled?.reason ?? 'UNKNOWN'}（请求未提交，可安全重试）`);
    }

    // Re-read the composer *after* filling. Taking the baseline from the
    // pre-send snapshot would compare against an empty box, so "the composer was
    // cleared" could never fire — which is exactly the signal the old code
    // claimed to use. If the page does not reflect the text back, the signal is
    // disabled rather than reported as already-cleared.
    const primed = await driver.probe();
    const composerBaseline = primed.composerText.trim().length > 0 ? primed.composerText : '';

    const startedAt = Date.now();
    const signals: string[] = [];
    let method = 'none';
    let escalatedEnter = false;
    let escalatedClick = false;

    // Click first. On the real page the composer is a controlled textarea whose
    // Enter handler reads framework state, and a keystroke sent through the
    // window did not submit — the text stayed in the box. Clicking the control
    // is a direct DOM action and is what actually works there.
    const clicked = await driver.clickSend();
    if (clicked?.ok) {
      method = 'button';
      signals.push('click:send');
    } else {
      signals.push(`click:failed(${clicked?.reason ?? 'UNKNOWN'})`);
    }

    while (Date.now() - startedAt < this.tuning.confirmMs) {
      await sleep(this.tuning.pollMs);
      if (driver.isDestroyed()) throw new Error(`${this.siteLabel} 页面已关闭，无法确认提交`);

      let probe: PageProbe;
      try {
        probe = await driver.probe();
      } catch {
        continue;
      }

      const composerCleared = composerBaseline.length > 0 && probe.composerText.trim().length === 0;
      const countGrew = probe.messageCount > before.messageCount;
      const generating = probe.generating;
      const stillFilled = probe.composerText.trim().length > 0;
      const textChanged = probe.conversationText !== before.conversationText;

      if (composerCleared) signals.push('composer:cleared');
      if (countGrew) signals.push('messages:grew');
      if (generating) signals.push('generating');
      if (textChanged) signals.push('transcript:changed');

      // A changed transcript on its own is not evidence. Switching or creating a
      // conversation rewrites the whole transcript while the prompt is still
      // sitting unsent in the composer — which is exactly how a task came to be
      // reported as sent and then timed out waiting for an answer that was never
      // requested. Text only counts once the composer no longer holds it.
      const submitted =
        composerCleared || countGrew || generating || (textChanged && !stillFilled);

      if (submitted) {
        this.waits.set(requestId, new AbortController());
        return {
          submitted: true,
          snapshotBefore: before,
          method,
          signals: [...new Set(signals)],
          waitedMs: Date.now() - startedAt
        };
      }

      const elapsed = Date.now() - startedAt;

      // Escalation: the composer still holds our text, so the click did nothing.
      // A real keystroke is the next thing a user would try.
      if (!escalatedEnter && elapsed > this.tuning.enterAfterMs && stillFilled) {
        escalatedEnter = true;
        await driver.pressEnter();
        signals.push('enter');
        method = 'enter';
        continue;
      }

      // Last resort: click again. Only reached when neither a click nor a
      // keystroke did anything, which points at a slow page rather than a wrong
      // control.
      if (!escalatedClick && elapsed > this.tuning.clickRetryAfterMs && stillFilled) {
        escalatedClick = true;
        const retry = await driver.clickSend();
        signals.push(retry?.ok ? 'click:retry' : `click:failed(${retry?.reason ?? 'UNKNOWN'})`);
        if (retry?.ok) method = 'button:retry';
        continue;
      }
    }

    const remaining = (await driver.probe().catch(() => null))?.composerText.trim().length ?? -1;
    throw new Error(
      `SEND_UNCONFIRMED：${String(this.tuning.confirmMs)}ms 内未观察到页面提交迹象，未自动重发以免重复提问。` +
        `（输入框仍保留 ${String(remaining)} 字，已尝试：${signals.join(', ')}）`
    );
  }

  /**
   * Wait for the answer that belongs to this request.
   *
   * Acceptance is driven by text stability, not by the stop button: a selector
   * we cannot verify must never be the only thing standing between us and a
   * timeout. A streaming answer changes on every poll; a finished one does not.
   * The stop button, when it does match, only lengthens the required stillness.
   *
   * `sentText` is stripped from the captured text because the user bubble is
   * part of the transcript and the prompt contains example protocol blocks.
   */
  async waitForAnswer(
    requestId: string,
    snapshot: MessageSnapshot,
    timeoutMs: number,
    sentText?: string
  ): Promise<string> {
    const controller = this.waits.get(requestId) ?? new AbortController();
    this.waits.set(requestId, controller);
    const driver = this.driver();
    const startedAt = Date.now();
    let candidate = '';
    let stableSince = 0;
    let stableCount = 0;
    let sawIncomplete = false;
    let lastSeen: PageProbe | null = null;

    try {
      while (Date.now() - startedAt < timeoutMs) {
        if (controller.signal.aborted) throw new Error('WAIT_CANCELLED');
        await sleep(this.tuning.pollMs);
        if (controller.signal.aborted) throw new Error('WAIT_CANCELLED');

        let probe: PageProbe;
        try {
          probe = await driver.probe();
        } catch {
          continue; // Page mid-navigation; keep waiting until timeout.
        }
        lastSeen = probe;

        const next = selectAnswerText(probe, snapshot, sentText);
        if (!next) continue;

        // A candidate that still contains our own prompt is not an answer.
        if (containsEcho(next, sentText)) continue;

        // Clean before judging stillness, not after it. 「Gemini 说」 is a speaker
        // label with nothing behind it yet, and while the model is thinking it is
        // perfectly still — three identical polls, then returned as the answer,
        // cleaned to an empty string, and reported as 「页面没有给出可读的回答」
        // for a page that answered two seconds later. Raw page text is not the
        // unit of comparison; the answer is.
        const cleaned = normalizeAnswerText(stripChrome(cutSpeakerLabels(next)));
        if (!cleaned) continue;

        if (cleaned === candidate) {
          stableCount += 1;
          const stillFor = Date.now() - stableSince;
          const required = probe.generating ? Math.max(this.tuning.settleMs * 2.5, 3000) : this.tuning.settleMs;
          if (!answerLooksComplete(cleaned)) {
            sawIncomplete = true;
            continue;
          }
          if (stableCount >= 3 && stillFor >= required) {
            // Already cleaned, at the point where page text becomes answer text:
            // furniture, speaker labels and citation chips never reach a bubble
            // or a synthesis.
            return cleaned;
          }
        } else {
          candidate = cleaned;
          stableSince = Date.now();
          stableCount = 1;
        }
      }
    } finally {
      this.waits.delete(requestId);
    }

    // Report what the page looked like, not just that nothing arrived. A bare
    // timeout is unactionable: the interesting facts are whether the transcript
    // grew, whether a bubble was selectable, and whether the page is even still
    // the same conversation.
    //
    // The two branches are different facts and used to read alike. "Still
    // changing" means the page is working and simply outran us — the answer will
    // land on the page a moment later. "Nothing found" means we never had text
    // to watch. Collapsing them into one message made a slow answer look exactly
    // like a broken one.
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(
      sawIncomplete
        ? `ANSWER_TIMEOUT：${String(seconds)} 秒内回答一直在变化，没能稳定下来（页面多半还在生成）。` +
            `右侧页面稍后可能出现完整回答，刷新即可看到。`
        : `ANSWER_TIMEOUT：${String(seconds)} 秒内没有确认到属于本轮的新回答。` +
            `页面 ${lastSeen ? `${String(lastSeen.messageCount)} 条回答 / ${String(lastSeen.conversationText.length)} 字` : '不可读'}` +
            `（发送前 ${String(snapshot.messageCount)} 条 / ${String(snapshot.conversationText.length)} 字），` +
            `回答选择器 ${lastSeen?.chosen.assistant ?? '未命中'}，` +
            `${lastSeen && lastSeen.url !== snapshot.url ? `页面已跳转到 ${lastSeen.url}` : '页面未跳转'}`
    );
  }

  cancelWait(requestId: string) {
    const controller = this.waits.get(requestId);
    if (controller) {
      controller.abort();
      this.waits.delete(requestId);
    }
  }

  cancelAllWaits() {
    for (const [id, controller] of this.waits) {
      controller.abort();
      this.waits.delete(id);
    }
  }
}

/**
 * Decide which text is this turn's answer.
 *
 * 1. If the page exposes assistant messages at all, only a *new* one can be the
 *    answer. Nothing else is considered while one exists.
 * 2. With no assistant message on the page, the transcript tail is considered.
 *    This is not a fallback for a broken page — it is the *only* path on a page
 *    that exposes no message attributes at all, which is what chatgpt.com ships
 *    today (verified: `data-message-author-role`, `article` and `.markdown` all
 *    match nothing, and the only surviving hooks are build-hashed class names).
 *
 * The tail used to have to contain the protocol marker, because every prompt
 * asked for one. The rebuild stopped asking, so the marker never appears and the
 * gate made this branch unreachable: a finished answer sat on the page while the
 * wait timed out. Removing the gate then exposed two more ways to miss a reply
 * that was already on screen — the prompt's own echo sitting in front of it
 * (see `cutPrompt`) and a length floor that rejected "8" — so a finished answer
 * is now whatever is left after our own message and the page's furniture are
 * removed. Stillness is still enforced by `waitForAnswer`, which requires three
 * identical polls.
 */
export function selectAnswerText(probe: PageProbe, snapshot: MessageSnapshot, sentText?: string): string {
  const grew = probe.messageCount > snapshot.messageCount;
  const bubbleFresh = grew && probe.lastText.trim().length > 0 && probe.lastText !== snapshot.lastText;

  if (probe.messageCount > 0) return bubbleFresh ? probe.lastText : '';

  const prefix = commonPrefixLength(snapshot.conversationText, probe.conversationText);
  const fresh = probe.conversationText.slice(prefix);
  const answer = normalizeAnswerText(stripChrome(cutSpeakerLabels(cutPrompt(fresh, sentText))));

  if (!answer) return '';

  if (answer.length < MIN_TAIL_CHARS) {
    // While the page says it is still generating, a short tail is its own status
    // line ("思考中") rather than a result.
    if (probe.generating) return '';
    // With the page idle, the other short thing that stabilises is the chat
    // title the site generates from the question — "列出工作区文件" for a prompt
    // that starts the same way. It is the question in fewer words, so a short
    // tail made of the question's own characters is not an answer.
    const squeezed = answer.replace(/\s+/g, '');
    if (squeezed.length >= 4 && sentText && sentText.replace(/\s+/g, '').includes(squeezed)) return '';
  }

  return answer;
}
