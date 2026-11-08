/**
 * 用应用自己的浏览器去搜一次。
 *
 * 为什么需要这条路：搜索服务全都要凭据，而「免凭据」的 HTTP 兜底在国内网络
 * 下基本是废的——实测从这台机器上，
 *   - `bing.com/search?format=rss` 被 302 到首页再 301 回 `/?q=…`，无限循环
 *     （`fetch failed: redirect count exceeded`）；
 *   - `html.duckduckgo.com` / `lite.duckduckgo.com` 回 202，内容是「Verifying
 *     your browser…」人机验证页；
 *   - 公共 SearXNG 实例不是 429 就是同一张验证页。
 * 同一条 `cn.bing.com/search?q=…` 放进应用自己的 Chromium 里却能立刻拿到
 * 10 条结果——差别不在网络，而在「有没有一个真浏览器把 `rdr=1` 那一步跳完、
 * 带上 cookie」。所以免凭据的搜索只好交给真浏览器做。
 *
 * 边界：
 * - 只读：搜完就关窗，不写盘、不发消息、不碰用户页面（单独一个 session 分区，
 *   不共享任何登录态）。
 * - 不编造：拿不到结果就返回空列表并说明原因，交回上层决定怎么说。
 * - 这是主进程的能力：Runtime 是 UtilityProcess，开不了窗口，通过
 *   agent-manager 的 `search.browser.request` 转过来（见 `searchInBrowser` 调用方）。
 */

import { BrowserWindow } from 'electron';
import type { SearchHit } from '../shared/search';

const SEARCH_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 400;
const MAX_SNIPPET = 400;

export interface BrowserSearchResult {
  results: SearchHit[];
  /** 实际落到的地址：Bing 会带 `rdr=1` 之类的参数，如实回报方便排查。 */
  finalUrl: string;
  pageTitle: string;
  /** 页面上明确说「没有结果」时的原文，用于区分「没搜到」和「页面没加载出来」。 */
  emptyNote?: string;
}

/** 串行化：一次只开一个搜索窗，避免并发搜索把内存和网络打满。 */
let queue: Promise<unknown> = Promise.resolve();

export function searchInBrowser(query: string, limit: number): Promise<BrowserSearchResult> {
  const run = queue.then(() => performSearch(query, limit));
  // 队列本身不能因为一次失败而断掉。
  queue = run.catch(() => undefined);
  return run;
}

async function performSearch(query: string, limit: number): Promise<BrowserSearchResult> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}`;
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      // 单独分区：搜索结果不该和用户的登录态混在一起，也不该继承任何一条通道。
      partition: 'persist:thinkfusion-search',
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });

  try {
    await loadWithTimeout(win, url);
    const deadline = Date.now() + SEARCH_TIMEOUT_MS;
    let last: BrowserSearchResult = { results: [], finalUrl: win.webContents.getURL(), pageTitle: '' };

    while (Date.now() < deadline) {
      const snapshot = await readResults(win, limit);
      last = {
        results: snapshot.results,
        finalUrl: snapshot.finalUrl ?? win.webContents.getURL(),
        pageTitle: snapshot.pageTitle ?? '',
        emptyNote: snapshot.emptyNote
      };
      if (last.results.length > 0) return last;
      // 页面已经明确说「没有结果」，就不用再等满超时。
      if (last.emptyNote) return last;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return last;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function loadWithTimeout(win: BrowserWindow, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`搜索页面加载超时（${SEARCH_TIMEOUT_MS}ms）`)), SEARCH_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      win.webContents.off('did-finish-load', done);
      resolve();
    };
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      reject(new Error(`搜索页面加载失败（${code} ${description}）`));
    });
    void win.loadURL(url).catch(error => {
      clearTimeout(timer);
      reject(new Error(`搜索页面打不开：${(error as Error).message}`));
    });
  });
}

/**
 * 从页面里读结果。
 *
 * 选择器只认 Bing 的结果块（`li.b_algo`）。不用「所有链接」是为了不把导航栏、
 * 广告位、相关搜索混进结果——那样的列表看起来更长，却答不了「第一条是什么」。
 */
async function readResults(
  win: BrowserWindow,
  limit: number
): Promise<{ results: SearchHit[]; finalUrl?: string; pageTitle?: string; emptyNote?: string }> {
  if (win.isDestroyed()) return { results: [] };
  const script = `(() => {
    const rows = [...document.querySelectorAll('li.b_algo')];
    // 用 textContent 而不是 innerText：窗口是隐藏的（show:false），没有布局，
    // innerText 会一律回空串——实测整页 5 条结果的标题全变成 ''。
    const text = node => (node && node.textContent ? node.textContent : '');
    const items = rows.slice(0, ${Math.max(1, Math.min(limit, 20))}).map(li => {
      const anchor = li.querySelector('h2 a');
      const caption = li.querySelector('.b_caption p') || li.querySelector('.b_snippet') || li.querySelector('p');
      return {
        title: text(anchor).trim(),
        url: anchor && anchor.href ? anchor.href : '',
        snippet: text(caption).replace(/\\s+/g, ' ').trim()
      };
    }).filter(item => /^https?:\\/\\//i.test(item.url));
    const empty = document.querySelector('.b_no') || document.querySelector('#b_results .b_no');
    return {
      items,
      finalUrl: location.href,
      pageTitle: document.title,
      emptyNote: empty ? text(empty).trim().slice(0, 200) : undefined,
      hasCaptcha: /verify|challenge|captcha/i.test(document.title || '')
    };
  })()`;

  const raw = (await win.webContents.executeJavaScript(script, true)) as {
    items?: Array<{ title?: string; url?: string; snippet?: string }>;
    finalUrl?: string;
    pageTitle?: string;
    emptyNote?: string;
    hasCaptcha?: boolean;
  };

  const results: SearchHit[] = [];
  for (const item of raw?.items ?? []) {
    const url = String(item.url ?? '');
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: (item.title || url).slice(0, 200),
      url,
      snippet: String(item.snippet ?? '').slice(0, MAX_SNIPPET),
      rank: results.length + 1
    });
  }

  const emptyNote = results.length > 0
    ? undefined
    : raw?.hasCaptcha
      ? `搜索页要求人机验证（页面标题：${raw?.pageTitle ?? '(空)'}）`
      : raw?.emptyNote;

  return { results, finalUrl: raw?.finalUrl, pageTitle: raw?.pageTitle, emptyNote };
}
