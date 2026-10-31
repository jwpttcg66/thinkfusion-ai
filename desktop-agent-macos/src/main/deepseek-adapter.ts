import type { WebContentsView } from 'electron';
import type { DeepSeekDiagnostics, DeepSeekStatus, PageDiagnostics } from '../shared/contracts';

/**
 * Everything the adapter can say about the page.
 *
 * Deliberately not the whole `DeepSeekDiagnostics`: where the native view sits
 * is a fact about the window, not about the page, so the main process adds it.
 * Keeping the boundary here means the adapter never needs to know that a
 * `WebContentsView` exists.
 */
export type PageReport = Omit<DeepSeekDiagnostics, 'view' | 'dragging'>;
import { PROTOCOL } from '../shared/contracts';
import { stripEcho, containsEcho } from '../shared/protocol';

const ALLOWED_HOSTS = new Set(['chat.deepseek.com']);

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

export function isAllowedDeepSeekUrl(raw: string): boolean {
  return isAllowedHostUrl(raw, ALLOWED_HOSTS);
}

/** Bumped whenever the probe changes shape, so a stale report is identifiable. */
export const PROBE_VERSION = '3';

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
export const SELECTORS = {
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
  assistant: ['[data-message-author-role="assistant"]', '.ds-markdown', '[class*="markdown"]'],
  passwordField: ['input[type="password"]']
};

export interface MessageSnapshot {
  messageCount: number;
  lastText: string;
  url: string;
  capturedAt: number;
  /** Page text with the composer removed: the cheapest reliable change signal. */
  conversationText: string;
  composerText: string;
}

export interface PageProbe {
  url: string;
  title: string;
  hasPasswordField: boolean;
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
}

const PROBE_SCRIPT = (selectors: typeof SELECTORS) => `(() => {
  const selectors = ${JSON.stringify(selectors)};

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
      .map((el) => (el.innerText || '').trim())
      .filter((text) => text.length > 0);
    if (texts.length) {
      assistantTexts = texts;
      chosen.assistant = selector;
      break;
    }
  }

  // Conversation text for change detection. Prefer the tallest scrollable
  // container: reading document.body.innerText on a long conversation is both
  // slower and noisier (sidebars, banners) than the transcript itself.
  let scrollRoot = null;
  let bestScore = 0;
  for (const el of document.querySelectorAll('div, main, section')) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 320 || rect.height < 240) continue;
    if (el.scrollHeight - el.clientHeight <= 0) continue;
    if (el.scrollHeight > bestScore) { bestScore = el.scrollHeight; scrollRoot = el; }
  }
  if (scrollRoot) chosen.conversation = 'structural:tallest-scroll-container';

  const rawText = ((scrollRoot || document.body).innerText || '').trim();
  const conversationText = (composerText
    ? rawText.split(composerText).join('')
    : rawText).slice(-120000);

  return {
    url: location.href,
    title: document.title,
    hasPasswordField: firstMatch('passwordField').length > 0,
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

const FILL_SCRIPT = (selectors: typeof SELECTORS, payload: string) => `(() => {
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

  const written = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    ? target.value
    : (target.innerText || target.textContent || '');

  return {
    ok: written.trim().length > 0,
    reason: written.trim().length ? undefined : 'INPUT_NOT_FILLED',
    kind: target.tagName.toLowerCase()
  };
})()`;

const CLICK_SEND_SCRIPT = (selectors: typeof SELECTORS) => `(() => {
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

const FOCUS_SCRIPT = (selectors: typeof SELECTORS) => `(() => {
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

/** The one place that knows this is Electron. */
export function createElectronDriver(view: WebContentsView, selectors: typeof SELECTORS = SELECTORS): PageDriver {
  return {
    url: () => view.webContents.getURL(),
    isDestroyed: () => view.webContents.isDestroyed(),
    probe: async () => (await view.webContents.executeJavaScript(PROBE_SCRIPT(selectors), true)) as PageProbe,
    fill: async text =>
      (await view.webContents.executeJavaScript(FILL_SCRIPT(selectors, JSON.stringify(text)), true)) as {
        ok: boolean;
        reason?: string;
        kind?: string;
      },
    clickSend: async () =>
      (await view.webContents.executeJavaScript(CLICK_SEND_SCRIPT(selectors), true)) as {
        ok: boolean;
        reason?: string;
        label?: string;
      },
    pressEnter: async () => {
      // Focus inside the page first: the keystroke has to land in the composer,
      // and the DOM focus may have drifted since the fill.
      await view.webContents.executeJavaScript(FOCUS_SCRIPT(SELECTORS), true);
      view.webContents.focus();
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
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
}

export const DEFAULT_TUNING: AdapterTuning = {
  confirmMs: 20000,
  pollMs: 700,
  settleMs: 2000,
  enterAfterMs: 3000,
  clickRetryAfterMs: 8000
};

export class DeepSeekAdapter {
  private waits = new Map<string, AbortController>();
  private tuning: AdapterTuning = { ...DEFAULT_TUNING };
  private readonly hosts: ReadonlySet<string>;
  private readonly siteLabel: string;

  /**
   * `options` exists so a second site can reuse this driver instead of getting
   * a copy of it. The only things that differ between chat.deepseek.com and
   * chatgpt.com are the allowed hosts and the wording of the status detail —
   * everything else (probe, send, wait, echo stripping) is site-agnostic.
   */
  constructor(
    private readonly getDriver: () => PageDriver | null,
    options: { hosts?: ReadonlySet<string>; siteLabel?: string } = {}
  ) {
    this.hosts = options.hosts ?? ALLOWED_HOSTS;
    this.siteLabel = options.siteLabel ?? 'DeepSeek';
  }

  private isAllowed(url: string): boolean {
    return isAllowedHostUrl(url, this.hosts);
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
    try {
      const probe = await this.probe();
      const loggedIn = !probe.hasPasswordField;
      return {
        url: probe.url,
        pageReady: probe.hasInput,
        loggedIn,
        hasInput: probe.hasInput,
        hasSendButton: probe.hasSendButton,
        generating: probe.generating,
        messageCount: probe.messageCount,
        detail: !loggedIn
          ? '需要在内嵌页面完成 DeepSeek 登录'
          : probe.hasInput
            ? undefined
            : '未找到输入框，页面结构可能已变化',
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
        detail: error instanceof Error ? error.message : String(error)
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
      selectors: SELECTORS as unknown as Record<string, string[]>,
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
      if (driver.isDestroyed()) throw new Error('DeepSeek 页面已关闭，无法确认提交');

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

        if (next === candidate) {
          stableCount += 1;
          const stillFor = Date.now() - stableSince;
          const required = probe.generating ? Math.max(this.tuning.settleMs * 2.5, 3000) : this.tuning.settleMs;
          if (!answerLooksComplete(next)) {
            sawIncomplete = true;
            continue;
          }
          if (stableCount >= 3 && stillFor >= required) return next;
        } else {
          candidate = next;
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
    throw new Error(
      sawIncomplete
        ? 'ANSWER_TIMEOUT：捕获到的回答一直没有结束（JSON 未闭合），可能是页面仍在生成或结构已变化'
        : `ANSWER_TIMEOUT：未确认到属于本轮的新回答。` +
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
 * 2. With no assistant message on the page, the transcript tail is considered —
 *    but only when it carries the protocol marker. That restriction is the fix
 *    for a real failure: right after a send, the first thing that stabilises on
 *    a fresh conversation is the chat title, the composer toggles and the footer
 *    disclaimer, and a 33-character capture of that chrome was accepted as the
 *    answer while the real reply was still streaming.
 *
 * The echo of our own prompt is removed from the tail first — it contains
 * example protocol blocks that would otherwise parse as a real message.
 */
export function selectAnswerText(probe: PageProbe, snapshot: MessageSnapshot, sentText?: string): string {
  const grew = probe.messageCount > snapshot.messageCount;
  const bubbleFresh = grew && probe.lastText.trim().length > 0 && probe.lastText !== snapshot.lastText;

  if (probe.messageCount > 0) return bubbleFresh ? probe.lastText : '';

  const prefix = commonPrefixLength(snapshot.conversationText, probe.conversationText);
  const tail = stripEcho(probe.conversationText.slice(prefix), sentText).trim();

  return tail.includes(PROTOCOL) ? tail : '';
}
