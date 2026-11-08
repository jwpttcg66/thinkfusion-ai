/**
 * 取网页 / 调用 HTTP 接口。
 *
 * 为什么要有独立工具而不是让模型 `curl`：
 * - 只有完全权限才放行 curl，而「读一篇网页」是最常见的本地动作之一；
 * - 直接把 content-type、状态码、字节数、指纹与正文交给模型，比让它解析
 *   curl 的原始输出可靠；
 * - 这里做 SSRF 防护：拒环回、私网、链路本地与云元数据地址，重定向逐跳校验，
 *   否则一个 `http://127.0.0.1:9222/json` 就能把本机调试端口读成"网页"。
 *
 * 边界：GET/POST、10 秒超时、2 MB 响应上限、正文最多 20,000 字符、不带 cookie
 * 与本地凭证（`Authorization` 之类需要显式写在 headers 里，且会出现在计划里）。
 */

import { createHash } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254', 'metadata.google.internal'
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
  if (host.startsWith('[') || host.includes(':')) {
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === '::1' || /^f[cd]/i.test(bare) || /^fe80:/i.test(bare)) {
      return { ok: false, reason: '不允许抓取本机或私网地址' };
    }
  }
  return { ok: true };
}

export interface WebFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  text: string;
  redirects: string[];
  durationMs: number;
}

export async function webFetch(
  args: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; maxBytes?: number }
): Promise<WebFetchResult> {
  const started = Date.now();
  const check = isFetchableUrl(args.url);
  if (!check.ok) throw new Error(`拒绝抓取：${check.reason}`);

  const maxBytes = Math.min(args.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const method = args.method ?? 'GET';
  const allowedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers ?? {})) {
    // 不允许覆盖 Host：否则可以把请求指到别的主机，绕过上面的校验。
    if (key.toLowerCase() === 'host') continue;
    allowedHeaders[key] = value;
  }
  if (!allowedHeaders['User-Agent'] && !allowedHeaders['user-agent']) {
    allowedHeaders['User-Agent'] = 'ThinkFusion/0.6 (local harness)';
  }
  if (method === 'POST' && args.body && !allowedHeaders['Content-Type']) {
    allowedHeaders['Content-Type'] = 'text/plain; charset=utf-8';
  }

  let current = args.url;
  const redirects: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        method,
        headers: allowedHeaders,
        body: method === 'POST' ? args.body : undefined,
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = (error as Error).name === 'AbortError';
      throw new Error(aborted ? `抓取超时（${TIMEOUT_MS}ms）` : `抓取失败：${(error as Error).message}`);
    }
    clearTimeout(timer);

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current).toString();
      const nextCheck = isFetchableUrl(next);
      if (!nextCheck.ok) throw new Error(`重定向目标被拒绝：${nextCheck.reason}`);
      redirects.push(next);
      current = next;
      continue;
    }

    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.byteLength > maxBytes) {
      throw new Error(`响应超过 ${maxBytes} bytes 上限（实际 ${raw.byteLength}）`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const text = decodeBody(raw, contentType);
    return {
      url: args.url,
      finalUrl: current,
      status: response.status,
      contentType,
      bytes: raw.byteLength,
      sha256: createHash('sha256').update(raw).digest('hex'),
      truncated: text.length > MAX_CHARS,
      text: text.slice(0, MAX_CHARS),
      redirects,
      durationMs: Date.now() - started
    };
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次，已停止`);
}

/** HTML 去标签、JSON 原样、其它按文本解码。 */
function decodeBody(raw: Buffer, contentType: string): string {
  const text = raw.toString('utf8');
  if (!/html/i.test(contentType)) return text;
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
