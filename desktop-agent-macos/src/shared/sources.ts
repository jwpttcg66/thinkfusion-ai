/**
 * The web pages this app embeds.
 *
 * Each source gets its own `WebContentsView` and its own persistent partition,
 * so two logins never share cookies and one site's storage cannot be read by
 * the other. Only one is on screen at a time — the rail on the right edge
 * switches which — but they all stay alive, because a page that gets torn down
 * and reloaded loses whatever the model was in the middle of writing.
 *
 * `planning: true` marks the single source the agent actually drives. The rest
 * are embedded so a person can read or ask by hand; wiring them into the
 * planning loop is a separate step, and the README says so.
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
}

export const PAGE_SOURCES: readonly PageSource[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    glyph: 'D',
    url: 'https://chat.deepseek.com/',
    hosts: ['chat.deepseek.com'],
    planning: true
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
    planning: false
  }
];

export function findSource(id: string): PageSource | undefined {
  return PAGE_SOURCES.find(source => source.id === id);
}

/**
 * Whether a source may navigate to a URL.
 *
 * Same rules as the DeepSeek allow-list: https only, no credentials in the
 * URL, and the hostname must be one the source declared. Sub-domains are not
 * matched by suffix — `evil-chatgpt.com` ends with `chatgpt.com` and would slip
 * through a `endsWith` check.
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
