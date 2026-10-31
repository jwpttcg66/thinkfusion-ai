/**
 * Checks the app column's own geometry: the composer is docked to the bottom
 * and the empty state is centred in the room above it.
 *
 * The composer used to live inside the scrolling column, so the first log line
 * pushed it out of view. Docked at the bottom it stays reachable, which is also
 * the shape the DeepSeek page has — and that resemblance was the point.
 *
 * Usage: node scripts/check-app-layout.mjs   (app must be running with CDP on)
 */
import { connect, createChecks, findAppTarget, listTargets } from './lib/cdp.mjs';

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

const layout = await cdp.evaluate(`(() => {
  const box = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      top: Math.round(b.top), bottom: Math.round(b.bottom),
      left: Math.round(b.left), right: Math.round(b.right),
      w: Math.round(b.width), h: Math.round(b.height)
    };
  };
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    split: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--split'), 10),
    topbar: box('.topbar'),
    scroll: box('.scroll'),
    hero: box('.hero'),
    dock: box('.dock'),
    composer: box('.composer'),
    send: box('.dock .send')
  };
})()`);

console.log(JSON.stringify(layout, null, 2));

const { viewport, split, topbar, dock, composer, scroll, hero, send } = layout;

checkTrue('the topbar is present', topbar);
checkTrue('the dock is present', dock);
checkTrue('the composer is present', composer);
check('the dock reaches the bottom edge', dock.bottom, viewport.h);
checkTrue('the composer sits inside the dock', composer.top >= dock.top && composer.bottom <= dock.bottom);
checkTrue('the composer is in the lower half of the window', composer.top > viewport.h / 2);
checkTrue('nothing overlaps the composer', scroll.bottom <= dock.top + 1);
checkTrue('the dock stays clear of the page pane', dock.right <= viewport.w - split + 1);
checkTrue('the send button is inside the composer', send.left >= composer.left && send.right <= composer.right);

if (hero) {
  const heroCentre = (hero.top + hero.bottom) / 2;
  const roomCentre = (scroll.top + scroll.bottom) / 2;
  checkTrue('the empty state is centred above the dock', Math.abs(heroCentre - roomCentre) < 24);
}

cdp.close();
process.exit(summary().fail === 0 ? 0 : 1);
