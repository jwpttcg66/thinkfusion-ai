import type { WebContentsView } from 'electron';

/**
 * 同一条网页会话 = 同源 + 同一 pathname。
 *
 * Kimi 会在地址上挂 `?chat_enter_method=home`，Gemini 会挂 `?hl=zh`；只因为
 * query 不同就重载一次页面，既慢又会把刚打开的输入框冲掉。
 */
export function isSameThread(current: string | null | undefined, target: URL): boolean {
  if (!current) return false;
  try {
    const url = new URL(current);
    return url.origin === target.origin && url.pathname === target.pathname;
  } catch {
    return false;
  }
}

export interface ThreadNavigationResult {
  ok: boolean;
  /** 判定结束时页面实际停在的地址，失败时用来如实说明。 */
  url: string;
}

/**
 * 把视图带回目标会话地址，**以最终地址为准**。
 *
 * 原来只等 `did-finish-load`：Gemini / ChatGPT 这类站点在 12 秒内没派发该事件，
 * 页面其实已经回到原会话，却被写成「导航回原会话超时或失败」，还白等满 12 秒。
 * 这里用导航/加载事件提前唤醒、轮询兜底，并在硬超时前最后复查一次 URL。
 *
 * 地址命中后留一小段渲染宽限（`graceMs`），避免文档还没可交互就把提问发出去；
 * 主文档加载完成或 `loadURL` 兑现时可以提前结束这段宽限。
 */
export async function navigateToThread(
  view: WebContentsView,
  target: URL,
  timeoutMs = 12_000,
  graceMs = 800
): Promise<ThreadNavigationResult> {
  const wc = view.webContents;
  const currentUrl = () => (wc.isDestroyed() ? '' : wc.getURL());
  if (isSameThread(currentUrl(), target)) return { ok: true, url: currentUrl() };

  return new Promise(resolve => {
    let done = false;
    let urlHit = false;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (grace) clearTimeout(grace);
      wc.off('did-navigate', onNavigate);
      wc.off('did-navigate-in-page', onNavigate);
      wc.off('did-finish-load', onLoad);
      wc.off('did-stop-loading', onLoad);
    }

    function finish(ok: boolean): void {
      if (done) return;
      done = true;
      cleanup();
      resolve({ ok, url: currentUrl() });
    }

    function check(): void {
      if (done) return;
      if (wc.isDestroyed()) {
        finish(false);
        return;
      }
      if (!isSameThread(currentUrl(), target)) return;
      if (!urlHit) {
        urlHit = true;
        grace = setTimeout(() => finish(true), Math.max(0, graceMs));
      }
      if (ready) finish(true);
    }

    function onNavigate(): void {
      check();
    }

    function onLoad(): void {
      ready = true;
      check();
    }

    timer = setTimeout(() => {
      // SPA 可能只换了地址、始终不派发加载事件；最后再看一眼真实地址，
      // 命中就算回到原会话，不再把「没等到事件」误报成失败。
      finish(isSameThread(currentUrl(), target));
    }, Math.max(1, timeoutMs));
    poller = setInterval(check, 200);
    wc.on('did-navigate', onNavigate);
    wc.on('did-navigate-in-page', onNavigate);
    wc.on('did-finish-load', onLoad);
    wc.on('did-stop-loading', onLoad);
    void wc.loadURL(target.href)
      .then(() => {
        ready = true;
        check();
      })
      .catch(() => undefined);
  });
}
