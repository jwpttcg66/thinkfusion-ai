/**
 * The web pages this app embeds, and the rules for changing them.
 *
 * Each source gets its own `WebContentsView` and its own persistent partition,
 * so two logins never share cookies and one site's storage cannot be read by
 * the other. Only one is on screen at a time — the rail on the right edge
 * switches which — but they all stay alive, because a page that gets torn down
 * and reloaded loses whatever the model was in the middle of writing.
 *
 * `planning: true` marks the single source the agent actually drives. The rest
 * are embedded so a person can read or ask by hand.
 *
 * **The list is no longer a constant.** Sites move (`kimi.moonshot.cn` became
 * `kimi.com`), people run regional mirrors, and a URL baked into the bundle
 * turns a working channel into a dead one with no way back except a new
 * release. So the shipped defaults live here and the user's edits live in
 * `userData/sources.json`; `resolveSources` is the one place the two are
 * combined, and it is a pure function so the merge can be asserted.
 */
export interface PageSource {
  id: string;
  label: string;
  /** One character for the rail button; two would not fit at 46px. */
  glyph: string;
  url: string;
  /** Hostnames this view may navigate to. Everything else is denied. */
  hosts: string[];
  planning: boolean;
  /**
   * Whether this source is part of the app right now.
   *
   * A disabled source keeps its settings and disappears from the rail — it is
   * not deleted, because "turn this off for now" and "remove this" are
   * different requests and only one of them should lose the URL.
   */
  enabled: boolean;
  /** Added in 设置 rather than shipped. Built-ins cannot be removed. */
  custom?: boolean;
}

/**
 * The shipped defaults.
 *
 * Two sources start enabled — ChatGPT and DeepSeek — because the app is a
 * cross-check, and a cross-check with one page is just a chatbot. Both have a
 * complete selector profile and a known sign-in path, so a fresh install has
 * somewhere to ask and a second opinion to compare it with.
 *
 * `deepseek` keeps its `planning: true` flag: it is the reference site — the one
 * the probe's structural heuristics were tuned against — and so is the right
 * planner.
 *
 * `kimi` ships off because it answers as a guest, so nothing breaks when it is
 * on — but a guest is put in the queue behind subscribers at busy times
 * （「和Kimi聊天的人太多了」）, and that is a poor first impression for a page
 * someone did not ask for. It has a full selector profile, so switching it on in
 * 设置 is all it takes; no 「更新样式」 needed.
 *
 * `workbuddy` is off for the original reason: no selector profile and no address
 * that is right for everyone. Turning it on is a guess, and 「更新样式」 is the
 * first thing to do afterwards.
 *
 * `gemini` ships off because it is the only channel that needs a Google account
 * to be worth having: signed out it answers, but nothing is saved and the answer
 * is weaker, so switching it on without an account looks like a broken channel
 * rather than a login prompt. The profile is complete (see
 * `adapters/providers/gemini.ts`), so turning it on and signing in once is all
 * it takes.
 */
export const BUILTIN_SOURCES: readonly PageSource[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    glyph: 'D',
    url: 'https://chat.deepseek.com/',
    hosts: ['chat.deepseek.com'],
    planning: true,
    enabled: true
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    glyph: 'G',
    url: 'https://chatgpt.com/',
    // Sign-in hops through an identity provider, and a view that cannot reach
    // the IdP cannot log in at all. These are listed one by one rather than
    // matched by suffix: `endsWith('openai.com')` would also admit
    // `evil-openai.com`, and the whole point of the list is that it is exact.
    hosts: [
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'auth.openai.com',
      'auth0.openai.com',
      'accounts.openai.com',
      'appleid.apple.com',
      'accounts.google.com',
      'login.microsoftonline.com'
    ],
    planning: false,
    enabled: true
  },
  {
    id: 'kimi',
    label: 'Kimi',
    glyph: 'K',
    url: 'https://kimi.moonshot.cn/',
    hosts: ['kimi.moonshot.cn', 'kimi.com', 'www.kimi.com'],
    planning: false,
    enabled: false
  },
  {
    id: 'gemini',
    label: 'Gemini',
    // Not 'G': ChatGPT already owns that letter in the rail, and two buttons
    // with the same initial in a 46px column is a coin flip every time. The
    // four-pointed star is the shape Gemini's own mark is built from.
    glyph: '✦',
    url: 'https://gemini.google.com/app?hl=zh',
    // Sign-in leaves this host for Google's account flow. The list stays exact
    // rather than `endsWith('google.com')`, for the same reason as ChatGPT's:
    // the point of the list is that it is a closed set.
    hosts: [
      'gemini.google.com',
      'accounts.google.com',
      'consent.google.com',
      'myaccount.google.com',
      'ogs.google.com',
      'www.google.com'
    ],
    planning: false,
    enabled: false
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    glyph: 'W',
    // Deliberately empty: there is no address that is right for everyone, and
    // guessing one would produce a page that loads someone else's product. The
    // settings panel says so instead of pretending.
    url: '',
    hosts: [],
    planning: false,
    enabled: false
  }
];

/** What the user changed about a source, as stored on disk. */
export interface SourceOverride {
  url?: string;
  enabled?: boolean;
}

/** The whole persisted file. */
export interface StoredSources {
  overrides: Record<string, SourceOverride>;
  custom: PageSource[];
  /**
   * Whether enabled web sources are opened when the app starts.
   *
   * Absent or `true` keeps the old behaviour (create every enabled view at
   * launch). `false` leaves them closed until the rail, a refresh, or an ask
   * needs them — so a cold start does not load every chat site up front.
   */
  openOnLaunch?: boolean;
}

export const EMPTY_STORED_SOURCES: StoredSources = { overrides: {}, custom: [] };

/** Absent means on: older `sources.json` files never had the field. */
export function sourcesOpenOnLaunch(stored: StoredSources): boolean {
  return stored.openOnLaunch !== false;
}

/**
 * 顶栏「页面就绪 / 未登录 / 诊断」是否显示。
 *
 * 只跟设置里的「启动时打开网页源」走：打开就显示，关闭就不显示。
 * 不看此刻有没有 WebContentsView——关掉后提问临时建页也不把顶栏加回来。
 */
export function showWebSourceStatusBar(openOnLaunch: boolean): boolean {
  return openOnLaunch;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

/**
 * Hosts after a URL edit.
 *
 * The declared hosts stay and the new URL's host is added. Replacing the list
 * would break sign-in on the sites that hop through an identity provider;
 * leaving it alone would deny the new address outright, which is the failure
 * that makes someone think the app is broken after they fixed the URL.
 */
function hostsFor(base: PageSource, url: string): string[] {
  const host = hostOf(url);
  if (!host || base.hosts.includes(host)) return [...base.hosts];
  return [...base.hosts, host];
}

function applyOverride(base: PageSource, override: SourceOverride | undefined): PageSource {
  if (!override) return { ...base, hosts: [...base.hosts] };
  const url = override.url ?? base.url;
  return {
    ...base,
    url,
    enabled: override.enabled ?? base.enabled,
    hosts: hostsFor(base, url)
  };
}

/**
 * The live list: shipped defaults, then the user's edits, then anything added.
 *
 * Order matters for the rail — built-ins keep their shipped order so the
 * buttons do not move around after an edit — and custom sources come last in
 * the order they were added.
 */
export function resolveSources(stored: StoredSources = EMPTY_STORED_SOURCES): PageSource[] {
  const built = BUILTIN_SOURCES.map(base => applyOverride(base, stored.overrides[base.id]));
  const custom = stored.custom.map(extra => applyOverride({ ...extra, custom: true }, stored.overrides[extra.id]));
  return [...built, ...custom];
}

export function sourceById(sources: readonly PageSource[], id: string): PageSource | undefined {
  return sources.find(source => source.id === id);
}

/**
 * The source the agent plans through.
 *
 * Prefers the shipped planner, but only while it is switched on: turning it off
 * in 设置 has to mean something, and the agent still needs somewhere to ask. The
 * fallback is the first enabled source, which is why the settings rule is "leave
 * at least one on" rather than "this one cannot be turned off".
 */
export function planningSource(sources: readonly PageSource[]): PageSource | undefined {
  return sources.find(source => source.planning && source.enabled) ?? sources.find(source => source.enabled);
}

/**
 * Whether a source may navigate to a URL.
 *
 * https only, no credentials in the URL, and the hostname must be one the
 * source declared. Sub-domains are not matched by suffix — `evil-chatgpt.com`
 * ends with `chatgpt.com` and would slip through an `endsWith` check.
 */
export function isAllowedSourceUrl(source: PageSource, raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    return source.hosts.includes(url.hostname);
  } catch {
    return false;
  }
}

export interface UrlCheck {
  ok: boolean;
  /** The normalized address, when `ok`. */
  url?: string;
  /** What to tell the user, when not. */
  error?: string;
}

/**
 * Turn whatever was typed into the address to load.
 *
 * A bare `kimi.com` is what people type, so the scheme is added rather than
 * demanded. `http:` is refused rather than upgraded silently: the whole
 * allow-list is https-only, and quietly rewriting the address someone gave you
 * is how a redirect loop becomes a mystery.
 */
export function normalizeSourceUrl(raw: string): UrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: '请填写网址' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: '这个网址看不懂，检查一下有没有拼错' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: '只支持 https:// 开头的网址' };
  if (parsed.username || parsed.password) return { ok: false, error: '网址里不能带账号密码' };
  if (!parsed.hostname.includes('.')) return { ok: false, error: '网址缺少域名' };
  return { ok: true, url: parsed.href };
}

/**
 * The id and glyph for a source added in 设置.
 *
 * The glyph is the first letter of the name, because the rail has room for one
 * character and inventing an icon for a site we know nothing about is worse
 * than showing its initial.
 */
export function makeCustomSource(input: { label: string; url: string }, existing: readonly PageSource[]): PageSource {
  const label = input.label.trim().slice(0, 24);
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  let id = `custom-${slug || 'source'}`;
  let n = 2;
  while (existing.some(source => source.id === id)) {
    id = `custom-${slug || 'source'}-${String(n)}`;
    n += 1;
  }
  return {
    id,
    label,
    glyph: (label[0] ?? '?').toUpperCase(),
    url: input.url,
    hosts: hostOf(input.url) ? [hostOf(input.url)] : [],
    planning: false,
    enabled: true,
    custom: true
  };
}
