/**
 * Runtime 侧的「借主进程浏览器搜一次」。
 *
 * Runtime 跑在 UtilityProcess 里，开不了窗口，而免凭据的搜索只能靠真浏览器
 * （原因见 `src/main/browser-search.ts` 顶部）。这里只做一件事：把请求发出去、
 * 按 requestId 等回包、超时就放弃。
 *
 * 三条要求：
 * - 一定要有超时。主进程如果因为窗口创建失败没回包，这里不能把整份计划挂死。
 * - 回包和请求一样不可信：结构用 typeof 逐个字段过一遍，不直接 `as`。
 * - 没有父端口（被当成普通 node 进程跑、或在测试里直接调工具）时就当能力不存在，
 *   让上层退回到 HTTP 兜底，而不是抛一个用户看不懂的错误。
 */

import { randomUUID } from 'node:crypto';
import type { SearchHit } from '../shared/search';

export interface BrowserSearchReply {
  results: SearchHit[];
  finalUrl?: string;
  pageTitle?: string;
  emptyNote?: string;
}

interface PendingRequest {
  resolve: (reply: BrowserSearchReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingRequest>();
const REPLY_TIMEOUT_MS = 40_000;
let listening = false;

function ensureListener(port: Electron.ParentPort) {
  if (listening) return;
  listening = true;
  port.on('message', (event: { data: unknown }) => {
    const message = event.data as { type?: string; requestId?: string; result?: unknown; error?: string } | null;
    if (!message || message.type !== 'search.browser.result' || typeof message.requestId !== 'string') return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (typeof message.error === 'string' && message.error) {
      entry.reject(new Error(message.error));
      return;
    }
    entry.resolve(sanitize(message.result));
  });
}

/** 主进程回来的是外部数据：字段类型不对就当没有，不把脏结构写进执行结果。 */
function sanitize(raw: unknown): BrowserSearchReply {
  const record = (raw ?? {}) as Record<string, unknown>;
  const hits: SearchHit[] = [];
  for (const item of Array.isArray(record.results) ? record.results : []) {
    const hit = item as Record<string, unknown>;
    const url = typeof hit?.url === 'string' ? hit.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    hits.push({
      title: typeof hit.title === 'string' && hit.title ? hit.title.slice(0, 200) : url,
      url,
      snippet: typeof hit.snippet === 'string' ? hit.snippet.slice(0, 400) : '',
      rank: hits.length + 1
    });
  }
  return {
    results: hits,
    finalUrl: typeof record.finalUrl === 'string' ? record.finalUrl : undefined,
    pageTitle: typeof record.pageTitle === 'string' ? record.pageTitle : undefined,
    emptyNote: typeof record.emptyNote === 'string' ? record.emptyNote : undefined
  };
}

/** 可选能力：没有父端口时返回 null，调用方据此退回 HTTP 兜底。 */
export function browserSearchCapability(): ((query: string, limit: number) => Promise<BrowserSearchReply>) | null {
  const port = process.parentPort;
  if (!port) return null;
  ensureListener(port);

  return (query, limit) =>
    new Promise<BrowserSearchReply>((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`主进程没有回复搜索请求（${REPLY_TIMEOUT_MS}ms）`));
      }, REPLY_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      try {
        port.postMessage({ type: 'search.browser.request', requestId, query, limit });
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error(`搜索请求发不出去：${(error as Error).message}`));
      }
    });
}
