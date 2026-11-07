/**
 * 网页内容提取（V2.1 Knowledge Workspace / Extract）。
 *
 * 之前 `extract` 只是给网页通道贴了个标签：系统照常把用户原话发给几家网页
 * AI，它们各自决定要不要打开那个链接。链接打不开、要登录、被反爬挡住的页面，
 * 用户拿到的就是一句「我无法访问」——所谓「提取」根本没发生。
 *
 * 这里做的是把正文真的取回来，作为**主导人汇总时的材料**，和工程证据一样：
 * 第一手提问仍然是用户原话，正文只在回答之后的汇总里出现，不改变提问链路。
 *
 * 边界（与 Phase E 的取证要求一致）：
 * - 只允许 http/https；
 * - 拒绝环回、私网、链路本地与云元数据地址，防止把本地服务当成网页去读；
 * - 10 秒超时、2 MB 上限，超了就如实说「页面太大」而不是截一半当全文；
 * - 只保留正文文本，脚本与样式先去干净；
 * - 存 sha256 与抓取时间，复盘时能确认看的是哪一版。
 */

import { createHash } from 'node:crypto';
import type { PageEvidence } from '../../shared/evidence';

export type { PageEvidence };

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20_000;
const TIMEOUT_MS = 10_000;

/** 私网、环回、链路本地、云元数据：一律不读，避免把本机服务当网页抓。 */
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal'
]);

export function isFetchableUrl(raw: string): { ok: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: '不是合法地址' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http/https' };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: '地址没有主机名' };
  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: '不允许抓取本机或元数据地址' };
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return { ok: false, reason: '不允许抓取私网地址' };
  }
  if (/^169\.254\./.test(host) || host.endsWith('.local')) {
    return { ok: false, reason: '不允许抓取链路本地地址' };
  }
  // IPv6 环回与唯一本地地址（fc00::/7）。
  if (host.startsWith('[') || host.includes(':')) {
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === '::1' || /^f[cd]/i.test(bare) || /^fe80:/i.test(bare)) {
      return { ok: false, reason: '不允许抓取本机或私网地址' };
    }
  }
  return { ok: true };
}

/** 去掉 script/style/nav 等非正文，压成一段文本。纯字符串处理，不引第三方解析器。 */
export function htmlToText(html: string): { title: string; text: string; notes: string[] } {
  const notes: string[] = [];
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const title = decodeEntities((ogTitle?.[1] ?? titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim());

  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // 优先取 main/article：正文通常在这里，避免把整站导航算进「内容」。
  const main = body.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (main) {
    body = main[1];
    notes.push('取用页面 main/article 区域');
  }

  body = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const text = decodeEntities(body)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return { title, text, notes };
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * 抓一个页面并取正文。失败一律抛出带原因的错误——「没抓到」和「抓到了空页面」
 * 必须能分开，否则汇总里会出现一段「据页面内容……」的凭空分析。
 */
export async function fetchPageText(rawUrl: string, fetcher?: FetchLike): Promise<PageEvidence> {
  const check = isFetchableUrl(rawUrl);
  if (!check.ok) throw new Error(`不能抓取这个地址：${check.reason}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    const doFetch = fetcher ?? (globalThis.fetch as unknown as FetchLike);
    response = await doFetch(rawUrl, { signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    throw new Error(`抓取失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status}`);

  const lengthHeader = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(lengthHeader) && lengthHeader > MAX_BYTES) {
    throw new Error(`页面超过 ${Math.round(MAX_BYTES / 1024)} KB，没有抓取`);
  }

  const html = await response.text();
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`页面超过 ${Math.round(MAX_BYTES / 1024)} KB，没有抓取`);

  const parsed = htmlToText(html);
  const notes = [...parsed.notes];
  let text = parsed.text;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    notes.push(`正文超长，只保留前 ${MAX_CHARS} 字`);
  }
  if (!text) throw new Error('页面没有可读正文（可能需要登录或由脚本渲染）');

  return {
    url: rawUrl,
    title: parsed.title || new URL(rawUrl).hostname,
    text,
    chars: text.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    fetchedAt: Date.now(),
    status: response.status,
    notes
  };
}

/** 拼成主导人汇总时的一段材料。 */
export function extractMaterial(evidence: PageEvidence): string {
  return [
    `【网页正文】${evidence.title}`,
    `地址：${evidence.url}`,
    `抓取时间：${new Date(evidence.fetchedAt).toISOString()}　状态：${evidence.status}　正文字数：${evidence.chars}　sha256：${evidence.sha256.slice(0, 12)}`,
    ...(evidence.notes.length > 0 ? [`说明：${evidence.notes.join('；')}`] : []),
    '正文：',
    evidence.text
  ].join('\n');
}
