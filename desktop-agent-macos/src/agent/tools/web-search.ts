/**
 * 联网搜索。
 *
 * 为什么必须有这个工具，而不是让模型自己 `web.fetch` 一个搜索页：
 * 搜索页不返回结果，返回的是给人看的 HTML，甚至人机验证。模型抓一次
 * `https://html.duckduckgo.com/html/?q=…` 拿到的是「Please complete the
 * following challenge」——然后它要么胡编，要么把这张验证页当资料引用。
 * 搜索必须落到一个**返回结构化结果**的后端上。
 *
 * 四种带凭据的提供方（brave / tavily / serper / searxng）给完整结果列表；
 * 没有凭据时按「谁能真的拿到结果」的顺序退：先借主进程的真浏览器打开 Bing
 * 结果页（受限网络下这是唯一还能拿到列表的免凭据路径），再退到 Bing RSS，
 * 最后是 DuckDuckGo Instant Answer + Wikipedia 摘要，只给定义级答案。
 * 无论退到哪一步，`degraded` 里都必须说清楚——「我只查到摘要」和
 * 「我搜到了八条结果」在界面上不能长得一样。
 *
 * 一条硬规则：这个工具永远不会为了让结果看起来更好看而编造条目。搜不到就是
 * 空数组 + 一句说明，模型据此要么追问、要么改用 web.fetch 读已知地址。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SEARCH_RESULTS,
  FALLBACK_PROVIDER,
  MAX_SEARCH_RESULTS,
  SEARCH_PROVIDER_LABEL,
  configuredProvider,
  type SearchHit,
  type SearchProvider,
  type SearchSettings,
  type WebSearchResult
} from '../../shared/search';
import { isFetchableUrl } from './web-fetch';

export const SEARCH_CONFIG_PATH = path.join(
  os.homedir(), 'Library', 'Application Support', 'ThinkFusion', 'search-config.json'
);

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SNIPPET = 400;

/**
 * 读配置：文件是用户在设置里填的，环境变量是开发/高级入口。
 *
 * 环境变量优先，因为它是「这一次要它用哪家」的意思；文件是「平时用哪家」。
 * 两者都给时，若家不同，环境变量那套整体生效（provider 与 key 一起换），
 * 不会出现「provider 取文件、key 取环境」这种半对半错的组合。
 */
export async function readSearchSettings(): Promise<SearchSettings> {
  const fromEnv: SearchSettings = {};
  if (process.env.BRAVE_API_KEY?.trim()) {
    fromEnv.provider = 'brave';
    fromEnv.apiKey = process.env.BRAVE_API_KEY.trim();
  } else if (process.env.TAVILY_API_KEY?.trim()) {
    fromEnv.provider = 'tavily';
    fromEnv.apiKey = process.env.TAVILY_API_KEY.trim();
  } else if (process.env.SERPER_API_KEY?.trim()) {
    fromEnv.provider = 'serper';
    fromEnv.apiKey = process.env.SERPER_API_KEY.trim();
  } else if (process.env.SEARXNG_URL?.trim()) {
    fromEnv.provider = 'searxng';
    fromEnv.searxngUrl = process.env.SEARXNG_URL.trim();
  }
  if (fromEnv.provider) return fromEnv;

  try {
    const raw = await fs.readFile(SEARCH_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SearchSettings;
    return {
      provider: parsed.provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
      searxngUrl: typeof parsed.searxngUrl === 'string' ? parsed.searxngUrl : undefined
    };
  } catch {
    return {};
  }
}

export interface SearchArgs {
  query: string;
  maxResults?: number;
  /** 只搜某个站点，例如 `github.com`。实现为给查询加 `site:` 限定。 */
  site?: string;
}

export interface WebSearchDeps {
  settings?: SearchSettings;
  fetchImpl?: typeof fetch;
  /**
   * 借主进程浏览器搜一次（可选）。
   *
   * 大多数环境里 HTTP 兜底就够了；但在国内网络下，免凭据的 HTTP 搜索端点
   * 全被挡（Bing RSS 无限重定向、DDG 返回人机验证页），只有真浏览器能走通。
   * 没有这个能力时（普通 node 进程、单元测试）就跳过，行为与以前一致。
   */
  browserSearch?: (query: string, limit: number) => Promise<{
    results: SearchHit[];
    finalUrl?: string;
    pageTitle?: string;
    emptyNote?: string;
  }>;
}

export async function webSearch(args: SearchArgs, options: WebSearchDeps = {}): Promise<WebSearchResult> {
  const started = Date.now();
  const settings = options.settings ?? (await readSearchSettings());
  const doFetch = options.fetchImpl ?? fetch;

  const query = args.query.trim();
  if (!query) throw new Error('搜索词不能为空');
  if (query.length > 300) throw new Error('搜索词超过 300 字符，请缩短');
  const effective = args.site ? `${query} site:${args.site.trim()}` : query;
  const limit = Math.min(Math.max(args.maxResults ?? DEFAULT_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);

  const attempts: WebSearchResult['attempts'] = [];
  const provider = configuredProvider(settings);

  if (provider) {
    try {
      const hit = await runProvider(provider, effective, limit, settings, doFetch);
      if (hit.results.length > 0) {
        return finalize(query, provider, hit, attempts, started);
      }
      attempts.push({ provider, ok: false, note: '返回 0 条结果' });
    } catch (error) {
      attempts.push({ provider, ok: false, note: trimError(error) });
    }
  }

  /**
   * 一级兜底：应用自己的浏览器。
   *
   * 放在 HTTP 兜底之前，是因为它是这里唯一在受限网络下真的能拿到结果列表的
   * 免凭据路径；HTTP 那两条在被挡的时候只会白花一次超时。
   */
  if (options.browserSearch) {
    try {
      const hit = await options.browserSearch(effective, limit);
      if (hit.results.length > 0) {
        return finalize(
          query,
          'browser',
          { results: hit.results },
          attempts,
          started,
          provider
            ? `${SEARCH_PROVIDER_LABEL[provider] ?? provider} 这次没给出结果，下面来自应用内浏览器打开的 Bing 结果页`
            : '没有配置搜索凭据，下面来自应用内浏览器打开的 Bing 结果页（免凭据）'
        );
      }
      attempts.push({ provider: 'browser', ok: false, note: hit.emptyNote ?? '页面上没有结果块' });
    } catch (error) {
      attempts.push({ provider: 'browser', ok: false, note: trimError(error) });
    }
  }

  // 二级兜底：Bing 的 RSS 接口。免凭据，返回的是真正的结果列表（标题/链接/摘要），
  // 不是「可能命中什么」的摘要条目。付费 API 不可用时，这条路径能让「搜一下」
  // 真的有结果，而不是退化成「只查到一段定义」。
  try {
    const hit = await runBingRss(effective, limit, doFetch);
    if (hit.results.length > 0) {
      const why = provider
        ? `${SEARCH_PROVIDER_LABEL[provider] ?? provider} 这次没给出结果，下面来自免凭据的 Bing RSS`
        : '没有配置搜索凭据，下面来自免凭据的 Bing RSS；要更稳的结果列表，在 设置 → 联网搜索 里配一个服务';
      return finalize(query, 'bing', hit, attempts, started, why);
    }
    attempts.push({ provider: 'bing', ok: false, note: '返回 0 条结果' });
  } catch (error) {
    attempts.push({ provider: 'bing', ok: false, note: trimError(error) });
  }

  // 二级兜底：免 key，只要一句定义级答案。失败也不抛，交给下面统一解释。
  try {
    const hit = await runFallback(effective, limit, doFetch);
    if (hit.results.length > 0) {
      return finalize(
        query,
        FALLBACK_PROVIDER,
        hit,
        attempts,
        started,
        '搜索结果列表拿不到，下面只有 DuckDuckGo / Wikipedia 的摘要与相关条目'
      );
    }
    attempts.push({ provider: FALLBACK_PROVIDER, ok: false, note: '没有摘要或相关条目' });
  } catch (error) {
    attempts.push({ provider: FALLBACK_PROVIDER, ok: false, note: trimError(error) });
  }

  return {
    query,
    provider: 'none',
    results: [],
    degraded:
      `这次没有搜到任何结果（试过：${attempts.map(item => item.provider).join('、')}）。` +
      (provider
        ? '可以在 设置 → 联网搜索 里检查凭据是否正确，或换个说法再搜。'
        : '应用内浏览器这条路也没拿到结果：先在右侧随便打开一次 Bing 页面确认网络能访问，或在 设置 → 联网搜索 里填一个搜索服务的 key（Brave / Tavily / Serper）或 SearXNG 实例地址。'),
    tookMs: Date.now() - started,
    attempts
  };
}

/** 把「试过谁、为什么失败」压成一句能给人看的话，且不泄露 key。 */
function trimError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  return message.replace(/[A-Za-z0-9_-]{24,}/g, '***').slice(0, 160);
}

function finalize(
  query: string,
  provider: string,
  hit: { results: SearchHit[]; answer?: string },
  attempts: WebSearchResult['attempts'],
  started: number,
  degraded?: string
): WebSearchResult {
  return {
    query,
    provider,
    results: hit.results,
    answer: hit.answer,
    degraded,
    tookMs: Date.now() - started,
    attempts
  };
}

interface ProviderHit {
  results: SearchHit[];
  answer?: string;
}

/**
 * 各家返回的 JSON 结构完全不同，且都是外部输入。
 *
 * 这里用宽松类型读、逐个字段做 `typeof` 判断：把四家的响应声明成四套精确
 * 类型，只会把「服务端换字段」变成一次编译期通过、运行期 undefined 的错。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

async function runProvider(
  provider: SearchProvider,
  query: string,
  limit: number,
  settings: SearchSettings,
  doFetch: typeof fetch
): Promise<ProviderHit> {
  if (provider === 'searxng') {
    const base = (settings.searxngUrl ?? '').trim().replace(/\/+$/, '');
    const check = isFetchableUrl(base);
    if (!check.ok) throw new Error(`SearXNG 地址不可用：${check.reason}`);
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=auto&safesearch=0`;
    const json = await getJson(url, {}, doFetch, 'SearXNG');
    return { results: dedupe(toHits(json?.results, 'title', 'url', 'content'), limit) };
  }

  if (provider === 'brave') {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const json = await getJson(
      url,
      { Accept: 'application/json', 'X-Subscription-Token': settings.apiKey ?? '' },
      doFetch,
      'Brave'
    );
    const rows = Array.isArray(json?.web?.results) ? json.web.results : [];
    return {
      results: dedupe(toHits(rows, 'title', 'url', 'description'), limit),
      answer: typeof json?.summarizer?.summary === 'string' ? json.summarizer.summary : undefined
    };
  }

  if (provider === 'tavily') {
    const json = await postJson(
      'https://api.tavily.com/search',
      { api_key: settings.apiKey ?? '', query, max_results: limit, include_answer: true },
      {},
      doFetch,
      'Tavily'
    );
    return {
      results: dedupe(toHits(json?.results, 'title', 'url', 'content'), limit),
      answer: typeof json?.answer === 'string' && json.answer.trim() ? json.answer : undefined
    };
  }

  // serper
  const json = await postJson(
    'https://google.serper.dev/search',
    { q: query, num: limit },
    { 'X-API-KEY': settings.apiKey ?? '' },
    doFetch,
    'Serper'
  );
  return { results: dedupe(toHits(json?.organic, 'title', 'link', 'snippet'), limit) };
}

/**
 * Bing 的 RSS 输出。免凭据、返回真实结果列表。
 *
 * 为什么用它而不是抓 HTML：HTML 会被反爬拦（DuckDuckGo 会给「选所有包含鸭子的
 * 图片」这种人机验证），而 RSS 是给阅读器用的结构化输出，不需要执行 JS。
 * 它仍然是一个外部接口，可能改、可能限流，所以它是兜底而不是首选：
 * 配了 Brave/Tavily/Serper/SearXNG 就先用那些。
 */
async function runBingRss(query: string, limit: number, doFetch: typeof fetch): Promise<ProviderHit> {
  const url =
    `https://www.bing.com/search?q=${encodeURIComponent(query)}` +
    `&format=rss&count=${Math.min(limit * 2, 20)}`;
  const response = await fetchWithTimeout(
    url,
    { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
    doFetch
  );
  const xml = await readLimited(response);
  if (!response.ok) throw new Error(`Bing RSS 返回 HTTP ${response.status}`);
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const hits: SearchHit[] = [];
  for (const item of items) {
    const link = pickTag(item, 'link');
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const title = stripTags(pickTag(item, 'title')) || link;
    const snippet = stripTags(pickTag(item, 'description'));
    hits.push({
      title: decodeEntities(title).slice(0, 200),
      url: link,
      snippet: decodeEntities(snippet).replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET),
      rank: hits.length + 1
    });
    if (hits.length >= limit) break;
  }
  return { results: hits };
}

/** 取一个 XML 标签的文本，去 CDATA 外壳。只用于 RSS 这种扁平结构。 */
function pickTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 免 key 兜底：DuckDuckGo Instant Answer + Wikipedia 摘要。
 *
 * 两者都是真接口、真数据，但都不是「搜索结果列表」：前者只有一条摘要加若干
 * 相关主题，后者只在词条命中时给一段定义。查到什么给什么，查不到就空着。
 */
async function runFallback(query: string, limit: number, doFetch: typeof fetch): Promise<ProviderHit> {
  const results: SearchHit[] = [];
  let answer: string | undefined;

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const json = await getJson(url, {}, doFetch, 'DuckDuckGo');
    const abstract = typeof json?.AbstractText === 'string' ? json.AbstractText.trim() : '';
    const abstractUrl = typeof json?.AbstractURL === 'string' ? json.AbstractURL.trim() : '';
    if (abstract || abstractUrl) {
      answer = abstract || undefined;
      if (abstractUrl) {
        results.push({
          title: typeof json?.Heading === 'string' && json.Heading ? json.Heading : abstractUrl,
          url: abstractUrl,
          snippet: abstract.slice(0, MAX_SNIPPET),
          rank: results.length + 1
        });
      }
    }
    for (const topic of flattenTopics(json?.RelatedTopics)) {
      const text = typeof topic?.Text === 'string' ? topic.Text : '';
      const firstUrl = typeof topic?.FirstURL === 'string' ? topic.FirstURL : '';
      if (!firstUrl || !text) continue;
      results.push({
        title: text.split(' - ')[0].slice(0, 120),
        url: firstUrl,
        snippet: text.slice(0, MAX_SNIPPET),
        rank: results.length + 1
      });
      if (results.length >= limit) break;
    }
  } catch {
    // DDG 挂了不影响 wiki 兜底；下面继续试。
  }

  if (results.length < Math.min(limit, 3)) {
    const wiki = await wikipediaSummary(query, doFetch).catch(() => null);
    if (wiki) {
      results.unshift({ title: wiki.title, url: wiki.url, snippet: wiki.extract.slice(0, MAX_SNIPPET), rank: 1 });
      answer = answer ?? wiki.extract;
    }
  }

  return { results: dedupe(results, limit), answer };
}

async function wikipediaSummary(
  query: string,
  doFetch: typeof fetch
): Promise<{ title: string; url: string; extract: string } | null> {
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);
  const langs = hasChinese ? ['zh', 'en'] : ['en', 'zh'];
  for (const lang of langs) {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}?redirect=true`;
    try {
      const response = await fetchWithTimeout(url, {}, doFetch);
      if (response.status !== 200) continue;
      const json = JSON.parse(await readLimited(response)) as {
        title?: string; extract?: string; content_urls?: { desktop?: { page?: string } };
      };
      const extract = typeof json.extract === 'string' ? json.extract.trim() : '';
      const page = json.content_urls?.desktop?.page;
      if (extract && page) return { title: json.title ?? query, url: page, extract };
    } catch {
      // 换下一个语言继续。
    }
  }
  return null;
}

function flattenTopics(topics: unknown): Array<{ Text?: string; FirstURL?: string }> {
  if (!Array.isArray(topics)) return [];
  const out: Array<{ Text?: string; FirstURL?: string }> = [];
  for (const item of topics) {
    const record = item as { Text?: string; FirstURL?: string; Topics?: unknown };
    if (Array.isArray(record?.Topics)) out.push(...flattenTopics(record.Topics));
    else if (record) out.push(record);
  }
  return out;
}

/** 按字段名取结果。不同提供方字段名不同，这里只做映射，不做「猜」。 */
function toHits(rows: unknown, titleKey: string, urlKey: string, snippetKey: string): SearchHit[] {
  if (!Array.isArray(rows)) return [];
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const url = typeof record?.[urlKey] === 'string' ? (record[urlKey] as string).trim() : '';
    if (!url) continue;
    hits.push({
      title: decodeEntities(String(record?.[titleKey] ?? url)).slice(0, 200),
      url,
      snippet: decodeEntities(String(record?.[snippetKey] ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET),
      rank: hits.length + 1
    });
  }
  return hits;
}

/** 同一个地址只留最靠前的一条：搜索结果的重复项会让人误以为「很多来源都这么说」。 */
export function dedupe(hits: SearchHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...hit, rank: out.length + 1 });
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    const trimmed = url.toString();
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  } catch {
    return raw;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  label: string
): Promise<JsonObject> {
  const check = isFetchableUrl(url);
  if (!check.ok) throw new Error(`${label} 请求被拒绝：${check.reason}`);
  const response = await fetchWithTimeout(url, headers, doFetch);
  return parseJson(response, label);
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  label: string
): Promise<JsonObject> {
  const check = isFetchableUrl(url);
  if (!check.ok) throw new Error(`${label} 请求被拒绝：${check.reason}`);
  const response = await fetchWithTimeout(
    url,
    { ...headers, 'Content-Type': 'application/json' },
    doFetch,
    JSON.stringify(body)
  );
  return parseJson(response, label);
}

async function parseJson(response: Response, label: string): Promise<JsonObject> {
  const text = await readLimited(response);
  if (!response.ok) {
    // 把服务端的错误摘要带出来，但截短：搜索服务的报错里可能回显 key。
    throw new Error(`${label} 返回 HTTP ${response.status}${text ? `：${text.slice(0, 120)}` : ''}`);
  }
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    throw new Error(`${label} 返回的不是 JSON（可能是人机验证页或被拦截）`);
  }
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  doFetch: typeof fetch,
  body?: string
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await doFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'User-Agent': 'ThinkFusion/0.6 (local harness)', ...headers },
      body,
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new Error(aborted ? `搜索请求超时（${TIMEOUT_MS}ms）` : `搜索请求失败：${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(response: Response): Promise<string> {
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.byteLength > MAX_BYTES) throw new Error(`响应超过 ${MAX_BYTES} 字节上限`);
  return raw.toString('utf8');
}

/** 给设置界面的「测试」按钮用：只验证凭据是否可用，不落任何结果。 */
export async function testSearch(
  settings: SearchSettings,
  doFetch: typeof fetch = fetch
): Promise<{ ok: boolean; provider?: string; note: string; sample?: string }> {
  const provider = configuredProvider(settings);
  if (!provider) return { ok: false, note: '还没填凭据：选一个提供方，再填 key 或实例地址' };
  try {
    const hit = await runProvider(provider, 'ThinkFusion', 3, settings, doFetch);
    return {
      ok: true,
      provider,
      note: `可用，返回 ${hit.results.length} 条`,
      sample: hit.results[0]?.title
    };
  } catch (error) {
    return { ok: false, provider, note: trimError(error) };
  }
}

/** 结果集的指纹：报告里用它说明「这次引用的是同一批结果」。 */
export function resultsDigest(result: WebSearchResult): string {
  return createHash('sha256')
    .update(result.results.map(hit => hit.url).join('\n'))
    .digest('hex');
}
