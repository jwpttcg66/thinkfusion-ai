/**
 * Drives the divider drag end to end and checks the native view follows.
 *
 * A synthetic pointer sequence cannot prove that macOS would have delivered a
 * real drag — that is exactly what `setPageDragging` exists for, and it is why
 * the view is parked outside the window for the duration of the gesture. What
 * this does prove is that every move reaches the main process, that the clamp
 * is applied there rather than in the renderer, and that the view ends up
 * exactly where the gutter reserved for it says it should.
 *
 * Usage: node scripts/check-split-drag.mjs   (app running with --remote-debugging-port=9222)
 */
import { connect, createChecks, findAppTarget, listTargets, sleep, waitFor } from './lib/cdp.mjs';

const GUTTER = 10;
/** The rail is DOM painted over the page area, so the view has to stop short of it. */
const RAIL = 46;
/** Width the native view should have for a given split — the same formula `computePageBounds` uses. */
const pageWidthFor = split => split - GUTTER - RAIL;

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

const state = () =>
  cdp.evaluate(`(() => {
    const divider = document.querySelector('.page-divider');
    const rect = divider ? divider.getBoundingClientRect() : null;
    return {
      viewport: window.innerWidth,
      split: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--split'), 10),
      dividerRight: rect ? Math.round(rect.right) : null,
      ghost: Boolean(document.querySelector('.page-ghost')),
      ghostLabel: document.querySelector('.page-ghost span')?.textContent ?? null
    };
  })()`);

const view = async () => {
  const report = await cdp.evaluate('window.agentAPI.getDeepSeekDiagnostics()');
  return { view: report.view, dragging: report.dragging };
};

const dispatch = (type, clientX) =>
  cdp.evaluate(`(() => {
    const divider = document.querySelector('.page-divider');
    if (!divider) return false;
    divider.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
      clientX: ${clientX}, clientY: 400, isPrimary: true,
      button: ${type === 'pointermove' ? -1 : 0}, buttons: ${type === 'pointerup' ? 0 : 1}
    }));
    return true;
  })()`);

// A previous run that failed mid-gesture can leave the ghost behind; the app
// recovers on the next real pointer-up, but a check has to start clean.
const initial = await state();
if (initial.ghost) {
  await dispatch('pointerup', initial.dividerRight - 2);
  await sleep(400);
}

const start = await state();
const startView = await view();
console.log('before', start, 'view', startView.view, 'dragging', startView.dragging);

await dispatch('pointerdown', start.dividerRight - 2);
await sleep(200);
const down = await state();
const downView = await view();
checkTrue('the ghost appears while dragging', down.ghost);
checkTrue('the ghost shows the width', (down.ghostLabel ?? '').includes('px'));
checkTrue('the main process knows a drag is in progress', downView.dragging);
// Parked means outside the window, not resized: resizing mid-gesture would
// reflow the page on every pointer move.
checkTrue('the view is parked outside the window', downView.view.x >= start.viewport);
check('the parked view keeps its width', downView.view.width, startView.view.width);

await dispatch('pointermove', 700);
await sleep(250);
const widened = await state();
check('the split follows the cursor', widened.split, Math.min(start.viewport - 700, start.viewport - 720));

await dispatch('pointermove', 5);
await sleep(250);
const clampedLeft = await state();
check('the app column is never squeezed below its minimum', start.viewport - clampedLeft.split, 720);

await dispatch('pointermove', start.viewport - 5);
await sleep(250);
const clampedRight = await state();
check('the page is never collapsed below its minimum', clampedRight.split, 380);

await dispatch('pointermove', 860);
await sleep(250);
const chosen = await state();
check('a comfortable width is honoured', chosen.split, start.viewport - 860);

await dispatch('pointerup', 860);
await sleep(300);
const released = await state();
checkTrue('the ghost is gone after release', !released.ghost);
check('the applied width survives the release', released.split, chosen.split);
const releasedView = await view();
checkTrue('the main process knows the drag ended', !releasedView.dragging);
const boundary = start.viewport - released.split + GUTTER;
const returned = await waitFor(async () => (await view()).view.x, boundary);
check('the view comes back to the boundary', returned, boundary);
check('the view width matches the applied split', (await view()).view.width, pageWidthFor(released.split));

await cdp.evaluate(`(() => {
  const divider = document.querySelector('.page-divider');
  divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 860, clientY: 400 }));
  return true;
})()`);
await sleep(400);
const reset = await state();
check('double click restores the default ratio', reset.split, Math.round(start.viewport * 0.42));
const resetView = await waitFor(async () => (await view()).view.width, pageWidthFor(reset.split));
check('the view follows the reset', resetView, pageWidthFor(reset.split));

cdp.close();
process.exit(summary().fail === 0 ? 0 : 1);
