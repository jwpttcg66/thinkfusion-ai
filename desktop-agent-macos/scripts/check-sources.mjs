/**
 * Checks the source rail: several pages embedded, one on screen, buttons still
 * clickable.
 *
 * Two failure modes this exists for. First, the rail is DOM but the page is a
 * native view painted above it — if the view's bounds are not reduced by the
 * rail's width, the buttons are simply invisible and unclickable, and nothing
 * throws. Second, switching must not tear the other page down: a chat page that
 * gets destroyed loses whatever the model was in the middle of writing.
 *
 * Both are silent. That is why the assertions read the native view geometry
 * (`getViewBounds`) instead of trusting the DOM: the DOM always believes the
 * rail is on top, because the thing covering it is not in the DOM at all.
 *
 * Usage: node scripts/check-sources.mjs   (app must be running with CDP on)
 */
import { connect, createChecks, findAppTarget, listTargets, waitFor } from './lib/cdp.mjs';

/** Mirrors RAIL_WIDTH in src/shared/layout.ts; scripts cannot import TS. */
const RAIL_WIDTH = 46;

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

/**
 * One round trip that reads all three layers at once: the rail's DOM rect, the
 * source state from the main process, and where the native views actually are.
 * The whole bug class here is these three disagreeing.
 */
const read = () =>
  cdp.evaluate(`(async () => {
    const rail = document.querySelector('.source-rail');
    const box = rail ? rail.getBoundingClientRect() : null;
    const state = await window.agentAPI.getSources();
    const bounds = await window.agentAPI.getViewBounds();
    return {
      win: { w: window.innerWidth, h: window.innerHeight },
      rail: box ? { left: Math.round(box.left), right: Math.round(box.right), w: Math.round(box.width) } : null,
      buttons: [...document.querySelectorAll('.rail-btn')].map(b => ({
        title: b.title,
        active: b.classList.contains('active')
      })),
      sources: state.sources.map(s => ({ id: s.id, planning: s.planning })),
      activeId: state.activeId,
      bounds
    };
  })()`);

/**
 * Clicks a rail button the way a user would — through the DOM, not through the
 * IPC call the button happens to make. If the native view covers the rail, the
 * click never arrives and this is where it shows up.
 */
const activate = async id => {
  await cdp.evaluate(`(async () => {
    const state = await window.agentAPI.getSources();
    const index = state.sources.findIndex(s => s.id === ${JSON.stringify(id)});
    if (index < 0) throw new Error('未知来源：' + ${JSON.stringify(id)});
    const buttons = [...document.querySelectorAll('.rail-btn')];
    if (!buttons[index]) throw new Error('来源栏里没有第 ' + index + ' 个按钮');
    buttons[index].click();
    return true;
  })()`);
  // The click goes renderer -> IPC -> main -> setBounds -> sources:changed. A
  // fixed sleep here reports a correct switch as a failure whenever the site is
  // slow, so wait for the state instead.
  await waitFor(async () => (await read()).activeId, id, { timeoutMs: 6000 });
  return read();
};

/** A view is "parked" when it sits entirely past the window's right edge. */
const isParked = (view, winWidth) => !view || view.x >= winWidth;

/** Views that are on screen and reach past the rail's left edge cover it. */
const coveringRail = state =>
  Object.entries(state.bounds)
    .filter(([, rect]) => rect.x < state.win.w && rect.x + rect.width > state.rail.left)
    .map(([id]) => id);

// --- the rail itself -------------------------------------------------------
// Start on the planning pane so the geometry below is about a page that exists.
const base = await activate('deepseek');

checkTrue('窗口宽度被读到', base.win.w > 0);
checkTrue('右侧存在来源栏', base.rail !== null);
check('来源栏贴在窗口右边缘', base.rail.right, base.win.w);
check('来源栏宽度等于 RAIL_WIDTH', base.rail.w, RAIL_WIDTH);
check('按钮数量等于来源数量', base.buttons.length, base.sources.length);
checkTrue('只有一个来源被标记为规划通道', base.sources.filter(s => s.planning).length === 1);
check('DeepSeek 是规划通道', base.sources.find(s => s.id === 'deepseek')?.planning, true);
check('当前来源被高亮', base.buttons.filter(b => b.active).length, 1);

// --- the page must stop where the rail begins ------------------------------
const view = base.bounds[base.activeId];
checkTrue('当前页面视图已创建', Boolean(view));
check('页面视图右边缘正好停在来源栏左边缘', Math.round(view.x + view.width), base.rail.left);
check('没有任何页面视图压住来源栏', coveringRail(base).length, 0);

// --- switching -------------------------------------------------------------
const others = base.sources.map(s => s.id).filter(id => id !== base.activeId);
checkTrue('至少还有一个来源可以切换', others.length > 0);

for (const id of others) {
  const switched = await activate(id);
  const rect = switched.bounds[id] ?? { x: 0, width: 0 };

  check(`切换到 ${id}`, switched.activeId, id);
  check(`切换后只有 ${id} 被高亮`, switched.buttons.filter(b => b.active).length, 1);
  // The view has to be in the layout before the page finishes loading: a view
  // created but not yet placed has zero bounds, and the pane is blank for as
  // long as the site is slow — which reads as "the button did nothing".
  checkTrue(`切换到 ${id} 时视图立刻就有了位置，不用等页面加载完`, rect.width > 0);
  check(`切换后 ${id} 的视图贴着来源栏左边缘`, Math.round(rect.x + rect.width), switched.rail.left);
  check('切换后没有任何页面视图压住来源栏', coveringRail(switched).length, 0);

  // The page that was just replaced must be parked, not destroyed: dropping the
  // view drops the target, and with it whatever the model was writing.
  checkTrue('旧页面仍然存在，没有被销毁', base.activeId in switched.bounds);
  checkTrue('旧页面被移出窗口', isParked(switched.bounds[base.activeId], switched.win.w));
}

// --- and back --------------------------------------------------------------
const back = await activate(base.activeId);
check('切回规划页面', back.activeId, base.activeId);
check(
  '切回后页面视图重新对齐到来源栏左边缘',
  Math.round(back.bounds[base.activeId].x + back.bounds[base.activeId].width),
  back.rail.left
);
check('切回后没有任何页面视图压住来源栏', coveringRail(back).length, 0);
for (const id of others) {
  checkTrue(`切回后 ${id} 被停到窗口外`, isParked(back.bounds[id], back.win.w));
}

// The planning page must survive a round trip. This is checked against the
// DevTools target list rather than a URL field, because a view that has been
// torn down has no target at all.
const live = await listTargets();
checkTrue('切换往返后规划页面仍然活着', live.some(t => t.url.includes('chat.deepseek.com')));

// Every embedded page must have a real box, not just the one on screen. A view
// that has never been given a size measures 0 wide for every element in it, so
// the probe cannot find an input box and the channel reports "未找到输入框，页面
// 结构可能已变化" about a healthy page — and a source the user never clicked is
// silently unaskable, which turns two-channel comparison into one channel.
for (const target of live.filter(t => t.type === 'page' && !t.url.startsWith('file:'))) {
  const pageCdp = await connect(target);
  const viewport = await pageCdp.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })');
  const size = JSON.parse(viewport);
  checkTrue(`内嵌页面有真实尺寸：${new URL(target.url).host}`, size.w > 0 && size.h > 0);
  pageCdp.close();
}

const tally = summary();
cdp.close();
process.exit(tally.fail === 0 ? 0 : 1);
