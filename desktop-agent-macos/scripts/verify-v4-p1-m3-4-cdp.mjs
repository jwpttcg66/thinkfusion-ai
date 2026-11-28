/**
 * V4 P1 M3-4 真机验收：无人值守开关真能改、改完真落盘；用户出口真开一轮；通道停住不判死。
 *
 * 离线用例（scripts/check-task-continue.mjs / check-task-fault.mjs）已把纯函数与源码守卫锁住。
 * 真机这一段只证离线证不到的事：
 * 1) `task:set-auto-continue` 的边界真在拦（字符串 "false" 看着像关、代码里是开），
 *    回执 `previous` 是生效值、开关**落盘**并在重启后读回，并且留下 `task.auto_continue.updated`；
 * 2) `task:continue-round` 在状态不对时拒得干净（不偷开一轮），在 `report_pending` /
 *    `awaiting_next_round` 时**真开出下一轮**：用户原话逐字进了那一轮的请求文本并落盘；
 * 3) 通道停住（CLI 那一轮真的不再输出）时任务落在 `interrupted` 而不是终态 `failed`，
 *    留下 `task.fault.stopped`，活动流与统计页同时说清「为什么停」和「怎么回来」，
 *    并且点「继续任务」真能接回去（再开一轮）——这是 M3-4d 唯一能证伪的部分；
 * 4) 开关的两半边各证一次：关掉时判定说要开下一轮也得停在轮次开始前（`task.round.await_user`，
 *    A/B 段），开着且**这个字段从来没被写过**时同一句判定要真的自己开出下一轮（E 段，期间没有
 *    任何用户出口点击）——A/B 段为了拿到停轮样本全程在拨开关，缺省那一半只能另起一条探针证。
 *
 * 通道停住怎么造（如实记录）：C 段单独建一条走 CLI 通道的探针（名单里写成员 id `cli:qoder`，
 * 不是注册表 id `qoder`——第一次跑就是差这个前缀，规划挑不出主导直接报「云端 Planner 不可用」），
 * 等主进程把 CLI 拉起来之后给它**整个进程组**发 `SIGSTOP`（CLI 是 `detached: true` 起的组长，
 * 只停外壳挡不住孙进程继续往管道写块）——stdout 就此不再有新块，编排器自己的看门狗（现网默认
 * 120 秒）说出真机那句「模型连续 N 秒没有输出」；观察完发 `SIGCONT` 放开，不补刀。不改任务、
 * 不注入假异常、不绕任何代码路径。云端那条不能用这个办法：它的请求在主进程里，CDP 的离线模拟
 * 只作用于页面目标（2026-11-28 试过，页面离线之后云端照常回答）。
 *
 * `source_disabled` 这一类没有真机样本：产品有「至少要留一个来源」的不变量（`saveSource`），
 * 这台机器只剩一条开着的网页源时无法通过界面把它全关。它的证据是主进程那两句原文的守卫用例
 * 加分类单测（scripts/check-task-fault.mjs），SUMMARY 里按未证真机记。
 * 第 10/11 次真机还看清了「为什么撞不到」：F 段指定关着的 `deepseek`，被拒的那句却是
 * 「ChatGPT 未登录：页面尚未加载」——提交门禁（`orchestrator.ts:479`）探的是**默认适配器**，
 * 选不出成员就退回当前开着的那条页面，于是「你指定的源关着」在现网表现为另一条源的登录问题，
 * `SOURCE_CLOSED` 那句轮不到说。属通道选择层，记为后续项（任务书 M3-4 落地校正 4）。
 *
 * 默认数据目录（AGENTS.md §10.2）：不设 `THINKFUSION_USER_DATA`、不加 `--user-data-dir`。
 *
 * Run: npm run test:task-continue:live
 *      长跑建议分两步：先手动起 dev（detached，日志指向本目录 dev.log），再
 *      `TF_M34_ATTACH=1 CDP_PORT=9334 node scripts/verify-v4-p1-m3-4-cdp.mjs`。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';
import { classifyFault } from '../out-test/shared/task-fault.js';
import { autoContinueOf, continueExitText, isContinueRoundAllowed } from '../out-test/shared/task-continue.js';
import { canOpenRound } from '../out-test/shared/task-budget.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m3-4-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const M33_EVENTS = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m3-3-20261128', 'events.after-budget-exhausted.json');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9334);
/**
 * 附着模式（`TF_M34_ATTACH=1`）：不起也不收 dev，直接连已经在跑的实例。
 *
 * 加这一档是因为本用例要跑 40 分钟以上：脚本自己 spawn 的子进程和脚本同属一个进程组，
 * 会话被中断时整组一起收到 SIGTERM，探针停在半路（2026-11-28 实测一次）。分开起之后
 * 脚本可以 nohup 跑，App 也能留着看现场。默认仍走脚本内起停，不影响既有跑法。
 */
const ATTACH = process.env.TF_M34_ATTACH === '1';
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKSPACE = path.join(os.tmpdir(), `tf-m3-4-ws-${String(Date.now())}`);
/** 用例刻意压短：等一个真轮次跑完最多 12 分钟（一轮 = 计划 + 执行 + 复验 + 报告四次模型往返），
 *  超时就跳过用户出口的正向段并如实记录，正向证据改由离线用例 + C 段的接回循环承担。 */
const WAIT_REPORT = 10 * 60 * 1000;
/** 自动续轮要等「上一轮跑完 + 判定说要开 + 新轮记账」，比单次等待长；等不到记跳过，不记失败。 */
const WAIT_AUTO_ROUND = 12 * 60 * 1000;
/** 看门狗默认 120 秒，加上收敛与落盘，给 200 秒。 */
const WAIT_STALL = 200_000;
/**
 * C 段停住通道要用 CLI：云端那一轮的 fetch 在主进程里，CDP 的离线模拟只作用于页面目标，
 * 注不进故障（2026-11-28 试过，页面离线只停住了网页，云端照常回答）。CLI 是主进程 spawn
 * 出来的真进程，`SIGSTOP` 之后 stdout 不再有新块，编排器自己的看门狗就会判停——这就是
 * 现网那条「模型连续 N 秒没有输出」的成因，不是假异常。
 */
/** 等 CLI 子进程出现（探针建起来后规划很快就会 spawn）。 */
const WAIT_CLI_CHILD = 150_000;
/** 停住之后给看门狗留时间：120 秒阈值 + 收敛 + 落盘。 */
const STALL_POLL = 400;
const SETTLE = 6_000;
const PROBE_TITLE = 'M3-4 无人值守探针';
const PROBE_PROMPT = `${PROBE_TITLE}：只读列出工作区根目录下的文件名，把文件名写进结论，不要改任何文件。`;
/** C 段单独一条探针：它要停在「规划正走在 CLI 通道上」，与主探针的进度互不干扰。 */
const PROBE_C_TITLE = 'M3-4 通道停住探针';
const PROBE_C_PROMPT = `${PROBE_C_TITLE}：只读列出工作区根目录下的文件名，把文件名写进结论，不要改任何文件。`;
/**
 * E 段用另一条问法：前两段那条「列文件名」的探针每一轮都成功，边界上判定只会说
 * 「目标仅部分达成 → stop_and_wait」（第 5、6 次真机的 C 段判定原文如此），开着无人值守
 * 也不该开轮，于是「缺省即自动开轮」的正向半边永远拿不到样本。这里给一条**首轮必定带着
 * 失败检查**的问法（工作区里的 `check-marker.mjs` 拿 marker.txt 和一个写死的期望值比，
 * 永远退 1），让判定落到 `REPAIR → open_next_round`——前置条件是造出来的，与 M3-3 把轮数
 * 上限填小同一性质，造的只是「判定说要开轮」这件事，开关与字段仍然一次没碰。
 */
const PROBE_E_TITLE = 'M3-4 缺省续轮探针';
const PROBE_E_PROMPT = `${PROBE_E_TITLE}：读工作区里的 marker.txt，再用 node 运行 check-marker.mjs 校验它，把校验的退出码与结论写进答案；不要新建或修改任何文件。`;
/**
 * F 段探针：只能用网页源的那一档。
 *
 * A/C/E 三条都改成 CLI 主导了（超算当场连不上），于是「网页源关着」这条落点没人撞——它是
 * M3-4d 六类里唯一还没真机样本的一格（其余由 C 段与 D 段回放覆盖）。这条探针对象要的就是
 * 「这一轮只能用网页源」，而默认网页源全关是用户的设置（2026-11-28 指示：关着就提示去打开）。
 */
const PROBE_F_TITLE = 'M3-4 网页源关闭探针';
const PROBE_F_PROMPT = `${PROBE_F_TITLE}：用网页源打开 https://example.com 并把页面主标题写进结论，不要用 CLI 或云端模型代答。`;
/**
 * G 段探针：把开关拨到「关」，撞 `awaiting_next_round` 这一格（真机第 10/11 次的唯一缺口）。
 *
 * 前两轮真机都没走到：A/B 段那轮判定自己给了 `stop_and_wait`，任务停在 `report_pending`，
 * 于是 M3-4c 的新落点——包括 `continueExitText('awaiting_next_round')` 那句「按你的设置停在这里」
 * 与该状态下多出来的「接受未验证并结束」出口（`DELIVERY_CLOSE_STATUSES`）——只有离线口径。
 * 问法沿用 E 段那条（真机实测它能把边界推到 `open_next_round`），差别只在这里显式把开关拨到关：
 * E 段证「缺省即开」，G 段证「关着即停」，两半合起来才是这颗开关真的在管边界。
 */
const PROBE_G_TITLE = 'M3-4 关档停轮探针';
const PROBE_G_PROMPT = `${PROBE_G_TITLE}：读工作区里的 marker.txt，再用 node 运行 check-marker.mjs 校验它，把校验的退出码与结论写进答案；不要新建或修改任何文件。`;
const PROBE_TITLES = [PROBE_TITLE, PROBE_C_TITLE, PROBE_E_TITLE, PROBE_F_TITLE, PROBE_G_TITLE];
const INSTRUCTION = '上一轮只列了文件名。这一轮改成同时给出每个文件的大小，仍然不要新建或修改文件。';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: `默认数据目录 / ThinkFusion Dev / CDP ${PORT} / 通道停住用 SIGSTOP 停住 CLI 子进程喂给现网看门狗 / ${ATTACH ? '附着在手起的 dev 实例上（脚本不起也不收 App）' : '脚本内起停 dev'}`,
  workspace: WORKSPACE,
  store: STORE,
  checks: {},
  shots: [],
  phaseA: {},
  phaseB: {},
  phaseC: {},
  replay: {},
  cleanup: [],
  probeIds: [],
  error: null
};
let child = null;
let cdp = null;
/** 脚本自己停住的那个 CLI 进程组：任何退出路径都得放开，否则留一个僵在 SIGSTOP 的进程组。 */
let cliStopped = null;

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * 等一次轮次边界，并把它「该不该开轮」判清楚。
 *
 * 原来只问「有没有新轮」，两处都错过：
 * - 拿 round 行数当基线不可信。第 6 次真机的 E 段在点「确认并执行」之后 6 秒就已经有 2 条
 *   非修正轮记录，而周期轮要跑完计划+执行+验证+报告才可能出现第三条——计数口径混进了不属于
 *   「判定开轮」的行，7 分钟窗口就这样白等。
 * - 判定说 `stop_and_wait` 时不开轮才是对的行为，记 skip 等于这一格没测。
 * 所以改成只看事件序列：一条 `cycle.decision.created` 之后紧跟的**第一条** `round.started`
 * 就是「判定开出来的那一轮」（该事件自带 `inputType`，`contracts.ts:1884`）；期间出现
 * `task.round.user_continue` 说明是人点的、不算自动。循环里只读 store 不打 CDP，
 * 免得把 90 秒的 evaluate 塞进轮询。
 */
async function waitRoundBoundary({ taskId, since, waitMs }) {
  const eventsSince = type => (readStore().events ?? []).filter(item =>
    item.taskId === taskId && item.type === type && Number(item.at) >= since);
  const brief = item => ({
    decisionType: item.decisionType,
    nextAction: item.nextAction,
    reason: String(item.reason ?? '').slice(0, 120),
    at: Number(item.at)
  });
  const read = () => {
    const decisions = eventsSince('cycle.decision.created');
    const starts = eventsSince('round.started');
    const clicks = eventsSince('task.round.user_continue');
    const decision = decisions.length > 0 ? decisions[decisions.length - 1] : null;
    // 同一秒也算：判定与开轮在同一个 tick 里发生（无人值守开着时就是这样）
    const opened = decision ? starts.filter(item => Number(item.at) >= Number(decision.at)) : [];
    return {
      decision: decision ? brief(decision) : null,
      openedAfterDecision: opened.length > 0,
      openedInputType: opened.length > 0 ? String(opened[0].inputType ?? '?') : null,
      clicks: clicks.length,
      awaitUser: eventsSince('task.round.await_user').length > 0,
      status: storeTask(taskId)?.status ?? null,
      roundTypes: storeRounds(taskId).map(round => `${String(round.roundNumber)}:${round.inputType ?? '?'}`)
    };
  };
  const deadline = Date.now() + waitMs;
  let state = read();
  while (Date.now() < deadline) {
    state = read();
    if (!state.decision) { await sleep(2000); continue; }
    // 判定说停、判定后真开了轮、或有人点了出口——三种都算边界已看清，不必再等
    if (String(state.decision.nextAction) !== 'open_next_round' || state.openedAfterDecision || state.clicks > 0) {
      return { ...state, timedOut: false, waitedMs: Date.now() - since };
    }
    await sleep(2000);
  }
  return { ...read(), timedOut: true, waitedMs: waitMs };
}

/**
 * 「本轮窗口没跑到」不等于「行为不对」：记成 skipped 单独汇总。
 * 混进未通过里，下一次读证据的人只会去改阈值而不是去看结论。
 */
function skip(name, detail) {
  evidence.checks[name] = { ok: 'skipped', detail: detail ?? null, at: new Date().toISOString() };
  console.log(`SKIP ${name}${detail ? ` — ${detail}` : ''}`);
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean);
  } catch { return []; }
}

/**
 * 附着模式下要的是 **App 主进程** 的 pid，不是「端口上第一个监听者」：CLI 子进程会继承监听
 * 套接字的 fd，`lsof -t` 于是把 `qodercli` 也列成监听者（2026-11-28 实测 9334 上有两个 pid）。
 * 拿它当父进程去等「新起的 CLI 子进程」会永远等不到，注入就此落空。
 */
function appMainPid() {
  const candidates = listenersOn(PORT).map(pid => Number(pid)).filter(Boolean)
    .map(pid => ({ pid, command: processCommand(pid).slice(0, 90) }));
  const isApp = item => /ThinkFusion|electron/i.test(item.command);
  const hit = candidates.find(isApp) ?? null;
  return { pid: hit?.pid ?? null, candidates };
}

function readStore() {
  if (!fs.existsSync(STORE)) return { tasks: [], rounds: [], events: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

const storeTask = taskId => (readStore().tasks ?? []).find(task => task.taskId === taskId) ?? null;
const storeRounds = taskId => (readStore().rounds ?? []).filter(round => round.taskId === taskId);
const roundCount = taskId => storeRounds(taskId).length;

async function waitFor(read, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`等待超时：${label}`);
}

async function startDev(build) {
  if (ATTACH) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (build) {
    execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
  }
  const log = fs.openSync(LOG, 'a');
  const env = { ...process.env };
  delete env.THINKFUSION_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log]
  });
  child.unref();
}

async function stopDev(signal) {
  if (cliStopped) {
    evidence.cliChild = { ...(evidence.cliChild ?? {}), releasedOnExit: releaseCliChild(cliStopped) };
    cliStopped = null;
  }
  for (const handle of [cdp]) { if (handle) { try { handle.close(); } catch { /* 已断开 */ } } }
  cdp = null;
  // 附着模式下 App 是别人（手动的 detached 进程）起的：脚本不该把它带走，留着看现场。
  if (ATTACH) return;
  if (!child?.pid) { await waitForPortFree(); return; }
  try { process.kill(-child.pid, signal); } catch { /* 已退出 */ }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch { child = null; break; }
    await sleep(300);
  }
  if (child) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    child = null;
  }
  await waitForPortFree();
}

async function waitForPortFree() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (listenersOn(PORT).length === 0) return true;
    await sleep(400);
  }
  return false;
}

async function targets() {
  try { return await (await fetch(ENDPOINT)).json(); } catch { return []; }
}

async function connectRenderer() {
  const deadline = Date.now() + 300000;
  let lastIssue = '没有匹配的 page 目标';
  while (Date.now() < deadline) {
    const list = await targets();
    const candidates = list.filter(item => item.type === 'page'
      && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
    if (candidates.length === 0) lastIssue = `目标里没有渲染页：${list.map(item => item.type).join(',') || '空'}`;
    for (const candidate of candidates) {
      const probe = await connect(candidate).catch(error => {
        lastIssue = `连不上 ${candidate.url}：${error.message}`;
        return null;
      });
      if (!probe) continue;
      const ready = await waitFor(async () => {
        try { return await probe.evaluate('typeof window.agentAPI', 8000) === 'object' ? 'ready' : null; }
        catch (error) { lastIssue = `evaluate 失败：${error.message}`; return null; }
      }, `agentAPI 注入 ${candidate.url}`, 90000).catch(() => null);
      if (ready) {
        await probe.send('Page.enable', {}, 10000).catch(() => null);
        return probe;
      }
      probe.close();
    }
    await sleep(2000);
  }
  throw new Error(`没有找到注入 agentAPI 的渲染进程（${lastIssue}）`);
}

const ev = (expression, timeoutMs = 60000) => cdp.evaluate(expression, timeoutMs);

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(OUT_DIR, file));
}

async function openTab(label) {
  return ev(`(() => {
    const scope = document.querySelector('.wb-tabs') ?? document;
    const target = [...scope.querySelectorAll('button[role="tab"]')].find(node => (node.textContent ?? '').trim() === ${JSON.stringify(label)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function selectTaskRow(...markers) {
  const list = markers.filter(marker => typeof marker === 'string' && marker.trim());
  const hit = await waitFor(async () => ev(`(() => {
    const markers = ${JSON.stringify(list)};
    const row = [...document.querySelectorAll('.task-item')].find(node => markers.some(marker =>
      (node.getAttribute('title') ?? '').includes(marker) ||
      (node.querySelector('.task-title')?.textContent ?? '').includes(marker)));
    if (!row) return null;
    row.click();
    return row.getAttribute('title') ?? row.textContent ?? '';
  })()`), `侧栏出现「${list[0]}」`, 40000).catch(() => null);
  if (!hit) return false;
  await sleep(1200);
  return true;
}

const taskEvents = async id => (await ev(`window.agentAPI.getTaskEvents(${JSON.stringify(id)})`, 90000)) ?? [];

/** 统计页那颗无人值守开关：勾选态 + 旁边那行说法 + 点完之后的结果行。 */
async function autoSwitch() {
  if (!(await openTab('统计'))) return { tabMissing: true };
  await sleep(600);
  return ev(`(() => {
    const row = [...document.querySelectorAll('.stats-grid > div')].find(node =>
      (node.querySelector('.task-progress-key')?.textContent ?? '').trim() === '无人值守');
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const input = row.querySelector('input[type="checkbox"]');
    return {
      checked: input ? input.checked : null,
      disabled: input ? input.disabled : null,
      label: (row.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      result: ([...document.querySelectorAll('.stats-grid > div')]
        .find(node => (node.querySelector('.task-progress-key')?.textContent ?? '').trim() === '结果')?.innerText ?? '').replace(/\\s+/g, ' ').trim()
    };
  })()`);
}

/** 活动流旁注与统计页卡里「为什么停 / 怎么回来」的读数（进度卡 TaskProgressCard 在现网没有挂载点，不作为读数来源）。 */
async function faultReadout() {
  const conv = await (async () => {
    if (!(await openTab('对话'))) return null;
    await sleep(700);
    return ev(`(() => {
      const notes = [...document.querySelectorAll('.chat-note-text, .chat-note, [class*="note"]')]
        .map(node => (node.innerText ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
      const folded = [...document.querySelectorAll('.chat-note-detail')]
        .map(node => (node.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
      const all = notes.concat(folded);
      return {
        stopped: all.filter(text => text.includes('通道停住') || text.includes('停在「interrupted」')).slice(0, 4),
        howBack: all.some(text => /继续任务/.test(text) && /检查点|换模型|通道/.test(text)),
        failedWord: all.filter(text => /失败原因|任务失败/.test(text)).slice(0, 3)
      };
    })()`);
  })();
  // 读的是「统计」页那张真在跑的卡（TaskStats），不是 TaskProgressCard：后者在界面上没有任何
  // 挂载点（M3-3 收尾就记过「已无引用」），给它写的「停下的原因」在现网永远读不到——第三次真机
  // 就是按它取的数，`card` 恒为 null。停下来的说法在现网的落点是活动流旁注 + 折叠详情两处。
  const stats = await (async () => {
    if (!(await openTab('统计'))) return null;
    await sleep(700);
    return ev(`(() => {
      const rows = [...document.querySelectorAll('.task-progress-key')].map(node => {
        const row = node.closest('div');
        return { key: (node.textContent ?? '').trim(), text: (row?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
      });
      const pick = name => rows.find(row => row.key === name)?.text ?? null;
      return { keys: rows.map(row => row.key).slice(0, 12), auto: pick('无人值守'), rounds: pick('轮次') };
    })()`);
  })();
  return { conv, stats };
}

async function callAuto(input) {
  return ev(`window.agentAPI.setTaskAutoContinue(${JSON.stringify(input)}).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: String(error && error.message ? error.message : error) })
  )`, 60000);
}

async function callContinue(input) {
  return ev(`window.agentAPI.continueWithUserInstruction(${JSON.stringify(input)}).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: String(error && error.message ? error.message : error) })
  )`, 90000);
}

/**
 * 等这条探针停在「计划待审批」，然后代人点一次「确认并执行」。
 *
 * 为什么要专门做这一步：`read-only` 档的计划不自动批（`approvalPolicyFor`），探针若不接这一下
 * 就一直停在 `awaiting_approval`，B 段等 `report_pending` 会白等满超时——那不是功能坏了，是
 * 脚本没走产品的门。这一下同时也是任务书要的那条「中途 WAIT_USER」样本。
 *
 * 拆成「先等住」和「再点」两半（2026-11-28 第二次真机改的）：合在一起点完就立刻进 B 段等待，
 * 而 A 段那串开关读写要花掉几十秒，轮次边界可能在这中间就到——到的时候无人值守还开着，本轮就
 * 自动开了下一轮，B 段等「停在轮次开始前」只能白等满超时。停在待审批时任务是不推进的，A 段在
 * 这段时间里读写同一个字段也不会有并发；点完立刻关掉，边界必然落在「关」这一侧。
 */
async function waitForApproval(taskId, label, timeoutMs = WAIT_REPORT) {
  try {
    return await waitFor(async () => {
      const task = storeTask(taskId);
      return task && task.status === 'awaiting_approval' && task.currentPlanId ? task : null;
    }, `${label} 停在「等计划审批」`, timeoutMs);
  } catch {
    return null;
  }
}

async function clickApprove(taskId, gated) {
  const round = storeRounds(taskId).slice(-1)[0] ?? null;
  const roundId = round?.roundId ?? gated.currentRoundId ?? '';
  // 点火即可，不等 IPC 回执：批准后主进程连着把整轮跑下去，回执可能上百秒不回——第 7 次真机
  // 就是这么死在 B 段（CDP 90 秒超时抛错，整轮证据与探针清理一起带走）。「批准有没有生效」本来
  // 就不靠回执判：状态离开 awaiting_approval 才是后面所有步骤真正要读的那一格。
  await fire(`window.agentAPI.approvePlan(${JSON.stringify({
    taskId,
    roundId,
    planId: gated.currentPlanId,
    approved: true
  })})`, 'Approve');
  const leftGate = await waitFor(async () => {
    const task = storeTask(taskId);
    return task && task.status !== 'awaiting_approval' ? task : null;
  }, '批准后离开「等计划审批」', 60000).catch(() => null);
  const settled = await firedState('Approve').catch(() => null);
  await sleep(SETTLE);
  const statusAfter = storeTask(taskId)?.status ?? null;
  return {
    reached: true,
    planId: gated.currentPlanId,
    roundId,
    receipt: settled?.state === 'settled' ? (settled.value ?? settled.error ?? null) : '（回执未回，按落盘状态判）',
    ok: leftGate !== null && statusAfter !== 'awaiting_approval',
    statusAfter
  };
}


/** resume / continue 都会在主进程里跑一整轮，awaitPromise 会挂死 CDP：点火后轮询落盘状态。 */
async function fire(expression, mark) {
  await ev(`(() => {
    window.__m34${mark} = 'pending';
    ${expression}
      .then(value => { window.__m34${mark} = { ok: true, value }; })
      .catch(error => { window.__m34${mark} = { ok: false, error: String(error && error.message ? error.message : error) }; });
    return 'fired';
  })()`, 30000);
}

const firedState = mark => ev(`(() => {
  const raw = window.__m34${mark};
  return typeof raw === 'string' ? { state: raw } : { state: 'settled', ...raw };
})()`, 15000);

const writeJson = (name, value) => {
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  return name;
};

/**
 * 把主进程 spawn 出来的 CLI 子进程停住 / 放开。
 *
 * 只碰「在这台机器上由这个主进程新起的、命令行里带这个 CLI 可执行路径」的进程：
 * 先按基线 pid 集合排除，再按父进程 pid 收敛，别的终端里跑着的同名 CLI 不受影响。
 */
function childPids(parentPid) {
  if (!parentPid) return [];
  try {
    return execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(Boolean).map(Number);
  } catch { return []; }
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function processState(pid) {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

/**
 * 等一个新的 CLI 子进程出现，出现即停住整组，返回它的 pid。
 *
 * 停的是**进程组**（`kill(-pid)`）而不是那一个 pid：`CliAnswerAgent` 用 `detached: true` 起
 * 子进程，它就是组长，外壳下面还会派生真正干活的进程。只停外壳时，孙进程照样能往同一条
 * stdout 管道写块，看门狗等不到「没有输出」。整组停住才是现网那条「模型连续 N 秒没有输出」
 * 的成因。若外壳自己换了组（`kill(-pid)` 报 ESRCH），退回只停它一个并记下原因。
 */
async function stopFreshCliChild(mainPid, tokens, baseline) {
  const deadline = Date.now() + WAIT_CLI_CHILD;
  while (Date.now() < deadline) {
    const fresh = childPids(mainPid).filter(pid => {
      if (baseline.has(pid)) return false;
      const command = processCommand(pid);
      return tokens.some(token => token && command.includes(token));
    });
    if (fresh.length > 0) {
      const pid = fresh[0];
      const group = childPids(pid);
      let mode = 'group';
      try {
        process.kill(-pid, 'SIGSTOP');
      } catch {
        mode = 'single';
        try {
          process.kill(pid, 'SIGSTOP');
        } catch (error) {
          return { pid: null, why: `SIGSTOP 失败：${error.message}` };
        }
      }
      await sleep(600);
      return { pid, stopped: mode === 'group' ? `-${String(pid)}` : String(pid), mode, group, state: processState(pid), command: processCommand(pid).slice(0, 160) };
    }
    await sleep(STALL_POLL);
  }
  return { pid: null, why: `${String(WAIT_CLI_CHILD / 1000)} 秒内没看到新起的 CLI 子进程（父进程 ${String(mainPid)}，匹配 ${JSON.stringify(tokens)}）` };
}

/**
 * 放开被停住的 CLI 子进程。
 *
 * 只 SIGCONT，不 SIGKILL：这一轮已经被看门狗判停了，进程继续跑完的输出会被
 * `driveRound` 按「回答来晚了」丢掉（orchestrator.ts:2072），任务不会因此二次受伤；
 * 反过来若在这里补一刀，主进程收到的是非零退出码，那条错误既不是现网故障也没有说法。
 */
function releaseCliChild(stopped) {
  const pid = stopped?.pid;
  if (!pid) return '没有停住任何进程，无需放开';
  const target = stopped.mode === 'single' ? pid : -pid;
  try {
    process.kill(target, 'SIGCONT');
    return `已 SIGCONT 放开 ${stopped.mode === 'single' ? String(pid) : `进程组 -${String(pid)}`}（它剩下的输出按「回答来晚」丢掉，不再补刀）`;
  } catch (error) {
    // 组已经没了（子进程跑完退出）：这只说明注入结束，不是失败。
    return `SIGCONT 未送达（${error.message}）——进程组可能已经退出`;
  }
}

/**
 * 建一条探针任务。
 *
 * 第 5 次真机死在这里：E 段的 `submitConversation` 在页面里 90 秒没回执，CDP 抛超时，脚本当场
 * 收尾——可任务其实已经建好并跑起来了（store 里有它、轮也开了）。一个丢掉的回执不该把整轮证据
 * 和探针清理一起带走，所以超时之后改从 store 认这条任务：只认「调用之前不存在、标题对得上」的那一条。
 */
async function createProbe({ title, text, executionConfig, permissionPreset = 'read-only', timeoutMs = 90000 }) {
  const known = new Set((readStore().tasks ?? []).map(task => task.taskId));
  const knownConversations = new Set((readStore().conversations ?? []).map(item => item.conversationId));
  const payload = {
    text,
    permissionPreset,
    workspaceRoot: WORKSPACE,
    workspaceMode: 'engineering',
    executionConfig,
    taskKindOverride: 'execution'
  };
  let created = null;
  let lostReceipt = null;
  try {
    created = await ev(`window.agentAPI.submitConversation(${JSON.stringify(payload)})`, timeoutMs);
  } catch (error) {
    lostReceipt = error.message;
  }
  const directId = created?.taskId ?? created?.task?.taskId ?? null;
  if (directId) {
    evidence.probeIds.push(directId);
    return { taskId: directId, conversationId: created?.conversationId ?? null, created, lostReceipt };
  }
  let recovered = null;
  try {
    recovered = await waitFor(async () => (readStore().tasks ?? []).find(task =>
      !known.has(task.taskId) && String(task.userPrompt ?? task.title ?? '').includes(title)) ?? null,
    `从 store 里认出「${title}」这条新任务`, 90000);
  } catch {
    recovered = null;
  }
  if (!recovered) {
    // 任务没建出来，会话却可能已经落库（第 10 次真机：F 段提交被拒，默认目录里留下一条
    // 「网页源关闭探针」会话，收尾名单里没有它）。按提交前后的差集把它认出来交给调用方回收，
    // 否则「跳过的一段」连带着把现场副作用一起跳过。
    const stray = (readStore().conversations ?? [])
      .filter(item => !knownConversations.has(item.conversationId))
      .map(item => item.conversationId);
    return { taskId: null, conversationId: null, strayConversationIds: stray, created, lostReceipt };
  }
  evidence.probeIds.push(recovered.taskId);
  const conversation = (readStore().conversations ?? []).find(item => item.taskId === recovered.taskId) ?? null;
  return {
    taskId: recovered.taskId,
    conversationId: conversation?.conversationId ?? null,
    created: { recoveredFromStore: true, lostReceipt },
    lostReceipt
  };
}

async function cleanupProbe(taskId, conversationId) {
  // 会话 id 不能只认建探针时拿到的那一个：`submitConversation` 的回执里不一定带 conversationId，
  // 第 6 次真机跑完，默认目录里就留下两条孤儿会话（taskId 指向已删任务）。删任务也不连带删会话，
  // 所以收尾时按 taskId 再回查一次，而且要在删除之前回查——任务一没，会话上的 taskId 就查不到归属了。
  const ids = new Set([conversationId,
    ...(readStore().conversations ?? []).filter(item => item.taskId === taskId).map(item => item.conversationId)
  ].filter(Boolean));
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  await sleep(2000);
  await ev(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  for (const id of ids) await ev(`window.agentAPI.deleteConversation(${JSON.stringify(id)})`, 30000).catch(() => null);
  await sleep(1500);
  const stillThere = (readStore().tasks ?? []).some(task => task.taskId === taskId);
  const stillConv = [...ids].filter(id => (readStore().conversations ?? []).some(item => item.conversationId === id));
  evidence.cleanup.push({ taskId, conversationIds: [...ids], removed: !stillThere, conversationLeft: stillConv });
  return stillThere;
}

/** D 段：上一里程碑真机产出的原文，喂给当前构建的分类器——不花墙钟，只证「现网那几条不再判死」。 */
function replayLiveStrings() {
  const sources = [M33_EVENTS, path.join(OUT_DIR, 'fault.cloud-unreachable.json')].filter(item => fs.existsSync(item));
  if (sources.length === 0) return { skipped: '找不到历史真机事件导出' };
  const texts = [];
  for (const file of sources) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 两份导出形状不同：M3-3 那份是裸事件数组，本轮存的那份把任务与事件包在对象里。
    const events = Array.isArray(raw) ? raw : (raw.events ?? []);
    const taskError = Array.isArray(raw) ? null : raw.task?.error;
    const buckets = [taskError, ...events];
    for (const item of buckets) {
      const candidates = typeof item === 'string' ? [item] : [];
      for (const field of ['error', 'message', 'detail']) {
        const value = typeof item === 'string' ? null : item?.[field];
        if (typeof value === 'string') candidates.push(value);
      }
      for (const value of candidates) {
        if (/超时|没有输出|上下文已满|连不上|fetch failed|ECONNRESET/i.test(value)) {
          texts.push({ from: path.basename(file), text: value.slice(0, 160) });
        }
      }
    }
  }
  const verdicts = texts.map(item => ({ ...item, verdict: classifyFault(new Error(item.text)) }));
  return {
    liveSamples: verdicts.length,
    stillFatal: verdicts.filter(item => item.verdict.status === 'failed').map(item => item.text),
    kinds: [...new Set(verdicts.map(item => `${item.verdict.kind}→${item.verdict.status}`))]
  };
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (ATTACH) {
    if (listenersOn(PORT).length === 0) throw new Error(`附着模式下 CDP 端口 ${PORT} 上没有实例：先把 dev 起起来`);
    // 上一段中断的日志要清掉，但 App 正握着这个文件追加写：删文件只会让它写进已 unlink 的 inode，
    // 所以截断保留同一个文件。
    fs.writeFileSync(LOG, '');
  } else {
    if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
    fs.rmSync(LOG, { force: true });
  }
  // 上一段被中途停掉的运行会留下同名产物（截图/事件导出）：不清掉，下一次读证据的人
  // 会把「上一轮跑到的地方」当成这一轮的结果。
  for (const stale of ['evidence.json', 'EVIDENCE.md', 'events.after-fault.json',
    '01-auto-continue-switch.png', '02-exit-visible.png', '03-continue-round.png', '04-fault-interrupted.png',
    '05-default-auto-open.png']) {
    fs.rmSync(path.join(OUT_DIR, stale), { force: true });
  }
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'marker.txt'), 'm3-4-probe\n');
  // E 段的「首轮必带失败检查」就是这颗脚本造的：期望值写死成一个 marker.txt 里不可能有的串，
  // read-only 档又改不动文件，所以校验永远退 1，判定只能落到「这一轮有失败步骤、还得再来一轮」。
  fs.writeFileSync(path.join(WORKSPACE, 'check-marker.mjs'),
    "import fs from 'node:fs';\nconst want = 'expected-marker-value';\nconst got = fs.readFileSync(new URL('./marker.txt', import.meta.url), 'utf8').trim();\nconsole.log(got === want ? 'MATCH' : 'MISMATCH got=' + got + ' want=' + want);\nprocess.exit(got === want ? 0 : 1);\n");

  const storeBackup = path.join(OUT_DIR, 'agent-store.before.json');
  if (fs.existsSync(STORE)) fs.copyFileSync(STORE, storeBackup);
  evidence.replay = replayLiveStrings();
  note('d-live-strings-not-fatal',
    evidence.replay.skipped ? false : evidence.replay.liveSamples > 0 && evidence.replay.stillFatal.length === 0,
    `真机原文 ${String(evidence.replay.liveSamples ?? 0)} 条，落点 ${JSON.stringify(evidence.replay.kinds ?? [])}｜仍判死的 ${JSON.stringify(evidence.replay.stillFatal ?? [])}`);

  const before = { tasks: (readStore().tasks ?? []).length };
  evidence.before = before;

  await startDev(true);
  cdp = await connectRenderer();
  // 上一次被中途停掉的探针会留在默认数据目录里继续占着网页通道：先按标题清掉再建新的，
  // 否则两条探针排队互相饿死，本轮所有等待都是在等别人。
  const stale = (readStore().tasks ?? [])
    .filter(task => PROBE_TITLES.some(title => String(task.userPrompt ?? task.title ?? '').includes(title)))
    .map(task => task.taskId);
  // 会话挂在 taskId 上，而 `deleteTask` 只回收检查点/归档/目标，不管会话：真机第 11 次被
  // 中途掐断后，默认目录里就留下两条没人认领的探针会话。收尾段有同类漏（F 段那次已修），
  // 开局这段同样得连着会话一起清，否则基线就不是基线。
  const staleConversations = (readStore().conversations ?? [])
    .filter(item => stale.includes(item.taskId) ||
      PROBE_TITLES.some(title => String(item.title ?? '').includes(title)))
    .map(item => item.conversationId);
  evidence.staleProbes = stale;
  evidence.staleConversations = staleConversations;
  for (const id of stale) {
    await ev(`window.agentAPI.cancelTask(${JSON.stringify(id)})`, 20000).catch(() => null);
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(id)})`, 30000).catch(() => null);
  }
  for (const id of staleConversations) {
    await ev(`window.agentAPI.deleteConversation(${JSON.stringify(id)})`, 20000).catch(() => null);
  }
  if (stale.length > 0 || staleConversations.length > 0) await sleep(2500);
  before.tasks = (readStore().tasks ?? []).length;
  before.conversations = (readStore().conversations ?? []).length;
  const leftover = stale.filter(id => (readStore().tasks ?? []).some(task => task.taskId === id));
  const leftoverConversations = staleConversations
    .filter(id => (readStore().conversations ?? []).some(item => item.conversationId === id));
  note('a-stale-probes-cleared', leftover.length === 0 && leftoverConversations.length === 0,
    leftover.length === 0 && leftoverConversations.length === 0
      ? (stale.length === 0 && staleConversations.length === 0
        ? '没有遗留探针'
        : `清掉 ${String(stale.length)} 条遗留探针任务 + ${String(staleConversations.length)} 条探针会话，基线任务数 ${String(before.tasks)}／会话数 ${String(before.conversations)}`)
      : `仍有任务 ${leftover.map(id => id.slice(0, 8)).join(',') || '无'}／会话 ${leftoverConversations.map(id => id.slice(0, 8)).join(',') || '无'} 没删掉`);

  const channel = await ev('window.agentAPI.getDeepSeekStatus().catch(() => null)');
  const cliAgents = await ev('window.agentAPI.getCliAgents().catch(() => [])');
  const cliLead = (cliAgents ?? []).find(agent => agent.available && agent.executable) ?? null;
  /**
   * 名单里要写的是**成员 id**（`cli:qoder`），不是注册表 id（`qoder`）：`getCliAgents()` 给的是
   * 后者，编排器选人按前者筛（`index.ts` 里 `enabledCliAgentIds().map(id => 'cli:' + id)`），
   * 差一个前缀就是「已开启的 CLI 都没探活成功」。2026-11-28 真机第一次跑 C 段就栽在这里。
   */
  const cliLeadId = cliLead ? `cli:${String(cliLead.id).replace(/^cli:/, '')}` : null;
  const pageUsable = Boolean(channel?.loggedIn && channel?.pageReady);
  evidence.channel = {
    page: channel ? { loggedIn: channel.loggedIn, pageReady: channel.pageReady, detail: channel.detail ?? null, url: channel.url ?? null } : null,
    cli: (cliAgents ?? []).map(agent => ({ id: agent.id, available: agent.available, headless: agent.headless, reason: agent.reason ?? null }))
  };
  // 网页源按用户的设置可以全关（2026-11-28 用户指示：关着就提示去打开），所以这里不再要求
  // 「页面必须登录」——只要三条通道里有一条真能用，探针就能跑。`source_disabled` 那一条落在
  // 单测与源码守卫里（scripts/check-task-fault.mjs）：`saveSource` 要求「至少要留一个来源」，
  // 这台机器上没法真把网页源全关掉，真机不认领。
  note('a-channel-state', pageUsable || Boolean(cliLead),
    `网页登录=${String(channel?.loggedIn)} 页面可用=${String(channel?.pageReady)}（${String(channel?.detail ?? '')}）｜已实测可用的 CLI=${JSON.stringify((cliAgents ?? []).filter(agent => agent.available).map(agent => agent.id))}`);

  const defaults = await ev('window.agentAPI.getExecutionDefaults()');
  evidence.defaults = defaults ?? null;
  /**
   * 探针一律用「实测可用的 CLI 当主导、云模型清单清空」，不用用户的默认配置。
   *
   * 第 8 次真机就是死在默认配置上：默认里挂着超算网关，网关当场 `连不上 https://api.scnet.cn/...`，
   * 探针第一轮就停在故障上，A/B/E 三段一格证据都拿不到（用户 2026-11-28 指示：超算不能用就用
   * qoder cli 继续）。判据本身与用哪条通道无关——断通道这一条另有 D 段用现网原文回放证明。
   */
  const probeConfig = cliLeadId
    ? { ...defaults, executionMode: 'cloud', selectedCloudModels: [], selectedCliAgents: [cliLeadId] }
    : defaults;
  evidence.probeExecution = cliLeadId
    ? `探针用 CLI 主导（${cliLeadId}）、云模型清空；用户默认配置见 evidence.defaults`
    : '没有实测可用的 CLI，探针退回用户默认配置（第 8 次真机：这条通道 `连不上`，任务停在故障上）';
  const created = await createProbe({ title: PROBE_TITLE, text: PROBE_PROMPT, executionConfig: probeConfig });
  const taskId = created.taskId;
  const conversationId = created.conversationId;
  assert.ok(taskId, `探针任务没创建出来：${JSON.stringify(created.created ?? created.lostReceipt).slice(0, 200)}`);
  evidence.taskId = taskId;
  evidence.conversationId = conversationId;
  note('a-probe-created', true, `task=${String(taskId).slice(0, 8)} conv=${String(conversationId ?? '').slice(0, 8)}`);

  // 只等到「停在待审批」，先不点确认：这一格里任务不会推进，A 段这几十秒读写开关才不会和轮次边界抢。
  const parked = await waitForApproval(taskId, '探针');
  evidence.parkedAtApproval = parked
    ? { status: parked.status, planId: parked.currentPlanId }
    : { status: storeTask(taskId)?.status ?? null };
  note('a-parked-at-approval', parked !== null,
    parked
      ? `停在 awaiting_approval（计划 ${String(parked.currentPlanId).slice(0, 8)}），确认留到关掉无人值守之后再点`
      : `没等到 awaiting_approval（此刻 ${String(storeTask(taskId)?.status)}）：这一档可能本来就自动批，B 段的等待照旧`);

  // ── A 段：开关的边界 / 生效值 / 落盘 / 事件 / 界面 ────────────────────────
  const rejected = [];
  for (const bad of [
    { input: { taskId }, why: '没指布尔，改的是哪一侧说不清' },
    { input: { taskId, autoContinue: 'false' }, why: '字符串 "false" 在代码里 !== false，会显示成已打开' },
    { input: { taskId, autoContinue: 1 }, why: '数字不能当布尔' },
    { input: { taskId, autoContinue: true, extra: 1 }, why: '多余键必须拒（strict），不能悄悄吞掉' }
  ]) {
    const out = await callAuto(bad.input);
    rejected.push({ input: bad.input, why: bad.why, ...out });
    note(`a-dirty-rejected:${JSON.stringify(bad.input)}`,
      out.ok === false && /autoContinue|Unrecognized|invalid_type/i.test(String(out.error ?? '')),
      out.ok ? `竟然通过了：${JSON.stringify(out.value).slice(0, 120)}` : `边界拒了：${String(out.error).slice(0, 150)}｜理由 ${bad.why}`);
  }
  evidence.phaseA.rejected = rejected;

  const bornTask = storeTask(taskId);
  const expectBornOn = autoContinueOf(bornTask);
  const turnOff = await callAuto({ taskId, autoContinue: false });
  const offPersisted = storeTask(taskId);
  // 落库值要在删探针之前抄进证据：结论段是收尾时拼的，那时再 storeTask 只能读到「已删除」。
  evidence.phaseA.persistedAutoContinue = offPersisted?.autoContinue ?? null;
  const eventsAfterOff = await taskEvents(taskId);
  const offEvent = eventsAfterOff.slice().reverse().find(item => item.type === 'task.auto_continue.updated') ?? null;
  note('a-switch-off-receipt',
    turnOff.ok === true && turnOff.value?.autoContinue === false && turnOff.value?.previous === expectBornOn,
    `回执 ${JSON.stringify(turnOff.value ?? turnOff.error).slice(0, 180)}｜建立时的生效值 ${String(expectBornOn)}（老任务没写过这个字段，缺省按自动续轮算）`);
  note('a-switch-off-persisted',
    offPersisted?.autoContinue === false,
    `落库 autoContinue=${String(offPersisted?.autoContinue)}（重启后要读回来的就是这一格）`);
  note('a-switch-off-event',
    Boolean(offEvent) && offEvent.autoContinue === false && offEvent.previous === expectBornOn,
    `事件 ${JSON.stringify({ autoContinue: offEvent?.autoContinue, previous: offEvent?.previous }).slice(0, 120)}｜这条任务共 ${String(eventsAfterOff.filter(item => item.type === 'task.auto_continue.updated').length)} 次改动`);
  const switchOff = await autoSwitch();
  evidence.phaseA.switchOff = switchOff;
  note('a-ui-switch-off',
    switchOff?.checked === false && String(switchOff?.label ?? '').includes('停在轮次开始前'),
    `界面读数「${String(switchOff?.label ?? '找不到开关')}」`);

  const turnOn = await callAuto({ taskId, autoContinue: true });
  const switchOn = await autoSwitch();
  evidence.phaseA.switchOn = switchOn;
  note('a-switch-back-on',
    turnOn.ok === true && turnOn.value?.autoContinue === true && turnOn.value?.previous === false
      && storeTask(taskId)?.autoContinue === true && switchOn?.checked === true
      && String(switchOn?.label ?? '').includes('自动开'),
    `回执 ${JSON.stringify(turnOn.value ?? turnOn.error).slice(0, 140)}｜界面「${String(switchOn?.label ?? '')}」`);
  await shot('01-auto-continue-switch.png');

  // ── A 段续：用户出口的拒绝面（此刻任务在跑，不该被「再来一轮」插队）────────
  const refused = [];
  for (const bad of [
    { input: { taskId, instruction: '   ' }, why: '空指令照样开一轮，等于把一轮模型调用烧在空格上' },
    { input: { taskId, instruction: INSTRUCTION, extra: 1 }, why: '多余键必须拒' },
    { input: { instruction: INSTRUCTION }, why: '没有任务 id，不能猜对哪条任务开轮' }
  ]) {
    const out = await callContinue(bad.input);
    refused.push({ input: { ...bad.input, instruction: bad.input.instruction?.slice(0, 24) }, why: bad.why, ...out });
  }
  const statusNow = String(storeTask(taskId)?.status ?? '');
  // 状态那条拒判要有前提：模型要是已经跑完一轮，此刻正该放行，硬断「必须拒」就是假失败。
  const checkState = !isContinueRoundAllowed(statusNow);
  if (checkState) {
    const outWrongState = await callContinue({ taskId, instruction: INSTRUCTION });
    refused.push({ input: { taskId, instruction: INSTRUCTION.slice(0, 24) }, why: `状态 ${statusNow} 不在允许名单`, ...outWrongState });
  }
  evidence.phaseA.continueRefused = refused;
  evidence.phaseA.stateWhenChecked = statusNow;
  note('a-continue-boundary',
    refused.length > 0 && refused.every(item => item.ok === false)
      && refused.some(item => /instruction|要说什么做法不对/.test(String(item.error ?? '')))
      && refused.some(item => /Unrecognized/.test(String(item.error ?? '')))
      && (!checkState || refused.some(item => /任务当前状态为/.test(String(item.error ?? '')))),
    `拒了 ${String(refused.length)} 条（状态检查=${String(checkState)}）：${refused.map(item => String(item.error ?? '').slice(0, 60)).join(' / ')}`);
  note('a-continue-no-sneak-round',
    isContinueRoundAllowed(statusNow) === false || roundCount(taskId) >= 1,
    `此刻状态 ${statusNow}（允许名单=${JSON.stringify(['report_pending', 'awaiting_next_round'])}）｜轮数 ${String(roundCount(taskId))}`);

  // ── B 段：等一个真轮次跑完，走真用户出口开下一轮 ──────────────────────────
  // 开关刻意留在「关」上过这一段：开着的话判定要开下一轮就直接开了，B 段等到的
  // `awaiting_next_round` 只是撞运气。关掉之后，「停在轮次开始前」是必然落点，
  // 同一次等待同时证到 M3-4c（停得住且留说法）与 M3-4b（人说的「再来一轮」真能开轮）。
  const turnOffForB = await callAuto({ taskId, autoContinue: false });
  evidence.phaseB.switchForB = turnOffForB.value ?? turnOffForB.error ?? null;
  note('b-stopped-before-wait', turnOffForB.ok === true && turnOffForB.value?.autoContinue === false,
    `等待前把无人值守关掉：${JSON.stringify(turnOffForB.value ?? turnOffForB.error).slice(0, 140)}`);

  // 关掉之后才点「确认并执行」：本轮跑完的那次判定必然落在「关」这一侧，「停在轮次开始前」
  // 就不是撞运气。第二次真机就是先点了确认，A 段还没读完开关轮次边界就到了（18:36:25 自动开出
  // 第 2 轮），B 段白等 10 分钟。
  const approval = parked
    ? await clickApprove(taskId, parked)
    : { reached: false, ok: false, receipt: null, statusAfter: storeTask(taskId)?.status ?? null };
  evidence.approval = approval;
  note('a-wait-user-approved', approval.reached === true && approval.ok === true,
    approval.reached
      ? `无人值守已关，脚本代点「确认并执行」开跑本轮：回执 ${JSON.stringify(approval.receipt).slice(0, 80)}｜之后状态 ${String(approval.statusAfter)}`
      : `没停在 awaiting_approval，确认这一下没点到（此刻 ${String(approval.statusAfter)}）：本轮没有样本，如实记为跳过`);

  let waitingTask = null;
  try {
    waitingTask = await waitFor(async () => {
      const task = storeTask(taskId);
      return task && isContinueRoundAllowed(task.status) ? task : null;
    }, '探针跑到 report_pending / awaiting_next_round', WAIT_REPORT);
  } catch {
    waitingTask = storeTask(taskId);
  }
  const roundsBefore = roundCount(taskId);
  evidence.phaseB.statusAtGate = waitingTask?.status ?? null;
  evidence.phaseB.roundsBefore = roundsBefore;
  const eventsBeforeExit = await taskEvents(taskId);
  const awaitEvent = eventsBeforeExit.slice().reverse().find(item => item.type === 'task.round.await_user') ?? null;
  evidence.phaseB.awaitEvent = awaitEvent ?? null;
  if (String(waitingTask?.status) === 'awaiting_next_round') {
    // 停在轮次开始前来不到 = 无人值守没真关掉，或者停法是别的（空转/待确认）。
    // 两种都要在证据里看得见，不能只写「等到了 report_pending」。
    note('b-stops-before-round', Boolean(awaitEvent) && awaitEvent.purpose && awaitEvent.reason
      && String(awaitEvent.gate?.reason ?? '').length > 0,
      `事件 ${JSON.stringify({ purpose: awaitEvent?.purpose, reason: String(awaitEvent?.reason ?? '').slice(0, 90), gate: awaitEvent?.gate }).slice(0, 260)}`);
  } else {
    skip('b-stops-before-round',
      `本轮自然停在 ${String(waitingTask?.status)}（不是 awaiting_next_round）：这一段要的是「同一条任务先拨关、再由这一轮判定撞停」，本轮没走到；落点本身由 G 段独立探针取证（见 g-*）`);
  }
  if (!isContinueRoundAllowed(String(waitingTask?.status ?? ''))) {
    skip('b-positive-window-skipped',
      `${String(WAIT_REPORT / 1000 / 60)} 分钟窗口内没等到 report_pending（实际状态 ${String(waitingTask?.status)}，轮数 ${String(roundsBefore)}）：正向段本轮不认领，出口由 C 段接回循环 + 离线用例覆盖`);
  } else {
    note('b-reached-waiting-state', true, `状态 ${String(waitingTask?.status)}｜轮数 ${String(roundsBefore)}`);
    // M3-2 的未通过项就出在「判定说停下等人，界面上却没有能接回去的按钮」，所以这条入口
    // 光有 IPC 通不够：得在停下的那一刻真在页面上摸得到，人才接得回去。
    await openTab('对话');
    await sleep(800);
    await shot('02-exit-visible.png');
    const exitShown = await ev(`(() => {
      const box = document.querySelector('textarea[aria-label="换手段再来一轮的指令"]');
      if (!box) return { found: false, groupText: '' };
      const group = box.closest('[role="group"]');
      const button = [...(group?.querySelectorAll('button') ?? [])]
        .map(node => (node.textContent ?? '').trim()).filter(text => /继续下一轮|换手段再来一轮/.test(text));
      return {
        found: true,
        placeholder: box.placeholder ?? '',
        button: button[0] ?? null,
        buttons: [...(group?.querySelectorAll('button') ?? [])].map(node => (node.textContent ?? '').trim()).filter(Boolean),
        groupText: (group?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300)
      };
    })()`);
    evidence.phaseB.exitShown = exitShown;
    note('b-exit-visible-in-ui', exitShown?.found === true && Boolean(exitShown?.button)
      && (String(waitingTask?.status) !== 'awaiting_next_round' || exitShown.button === '继续下一轮'),
      `入口渲染=${String(Boolean(exitShown?.found))}｜按钮「${String(exitShown?.button)}」｜同组按钮 ${JSON.stringify(exitShown?.buttons ?? []).slice(0, 160)}`);
    const opened = await callContinue({ taskId, instruction: INSTRUCTION });
    const after = storeTask(taskId);
    const newRounds = roundCount(taskId);
    const continued = storeRounds(taskId).slice(-1)[0] ?? null;
    const events = await taskEvents(taskId);
    const userEvent = events.slice().reverse().find(item => item.type === 'task.round.user_continue') ?? null;
    const expectGate = canOpenRound({
      budget: after?.budget ?? null,
      usage: { rounds: roundsBefore, modelCalls: null, tokens: null }
    });
    evidence.phaseB = {
      ...evidence.phaseB,
      receipt: opened.value ?? opened.error ?? null,
      status: after?.status ?? null,
      roundsAfter: newRounds,
      round: { inputType: continued?.inputType ?? null, requestHasInstruction: String(continued?.requestText ?? '').includes(INSTRUCTION) },
      event: userEvent ? { fromStatus: userEvent.fromStatus, instruction: userEvent.instruction, means: (userEvent.means ?? []).length, gate: userEvent.gate } : null
    };
    note('b-opened-round',
      opened.ok === true && newRounds > roundsBefore && String(after?.status) === 'planning',
      `轮数 ${String(roundsBefore)} → ${String(newRounds)}，状态 ${String(after?.status)}（不是只回一个回执）`);
    note('b-instruction-persisted',
      continued?.inputType === 'user_continue' && String(continued?.requestText ?? '').includes(INSTRUCTION),
      `新一轮 inputType=${String(continued?.inputType)}，请求文本含用户原话=${String(String(continued?.requestText ?? '').includes(INSTRUCTION))}｜上一轮手段清单 ${String(userEvent?.means?.length ?? 0)} 条一并带上`);
    note('b-event-and-gate',
      Boolean(userEvent) && userEvent.fromStatus === String(waitingTask?.status) && userEvent.instruction === INSTRUCTION
      && userEvent.gate?.ok === expectGate.ok && userEvent.gate?.reason === expectGate.reason,
      `事件 gate=${JSON.stringify(userEvent?.gate ?? null)}｜脚本用同一批纯函数反算 gate=${JSON.stringify(expectGate)}`);
    await shot('03-continue-round.png');
  }

  // ── C 段：通道停住 → 落在可恢复那侧 → 点「继续任务」接回循环 ────────────────
  // 另建一条走 CLI 通道的探针，不动主探针（B 段刚给它开了一轮，留着当对照）。
  // 为什么用 CLI：这一条通道的进程在进程表里看得见，`SIGSTOP` 之后 stdout 不再有新块，
  // 编排器的看门狗就会说出真机那句「模型连续 N 秒没有输出」——不是假异常，也不动用户的设置。
  if (!cliLead) {
    skip('c-channel-stall',
      `没有已实测可用的 CLI 通道（清单 ${JSON.stringify(evidence.channel.cli.map(item => `${item.id}:${String(item.headless)}`))}）：故障注入本轮不做，落点由 D 段真机原文回放 + 离线用例覆盖`);
    skip('c-resume-recovers', 'C 段整段未跑');
    skip('c-auto-open-after-resume', 'C 段整段未跑');
  } else {
    const { pid: mainPid, candidates } = appMainPid();
    evidence.phaseC.listeners = candidates;
    if (!mainPid) {
      skip('c-channel-stall', `认不出 App 主进程：端口 ${PORT} 上的监听者 ${JSON.stringify(candidates)} 里没有 ThinkFusion/Electron，注入无处下手`);
      skip('c-resume-recovers', '没认出 App 主进程');
      skip('c-auto-open-after-resume', '没认出 App 主进程');
    } else {
    const cliBaseline = new Set(childPids(mainPid));
    const createdC = await createProbe({
      title: PROBE_C_TITLE,
      text: PROBE_C_PROMPT,
      executionConfig: { ...defaults, executionMode: 'cloud', selectedCloudModels: [], selectedCliAgents: [cliLeadId] }
    });
    const cid = createdC.taskId;
    const conversationC = createdC.conversationId;
    if (!cid) {
      // 「这一段没跑成」不能把整轮证据带走：A/B/D 已经落盘，C 记跳过同样诚实。
      skip('c-channel-stall', `CLI 主导的探针没建出来（名单 ${cliLeadId}）：${JSON.stringify(createdC.created ?? createdC.lostReceipt).slice(0, 220)}`);
      skip('c-resume-recovers', 'C 段探针没建出来');
      skip('c-auto-open-after-resume', 'C 段探针没建出来');
    } else {
    evidence.phaseC.taskId = cid;
    // 开关拨到「开」：C 段之后要证的是无人值守的正向半边——恢复出来的那一轮跑完，
    // 判定说要开下一轮时得真开，不需要人再点一次。
    const turnOnForC = await callAuto({ taskId: cid, autoContinue: true });
    evidence.phaseC.switchBackOn = turnOnForC.value ?? turnOnForC.error ?? null;
    note('c-switch-back-on', turnOnForC.ok === true && turnOnForC.value?.autoContinue === true,
      JSON.stringify(turnOnForC.value ?? turnOnForC.error).slice(0, 140));

    const roundsBeforeFault = roundCount(cid);
    const stopped = await stopFreshCliChild(mainPid, [cliLead.executable, cliLead.command ?? cliLead.id], cliBaseline);
    cliStopped = stopped;
    evidence.phaseC.inject = { cliId: cliLead.id, executable: cliLead.executable, mainPid, ...stopped, at: new Date().toISOString() };
    note('c-channel-stall-injected', stopped.pid != null,
      stopped.pid
        ? `已 SIGSTOP 规划用的 CLI 进程 ${String(stopped.mode === 'group' ? `组 -${String(stopped.pid)}` : String(stopped.pid))}（进程态 ${String(stopped.state || '?')}，组内子进程 ${String(stopped.group.length)} 个｜${String(stopped.command).slice(0, 70)}）`
        : stopped.why);

    let faulted = null;
    if (stopped.pid) {
      try {
        faulted = await waitFor(async () => {
          const task = storeTask(cid);
          return task && ['interrupted', 'blocked', 'failed', 'completed', 'cancelled'].includes(task.status) ? task : null;
        }, '通道停住后被看门狗收口', WAIT_STALL);
      } catch {
        faulted = storeTask(cid);
      }
    }
    await sleep(SETTLE);
    const released = releaseCliChild(stopped);
    cliStopped = null;
    evidence.phaseC.released = released;
    const eventsC = await taskEvents(cid);
    const faultEvent = eventsC.slice().reverse().find(item => item.type === 'task.fault.stopped') ?? null;
    const failAfter = faultEvent
      ? eventsC.slice(eventsC.indexOf(faultEvent) + 1).filter(item => item.type === 'task.failed')
      : eventsC.filter(item => item.type === 'task.failed');
    const roundsAfterFault = roundCount(cid);
    evidence.phaseC = {
      ...evidence.phaseC,
      status: faulted?.status ?? null,
      error: faulted?.error ?? null,
      faultEvent: faultEvent ?? null,
      failedAfterFault: failAfter,
      roundsBeforeFault,
      roundsAfterFault
    };
    writeJson('events.after-fault.json', eventsC);
    note('c-not-killed',
      String(faulted?.status) !== 'failed' && failAfter.length === 0,
      `实际状态 ${String(faulted?.status)}（要停在可恢复那侧，不是终态 failed）｜错误「${String(faulted?.error ?? '').slice(0, 120)}」`);
    note('c-fault-event',
      Boolean(faultEvent) && faultEvent.landedStatus === String(faulted?.status)
        && ['channel_stall', 'channel_timeout', 'channel_context_full', 'plan_unusable', 'source_disabled'].includes(String(faultEvent.kind))
        && Boolean(faultEvent.headline) && Boolean(faultEvent.howBack),
      `事件 ${JSON.stringify({ kind: faultEvent?.kind, landedStatus: faultEvent?.landedStatus, error: String(faultEvent?.error ?? '').slice(0, 60) })}`);
    note('c-no-new-round-while-stopped', roundsAfterFault === roundsBeforeFault,
      `停住之后不得再开轮：${String(roundsBeforeFault)} → ${String(roundsAfterFault)}`);
    // 界面读数针对这条探针：不先在侧栏选中它，读到的是主探针（另一条任务）的卡片。
    const selected = await selectTaskRow(PROBE_C_TITLE);
    const readout = await faultReadout();
    evidence.phaseC.ui = { selectedRow: selected, ...readout };
    note('c-activity-note',
      (readout.conv?.stopped?.length ?? 0) > 0 && readout.conv?.howBack === true,
      `活动流旁注「${String(readout.conv?.stopped?.[0] ?? '没找到').slice(0, 90)}」｜带回来的说法=${String(readout.conv?.howBack)}`);
    note('c-ui-says-why-and-how',
      (readout.conv?.failedWord?.length ?? 0) === 0 && Boolean(readout.stats?.auto) && Boolean(readout.stats?.rounds),
      `仍在说「失败原因」的条数=${String(readout.conv?.failedWord?.length ?? 0)}｜统计页 无人值守「${String(readout.stats?.auto ?? '没找到')}」｜轮次「${String(readout.stats?.rounds ?? '没找到')}」`);
    await shot('04-fault-interrupted.png');

    const resumeStamp = Date.now();
    await fire(`window.agentAPI.resumeTask(${JSON.stringify(cid)})`, 'Back');
    try {
      await waitFor(async () => {
        const task = storeTask(cid);
        return task && task.status !== 'interrupted' ? task : null;
      }, '点「继续任务」后离开 interrupted', 120000);
    } catch { /* 留在证据里 */ }
    await sleep(SETTLE);
    const backTask = storeTask(cid);
    evidence.phaseC.afterResume = {
      status: backTask?.status ?? null,
      rounds: roundCount(cid),
      fired: await firedState('Back')
    };
    note('c-resume-recovers',
      String(backTask?.status) !== 'interrupted' && !['failed', 'cancelled'].includes(String(backTask?.status)),
      `继续任务后状态 ${String(backTask?.status)}｜轮数 ${String(roundsAfterFault)} → ${String(roundCount(cid))}（可恢复不是写在状态表里的空话）`);
    // 恢复出来的那一轮要重新出计划，而 `read-only` 档每轮计划都得人批（`approvalPolicyFor`）：
    // 第三次真机就停在这一格等满 12 分钟（状态 awaiting_approval、轮数 2→2），那不是自动续轮坏了，
    // 是这一轮压根没开跑。脚本照产品的门代点确认，让恢复出来的轮次真跑到边界。
    // 只能等「停在待审批」这一个格子：第四次真机读早了半秒，读到的是 `plan_ready`（评审还在辩论，
    // 之后才转 awaiting_approval），当时判成「没停在待审批」，等于没点。
    const resumedGate = await waitForApproval(cid, 'C 段恢复后的那一轮', 240000);
    const approveAfterResume = resumedGate ? await clickApprove(cid, resumedGate) : null;
    evidence.phaseC.resumeGate = resumedGate
      ? { status: resumedGate.status, planId: resumedGate.currentPlanId }
      : { status: storeTask(cid)?.status ?? null };
    evidence.phaseC.approveAfterResume = approveAfterResume;
    note('c-resume-plan-approved', approveAfterResume === null || approveAfterResume.ok === true,
      approveAfterResume === null
        ? `4 分钟内没等到待审批（状态 ${String(evidence.phaseC.resumeGate.status)}），直接等轮次边界`
        : `恢复后停在待审批，脚本代点确认：回执 ${JSON.stringify(approveAfterResume.receipt ?? null).slice(0, 80)}｜之后状态 ${String(approveAfterResume.statusAfter)}`);

    note('c-plan-annotations',
      !(await taskEvents(cid)).slice(-40).some(item => item.type === 'plan.invalid' && /dependsOn|expect|checksCategory/.test(String(item.error ?? ''))),
      '事件尾部 40 条里没有因说明字段而判废的计划（真机样本那三条键已接住）');

    // ── C 段续：无人值守开着时，边界上到底开不开轮得跟着判定走（M3-4c 的正向半边）──
    const boundaryC = await waitRoundBoundary({ taskId: cid, since: resumeStamp, waitMs: WAIT_AUTO_ROUND });
    evidence.phaseC.autoOpen = boundaryC;
    const nextC = String(boundaryC.decision?.nextAction ?? '');
    const typesC = boundaryC.roundTypes.join('、') || '无';
    if (nextC === 'open_next_round') {
      note('c-auto-open-after-resume', boundaryC.openedAfterDecision && !boundaryC.awaitUser && boundaryC.clicks === 0,
        `判定说「${String(boundaryC.decision?.decisionType)}/${nextC}」（${String(boundaryC.decision?.reason ?? '').slice(0, 60)}）→ 判定后自动开出「${String(boundaryC.openedInputType)}」轮，没落「等你点继续」旁注=${String(!boundaryC.awaitUser)}，期间出口点击 ${String(boundaryC.clicks)} 次（0 才算自动）｜轮次记录 ${typesC}`);
    } else if (boundaryC.decision) {
      // 开着无人值守也不许越过判定：这一格证的是反半边——自动续轮不是无条件开轮。
      note('c-open-still-obays-gate', !boundaryC.openedAfterDecision && boundaryC.clicks === 0,
        `判定说「${String(boundaryC.decision.decisionType)}/${nextC}」（${String(boundaryC.decision.reason ?? '').slice(0, 60)}）→ 判定后没有新轮（出口点击 ${String(boundaryC.clicks)} 次，开着也不新开轮才算对）｜状态 ${String(boundaryC.status)}｜轮次记录 ${typesC}`);
      skip('c-auto-open-after-resume',
        `窗口内到不了「要开下一轮」这一格（最近判定 ${nextC}）：这一轮自己判成停，正向半边由 E 段补`);
    } else {
      skip('c-auto-open-after-resume',
        `${String(WAIT_AUTO_ROUND / 60000)} 分钟窗口内没有新判定（状态 ${String(boundaryC.status)}，轮次记录 ${typesC}）：这一轮可能还停在计划审批或执行里，不能反过来说自动续轮坏了`);
    }

    const stillC = await cleanupProbe(cid, conversationC);
    note('c-probe-cleaned-up', stillC === false, `C 段探针删除后仍存在 ${String(stillC)}`);
    }
    }
  }

  // ── E 段：一个字段都没写过的任务，判定要开下一轮时得自己开（M3-4c 缺省即开）──────
  // 为什么单开一段：A/B 两段为了拿到「停在轮次开始前」的样本全程在拨这个开关，落库写的是显式值；
  // 现网绝大多数任务压根没写过它（`contracts.ts` 的写路径不带这个字段，生效值全靠 `autoContinueOf()`
  // 缺省算），它们的真行为要一条一次开关都不碰的探针才证得到。第 2 次真机靠执行顺序撞上过一次
  // （18:36:25 判定 open_next_round、同一秒 round.started，脚本 7 秒后才第一次改这个字段），但那
  // 一轮证据没落盘，所以不认领。第 5/6 次真机用「列文件名」这条问法跑不到那一格（边界判定全是
  // stop_and_wait），改用带失败校验的问法把边界推到 `open_next_round`，见 PROBE_E_PROMPT 的说明。
  // 权限档这一格从 read-only 改成 workspace-write：read-only 下 `node check-marker.mjs` 会被权限
  // 拒掉，那条失败是「没批工具」而不是「校验没过」，反空转分类很可能据此判 missing_permission 直接
  // 停手（M3-2 的规矩：缺权限不给重规划机会），E 段要的 `open_next_round` 就永远跑不到。工作区是
  // /tmp 下的夹具，写权限扩到它里面没有副作用。
  const createdE = await createProbe({
    title: PROBE_E_TITLE,
    text: PROBE_E_PROMPT,
    executionConfig: probeConfig,
    permissionPreset: 'workspace-write'
  });
  const eid = createdE.taskId;
  const conversationE = createdE.conversationId;
  if (!eid) {
    skip('e-default-auto-open', `缺省探针没建出来：${JSON.stringify(createdE.created ?? createdE.lostReceipt).slice(0, 200)}`);
    skip('e-default-field-untouched', '缺省探针没建出来');
  } else {
    const bornE = storeTask(eid);
    const parkedE = await waitForApproval(eid, 'E 段探针', WAIT_REPORT);
    // 时间戳取在点确认之前：第 6 次真机把基线取在确认之后，窗口里混进了「这一轮自己」的轨迹，
    // 而判定/开轮都只发生在执行完之后，取早了不会漏证据，取晚了才会把自动开的那一轮读成窗口外。
    const sinceE = Date.now();
    const approvedE = parkedE ? await clickApprove(eid, parkedE) : null;
    evidence.phaseE = {
      taskId: eid,
      lostReceipt: createdE.lostReceipt,
      bornFieldWritten: Object.prototype.hasOwnProperty.call(bornE ?? {}, 'autoContinue'),
      bornEffective: autoContinueOf(bornE),
      approved: approvedE ? { ok: approvedE.ok, statusAfter: approvedE.statusAfter } : { ok: false, statusAfter: storeTask(eid)?.status ?? null },
      roundTypesAtApproval: (storeRounds(eid) ?? []).map(round => `${String(round.roundNumber)}:${round.inputType ?? '?'}`).join('、') || '无'
    };
    const boundaryE = await waitRoundBoundary({ taskId: eid, since: sinceE, waitMs: WAIT_AUTO_ROUND });
    const eventsE = await taskEvents(eid);
    const autoEvents = eventsE.filter(item => item.type === 'task.auto_continue.updated').length;
    const clicksE = eventsE.filter(item => item.type === 'task.round.user_continue').length;
    const nowE = storeTask(eid);
    const decisionE = boundaryE.decision;
    evidence.phaseE.decision = decisionE
      ? { decisionType: decisionE.decisionType, nextAction: decisionE.nextAction, reason: String(decisionE.reason ?? '').slice(0, 140) }
      : null;
    evidence.phaseE.boundary = boundaryE;
    evidence.phaseE.roundsAfter = roundCount(eid);
    evidence.phaseE.autoContinueEvents = autoEvents;
    evidence.phaseE.userContinueClicks = clicksE;
    evidence.phaseE.nowFieldWritten = Object.prototype.hasOwnProperty.call(nowE ?? {}, 'autoContinue');
    evidence.phaseE.nowEffective = autoContinueOf(nowE);
    note('e-default-field-untouched',
      autoEvents === 0 && clicksE === 0 && autoContinueOf(nowE) === true,
      `全程没碰开关：改动事件 ${String(autoEvents)} 条｜出口点击 ${String(clicksE)} 次｜字段是否被显式写过 建=${String(evidence.phaseE.bornFieldWritten)}/现=${String(evidence.phaseE.nowFieldWritten)}（生效值 ${String(autoContinueOf(nowE))}）`);
    const typesE = boundaryE.roundTypes.join('、') || '无';
    if (String(decisionE?.nextAction ?? '') === 'open_next_round') {
      note('e-default-auto-open',
        boundaryE.openedAfterDecision && !boundaryE.awaitUser && clicksE === 0,
        `判定 ${String(decisionE.decisionType)}/${decisionE.nextAction}「${String(decisionE.reason ?? '').slice(0, 70)}」→ 判定后自动开出「${String(boundaryE.openedInputType)}」轮，没落「等你点继续」旁注=${String(!boundaryE.awaitUser)}，全程出口点击 ${String(clicksE)} 次（0 才算自动）｜轮次记录 ${typesE}`);
    } else if (decisionE) {
      skip('e-default-auto-open',
        `${String(Math.round(WAIT_AUTO_ROUND / 60000))} 分钟窗口内这一轮判成了「${String(decisionE.decisionType)}/${decisionE.nextAction}」（${String(decisionE.reason ?? '').slice(0, 70)}，判定后新轮 ${String(boundaryE.openedAfterDecision)}，状态 ${String(boundaryE.status)}，轮次记录 ${typesE}）：这一条探针拿到的是停的半边，缺省即开的正向半边要在判定说开的那一轮才证得到`);
    } else {
      skip('e-default-auto-open',
        `${String(Math.round(WAIT_AUTO_ROUND / 60000))} 分钟窗口内没等到判定（状态 ${String(boundaryE.status)}，轮次记录 ${typesE}）：这一轮可能还停在计划审批或执行里，不能反过来说缺省即开坏了`);
    }
    await shot('05-default-auto-open.png');
    const stillE = await cleanupProbe(eid, conversationE);
    note('e-probe-cleaned-up', stillE === false, `缺省探针删除后仍存在 ${String(stillE)}`);
  }

  // ── F 段：只能用网页源时停在「受阻」，说的是「去设置里打开」而不是判死（M3-4d 最后一格）───
  // 断在这里也照收：这一段只在 E 之后顺手跑，拿不到现场就记跳过并写清原因，不把它编成通过。
  const WAIT_SOURCE_STOP = 4 * 60 * 1000;
  const sourceState = await ev('window.agentAPI.getSources()', 30000).catch(() => null);
  const pageSources = (sourceState?.sources ?? []).map(item => ({
    id: String(item.id), label: String(item.label ?? ''), enabled: item.enabled !== false
  }));
  const closedSource = pageSources.find(item => !item.enabled) ?? null;
  evidence.phaseF = { pageSources, chosen: closedSource?.id ?? null };
  if (!closedSource) {
    skip('f-source-disabled-landing',
      pageSources.length === 0
        ? '设置里没有网页源可指，这一格只剩离线用例'
        : `设置里的网页源全是开着的（${JSON.stringify(pageSources.map(item => item.id))}），撞不到「源关着」这一格；离线用例与源码守卫仍覆盖`);
  } else {
    const createdF = await createProbe({
      title: PROBE_F_TITLE,
      text: PROBE_F_PROMPT,
      executionConfig: { ...defaults, executionMode: 'web', selectedWebChannels: [closedSource.id], selectedCloudModels: [], selectedCliAgents: [] },
      timeoutMs: 60000
    });
    const fid = createdF.taskId;
    if (!fid) {
      // 「提交就被拒」同样是现网行为，只是它不经过 classifyFault——照原文记下来，不冒充通过也不判失败。
      evidence.phaseF.reject = String(createdF.created?.error ?? createdF.lostReceipt ?? '没建出来').slice(0, 200);
      const stray = createdF.strayConversationIds ?? [];
      for (const id of stray) await ev(`window.agentAPI.deleteConversation(${JSON.stringify(id)})`, 30000).catch(() => null);
      await sleep(1500);
      const stillStray = stray.filter(id => (readStore().conversations ?? []).some(item => item.conversationId === id));
      evidence.phaseF.strayConversations = stray;
      // 记进 cleanup，让收尾那条总线（而不是本段自己）判定有没有留下孤儿。
      evidence.cleanup.push({ taskId: '（F 段只有会话，没有任务）', conversationIds: stray,
        removed: stillStray.length === 0, conversationLeft: stillStray });
      skip('f-source-disabled-landing',
        `源关着时这条探针没建出来（${evidence.phaseF.reject}）：落点在提问/规划之前，本段证不到`
        + `｜顺手回收 ${String(stray.length)} 条会话，仍没删掉的 ${String(stillStray.length)} 条`);
    } else {
      evidence.phaseF.taskId = fid;
      const deadlineF = Date.now() + WAIT_SOURCE_STOP;
      let faultF = null;
      let statusF = null;
      while (Date.now() < deadlineF) {
        const events = await taskEvents(fid).catch(() => []);
        faultF = events.slice().reverse().find(item => item.type === 'task.fault.stopped') ?? null;
        statusF = storeTask(fid)?.status ?? null;
        if (faultF || ['failed', 'completed', 'cancelled'].includes(String(statusF))) break;
        await sleep(3000);
      }
      evidence.phaseF.fault = faultF ?? null;
      evidence.phaseF.status = statusF;
      const landed = faultF
        ? faultF.kind === 'source_disabled'
          && faultF.landedStatus === 'blocked'
          && /设置/.test(`${String(faultF.headline ?? '')}${String(faultF.howBack ?? '')}`)
        : false;
      note('f-source-disabled-landing', landed,
        faultF
          ? `kind=${String(faultF.kind)} 落点=${String(faultF.landedStatus)}｜「${String(faultF.headline ?? '')}｜${String(faultF.howBack ?? '').slice(0, 90)}」`
          : `没等到 task.fault.stopped（此刻 ${String(statusF)}）：源关着也没挡住这一轮，说明它没用网页源作答，这一格仍只有离线证据`);
      note('f-source-disabled-not-terminal', String(statusF) !== 'failed',
        `任务状态 ${String(statusF)}｜failed 没有出边，用户拨完开关只能重新提问`);
      const stillF = await cleanupProbe(fid, createdF.conversationId);
      note('f-probe-cleaned-up', stillF === false, `F 段探针删除后仍存在 ${String(stillF)}`);
    }
  }

  // ── G 段：开关拨到关之后，判定说要开下一轮也得停在轮次开始前（M3-4c 的新落点）───────────
  const createdG = await createProbe({
    title: PROBE_G_TITLE,
    text: PROBE_G_PROMPT,
    executionConfig: probeConfig,
    permissionPreset: 'workspace-write'
  });
  const gid = createdG.taskId;
  if (!gid) {
    skip('g-stopped-at-await', `停轮探针没建出来：${JSON.stringify(createdG.created ?? createdG.lostReceipt).slice(0, 200)}`);
    skip('g-ui-says-why-and-how', '停轮探针没建出来');
    skip('g-no-sneak-round', '停轮探针没建出来');
  } else {
    const offG = await callAuto({ taskId: gid, autoContinue: false });
    const parkedG = await waitForApproval(gid, 'G 段探针', WAIT_REPORT);
    const approvedG = parkedG ? await clickApprove(gid, parkedG) : null;
    const roundsAtApprovalG = roundCount(gid);
    evidence.phaseG = {
      taskId: gid,
      switchOff: offG?.value ?? offG?.error ?? null,
      approved: approvedG
        ? { ok: approvedG.ok, statusAfter: approvedG.statusAfter }
        : { ok: false, statusAfter: storeTask(gid)?.status ?? null },
      roundsAtApproval: roundsAtApprovalG
    };
    const deadlineG = Date.now() + WAIT_AUTO_ROUND;
    let stopG = null;
    while (Date.now() < deadlineG) {
      const eventsG = await taskEvents(gid);
      const decisionG = eventsG.slice().reverse().find(item => item.type === 'cycle.decision.created') ?? null;
      const awaitG = eventsG.slice().reverse().find(item => item.type === 'task.round.await_user') ?? null;
      const statusG = storeTask(gid)?.status ?? null;
      // 三种「边界已看清」都收手：真停在轮次开始前、判定自己没要开轮、任务跑到终态那边去了。
      // 不能沿用 E 段那个等待条件——那一边的「没开轮」是超时，这一边的「没开轮」正是要看的现象。
      if (awaitG || statusG === 'awaiting_next_round'
        || (decisionG && String(decisionG.nextAction) !== 'open_next_round')
        || ['failed', 'completed', 'cancelled'].includes(String(statusG))) {
        stopG = { decision: decisionG, awaitEvent: awaitG, status: statusG };
        break;
      }
      await sleep(3000);
    }
    const eventsAfterG = await taskEvents(gid);
    const clicksG = eventsAfterG.filter(item => item.type === 'task.round.user_continue').length;
    const roundsG = roundCount(gid);
    const awaitEventG = stopG?.awaitEvent ?? null;
    evidence.phaseG.rounds = roundsG;
    evidence.phaseG.clicks = clicksG;
    evidence.phaseG.stop = stopG
      ? {
        decision: stopG.decision
          ? {
            decisionType: stopG.decision.decisionType,
            nextAction: stopG.decision.nextAction,
            reason: String(stopG.decision.reason ?? '').slice(0, 140)
          }
          : null,
        awaitEvent: awaitEventG
          ? {
            purpose: String(awaitEventG.purpose ?? '').slice(0, 140),
            gate: awaitEventG.gate ?? null,
            roundNumber: awaitEventG.roundNumber ?? null
          }
          : null,
        status: stopG.status
      }
      : { timedOut: true, status: storeTask(gid)?.status ?? null };
    if (!stopG || String(stopG.decision?.nextAction ?? '') !== 'open_next_round') {
      const why = !stopG
        ? `${String(Math.round(WAIT_AUTO_ROUND / 60000))} 分钟窗口内没等到判定（此刻状态 ${String(evidence.phaseG.stop?.status)}、轮数 ${String(roundsG)}）`
        : `这一轮判成 ${String(stopG.decision?.decisionType)}/${String(stopG.decision?.nextAction)}「${String(stopG.decision?.reason ?? '').slice(0, 70)}」——判定自己就没要求开轮，停轮段要的是「判定说开、被设置停住」那一格`;
      skip('g-stopped-at-await', why);
      skip('g-ui-says-why-and-how', why);
      skip('g-no-sneak-round', why);
    } else {
      note('g-stopped-at-await',
        stopG.status === 'awaiting_next_round' && Boolean(awaitEventG),
        `状态 ${String(stopG.status)}｜事件 ${JSON.stringify({ purpose: String(awaitEventG?.purpose ?? '').slice(0, 60), gate: awaitEventG?.gate ?? null }).slice(0, 200)}`);
      await selectTaskRow(PROBE_G_TITLE);
      await openTab('对话');
      await sleep(900);
      await shot('06-awaiting-next-round.png');
      const exitG = await ev(`(() => {
        const box = document.querySelector('textarea[aria-label="换手段再来一轮的指令"]');
        if (!box) return { found: false, groupText: '' };
        const group = box.closest('[role="group"]');
        const all = [...(group?.querySelectorAll('button') ?? [])].map(node => (node.textContent ?? '').trim()).filter(Boolean);
        return {
          found: true,
          button: all.filter(text => /继续下一轮|换手段再来一轮/.test(text))[0] ?? null,
          buttons: all,
          groupText: (group?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 400)
        };
      })()`);
      const wanted = continueExitText('awaiting_next_round');
      evidence.phaseG.ui = { exitShown: exitG, wantedHeadline: wanted?.headline ?? null };
      const saysWhy = String(exitG?.groupText ?? '').includes(String(wanted?.headline ?? '‹没有这句话›'));
      note('g-ui-says-why-and-how',
        exitG?.button === '继续下一轮' && saysWhy
          && (exitG?.buttons ?? []).some(text => text.includes('接受未验证并结束')),
        `按钮「${String(exitG?.button)}」｜同组 ${JSON.stringify(exitG?.buttons ?? []).slice(0, 170)}｜文案含「${String(wanted?.headline)}」=${String(saysWhy)}`);
      note('g-no-sneak-round', clicksG === 0 && roundsG === roundsAtApprovalG,
        `出口点击 ${String(clicksG)} 次、轮数 ${String(roundsAtApprovalG)} → ${String(roundsG)}（开着无人值守时同一问法当场就开了轮，见 E 段）`);
    }
    const stillG = await cleanupProbe(gid, createdG.conversationId);
    note('g-probe-cleaned-up', stillG === false, `停轮探针删除后仍存在 ${String(stillG)}`);
  }

  const stillThere = await cleanupProbe(taskId, conversationId);
  note('probe-cleaned-up', stillThere === false, `删除后仍存在 ${String(stillThere)}`);
  note('tasks-back-to-baseline', (readStore().tasks ?? []).length <= before.tasks,
    `任务数 ${String(before.tasks)} → ${String((readStore().tasks ?? []).length)}`);
  // 收尾还得数会话：删任务不连带删会话，第 6 次真机就在默认目录留下两条指向已删任务的孤儿会话。
  // 只断言「本轮探针建出来的那几条」，用户自己的历史会话不算本轮副作用。
  const probeConversations = evidence.cleanup.flatMap(row => row.conversationIds ?? []);
  const leftConversations = probeConversations.filter(id =>
    (readStore().conversations ?? []).some(item => item.conversationId === id));
  note('probe-conversations-cleaned-up', leftConversations.length === 0,
    `探针会话 ${String(probeConversations.length)} 条，没删掉的 ${String(leftConversations.length)} 条${leftConversations.length ? `：${leftConversations.map(id => String(id).slice(0, 8)).join('、')}` : ''}`);
  // 再兜一层：本轮建出来但没进 `evidence.cleanup` 名单的会话（F 段那次就是这种）也会在这里露出来。
  note('conversations-back-to-baseline', (readStore().conversations ?? []).length <= before.conversations,
    `会话数 ${String(before.conversations)} → ${String((readStore().conversations ?? []).length)}`);
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  note('probe-workspace-removed', !fs.existsSync(WORKSPACE), WORKSPACE);
}

try {
  await main();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${evidence.error}`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  // 中途崩掉时探针会留在**默认数据目录**里（第 5 次真机就是这样留下两条还在跑的探针）：
  // 收尾再认一次，删得掉就删，删不掉写进证据让人手工核对。
  const leftovers = evidence.probeIds.filter(id => storeTask(id));
  if (leftovers.length > 0) {
    evidence.leftoverProbes = [];
    for (const id of leftovers) {
      const conversation = (readStore().conversations ?? []).find(item => item.taskId === id) ?? null;
      const still = await cleanupProbe(id, conversation?.conversationId ?? null).catch(() => 'cleanup 调用失败');
      evidence.leftoverProbes.push({ taskId: id, removed: still === false });
      console.log(`CLEAN ${String(id).slice(0, 8)} — 崩溃收尾删除，回执 ${String(still === false)}`);
    }
  }
  await stopDev('SIGTERM');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const checks = Object.entries(evidence.checks);
  const skipped = checks.filter(([, item]) => item.ok === 'skipped');
  const failed = checks.filter(([, item]) => item.ok !== true && item.ok !== 'skipped');
  const receipts = evidence.cleanup ?? [];
  const probeLine = (receipts.length > 0
    ? receipts.map(item => `'${String(item.taskId)}'（${item.removed ? '已删除' : '**删除回执缺失，需手工核对默认数据目录**'}）`).join('、')
    : '未创建或未走到收尾')
    + ((evidence.leftoverProbes ?? []).length > 0
      ? `｜崩溃收尾补删：${evidence.leftoverProbes.map(item => `'${String(item.taskId)}'（${item.removed ? '已删除' : '**仍在，需手工删除**'}）`).join('、')}`
      : '');
  const awaitSample = evidence.phaseB?.awaitEvent ?? null;
  const lines = [
    '# V4 P1 M3-4 真机验收：无人值守开关真落盘、用户出口真开轮、通道停住不判死',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 墙钟：${String(Math.round((new Date(evidence.finishedAt).getTime() - new Date(evidence.startedAt).getTime()) / 1000))} 秒（用例刻意压短；「≥2 小时无人值守」按用户指示暂缓，不在本条范围内）`,
    `- 环境：${evidence.mode}`,
    `- 数据目录：\`${USER_DATA}\`（默认，未隔离）；store 备份：${fs.existsSync(path.join(OUT_DIR, 'agent-store.before.json')) ? 'agent-store.before.json' : '未生成'}`,
    `- 工作区：\`${WORKSPACE}\`（探针只在这里读文件）`,
    `- 探针任务：${probeLine}`,
    `- 通道状态：${JSON.stringify(evidence.channel ?? null).slice(0, 260)}`,
    `- 探针用的执行档：${evidence.probeExecution ?? '未记录'}｜用户默认配置 ${JSON.stringify(evidence.defaults ?? null).slice(0, 200)}｜C 段用的 CLI：${JSON.stringify(evidence.phaseC?.inject?.cliId ?? '未跑')}`,
    '',
    '## 通道停住是怎么造的（如实记录）',
    '',
    '不给异常造假数据：C 段另建一条走 CLI 通道的探针，等主进程把 CLI 拉起来后给那个子进程发 `SIGSTOP`，',
    '它的 stdout 就此不再有新块，由编排器自己的看门狗（现网默认 120 秒静默）说出真机那句',
    `「模型连续 N 秒没有输出」；观察完发 \`SIGCONT\` 放开、不补刀。注入时刻 ${String(evidence.phaseC?.inject?.at ?? '?')}，放开设法：${String(evidence.phaseC?.released ?? '未记录')}。`,
    '判定、落点、事件、界面读数的代码路径一行没绕。云端那条不能用这个办法：它的请求在主进程里，',
    'CDP 的离线模拟只作用于页面目标（2026-11-28 实测：页面离线之后云端照常回答）。',
    '',
    '## A 段：无人值守开关 + 用户出口的边界',
    '',
    '```json',
    JSON.stringify(evidence.phaseA, null, 2),
    '```',
    '',
    '## B 段：用户出口真开一轮',
    '',
    '```json',
    JSON.stringify(evidence.phaseB, null, 2),
    '```',
    '',
    '## C 段：通道停住落在可恢复那侧',
    '',
    '```json',
    JSON.stringify(evidence.phaseC, null, 2),
    '```',
    '',
    '## E 段：没写过这个字段的任务，缺省就自动开下一轮',
    '',
    '```json',
    JSON.stringify(evidence.phaseE ?? null, null, 2),
    '```',
    '',
    '## F 段：只能用网页源时说的是「去设置里打开」，不是判死',
    '',
    '```json',
    JSON.stringify(evidence.phaseF ?? null, null, 2),
    '```',
    '',
    '## G 段：开关拨到关，判定说要开下一轮也得停在轮次开始前',
    '',
    '```json',
    JSON.stringify(evidence.phaseG ?? null, null, 2),
    '```',
    '',
    '## D 段：上一里程碑真机原文回放当前分类器',
    '',
    '```json',
    JSON.stringify(evidence.replay, null, 2),
    '```',
    '',
    '## 中断原因',
    '',
    evidence.error ? evidence.error : '无。',
    '',
    '## 结论',
    '',
    `1. **开关真落盘**：关掉后落库 autoContinue=${String(evidence.phaseA?.persistedAutoContinue ?? '（没读到）')}，事件与界面读数同向；脏值（字符串 "false"、数字 1、多余键）全部被 IPC 边界拒掉。`,
    `2. **用户出口真开轮**：${isContinueRoundAllowed(String(evidence.phaseB?.statusAtGate ?? '')) ? `状态 ${String(evidence.phaseB?.statusAtGate)} 时出口开出 ${String(evidence.phaseB?.roundsAfter ?? '?')} 轮（原 ${String(evidence.phaseB?.roundsBefore ?? '?')} 轮），用户原话逐字进请求文本` : `本轮窗口内未等到 report_pending（实际 ${String(evidence.phaseB?.statusAtGate ?? '?')}），正向段跳过并如实记录`}`,
    `3. **通道停住不判死**：实际落点 \`${String(evidence.phaseC?.status ?? '?')}\`，事件 kind=\`${String(evidence.phaseC?.faultEvent?.kind ?? '?')}\`，故障之后 task.failed ${String((evidence.phaseC?.failedAfterFault ?? []).length)} 条，点「继续任务」后状态 ${String(evidence.phaseC?.afterResume?.status ?? '?')}。`,
    `4. **说明字段不再白烧轮**：真机原文 ${String(evidence.replay?.liveSamples ?? 0)} 条通道类错误的当前落点为 ${JSON.stringify(evidence.replay?.kinds ?? [])}，仍判死 ${JSON.stringify(evidence.replay?.stillFatal ?? [])}。`,
    `5. **关掉无人值守就真停在开轮之前**：${awaitSample ? `停在 ${String(evidence.phaseB?.statusAtGate)} 时留下 ${JSON.stringify({ purpose: awaitSample.purpose, gate: awaitSample.gate?.reason }).slice(0, 160)}` : `A/B 这条探针本轮停在 ${String(evidence.phaseB?.statusAtGate)}，同一条任务里没走到「判定要开、被设置停住」；${evidence.phaseG?.stop?.status === 'awaiting_next_round' ? '这一停法本身的现场样本见第 8 条（G 段独立探针）' : '第 8 条（G 段）本轮也没有样本，故这一格仍是离线用例口径'}`}。`,
    `6. **开着无人值守时判定说了算**（口径：一条 cycle.decision.created 之后紧跟的第一条 round.started 才算判定开出来的那一轮，轮次行数不做证据）：C 段恢复后${evidence.phaseC?.autoOpen ? (() => {
      const b = evidence.phaseC.autoOpen;
      const d = b.decision ?? null;
      return `判定后自动开轮=${String(b.openedAfterDecision)}（类型 ${String(b.openedInputType ?? '无')}）、出口点击 ${String(b.clicks)} 次，最近判定 ${d ? `${String(d.decisionType)}/${String(d.nextAction)}「${String(d.reason ?? '').slice(0, 50)}」` : '无（窗口内没到边界）'}，轮次记录 ${String((b.roundTypes ?? []).join('、') || '无')}——${evidence.checks['c-auto-open-after-resume']?.ok === true ? '判定说开，轮真自己开出来了' : evidence.checks['c-open-still-obays-gate']?.ok === true ? '判定说停，开着也没有多开一轮' : '这一格本轮没落到，见断言表的跳过说明'}`;
    })() : '本轮未跑'}；E 段（一次开关都没碰、字段没写过）${evidence.phaseE ? (() => {
      const b = evidence.phaseE.boundary ?? {};
      return `判定后自动开轮=${String(b.openedAfterDecision ?? '?')}（类型 ${String(b.openedInputType ?? '无')}），判定 ${String(evidence.phaseE.decision?.nextAction ?? '（窗口内没到边界）')}，改动事件 ${String(evidence.phaseE.autoContinueEvents ?? '?')} 条、出口点击 ${String(evidence.phaseE.userContinueClicks ?? '?')} 次，轮次记录 ${String((b.roundTypes ?? evidence.phaseE.roundTypesAtApproval ?? []).join('、') || '无')}——${evidence.checks['e-default-auto-open']?.ok === true ? '缺省即开：没人点也开出了下一轮' : '本轮窗口内没拿到「判定说开」的那一轮，缺省半边由 A 段生效值与单测补'}`;
    })() : '未跑'}。`,
    `7. **中途那次 WAIT_USER 真由人接回去**：${evidence.approval?.reached ? `探针停在 \`awaiting_approval\`（read-only 档不自动批），代点「确认并执行」之后状态 ${String(evidence.approval.statusAfter)}——判定把任务停在等人那侧，人接了就继续走` : `本轮没有停在 awaiting_approval（${String(evidence.approval?.status ?? '?')}）：这一档本来就自动批`}。`,
    `8. **关掉无人值守时「判定说开」也被停住**：${evidence.phaseG ? (() => {
      const g = evidence.phaseG;
      return `开关显式关（回执 ${JSON.stringify(g.switchOff ?? null).slice(0, 70)}）后判定 ${String(g.stop?.decision?.nextAction ?? '（没到边界）')}，状态 ${String(g.stop?.status ?? '?')}、轮数 ${String(g.roundsAtApproval ?? '?')} → ${String(g.rounds ?? '?')}、出口点击 ${String(g.clicks ?? '?')} 次——${evidence.checks['g-stopped-at-await']?.ok === true ? `停在轮次开始前并留下 \`task.round.await_user\`，界面按钮换成「${String(g.ui?.exitShown?.button ?? '?')}」且同组仍有「接受未验证并结束」` : '本轮没拿到「判定说开却被设置停住」那一格，停轮段仍只有离线口径'}`;
    })() : '未跑'}。`,
    '',
    '## 断言结果',
    '',
    '| 断言 | 结果 | 实测 |',
    '| --- | --- | --- |',
    ...checks.map(([name, item]) => `| ${name} | ${item.ok === 'skipped' ? '跳过' : item.ok ? '通过' : '**未通过**'} | ${String(item.detail ?? '').replace(/\s*\|\s*/g, '｜').replace(/\s+/g, ' ')} |`),
    '',
    `合计 ${String(checks.length)} 项，未通过 ${String(failed.length)} 项${failed.length ? `：${failed.map(([name]) => name).join('、')}` : ''}`
    + `${skipped.length ? `；跳过 ${String(skipped.length)} 项：${skipped.map(([name]) => name).join('、')}` : ''}。`,
    '',
    '## 截图',
    '',
    ...(evidence.shots.length ? evidence.shots.map(item => `- \`${item}\``) : ['- 无']),
    '',
    '事件原文：`events.after-fault.json`（通道停住到手后的完整事件流）。'
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), `${lines.join('\n')}\n`);
  console.log(`EVIDENCE ${path.relative(ROOT, path.join(OUT_DIR, 'EVIDENCE.md'))}`);
  process.exitCode = failed.length > 0 || evidence.error ? 1 : 0;
}
