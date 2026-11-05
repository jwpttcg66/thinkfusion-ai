/**
 * 证据的公共形状：页面给出的引用链接、内容指纹、URL 归一。
 *
 * 这一层放在 `shared`，因为三个地方都要用同一套判定，各写一份迟早会不一致：
 *
 * 1. 页面驱动读出「这条回答里带哪些链接」；
 * 2. 辩论把链接变成带来源元数据的证据（AC-09）；
 * 3. 去重与同源识别（AC-10）靠的就是这里的指纹和 `canonicalUrl`。
 *
 * 三条边界，写在这里是为了以后不在别处偷偷放宽：
 *
 * - **指纹不是加密哈希**，也不用于安全判断。它只回答「这两段文字是不是同一段」，
 *   所以用 FNV-1a 双种子拼 16 位十六进制，没有依赖、跨平台稳定、肉眼能比对。
 * - **`canonicalUrl` 只在已知的跳转包装上展开**（Google / Bing / DuckDuckGo /
 *   知乎的 `/url?…` 这类）。它不发网络请求，所以「最终 URL」只在这层包装被
 *   认出来时才有值；认不出来就留空，不拿原始地址冒充最终地址。
 * - **同源不等于同指纹**。两个 URL 的指纹不同，也可能是同一份原始材料被转载。
 *   指纹去重和来源谱系是两个判断，分别由 `fingerprintOf` 与 `originKeyOf` 负责，
 *   不要合成一个「重复度」分数。
 */

/**
 * 页面上读到的引用链接。字段取自 DOM，不加推断。
 *
 * `finalUrl` 只在跳转包装被展开时存在（见 `canonicalUrl`）；`fetchedAt` 是
 * 读到这条链接的时间，不是页面发布的时间——我们打不开这些页面，就不能假装
 * 知道它们什么时候发布。
 */
export interface PageCitation {
  /** DOM 里写的地址，原样保留。 */
  url: string;
  /** 展开已知跳转包装后的地址；没有包装或展开失败时为空。 */
  finalUrl?: string;
  /** 链接的 `title` 属性或页面标题，能读到才有。 */
  title?: string;
  /** 链接上显示的文字（「来源」「Redis 文档」之类）。 */
  anchorText?: string;
  /** 读到这条链接的时间（毫秒时间戳）。 */
  fetchedAt?: number;
  /** 读到链接时页面所在的地址。 */
  pageUrl?: string;
  /** 哪个通道给的（agentId / sourceId）。 */
  sourceId?: string;
}

/** 去重后的一批链接，附上「为什么留下这几条」。 */
export interface CitationDigest {
  citations: PageCitation[];
  /** 被丢掉的数量，按原因分开——不静默丢弃。 */
  dropped: { notHttp: number; duplicate: number; beyondCap: number };
}

/** 只看跳转包装的查询参数名。顺序有含义：先看常见的 `url`，再看 `q`。 */
const REDIRECT_PARAMS = ['url', 'q', 'u', 'target', 'to', 'dest', 'destination', 'redirect'];

/** 这些查询参数只影响来源统计，不改变指向的内容。 */
const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'spm',
  'scm',
  'from',
  'ref',
  'ref_src',
  'referrer',
  'source',
  'share',
  'share_token',
  'share_source',
  'scene',
  'sa',
  'ved',
  'ei',
  'usg',
  'si',
  'feature',
  'trk',
  'trackingid'
]);

/** `utm_*` 全系列一起丢。 */
function isTracking(name: string): boolean {
  return TRACKING_PARAMS.has(name) || name.toLowerCase().startsWith('utm_');
}

/**
 * 展开已知跳转包装。认不出来就原样返回（不是错误）。
 *
 * 判据分两层：先看主机是不是已知的跳转服务，再退一步看路径里是否有
 * `/url`、`/l/`、`/ck/a` 这类入口且参数里带着一个 http 地址。第二层是
 * 通用规则，覆盖站点自己搭的跳转；参数值必须真的能解析成 http(s) 地址才认，
 * 所以不会把普通查询串误当成跳转。
 */
export function unwrapRedirect(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');
  const known =
    /(^|\.)google\.[a-z.]+$/.test(host) ||
    /(^|\.)bing\.com$/.test(host) ||
    /(^|\.)duckduckgo\.com$/.test(host) ||
    host === 'link.zhihu.com' ||
    host === 'link.juejin.cn';

  for (const name of REDIRECT_PARAMS) {
    const value = parsed.searchParams.get(name);
    if (!value) continue;
    if (known || /(^|\/)(url|l|ck\/a|redirect|link)$/.test(path)) {
      const decoded = decodeParam(value);
      if (decoded) return decoded;
    }
  }
  return raw;
}

/** 参数值可能被百分号编码、也可能是 Bing 的 `a1<base64url>` 形式。 */
function decodeParam(value: string): string | null {
  const candidates = [value];
  if (value.startsWith('a1')) candidates.push(decodeBase64Url(value.slice(2)));
  try {
    candidates.push(decodeURIComponent(value));
  } catch {
    // 不是编码过的，就不用这一份。
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      return url.href;
    } catch {
      // 下一份。
    }
  }
  return null;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64url 解码，不依赖 `Buffer`：这个模块也会被打进渲染进程，
 * 那里没有 Node 的全局对象。解不出来就返回空串，由调用方当成「没展开」。
 */
function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index === -1) return '';
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return '';
  }
}

/**
 * 同一个地址的规范形式：解开跳转包装、丢掉锚点与跟踪参数、排好参数顺序、
 * 去掉末尾斜杠。
 *
 * 只做「地址等价」判断，不做内容判断：`?v=1` 与 `?v=2` 是两个地址。
 */
export function canonicalUrl(raw: string): string | null {
  const unwrapped = unwrapRedirect(raw);
  let parsed: URL;
  try {
    parsed = new URL(unwrapped);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  const isDefaultPort =
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTracking(name))
    .sort(([a], [b]) => a.localeCompare(b));

  const query = params.length
    ? `?${params.map(([name, value]) => `${name}=${value}`).join('&')}`
    : '';
  const port = parsed.port && !isDefaultPort ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${host}${port}${pathname}${query}`;
}

/** 从地址里取「站点」：同一站点的不同页面在来源谱系里仍可能互相转载。 */
export function siteOf(raw: string): string {
  try {
    return new URL(unwrapRedirect(raw)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 内容指纹：空白、标点、大小写都不参与比较，剩下的字符算 FNV-1a。
 *
 * 双种子是为了让两段内容碰巧同指纹的概率降到可以忽略；这不是加密哈希，
 * 也不该被用来证明内容「未被篡改」。
 */
export function fingerprintOf(text: string): string {
  const normalized = normalizeForPrint(text);
  if (!normalized) return '';
  return `${fnv1a(normalized, 0x811c9dc5)}${fnv1a(normalized, 0x01000193)}`;
}

function normalizeForPrint(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // 32 位 FNV 质数，乘法用 Math.imul 保证不丢精度。
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 链接地址是否可用作证据来源。只认 http(s)，且必须有主机名。
 *
 * `javascript:`、`mailto:`、`#anchor` 这些在回答气泡里也常见，它们不是来源。
 */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 同一份材料的标识。
 *
 * 顺序是有含义的：能拿到地址就按地址归一（`url:`），拿不到地址才退回内容指纹
 * （`fp:`）。**两个站引用同一个地址 → 同一个 key**；两段文字相同但地址不同 →
 * 只有指纹那一层能认出来，所以调用方要把两者都算进来（见 debate/evidence.ts）。
 */
export function originKeyOf(input: { url?: string; finalUrl?: string; fingerprint?: string }): string | null {
  for (const candidate of [input.finalUrl, input.url]) {
    if (!candidate) continue;
    const canonical = canonicalUrl(candidate);
    if (canonical) return `url:${canonical}`;
  }
  if (input.fingerprint) return `fp:${input.fingerprint}`;
  return null;
}

/**
 * 一批链接 → 去重后的链接。
 *
 * 按 `canonicalUrl` 去重，保留第一次出现的那条（原始 `url` 不覆盖），
 * 并把展开后的地址补到 `finalUrl`。超出 `cap` 的丢掉并计数——链接抓取是
 * 为证据服务的，一条回答挂 40 个链接只说明它列了参考资料。
 */
export function digestCitations(
  citations: readonly PageCitation[],
  options: { cap?: number; pageUrl?: string; sourceId?: string; now?: number } = {}
): CitationDigest {
  const cap = options.cap ?? 12;
  const dropped = { notHttp: 0, duplicate: 0, beyondCap: 0 };
  const seen = new Set<string>();
  const kept: PageCitation[] = [];

  for (const citation of citations) {
    const raw = citation.url?.trim();
    if (!raw) continue;
    let absolute = raw;
    // 页面脚本已经解析过相对地址；驱动层也可能传来相对地址（fixture、旧调用），
    // 这里再兜一次，免得把 `#/s/xxx` 当成来源。
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && options.pageUrl) {
      try {
        absolute = new URL(raw, options.pageUrl).href;
      } catch {
        dropped.notHttp += 1;
        continue;
      }
    }
    if (!isHttpUrl(absolute)) {
      dropped.notHttp += 1;
      continue;
    }
    // 展开跳转包装只在认得出包装时有结果；没展开就把 `finalUrl` 留空，
    // 不拿原始地址冒充「跟随后得到的地址」。
    const unwrapped = unwrapRedirect(absolute);
    const finalUrl = unwrapped !== absolute && isHttpUrl(unwrapped) ? unwrapped : undefined;
    const canonical = canonicalUrl(finalUrl ?? absolute);
    if (!canonical || seen.has(canonical)) {
      dropped.duplicate += 1;
      continue;
    }
    if (kept.length >= cap) {
      dropped.beyondCap += 1;
      continue;
    }
    seen.add(canonical);
    kept.push({
      ...citation,
      url: absolute,
      finalUrl: finalUrl ?? citation.finalUrl,
      pageUrl: citation.pageUrl ?? options.pageUrl,
      sourceId: citation.sourceId ?? options.sourceId,
      fetchedAt: citation.fetchedAt ?? options.now
    });
  }

  return { citations: kept, dropped };
}
