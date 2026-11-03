/**
 * Checks the account row and 设置 · 模型.
 *
 * The failure this exists for is the one the feature was asked for: an address
 * that cannot be changed, and a source that cannot be switched off. Every
 * assertion here is either "the row is there" or "the value that was typed is
 * the value the main process now holds" — because a settings panel that renders
 * a saved-looking address while the app still loads the old one is worse than no
 * panel at all.
 *
 * It deliberately edits **Kimi's** address rather than DeepSeek's: Kimi is off
 * by default and has no view, so the edit costs no navigation and cannot sign
 * anybody out of the page they are using. The one thing it asserts about
 * DeepSeek is the rule that matters — the switch on every row works, and the
 * last remaining source cannot be switched off.
 *
 * Usage: node scripts/check-settings.mjs   (app running with --remote-debugging-port=9222)
 */
import os from 'node:os';
import { connect, createChecks, findAppTarget, listTargets, sleep, waitFor } from './lib/cdp.mjs';

const KIMI_DEFAULT = 'https://kimi.moonshot.cn/';
const KIMI_TRIAL = 'https://kimi.com/';
const LAST_REFUSED = '至少要留一个来源，全关掉 Agent 就没地方问了';

const targets = await listTargets();
const app = findAppTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const cdp = await connect(app);
const { check, checkTrue, summary } = createChecks();

// Start from a known state. A previous run that died halfway would otherwise
// leave Kimi on — or on the trial address it typed — and then the assertions
// below are measuring the previous run instead of this one.
//
// Order matters: switch the two on *before* switching the others off, or a run
// that died while only one source was on would make the first "off" illegal and
// the check would fail on its own housekeeping.
await cdp.evaluate('window.agentAPI.saveSource("deepseek", { enabled: true })');
await cdp.evaluate('window.agentAPI.saveSource("chatgpt", { enabled: true })');
await cdp.evaluate(`window.agentAPI.saveSource("kimi", { url: "${KIMI_DEFAULT}", enabled: false })`);
await cdp.evaluate('window.agentAPI.saveSource("workbuddy", { enabled: false })');
// Same reasoning for the name: the account-row assertions below expect the
// shipped name, and a run that died after renaming would otherwise fail on its
// own leftovers rather than on a real regression.
await cdp.evaluate('window.agentAPI.setDisplayName("")');
await sleep(400);

// Housekeeping that verifies itself. Four fire-and-forget writes are not a known
// state — a rejected write (the last-source rule) or a panel that was still
// saving leaves the run measuring something else, and the failure then shows up
// three assertions later as "the planner did not come back". Read it back, and
// say so plainly if it did not take.
const settled = await waitFor(
  async () => {
    const list = await cdp.evaluate('window.agentAPI.getSources()');
    const state = Object.fromEntries(list.sources.map(source => [source.id, source.enabled]));
    return state.deepseek === true && state.chatgpt === true && state.kimi === false && state.workbuddy === false;
  },
  true,
  { timeoutMs: 4000 }
);
if (!settled) {
  const list = await cdp.evaluate('window.agentAPI.getSources()');
  throw new Error(`检查开始前无法把来源恢复成已知状态：${JSON.stringify(list.sources.map(s => [s.id, s.enabled]))}`);
}

const readFoot = () =>
  cdp.evaluate(`(() => {
    const foot = document.querySelector('.side-foot');
    if (!foot) return { present: false };
    return {
      present: true,
      name: foot.querySelector('.side-foot-name')?.textContent ?? '',
      title: foot.querySelector('.side-foot-name')?.getAttribute('title') ?? '',
      initial: foot.querySelector('.side-foot-avatar')?.textContent ?? '',
      buttons: [...foot.querySelectorAll('.side-foot-btn')].map(button => button.getAttribute('aria-label')),
      icons: [...foot.querySelectorAll('.side-foot-btn svg')].length
    };
  })()`);

const readPanel = () =>
  cdp.evaluate(`(() => {
    const panel = document.querySelector('.settings-panel');
    // formUrl is null on a closed panel, not undefined: the helpers below use
    // "is there a form open" as a boolean, and undefined would read as "yes".
    if (!panel) return { open: false, formUrl: null, tags: [], urls: [] };
    const rows = [...panel.querySelectorAll('.settings-row')];
    return {
      open: true,
      nav: [...panel.querySelectorAll('.settings-nav-item')].map(item => item.textContent?.trim() ?? ''),
      activeNav: panel.querySelector('.settings-nav-item.active')?.textContent?.trim() ?? '',
      title: panel.querySelector('.settings-section h3')?.textContent ?? '',
      providers: rows.map(row => row.querySelector('.settings-row-name')?.textContent ?? ''),
      dots: rows.map(row => {
        const dot = row.querySelector('.settings-state');
        return dot ? dot.className.replace('settings-state ', '') : '';
      }),
      tags: rows.map(row => [...row.querySelectorAll('.settings-tag')].map(tag => tag.textContent ?? '')),
      urls: rows.map(row => row.querySelector('.settings-row-url')?.textContent ?? ''),
      rowClasses: rows.map(row => row.className),
      editButtons: rows.map(row => row.querySelector('.settings-edit')?.textContent ?? ''),
      // The switch is read as an object, not a boolean, because three separate
      // things have to hold: it is a real switch for assistive tech, it says
      // which state it is in, and it is the row's first control rather than a
      // checkbox hidden inside 编辑.
      switches: rows.map(row => {
        const el = row.querySelector('.settings-switch');
        if (!el) return null;
        return {
          role: el.getAttribute('role'),
          checked: el.getAttribute('aria-checked'),
          label: el.getAttribute('aria-label'),
          title: el.getAttribute('title') ?? '',
          disabled: el.disabled,
          first: row.querySelector('.settings-row-head')?.firstElementChild === el
        };
      }),
      formUrl: panel.querySelector('.settings-form .settings-input input')?.value ?? null,
      error: panel.querySelector('.settings-error')?.textContent ?? '',
      addButton: panel.querySelector('.settings-add')?.textContent?.trim() ?? ''
    };
  })()`);

/**
 * Click something if it is there. Returns whether it was.
 *
 * These checks drive a real window on a real desktop, so a selector can go away
 * between reading it and clicking it — most often because somebody dismissed the
 * panel. A missing element is a retry, not a stack trace.
 */
const clickIfPresent = selector =>
  cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el) el.click();
    return !!el;
  })()`);

const clickInRow = (row, selector) =>
  cdp.evaluate(`(() => {
    const el = document.querySelectorAll('.settings-row')[${row}]?.querySelector(${JSON.stringify(selector)});
    if (el) el.click();
    return !!el;
  })()`);

/**
 * Reopen 设置 if it is closed.
 *
 * Not defensive coding for its own sake: this runs against a live app on a
 * person's desktop, and a click on the dimmed backdrop dismisses the panel. The
 * assertions below are about what the panel says, not about whether somebody
 * happened to click elsewhere in the meantime.
 */
const ensurePanel = async () => {
  if ((await readPanel()).open) return;
  await clickIfPresent('.side-foot-btn[aria-label="设置"]');
  await waitFor(async () => (await readPanel()).open, true, { timeoutMs: 3000 });
};

/**
 * Open one row's form, and only one.
 *
 * 编辑 is a toggle: on a row that is already open it means 取消. Making "open"
 * idempotent here keeps every step below from depending on whether the previous
 * one left a form behind.
 */
const openForm = async row => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensurePanel();
    if ((await readPanel()).formUrl !== null) {
      await clickIfPresent('.settings-form-foot .btn.secondary');
      await sleep(150);
    }
    await clickInRow(row, '.settings-edit');
    const opened = await waitFor(async () => (await readPanel()).formUrl !== null, true, { timeoutMs: 1500 });
    if (opened) return;
  }
  throw new Error(`打不开第 ${String(row + 1)} 行的编辑表单`);
};

/** Type into the address box the way a person would: through the input event. */
const typeUrl = async value => {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.settings-form .settings-input input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
};

/**
 * Flip one row's switch, the way a person would: one click, no form.
 *
 * There used to be a `toggleEnable` here that ticked a checkbox inside the edit
 * form and then pressed 保存. The point of the switch moving out into the row is
 * that those three steps become one, so this helper must not reach for the form
 * — and the assertions below check that no form opened.
 */
const flip = async row => {
  await ensurePanel();
  const clicked = await clickInRow(row, '.settings-switch');
  await sleep(300);
  return clicked;
};

const saveForm = async () => {
  await cdp.evaluate(`[...document.querySelectorAll('.settings-form-foot .btn')].pop().click()`);
};

const cancelForm = async () => {
  await clickIfPresent('.settings-form-foot .btn.secondary');
  await sleep(200);
};

const railCount = () => cdp.evaluate(`document.querySelectorAll('.source-rail .rail-btn').length`);
const kimiUrl = async () =>
  (await cdp.evaluate('window.agentAPI.getSources()')).sources.find(source => source.id === 'kimi').url;

// ------------------------------------------------------------ the account row

const foot = await readFoot();
check('侧栏底部有账号行', foot.present, true);
check('账号行默认写「本机用户」', foot.name, '本机用户');
// The row used to print the operating system's login name, and its tooltip
// printed the machine name. Both are things this app was never given, and both
// ended up in screenshots. Compared against the running user rather than a
// literal: a literal here would be the leak it is guarding against.
checkTrue(
  '账号行不是系统用户名',
  foot.name !== os.userInfo().username && !foot.name.includes(os.userInfo().username)
);
checkTrue(`账号行的提示是平台，不是机器名（${foot.title}）`, foot.title === '这台 Mac');
checkTrue(`头像里是名字的第一个字（${foot.initial}）`, foot.initial.trim() === '本');
check('账号行有两个按钮：页面诊断、设置', (foot.buttons ?? []).join('/'), '页面诊断/设置');
check('两个按钮都是图标', foot.icons, 2);

// --------------------------------------------------------------- open 设置

// A previous run may have left the panel open — and the panel remembers which
// page it was on, so reopening it would land on 通用设置 and the assertions below
// would be measuring the wrong page. Close first, then open it through the
// button, the way a person would.
if ((await readPanel()).open) {
  await cdp.evaluate(`document.querySelector('.settings-close').click()`);
  await waitFor(async () => (await readPanel()).open, false, { timeoutMs: 3000 });
}

await cdp.evaluate(`document.querySelector('.side-foot-btn[aria-label="设置"]').click()`);
const opened = await waitFor(async () => (await readPanel()).open, true, { timeoutMs: 3000 });
check('点设置打开面板', opened, true);

const panel = await readPanel();
check('左侧有四个分类', panel.nav.join('/'), '通用设置/模型/内置插件/Agent 预设');
// The model list is the reason the panel exists, so it is where it opens.
check('默认停在「模型」', panel.activeNav, '模型');
check('模型页列出四个提供商', panel.providers.join('/'), 'DeepSeek/ChatGPT/Kimi/WorkBuddy');
check('每一行都有状态点', panel.dots.length, 4);
checkTrue(`未启用的行状态是关（${panel.dots.join(',')}）`, panel.dots[2] === 'off' && panel.dots[3] === 'off');
checkTrue(`规划通道被标了出来（${panel.tags[0].join('、')}）`, panel.tags[0].includes('规划通道'));
// WorkBuddy ships without an address on purpose; the row has to say so rather
// than show an empty string that looks like a rendering bug.
checkTrue(`没填网址的行明说了（${panel.tags[3].join('、')}）`, panel.tags[3].includes('还没填网址'));
// 编辑 stays on every row, including the ones that are off. "Only editable while
// on" reads tidier than it behaves: switching a source on creates its view and
// loads the page, so fixing the address of a source you just turned off would
// first load the address you are trying to replace.
check('每一行都有编辑按钮', panel.editButtons.join('/'), '编辑/编辑/编辑/编辑');
check('列表底部是添加按钮', panel.addButton, '＋ 添加模型提供商');

// ------------------------------------------------------------------ the switch
//
// The switch is the row's first control, it is a real switch rather than a
// checkbox, and it says out loud which state it is in. It used to live inside
// the edit form as 「启用这个提供商」, which made the cheapest action on the page
// cost four clicks.
check('每一行最左边都是开关', panel.switches.map(item => item?.first).join(','), 'true,true,true,true');
check('开关的角色是 switch', panel.switches.map(item => item?.role).join(','), 'switch,switch,switch,switch');
check('开关说得出自己是开还是关', panel.switches.map(item => item?.checked).join(','), 'true,true,false,false');
check('开关的名字带着提供商', panel.switches[2].label, '启用 Kimi');
check('开着的行提前说清点下去会关掉', panel.switches[0].title, '关掉 DeepSeek');
checkTrue(`关着的行说的是启用（${panel.switches[3].title}）`, panel.switches[3].title === '启用 WorkBuddy');
// Two indicators for one fact is the thing this change was meant to remove: the
// switch already says "off", so the row must not also print a 「未启用」 tag.
check('关着的行不再重复写「未启用」', panel.tags[2].join('、'), '');
checkTrue(
  '关着的行只变淡，不消失',
  panel.rowClasses[2].includes('off') && !panel.rowClasses[0].includes('off')
);

// ------------------------------------------------------------ edit a URL

await openForm(2);
check('点编辑后网址栏里是当前的地址', (await readPanel()).formUrl, KIMI_DEFAULT);

// A rule the panel must not swallow: https only. Typing http:// is the most
// likely mistake, so it is the one asserted.
await typeUrl('http://kimi.com/');
await saveForm();
const refused = await waitFor(async () => (await readPanel()).error, '只支持 https:// 开头的网址', { timeoutMs: 4000 });
check('http 地址被拒绝，理由写在表单里', refused, '只支持 https:// 开头的网址');
check('被拒绝的地址没有落盘', await kimiUrl(), KIMI_DEFAULT);

// ----------------------------------------------------------- save a URL

await typeUrl(KIMI_TRIAL);
await saveForm();
const saved = await waitFor(kimiUrl, KIMI_TRIAL, { timeoutMs: 4000 });
check('保存之后主进程里是新地址', saved, KIMI_TRIAL);
const afterSave = await waitFor(async () => (await readPanel()).urls[2], KIMI_TRIAL, { timeoutMs: 3000 });
check('面板上也显示新地址', afterSave, KIMI_TRIAL);

// ------------------------------------------------------- on / off switching

check('现在来源栏有两个按钮', await railCount(), 2);
const channelsBefore = await cdp.evaluate('window.agentAPI.getChannelStatuses()');
check('现在有两个通道', channelsBefore.length, 2);

// One click. The assertion that matters is the second one: flipping a source
// must not open a form, because a form is where the switch used to hide.
check('点开关之前没有任何表单开着', (await readPanel()).formUrl, null);
await flip(2);
const railAfter = await waitFor(railCount, 3, { timeoutMs: 4000 });
check('点一下开关，来源栏就多了一个按钮', railAfter, 3);
check('开关没有把表单打开', (await readPanel()).formUrl, null);
check('开关自己翻到了开', (await readPanel()).switches[2].checked, 'true');
const channelsAfter = await cdp.evaluate('window.agentAPI.getChannelStatuses()');
check('启用之后通道也变成三个', channelsAfter.length, 3);

// 通道和来源必须是同一份清单. A source that is on is a channel, a source that is
// off is not — anything else means the readiness pill counts pages the user
// cannot use, or hides one they can.
const channelIdsAfter = channelsAfter
  .map(channel => channel.id)
  .sort()
  .join(',');
check('通道和开着的来源是同一份清单', channelIdsAfter, 'chatgpt,deepseek,kimi');
// "A view was created" is asked of the main process, not of the CDP target list.
// A view exists — with bounds — a frame before its page becomes a debugging
// target, and on a cold start that target is briefly blank, so matching on the
// URL turns "not yet" into "never". The bounds map is the app's own answer.
const kimiBounds = await waitFor(
  async () => (await cdp.evaluate('window.agentAPI.getViewBounds()'))?.kimi ?? null,
  null,
  { timeoutMs: 6000, until: value => value !== null }
);
checkTrue(
  `启用之后给 Kimi 建了视图（${kimiBounds ? `${kimiBounds.width}×${kimiBounds.height}` : '无'}）`,
  Boolean(kimiBounds) && (kimiBounds?.width ?? 0) > 0 && (kimiBounds?.height ?? 0) > 0
);

// The viewport is a second, independent question: a view can exist with a box
// and still have a page that never got laid out (that was the bug this whole
// section was written for). Chromium will not lay out a view inside a window
// that is not in front, so when the app is behind another window this reads 0
// for reasons that have nothing to do with the app — say so rather than turning
// "nobody is looking at it" into a failure.
const kimiTarget = await waitFor(
  async () => (await listTargets()).find(target => target.type === 'page' && /kimi/.test(target.url)) ?? null,
  null,
  { timeoutMs: 8000, until: value => value !== null }
);
const kimiView = kimiTarget ? await connect(kimiTarget) : null;
const kimiHasViewport = kimiView
  ? await waitFor(
      async () => {
        const size = JSON.parse(await kimiView.evaluate('JSON.stringify({ w: innerWidth, h: innerHeight })'));
        return size.w > 0 && size.h > 0;
      },
      true,
      { timeoutMs: 4000 }
    )
  : false;
const kimiSize = kimiView ? await kimiView.evaluate('innerWidth + "×" + innerHeight') : '0×0';
const appInFront = await cdp.evaluate('document.hasFocus()');
if (appInFront) {
  checkTrue(`刚打开的来源有真实视口（${kimiSize}）`, kimiHasViewport);
} else {
  console.log('note  the app window is not in front, so the new view is not laid out — its bounds are asserted instead');
}

// ------------------------------------------------- the planner can be switched off
//
// Every source has a working switch, the planner's included. The invariant is
// "at least one stays on", not "this one is special": the agent needs somewhere
// to ask, and a checkbox that cannot be unchecked is a product rule leaking out
// as a dead control.

const beforePlanning = await cdp.evaluate('window.agentAPI.getSources()');
check('规划通道是 DeepSeek', beforePlanning.planningId, 'deepseek');

await ensurePanel();
check('规划通道的开关也能点', (await readPanel()).switches[0].disabled, false);
await flip(0);
const movedPlanning = await waitFor(
  async () => (await cdp.evaluate('window.agentAPI.getSources()')).planningId,
  'chatgpt',
  { timeoutMs: 4000 }
);
check('关掉规划通道之后规划换到下一个来源', movedPlanning, 'chatgpt');
const movedTags = await waitFor(async () => ((await readPanel()).tags?.[1] ?? []).join('、'), '规划通道', {
  timeoutMs: 3000
});
check('「规划通道」标签跟着走', movedTags, '规划通道');

// Put it back before the rail counts below: a disabled DeepSeek is one less
// button and one less channel, and those numbers are asserted elsewhere.
await flip(0);
const backPlanning = await waitFor(
  async () => (await cdp.evaluate('window.agentAPI.getSources()')).planningId,
  'deepseek',
  { timeoutMs: 4000 }
);
check('再打开就换回来', backPlanning, 'deepseek');

// ---------------------------------------------------------------- restore

await flip(2);
const restoredRail = await waitFor(railCount, 2, { timeoutMs: 4000 });
check('关掉 Kimi 之后来源栏回到两个', restoredRail, 2);
const channelIdsRestored = (await cdp.evaluate('window.agentAPI.getChannelStatuses()'))
  .map(channel => channel.id)
  .sort()
  .join(',');
check('关掉之后通道里也没有它了', channelIdsRestored, 'chatgpt,deepseek');

// A source that is off can still have its address changed — and that has to be
// true, because switching one on loads its page.
await openForm(2);
check('关着的行照样能改地址', (await readPanel()).formUrl, KIMI_TRIAL);
await typeUrl(KIMI_DEFAULT);
await saveForm();
const restoredUrl = await waitFor(kimiUrl, KIMI_DEFAULT, { timeoutMs: 4000 });
check('跑完之后 Kimi 的地址回到出厂值', restoredUrl, KIMI_DEFAULT);

// ------------------------------------------- the last source cannot be turned off
//
// The other end of the same rule, asserted at the end because it needs the state
// the restore section leaves behind: DeepSeek and ChatGPT on, nothing else. With
// one source left, switching it off is refused — and the reason has to land in
// the panel, next to the switch that was just clicked, not in the app's error
// strip at the bottom of the window.
await flip(1);
const oneLeft = await waitFor(railCount, 1, { timeoutMs: 4000 });
check('关掉 ChatGPT 之后只剩一个来源', oneLeft, 1);

// Said before the click, too: the switch's tooltip is the warning, so nobody
// has to be refused to find out.
check('最后一个来源的开关提前提醒', (await readPanel()).switches[0].title, '这是最后一个开着的来源，关掉就没地方问了');
await flip(0);
const lastRefused = await waitFor(async () => (await readPanel()).error, LAST_REFUSED, { timeoutMs: 4000 });
check('关掉最后一个来源被拒绝，理由写在开关旁边', lastRefused, LAST_REFUSED);
const stillOn = (await cdp.evaluate('window.agentAPI.getSources()')).sources.find(source => source.id === 'deepseek').enabled;
check('被拒绝之后它还是开着的', stillOn, true);

// Put ChatGPT back so the closing assertions count what a fresh install has.
await flip(1);
const backRail = await waitFor(railCount, 2, { timeoutMs: 4000 });
check('把 ChatGPT 打开之后来源栏回到两个', backRail, 2);

// The other half of "开之前得有地址": a source with no address cannot be switched
// on at all. WorkBuddy ships that way on purpose — there is no address to default
// to — and switching it on would only add a channel that fails forever. The click
// opens the address field instead of refusing: the dead end becomes the next step.
await ensurePanel();
await flip(3);
const noUrlOpened = await waitFor(async () => (await readPanel()).formUrl, '', { timeoutMs: 3000 });
check('没地址的行点开关，打开的是地址框', noUrlOpened, '');
check('并且说清要先填网址', (await readPanel()).error, '先填网址，再打开这个提供商');
check('它还是关着的', (await readPanel()).switches[3].checked, 'false');
check('被拒绝之后它还是关着的', (await railCount()) === 2, true);
await cancelForm();

// ------------------------------------------------------------------ the name
//
// The name is the one thing on 通用设置 that is about the person rather than
// about a page. It has to be editable, it has to show up in the sidebar the
// moment it is saved, and an empty one has to be refused with a sentence next to
// the field — an empty row at the bottom of the sidebar reads as "not signed in",
// and there is nothing to sign into.

await ensurePanel();
await cdp.evaluate(`[...document.querySelectorAll('.settings-nav-item')].find(button => button.textContent.includes('通用设置')).click()`);
await waitFor(async () => (await readPanel()).activeNav, '通用设置', { timeoutMs: 3000 });
checkTrue('通用设置里有名字输入框', (await cdp.evaluate(`!!document.querySelector('.settings-account .settings-name-input')`)) === true);
check(
  '输入框预填当前名字',
  await cdp.evaluate(`document.querySelector('.settings-account .settings-name-input').value`),
  '本机用户'
);

const typeName = async value => {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('.settings-account .settings-name-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
};

await typeName('小柯');
await cdp.evaluate(`document.querySelector('.settings-account .btn.secondary').click()`);
const renamed = await waitFor(async () => (await readFoot()).name, '小柯', { timeoutMs: 3000 });
check('改完名字，侧栏立刻跟着变', renamed, '小柯');
const renamedInitial = (await readFoot()).initial.trim();
check('头像也跟着换成第一个字', renamedInitial, '小');

await typeName('   ');
await cdp.evaluate(`document.querySelector('.settings-account .btn.secondary').click()`);
const emptyRefused = await waitFor(
  async () => cdp.evaluate(`document.querySelector('.settings-account ~ .settings-error')?.textContent ?? document.querySelector('.settings-field .settings-error')?.textContent ?? ''`),
  '名字不能是空的',
  { timeoutMs: 3000 }
);
check('空名字被拒绝，理由写在输入框下面', emptyRefused, '名字不能是空的');
check('被拒绝之后名字没变', (await readFoot()).name, '小柯');

await cdp.evaluate(`document.querySelector('.settings-account .btn.ghost').click()`);
const backToDefault = await waitFor(async () => (await readFoot()).name, '本机用户', { timeoutMs: 3000 });
check('恢复默认回到「本机用户」', backToDefault, '本机用户');

// ------------------------------------------------------------------ close

await cdp.evaluate(`document.querySelector('.settings-close').click()`);
const closed = await waitFor(async () => (await readPanel()).open, false, { timeoutMs: 3000 });
check('关掉之后面板消失', closed, false);

// Exit explicitly: the CDP socket keeps a timer alive, and a script that prints
// its verdict but never returns is a script whose exit code lies about it.
const tally = summary();
cdp.close();
process.exit(tally.fail > 0 ? 1 : 0);
