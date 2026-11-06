/**
 * 窗口关掉再打开，还是上次那个样子。
 *
 * 原来窗口固定 1560×960、分栏固定占窗口的 42%：拖过分隔条、拉过窗口，下次启动
 * 全部归位。这不是「默认值」，是**改动没有被记住**——用户看到的就是「每次都会
 * 变回去」。
 *
 * 这个文件只放**判定**，不放读写：文件损坏、屏幕拔掉、数值被改坏，都要能退回
 * 一个能用的大小，而这几条规则是可以断言的（`scripts/check-window-state.mjs`）。
 */

export interface WindowPlacement {
  width: number;
  height: number;
  /** 没有位置就让系统居中：上次那块屏可能已经不在了。 */
  x?: number;
  y?: number;
  maximized?: boolean;
  /** 页面那一侧（分栏）的宽度，px。 */
  split?: number;
}

/** 一块显示器的可用区域（Electron 的 `display.workArea`）。 */
export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_WIDTH = 1560;
export const DEFAULT_WINDOW_HEIGHT = 960;
export const MIN_WINDOW_WIDTH = 1180;
export const MIN_WINDOW_HEIGHT = 720;

/** 一块屏都装不下这么大的窗口；防的是文件被改坏后开出一个够不着的窗口。 */
const MAX_WINDOW_SIZE = 12000;

/**
 * 至少要有这么大一块落在某块屏里，窗口才算「找得回来」。
 *
 * 判据不是「原点在屏内」：把窗口往左上角拖出去一半是常见用法，那仍然能用；
 * 而换个显示器以后整块落在屏幕外，就只剩任务栏里一个点不出来的条目。
 */
const VISIBLE_WIDTH = 120;
const VISIBLE_HEIGHT = 60;

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

function intersects(rect: DisplayRect, x: number, y: number, width: number, height: number): boolean {
  const overlapWidth = Math.min(x + width, rect.x + rect.width) - Math.max(x, rect.x);
  const overlapHeight = Math.min(y + height, rect.y + rect.height) - Math.max(y, rect.y);
  return overlapWidth >= Math.min(VISIBLE_WIDTH, width) && overlapHeight >= Math.min(VISIBLE_HEIGHT, height);
}

/**
 * 读回来的状态要能用，不能只是「读回来了」。
 *
 * - 大小先夹在最小值与**最大那块屏**之间：在 5K 上拉大的窗口，换到笔记本上
 *   打开时不该是一条越过屏幕的边；
 * - 位置只在一块屏还看得见时才用，否则交给系统居中——把窗口开到不存在的
 *   显示器上是这个功能最容易造成的坏结果；
 * - 分栏宽度只做正向校验（> 0），真正的夹取留给 `computeSplit`，它知道窗口
 *   现在多宽、两侧的最小宽度是多少。
 */
export function restoreWindowPlacement(
  raw: unknown,
  displays: readonly DisplayRect[]
): WindowPlacement {
  // 没有记录（第一次启动、文件被删、文件读坏了）就按出厂大小开——和以前完全
  // 一样。夹到屏幕大小只针对**记下来的**尺寸：那可能是另一块屏上的数字。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  }

  const record = raw as Record<string, unknown>;
  const largest = displays.reduce<DisplayRect | null>(
    (best, display) =>
      !best || display.width * display.height > best.width * best.height ? display : best,
    null
  );
  const maxWidth = Math.min(largest?.width ?? MAX_WINDOW_SIZE, MAX_WINDOW_SIZE);
  const maxHeight = Math.min(largest?.height ?? MAX_WINDOW_SIZE, MAX_WINDOW_SIZE);

  const width = Math.round(
    clamp(finite(record.width) ?? DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, maxWidth))
  );
  const height = Math.round(
    clamp(finite(record.height) ?? DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, maxHeight))
  );

  const placement: WindowPlacement = { width, height };

  const x = finite(record.x);
  const y = finite(record.y);
  if (x !== null && y !== null) {
    const reachable =
      displays.length === 0 || displays.some(display => intersects(display, x, y, width, height));
    if (reachable) {
      placement.x = Math.round(x);
      placement.y = Math.round(y);
    }
  }

  if (record.maximized === true) placement.maximized = true;

  const split = finite(record.split);
  if (split !== null && split > 0) placement.split = Math.round(split);

  return placement;
}
