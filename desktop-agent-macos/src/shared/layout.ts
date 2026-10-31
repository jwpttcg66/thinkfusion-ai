/**
 * How the window is divided between the app and the embedded page.
 *
 * This lives in shared/ rather than main/ because *both* sides need it: the
 * main process to place the native page view, the renderer to reserve the
 * matching gutter. When each side had its own arithmetic they disagreed by
 * 88px and the page was painted on top of the app's own column.
 *
 * The previous version also got the formula wrong in a way no amount of
 * reading would catch: `Math.max(820, width - viewWidth)` put the page view at
 * x=820 with width 448 on a 1180px window — a right edge of 1268, past the
 * window — while the renderer still believed it owned the full width.
 */

/** The app's own column must stay usable; below this the UI stops being readable. */
export const MIN_APP_COLUMN = 720;

/** Below this the embedded page is too narrow to be worth showing. */
export const MIN_PAGE_COLUMN = 380;

/**
 * Width of the gap between the app column and the page view.
 *
 * The divider is the only way to grab the boundary, and the boundary is exactly
 * where the native view starts — so without a gap the grab target is covered by
 * the very thing it is supposed to move, and aiming at the seam does nothing.
 * The gutter gives the handle somewhere to live.
 */
export const PAGE_GUTTER = 10;

/** Default share of the window given to the page, before any dragging. */
export const DEFAULT_PAGE_RATIO = 0.42;

/**
 * The split the user dragged to, if any.
 *
 * The embedded page is a real web app laid out for a full window, so how much
 * room it gets decides whether it looks like the site or like a squeezed mobile
 * view. That is a judgement call, so it is a control rather than a constant —
 * but it is still clamped, because a split that leaves the app unusable or
 * spills past the window is not a preference, it is a broken layout.
 *
 * Passing 0 or null restores the default ratio.
 */
export function computeSplit(width: number, preferred?: number | null): number {
  const available = Math.max(0, width);
  const upper = Math.max(MIN_PAGE_COLUMN, available - MIN_APP_COLUMN);
  const wanted = preferred && preferred > 0 ? Math.round(preferred) : Math.round(available * DEFAULT_PAGE_RATIO);
  return Math.max(MIN_PAGE_COLUMN, Math.min(wanted, upper));
}

/** Whether a dragged width is representable at the current window size. */
export function isSplitUsable(width: number, split: number): boolean {
  return width - split >= MIN_APP_COLUMN && split >= MIN_PAGE_COLUMN;
}

/**
 * Width of the source rail pinned to the window's right edge.
 *
 * The rail is DOM, the page is a native view painted above the DOM — so the
 * view has to stop short of the rail's width or it covers the buttons. The
 * renderer sets its rail to this exact number; the two are the same constant
 * for the same reason `--split` is shared.
 */
export const RAIL_WIDTH = 46;

export interface PageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the embedded page view goes.
 *
 * `split` is measured from the window's right edge and includes both the
 * gutter and the rail, so the view is narrower than the split by exactly those
 * two. Getting this wrong once pushed the view past the window edge; forgetting
 * the rail now would hide the very buttons that switch sources.
 */
export function computePageBounds(
  width: number,
  height: number,
  split: number,
  options: { parked?: boolean } = {}
): PageBounds {
  const pageWidth = Math.max(1, split - PAGE_GUTTER - RAIL_WIDTH);
  return {
    x: options.parked ? width + 4 : width - split + PAGE_GUTTER,
    y: 0,
    width: pageWidth,
    height
  };
}

