/**
 * Checks the strip above the embedded page, and 放大 / 吸附回来.
 *
 * The failure this exists for is not visual: the page is a native view painted
 * over the document, so a bar drawn in the wrong place is *invisible* rather
 * than misplaced — it is simply covered. The only way to catch that is to
 * compare the bar's rectangle with the view's bounds, which is exactly what the
 * first check does.
 *
 * The detach half is about the page really growing. A `WebContentsView` that is
 * re-parented but never re-measured keeps its old viewport, and then the page
 * renders at the old width inside a bigger window — which looks like a zoomed
 * screenshot, not a bigger page. So the assertion is on `window.innerWidth` of
 * the page itself, not on the window size.
 *
 * Usage: node scripts/check-page-pane.mjs   (app running with --remote-debugging-port=9222)
 */
import { connect, createChecks, findAppTarget, listTargets, sleep, waitFor } from './lib/cdp.mjs';

/** Mirrors RAIL_WIDTH / PAGE_GUTTER / PAGE_HEADER_HEIGHT in src/shared/layout.ts. */
const RAIL = 46;
const GUTTER = 10;
const HEADER = 36;

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

// The rail may leave another page in front. This check is about one pane, so put
// the planning page there first.
const before = await cdp.evaluate('window.agentAPI.getSources()');
if (before.activeId !== 'deepseek') {
  await cdp.evaluate("window.agentAPI.setSource('deepseek')");
  await sleep(900);
}
// And make sure nothing is left detached from an earlier run.
await cdp.evaluate('window.agentAPI.reattachPage()');
await sleep(400);

const readPane = () =>
  cdp.evaluate(`(() => {
    const bar = document.querySelector('.page-bar');
    const rect = bar ? bar.getBoundingClientRect() : null;
    return {
      split: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--split'), 10),
      bar: rect ? { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      text: bar ? bar.innerText.split('\\n').join(' / ') : '',
      // Icon buttons carry no text, so the label has to come from aria-label —
      // which is also what a screen reader reads, so this checks the same thing
      // a person using one would get.
      buttons: [...document.querySelectorAll('.page-btn')].map(button => button.getAttribute('aria-label') ?? button.textContent),
      iconButton: Boolean(document.querySelector('.page-btn.icon svg')),
      iconWidth: (() => {
        const icon = document.querySelector('.page-btn.icon');
        return icon ? Math.round(icon.getBoundingClientRect().width) : 0;
      })(),
      placeholder: Boolean(document.querySelector('.page-detached')),
      hasNote: Boolean(document.querySelector('.page-note'))
    };
  })()`);

const viewOf = async () => {
  const bounds = await cdp.evaluate('window.agentAPI.getViewBounds()');
  return bounds.deepseek ?? null;
};

const pageViewport = async () => {
  const list = await listTargets();
  const page = list.find(target => target.url.includes('chat.deepseek.com'));
  if (!page) return null;
  const pageCdp = await connect(page);
  const size = await pageCdp.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })');
  pageCdp.close();
  return JSON.parse(size);
};

// ---------------------------------------------------------------- the bar

const pane = await readPane();
checkTrue('页面栏存在', pane.bar !== null);
if (pane.bar) {
  const view = await viewOf();
  checkTrue('页面栏宽度与页面视图一致', Math.abs(pane.bar.width - view.width) <= 1);
  // This is the one that matters: the view must start *below* the bar, or the
  // bar is painted but covered.
  check('页面视图从页面栏下沿开始', view.y, HEADER);
  check('页面栏高度就是预留的那一条', pane.bar.height, HEADER);
  checkTrue('页面栏与页面视图左边缘对齐', Math.abs(pane.bar.left - view.x) <= 1);
  checkTrue('页面栏里有两个按钮：放大、更新样式', pane.buttons.join('/') === '放大/更新样式');
  // The pane can be dragged down to 380px, and two four-character labels used to
  // push the status out of view. An icon is a fixed width, so this asserts the
  // width rather than trusting that it stayed small.
  checkTrue('放大是一个图标按钮', pane.iconButton);
  checkTrue(`图标按钮是方形的（${String(pane.iconWidth)}px）`, pane.iconWidth > 0 && pane.iconWidth <= 26);
  checkTrue('页面栏写出了来源', pane.text.includes('DeepSeek'));
  // Any of the real states is fine — the page may be signed out, and this check
  // must not depend on somebody's session staying alive. What it does assert is
  // that the bar says *something* about the page.
  checkTrue(`页面栏写出了状态（${pane.text}）`, /(就绪|加载中|登录|不可用)/.test(pane.text));
  // The repair result used to live here and got cut off; it is a dialog now.
  checkTrue('页面栏里不再挤着结果文字', pane.hasNote === false);
  check('页面还没有被分离', pane.placeholder, false);
}

// -------------------------------------------------------------- detach

const detached = await cdp.evaluate("window.agentAPI.detachPage('deepseek')");
check('放大之后状态里记录了分离的页面', detached.detachedId, 'deepseek');

const afterDetach = await waitFor(async () => (await readPane()).placeholder, true, { timeoutMs: 3000 });
check('主窗口的页面位置换成了说明', afterDetach, true);

const detachedView = await viewOf();
const grown = await waitFor(
  async () => {
    const size = await pageViewport();
    return size ? size.w : 0;
  },
  detachedView.width,
  { timeoutMs: 6000 }
);
// The page inside the detached window has to be re-measured, not just moved.
checkTrue(`分离后页面真的变宽了（${String(grown)} > ${String(pane.bar?.width ?? 0)}）`, grown > (pane.bar?.width ?? 0));
checkTrue('分离后页面仍有真实尺寸', grown > 200);

const barWhenDetached = await readPane();
checkTrue('按钮变成「吸附回来」', barWhenDetached.buttons[0] === '吸附回来');

// ------------------------------------------------------------ reattach

await cdp.evaluate('window.agentAPI.reattachPage()');
await sleep(600);

const back = await readPane();
check('吸附回来后不再有说明卡', back.placeholder, false);
checkTrue('按钮变回「放大」', back.buttons[0] === '放大');

const backView = await viewOf();
check('吸附回来后页面视图回到原位', backView.y, HEADER);
checkTrue('吸附回来后宽度恢复', Math.abs(backView.width - (back.split - GUTTER - RAIL)) <= 1);

const restored = await waitFor(
  async () => {
    const size = await pageViewport();
    return size ? size.w : 0;
  },
  backView.width,
  { timeoutMs: 6000 }
);
check('吸附回来后页面视口也跟着恢复', restored, backView.width);

// ------------------------------------------------------------ repair

// Press the real button, not the IPC call: the point of this half is that the
// result reaches the user, and the dialog is opened by the click handler.
await cdp.evaluate(`document.querySelector('.page-btn[data-action="learn"]').click()`);

const readDialog = () =>
  cdp.evaluate(`(() => {
    const panel = document.querySelector('.style-panel');
    if (!panel) return { open: false };
    return {
      open: true,
      title: panel.querySelector('.diag-head b')?.textContent ?? '',
      message: panel.querySelector('.style-lead')?.textContent ?? '',
      roles: [...panel.querySelectorAll('.style-role-name')].map(node => node.textContent),
      badges: [...panel.querySelectorAll('.style-badge')].map(node => node.textContent),
      selectors: [...panel.querySelectorAll('.style-selectors code')].map(node => node.textContent),
      probe: panel.querySelector('.style-probe')?.textContent ?? ''
    };
  })()`);

const opened = await waitFor(async () => (await readDialog()).open, true, { timeoutMs: 20000 });
check('点「更新样式」后弹出结果', opened, true);

const dialog = await readDialog();
checkTrue(`弹窗标题写明了来源（${dialog.title}）`, dialog.title.includes('DeepSeek'));
checkTrue(`弹窗写出了结论（${dialog.message}）`, dialog.message.length > 0);
check('弹窗按三项角色列出', dialog.roles.join('/'), '输入框/发送键/回答区域');
check('每项角色都有状态', dialog.badges.length, 3);
// Whichever state the page is in, the sentence has to name it — "已重新提取",
// "不需要更新", or the reason it could not be checked. A generic "失败" would
// pass a looser assertion and tell the user nothing.
checkTrue(
  `结论解释了当前状态（${dialog.message}）`,
  /(已重新提取|不需要更新|校准|登录|加载|仍没找到)/.test(dialog.message)
);
checkTrue(`弹窗附上了页面状态（${dialog.probe}）`, /页面 \d+px/.test(dialog.probe));
checkTrue('有提取结果时列出了具体选择器', dialog.badges.includes('已重新提取') ? dialog.selectors.length > 0 : true);
checkTrue('列出的选择器都不是空的', dialog.selectors.every(item => item.trim().length > 8));

await cdp.evaluate(`document.querySelector('.style-foot .btn').click()`);
const closed = await waitFor(async () => (await readDialog()).open, false, { timeoutMs: 3000 });
check('关掉之后弹窗消失', closed, false);

summary();
cdp.close();
