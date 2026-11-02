/**
 * Checks that the two panes agree on where the boundary is.
 *
 * This is the check that would have caught the original layout bug: the page
 * view was placed with `Math.max(820, width - viewWidth)`, which at the
 * window's minimum width put its right edge 88px past the window and painted it
 * on top of the app's own column. Nothing in the renderer could see that — the
 * page is a native view, not an element — so the numbers have to be read from
 * both sides and compared.
 *
 * The authority is the main process's own `setBounds` arguments, which the
 * diagnostics report exposes. The page's `window.innerWidth` is a second,
 * independent confirmation — but Chromium does not relayout a page whose window
 * is hidden or occluded, so that half is skipped (with a note) rather than
 * reported as a failure when the window is not in front.
 *
 * Usage: node scripts/check-split.mjs     (app running with --remote-debugging-port=9222)
 */
import { connect, createChecks, findAppTarget, findPageTarget, listTargets, sleep, waitFor } from './lib/cdp.mjs';

const GUTTER = 10;
/** Mirrors RAIL_WIDTH in src/shared/layout.ts; scripts cannot import TS. */
const RAIL = 46;
/** Mirrors PAGE_HEADER_HEIGHT: the strip of document above the page view. */
const HEADER = 36;

const targets = await listTargets();
const app = findAppTarget(targets);
const page = findPageTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const appCdp = await connect(app);
const pageCdp = page ? await connect(page) : null;
const { check, checkTrue, summary } = createChecks();

// The rail can leave another embedded page on screen. This check is about the
// planning pane's geometry, so put that pane in front first — otherwise every
// position assertion reads the parked bounds of a hidden view and fails for a
// reason that has nothing to do with layout.
const before = await appCdp.evaluate('window.agentAPI.getSources()');
if (before.activeId !== 'deepseek') {
  await appCdp.evaluate("window.agentAPI.setSource('deepseek')");
  await sleep(900);
}

const readApp = () =>
  appCdp.evaluate(`(() => {
    const divider = document.querySelector('.page-divider');
    const rect = divider ? divider.getBoundingClientRect() : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      split: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--split'), 10),
      dividerLeft: rect ? Math.round(rect.left) : null,
      dividerRight: rect ? Math.round(rect.right) : null
    };
  })()`);

const readView = async () => {
  const report = await appCdp.evaluate('window.agentAPI.getDeepSeekDiagnostics()');
  return { view: report.view, dragging: report.dragging };
};

const state = await readApp();
const { view, dragging } = await readView();
console.log('app', state.viewport, 'split', state.split, 'view', view, 'dragging', dragging);

checkTrue('the page view exists', view);
// The split covers the gutter and the source rail, so the view is narrower than
// the split by both, and it stops at the rail rather than the window edge.
check('the page view width is the split minus the gutter and rail', view.width, state.split - GUTTER - RAIL);
// Not full height: the strip above the page is document, and the view starts
// under it. If this ever goes back to `viewport.h` the bar is covered again —
// painted, but invisible, because a native view is always on top.
check('the page view starts under the page bar', view.y, HEADER);
check('the page view ends at the window bottom', view.height, state.viewport.h - HEADER);
check('the page view starts one gutter in from the boundary', view.x, state.viewport.w - state.split + GUTTER);
checkTrue('the page view ends where the source rail begins', view.x + view.width === state.viewport.w - RAIL);
// The divider fills the gutter: left edge where the app column stops, right
// edge where the page view starts.
check('the app column stops at the boundary', state.dividerLeft, state.viewport.w - state.split);
check('the divider ends where the page view begins', state.dividerRight, view.x);
checkTrue('the app column keeps its minimum', state.viewport.w - state.split >= 720);
checkTrue('the page keeps its minimum', state.split >= 380);
checkTrue('the view is not parked while idle', !dragging);

// A width the user asked for must survive the round trip unchanged — that is
// what makes the drag feel like dragging rather than like requesting.
const applied = await appCdp.evaluate('window.agentAPI.setSplit(700)');
check('a representable width is applied as asked', applied.split, 700);
const appliedView = await waitFor(async () => (await readView()).view.width, 700 - GUTTER - RAIL);
check('the view follows the applied width', appliedView, 700 - GUTTER - RAIL);

// Restore the default ratio so the app is left the way a user expects it.
const restored = await appCdp.evaluate('window.agentAPI.setSplit(0)');
check('reset restores the default ratio', restored.split, Math.round(state.viewport.w * 0.42));
const restoredView = await waitFor(async () => (await readView()).view.width, restored.split - GUTTER - RAIL);
check('the view follows the reset', restoredView, restored.split - GUTTER - RAIL);

if (pageCdp) {
  // `setBounds` lands immediately, the page's own layout pass does not. That is
  // only true while the window is really in front, though: macOS stops
  // compositing an occluded window, and Chromium then defers the relayout of the
  // page inside it. The page's own `visibilityState` does not report that — it
  // kept saying "visible" while the width sat at a stale 644 through three
  // resizes — so the signal used here is whether the app window has focus at
  // all. Without this the check fails for a reason that has nothing to do with
  // the split, and the failure is indistinguishable from a real one.
  const focused = await appCdp.evaluate('document.hasFocus()');
  if (focused) {
    const expected = restored.split - GUTTER - RAIL;
    const pageWidth = await waitFor(() => pageCdp.evaluate('window.innerWidth'), expected, { timeoutMs: 4000 });
    check('the page agrees with the view width', pageWidth, expected);
  } else {
    console.log('note  the app window is not in front, so the page inside it is not being relaid out — the view bounds above are authoritative');
  }
}

appCdp.close();
pageCdp?.close();
process.exit(summary().fail === 0 ? 0 : 1);
