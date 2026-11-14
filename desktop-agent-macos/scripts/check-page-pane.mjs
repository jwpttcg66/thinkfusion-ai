/**
 * Checks the strip above the embedded page, and 放大 / 吸附回来 / 收起 — the last
 * of which now lives at the top of the source rail, on the window's right edge.
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
 * The fold half is the mirror image: folding must give the width back to the app
 * *without* taking the page's viewport away. A hidden view that was shrunk to
 * zero loses it, and the channel then reports "找不到输入框" about a page that is
 * perfectly healthy — so the assertion is that the box is unchanged and only the
 * painting stopped.
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
// one page there first — whichever source is enabled first, since which sources
// ship switched on is a product decision, not a fact this script should assume.
const before = await cdp.evaluate('window.agentAPI.getSources()');
const source = before.sources.find(s => s.enabled);
if (!source) throw new Error('没有启用的来源：页面窗格检查无法进行');
const SOURCE = source.id;
const HOST = new URL(source.url).host;
if (before.activeId !== SOURCE) {
  await cdp.evaluate(`window.agentAPI.setSource(${JSON.stringify(SOURCE)})`);
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
      // The path data, not just the label: a label can flip while the drawing
      // stays put, and then the button says "back" but still looks like "grow".
      // Joined, because the dock-back glyph is two paths. Scoped to the detach
      // button, because the fold button is an icon too.
      iconPath: [...document.querySelectorAll('.page-btn[data-action="detach"] path')]
        .map(path => path.getAttribute('d'))
        .join('|'),
      iconWidth: (() => {
        const icon = document.querySelector('.page-btn.icon');
        return icon ? Math.round(icon.getBoundingClientRect().width) : 0;
      })(),
      // The fold toggle is no longer in this bar: it lives at the top of the
      // rail, on the window's right edge. Read here anyway so one round trip
      // answers "where is it and what does it draw".
      railToggle: (() => {
        const button = document.querySelector('.rail-toggle');
        if (!button) return null;
        const box = button.getBoundingClientRect();
        return {
          label: button.getAttribute('aria-label'),
          pressed: button.getAttribute('aria-pressed'),
          path: [...button.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|'),
          filled: [...button.querySelectorAll('path[fill="currentColor"]')].length,
          right: Math.round(box.right),
          width: Math.round(box.width),
          // The drawing and the paint, so the folded state can be compared with
          // the open one. The requirement is that they are identical.
          glyph: Math.round(button.querySelector('svg')?.getBoundingClientRect().width ?? 0),
          background: getComputedStyle(button).backgroundColor,
          border: getComputedStyle(button).borderTopColor
        };
      })(),
      winWidth: window.innerWidth,
      // Whether the window is in front. It decides whether the focus ring can be
      // observed at all: with the window behind another app, Chromium still
      // paints its own ring around the focused element but does not match
      // author :focus-visible rules, so the reading is the UA's colour and the
      // assertion would fail for a reason that has nothing to do with the app.
      appFocused: document.hasFocus(),
      // The focus ring, forced on. Chromium's default is the *system* highlight
      // colour — orange on this machine, around a blue-accent app — so the ring
      // has to be ours, and this is where that is checked.
      focusRing: (() => {
        const button = document.querySelector('.rail-toggle');
        if (!button) return null;
        button.focus({ focusVisible: true });
        const style = getComputedStyle(button);
        const ring = { color: style.outlineColor, width: style.outlineWidth };
        button.blur();
        return ring;
      })(),
      placeholder: Boolean(document.querySelector('.page-detached')),
      hasNote: Boolean(document.querySelector('.page-note')),
      // What the app column reserved for the pane. Read from the computed style
      // rather than from the --split variable: the variable could be right while
      // the rule that consumes it is missing, and then the app draws under the
      // page.
      appPadding: Number.parseInt(getComputedStyle(document.querySelector('.app')).paddingRight, 10),
      stub: (() => {
        const node = document.querySelector('.page-stub');
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { left: Math.round(box.left), width: Math.round(box.width) };
      })(),
      stubLabel: document.querySelector('.page-stub-label')?.textContent ?? '',
      // The strip itself is the button now — a 24px glyph inside a 30px column
      // was a small target for undoing the fold, and after the toggle moved to
      // the rail it was a second copy of the same control.
      expandLabel: document.querySelector('.page-stub')?.getAttribute('aria-label') ?? null,
      expandTag: document.querySelector('.page-stub')?.tagName ?? '',
      railLeft: Math.round(document.querySelector('.source-rail').getBoundingClientRect().left)
    };
  })()`);

const viewOf = async () => {
  const bounds = await cdp.evaluate('window.agentAPI.getViewBounds()');
  return bounds[SOURCE] ?? null;
};

const pageViewport = async () => {
  const list = await listTargets();
  const page = list.find(target => target.url.includes(HOST));
  if (!page) return null;
  const pageCdp = await connect(page);
  const size = await pageCdp.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })');
  pageCdp.close();
  return JSON.parse(size);
};

// ---------------------------------------------------------------- the bar

// A cold start reads "页面尚未加载" for a second or two — true, and not what the
// status assertion below is about. Wait for the page to settle rather than
// teaching the assertion to accept a state that means "ask again later".
await waitFor(async () => !(await readPane()).text.includes('尚未加载'), true, { timeoutMs: 12000 });

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
  check('页面栏的操作顺序稳定', pane.buttons.join('/'), '保存文档/保存为 Word/刷新/诊断/放大');
  // 收起 moved out of this bar on purpose: the bar is inside the pane, so folding
  // deleted the button that undoes the fold. It now sits at the top of the rail —
  // the window's right edge — and this is the assertion that keeps it there.
  checkTrue('收起按钮在轨道里', pane.railToggle !== null);
  checkTrue(
    `收起按钮贴着窗口右边（右沿 ${String(pane.railToggle?.right)} / 窗口 ${String(pane.winWidth)}）`,
    (pane.railToggle?.right ?? 0) >= pane.winWidth - 8
  );
  checkTrue(`收起画的是面板（${pane.railToggle?.path ?? ''}）`, (pane.railToggle?.path ?? '').includes('M4.4 3.1'));
  checkTrue('面板右侧那一列是实心的', (pane.railToggle?.filled ?? 0) === 1);
  checkTrue('收起和放大不是同一个图标', (pane.railToggle?.path ?? '') !== pane.iconPath);
  // 收起 is a window-level control, not a fourth page: a size up from the page
  // buttons below it, and a bigger glyph inside.
  const pageButtonWidth = await cdp.evaluate(`Math.round(document.querySelector('.rail-btn').getBoundingClientRect().width)`);
  checkTrue(`收起按钮比来源按钮大（${String(pane.railToggle?.width)} > ${String(pageButtonWidth)}）`, (pane.railToggle?.width ?? 0) > pageButtonWidth);
  checkTrue(`图标本身也更大（${String(pane.railToggle?.glyph)}px）`, (pane.railToggle?.glyph ?? 0) >= 18);
  // The ring is only observable with the window in front — see `appFocused`.
  // Reporting the UA's colour as a regression would send the next person looking
  // at the CSS for a bug that is a background window.
  if (pane.appFocused) {
    check('聚焦环用的是应用自己的蓝，不是系统强调色', pane.focusRing?.color, 'rgb(77, 107, 254)');
    check('聚焦环两像素，和按钮留出间隙', `${pane.focusRing?.width}`, '2px');
  } else {
    console.log('note  the app window is not in front, so author :focus-visible rules do not match — the focus ring is not asserted');
  }
  // The pane can be dragged down to 380px, and two four-character labels used to
  // push the status out of view. An icon is a fixed width, so this asserts the
  // width rather than trusting that it stayed small.
  checkTrue('放大是一个图标按钮', pane.iconButton);
  checkTrue(`放大画的是向外四角（${pane.iconPath}）`, pane.iconPath.includes('M6 2.5H2.5V6'));
  checkTrue(`图标按钮是方形的（${String(pane.iconWidth)}px）`, pane.iconWidth > 0 && pane.iconWidth <= 26);
  checkTrue(`页面栏写出了来源（${source.label}）`, pane.text.includes(source.label));
  // Any of the real states is fine — the page may be signed out, and this check
  // must not depend on somebody's session staying alive. What it does assert is
  // that the bar says *something* about the page.
  checkTrue(`页面栏写出了状态（${pane.text}）`, /(就绪|加载中|登录|不可用)/.test(pane.text));
  // The repair result used to live here and got cut off; it is a dialog now.
  checkTrue('页面栏里不再挤着结果文字', pane.hasNote === false);
  check('页面还没有被分离', pane.placeholder, false);
}

// -------------------------------------------------------------- detach

const detached = await cdp.evaluate(`window.agentAPI.detachPage(${JSON.stringify(SOURCE)})`);
check('放大之后状态里记录了分离的页面', detached.detachedId, SOURCE);

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
checkTrue('主窗口按钮变成「吸附回来」', barWhenDetached.buttons.at(-1) === '吸附回来');
// The glyph has to change too. This is the assertion that would have caught the
// detached window still showing a text button while the main window showed an
// icon: same action, two different-looking controls.
checkTrue(`图标换成箭头回到竖线（${barWhenDetached.iconPath}）`, barWhenDetached.iconPath.includes('M13 8H6.2'));
checkTrue('两个状态的图标不是同一个', barWhenDetached.iconPath !== pane.iconPath);

// The detached window's own toolbar carries the same button, drawn from the same
// path data in shared/icons.ts. Its document is a `data:` URL that loads
// asynchronously, so this waits for it instead of racing it.
const detachedFrame = (await listTargets()).find(target => target.url.startsWith('data:text/html'));
let detachedCdp = null;
if (detachedFrame) {
  const frameCdp = await connect(detachedFrame);
  detachedCdp = frameCdp;
  const readBack = () =>
    frameCdp.evaluate(`(() => {
      const back = document.getElementById('back');
      const save = document.getElementById('save');
      const word = document.getElementById('save-word');
      const paths = back ? [...back.querySelectorAll('svg path')].map(path => path.getAttribute('d')) : [];
      const savePaths = save ? [...save.querySelectorAll('svg path')].map(path => path.getAttribute('d')) : [];
      const wordPaths = word ? [...word.querySelectorAll('svg path')].map(path => path.getAttribute('d')) : [];
      return {
        ready: paths.length > 0 && savePaths.length > 0 && wordPaths.length > 0,
        label: back ? back.getAttribute('aria-label') : null,
        path: paths.join('|'),
        saveLabel: save ? save.getAttribute('aria-label') : null,
        savePath: savePaths.join('|'),
        wordLabel: word ? word.getAttribute('aria-label') : null,
        wordPath: wordPaths.join('|')
      };
    })()`);
  const ready = await waitFor(async () => (await readBack()).ready, true, { timeoutMs: 4000 });
  const frameBar = await readBack();
  check('独立窗口的工具栏加载出来了', ready, true);
  checkTrue('独立窗口里的按钮也是图标', frameBar.ready);
  checkTrue('独立窗口的图标和主窗口一致', frameBar.path.includes('M13 8H6.2'));
  check('独立窗口的按钮有可读的名字', frameBar.label, '吸附回去');
  // 放大之后眼前就是独立窗口：保存必须在这里，不能只留在主窗口那条页面栏上。
  check('独立窗口有保存文档', frameBar.saveLabel, '保存文档');
  checkTrue('独立窗口的保存图标是纸+箭头', frameBar.savePath.includes('M3 1.9h6.1'));
  check('独立窗口有保存为 Word', frameBar.wordLabel, '保存为 Word');
  checkTrue('独立窗口的 Word 也是图标（纸+横线）', frameBar.wordPath.includes('M5.5 8.2h5'));
  await frameCdp.evaluate("document.getElementById('save').click()").catch(() => undefined);
  const saveErrorVisible = await waitFor(
    async () => Boolean(await cdp.evaluate('document.querySelector(".error")?.textContent')),
    true,
    { timeoutMs: 15000 }
  );
  const saveError = await cdp.evaluate('document.querySelector(".error")?.textContent ?? ""');
  checkTrue(`独立窗口保存请求转交给主窗口同一套提取流程（${saveError}）`, saveErrorVisible && saveError.includes(source.label));
  const focusedDetached = await cdp.evaluate(`window.agentAPI.focusDetachedPage(${JSON.stringify(SOURCE)})`);
  check('独立窗口保存请求后可以返回放大窗口', focusedDetached, true);
  check(
    '返回放大窗口不会吸附或销毁页面',
    (await cdp.evaluate('window.agentAPI.getPageState()')).detachedId,
    SOURCE
  );
} else {
  checkTrue('独立窗口存在', false);
}

// ------------------------------------------------------------ reattach

// Exercise the detached window's own 「吸附回去」 control, not the duplicate in
// the main window. Closing the standalone window used to destroy the WebContentsView
// instead of returning it, leaving an empty pane that looked stuck.
if (detachedCdp) {
  await detachedCdp.evaluate("document.getElementById('back').click()").catch(() => undefined);
  await waitFor(async () => (await cdp.evaluate('window.agentAPI.getPageState()')).detachedId, null, { timeoutMs: 3000 });
  detachedCdp.close();
} else {
  checkTrue('独立窗口控制桥已连接', false);
}
await sleep(600);

const back = await readPane();
check('吸附回来后不再有说明卡', back.placeholder, false);
checkTrue('主窗口按钮变回「放大」', back.buttons.at(-1) === '放大');

const backView = await viewOf();
checkTrue('吸附回来后原网页视图仍然存在', backView !== null);
if (backView) {
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
  // The viewport only moves when Chromium lays the page out, and it does not do
  // that for a window that is not in front. Say which one this is instead of
  // reporting the environment as a bug in the reattach path.
  if (await cdp.evaluate('document.hasFocus()')) {
    check('吸附回来后页面视口也跟着恢复', restored, backView.width);
  } else {
    console.log('note  the app window is not in front, so the page was never relaid out — viewport assertion skipped');
    checkTrue('吸附回来后页面视图仍然有尺寸', backView.width > 0);
  }
} else {
  check('吸附回来后页面视图回到原位', null, HEADER);
  checkTrue('吸附回来后宽度恢复', false);
}

// The main-window toggle is a second supported reattach route. Exercise it too
// after returning from the detached toolbar so both controls keep the same view.
await cdp.evaluate(`document.querySelector('.page-btn[data-action="detach"]').click()`);
await waitFor(async () => (await cdp.evaluate('window.agentAPI.getPageState()')).detachedId, SOURCE, { timeoutMs: 3000 });
await cdp.evaluate(`document.querySelector('.page-btn[data-action="detach"]').click()`);
await waitFor(async () => (await cdp.evaluate('window.agentAPI.getPageState()')).detachedId, null, { timeoutMs: 3000 });
await sleep(100);
const mainToggleView = await viewOf();
checkTrue('主窗口吸附按钮也保留原网页视图', mainToggleView !== null);
if (mainToggleView) {
  check('主窗口吸附后页面回到页面栏下方', mainToggleView.y, HEADER);
  checkTrue('主窗口吸附后页面尺寸有效', mainToggleView.width > 200 && mainToggleView.height > 100);
}

// ------------------------------------------------------------ diagnostics

// Open the channel report from the page bar, then run the repair from the
// diagnostics panel where the action now lives.
await cdp.evaluate(`document.querySelector('.page-btn[data-action="diagnose"]').click()`);

const readDialog = () =>
  cdp.evaluate(`(() => {
    const panel = document.querySelector('.diag-overlay[aria-label="通道诊断"]');
    const repair = panel?.querySelector('.diag-repair');
    if (!repair) return { open: false };
    return {
      open: true,
      title: repair.querySelector('h3')?.textContent ?? '',
      message: repair.querySelector('.style-lead')?.textContent ?? '',
      roles: [...repair.querySelectorAll('.style-role-name')].map(node => node.textContent),
      badges: [...repair.querySelectorAll('.style-badge')].map(node => node.textContent),
      selectors: [...repair.querySelectorAll('.style-selectors code')].map(node => node.textContent),
      probe: repair.querySelector('.style-probe')?.textContent ?? ''
    };
  })()`);

await waitFor(async () => Boolean(await cdp.evaluate('document.querySelector(".diag-overlay[aria-label=\\"通道诊断\\"]")')), true, { timeoutMs: 5000 });
await cdp.evaluate(`document.querySelector('.diag-overlay[aria-label="通道诊断"] .diag-fix button').click()`);
const opened = await waitFor(async () => (await readDialog()).open, true, { timeoutMs: 20000 });
check('点「更新样式」后报告显示在诊断面板', opened, true);

const dialog = await readDialog();
checkTrue(`报告标题写明了来源（${dialog.title}）`, dialog.title.includes(source.label));
checkTrue(`报告写出了结论（${dialog.message}）`, dialog.message.length > 0);
check('报告按三项角色列出', dialog.roles.join('/'), '输入框/发送键/回答区域');
check('每项角色都有状态', dialog.badges.length, 3);
// Whichever state the page is in, the sentence has to name it — "已重新提取",
// "不需要更新", or the reason it could not be checked. A generic "失败" would
// pass a looser assertion and tell the user nothing.
checkTrue(
  `结论解释了当前状态（${dialog.message}）`,
  /(已重新提取|不需要更新|校准|登录|加载|仍没找到)/.test(dialog.message)
);
checkTrue(`报告附上了页面状态（${dialog.probe}）`, /页面 \d+px/.test(dialog.probe));
checkTrue('有提取结果时列出了具体选择器', dialog.badges.includes('已重新提取') ? dialog.selectors.length > 0 : true);
checkTrue('列出的选择器都不是空的', dialog.selectors.every(item => item.trim().length > 8));

await cdp.evaluate(`document.querySelector('.diag-overlay[aria-label="通道诊断"] .diag-actions button:last-child').click()`);
const closed = await waitFor(async () => (await readDialog()).open, false, { timeoutMs: 3000 });
check('关掉之后弹窗消失', closed, false);

// ------------------------------------------------------------------ fold

// Start from a known state: an earlier run, or the section above, may have left
// the pane folded.
await cdp.evaluate('window.agentAPI.setPageCollapsed(false)');
await sleep(350);

const openPane = await readPane();
const openView = await viewOf();
const openViewport = await pageViewport();
const viewportWidth = await cdp.evaluate('window.innerWidth');

// Press the real button. Folding removes the bar that carries the button, so a
// click is also the only way to prove the reply arrives before the bar is gone.
await cdp.evaluate(`document.querySelector('.rail-toggle').click()`);
const folded = await waitFor(async () => (await readPane()).railToggle?.label === '展开网页', true, {
  timeoutMs: 3000
});
check('点「收起」之后轨道开关变成展开', folded, true);

const stub = await readPane();
check('收起后页面栏消失', stub.bar, null);
check('收起后不再画竖排站名框', stub.stub, null);
// The switch keeps its face: same drawing, same fill, same paint. Only the
// label and the window behind it change — a control that redraws itself is a
// second thing to read.
check('收起后图标没变', stub.railToggle?.path, pane.railToggle?.path);
check('收起后填充没变', stub.railToggle?.filled, pane.railToggle?.filled);
check('收起后底色没变', stub.railToggle?.background, pane.railToggle?.background);
check('收起后边框没变', stub.railToggle?.border, pane.railToggle?.border);
check('收起后只有名字变了', stub.railToggle?.label, '展开网页');
// The width has to go back to the app, but not all the way: the rail stays, and
// a zero split would put the app column underneath it.
check('收起后只留轨道', stub.split, RAIL);
check('收起后应用列排到轨道前', stub.appPadding, RAIL);

const foldedView = await viewOf();
checkTrue(`收起后页面视图挪到窗口外（${String(foldedView.x)} > ${String(viewportWidth)}）`, foldedView.x > viewportWidth);
// This is the assertion the whole section exists for. Folding must hide the
// view, not shrink it: a view handed a zero-width rectangle loses the viewport
// it was primed with, and every element in the page then measures zero.
check('收起没有把页面视图缩没', foldedView.width, openView.width);
const foldedViewport = await pageViewport();
checkTrue('两个状态的页面视口都读得到', openViewport !== null && foldedViewport !== null);
check('收起后页面自己的视口没变', foldedViewport?.w, openViewport?.w);

await cdp.evaluate(`document.querySelector('.rail-toggle').click()`);
const unfolded = await waitFor(async () => (await readPane()).bar !== null, true, { timeoutMs: 3000 });
check('点展开之后页面栏回来了', unfolded, true);

const backPane = await readPane();
check('展开后宽度回到收起前', backPane.split, openPane.split);
check('展开后应用列也回到收起前', backPane.appPadding, openPane.appPadding);
check('展开后页面栏操作顺序稳定', backPane.buttons.join('/'), '保存文档/保存为 Word/刷新/诊断/放大');

const backToPane = await viewOf();
check('展开后页面视图回到原位', backToPane.x, openView.x);
check('展开后页面视图恢复宽度', backToPane.width, openView.width);

summary();
cdp.close();
