/**
 * V4 P1 M3-3 真机验收：预算超限真的能停、说得清、加得回去、加完真接回循环。
 *
 * 原来错在哪（离线用例 scripts/check-task-budget.mjs 已逐条锁住）：轮数上限在编排器里算了三遍、
 * token 形参没人传值、超限落点 `fail_budget` 把任务标成终态 `failed`——状态表里
 * 「`budget_exhausted` 可恢复」那条边一直是死代码，用户加完预算也接不回去。
 *
 * 真机这一段只证离线证不到的事：
 * 1) IPC 边界真在拦脏值（0 / 缺维度 / 字符串），不是主进程里 if 一下；
 * 2) 追加的预算**落盘**（重启后读回来还是那个数），并留下 `task.budget.updated` 事件；
 * 3) 「只增不减」在现网数据上成立（手滑填小不会把在跑的额度缩掉）；
 * 4) 超限真的把任务停进 `budget_exhausted`（不是 `failed`），停手有事件、活动流说得清原因、
 *    统计页能操作；
 * 5) 追加预算后门禁放行并且**接回了循环**（状态离开 budget_exhausted、后续有新轮）。
 *
 * 超限前置条件怎么造的（如实记录，不假装自然跑到 20 轮）：预算按设计只增不减，现网也不会在
 * 几分钟内跑满默认 20 轮，所以 A 段跑出一个真轮次后停进程，把这条**探针任务自己的**落库记录
 * 的 `budget.maxRounds` 改成已用轮数（等价于「老任务带着小上限被恢复」这条真实形态），再重启走
 * 常规 `task:resume`。改的是探针记录、动盘前先备份、跑完删探针并把任务数核回基线；
 * 判定、落点、事件、界面读数的代码路径一行没绕。
 *
 * 默认数据目录（AGENTS.md §10.2）：不设 `THINKFUSION_USER_DATA`、不加 `--user-data-dir`。
 * 阈值与轮数不在这里配：触发轮数由 `npm run test:task-budget` 按默认值覆盖。
 *
 * Run: npm run test:budget:live
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';
// 判据用产品同一份口径：超限维度、门禁理由、中文说法都不在脚本里重抄。
import {
  BUDGET_DIMENSION_TEXT,
  DEFAULT_TASK_BUDGET,
  budgetStateOf,
  canOpenRound,
  extendTaskBudget,
  normalizeTaskBudget
} from '../out-test/shared/task-budget.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m3-3-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKSPACE = path.join(os.tmpdir(), `tf-m3-3-ws-${String(Date.now())}`);
/** 一轮开了就有 round.started；这里等的是「记账有数」，不是等模型答完。 */
const WAIT_ROUND = 6 * 60 * 1000;
/** resume 里要做上下文恢复与版本链核对，给足但不下满：真机实测这一段在 60 秒内落地。 */
const WAIT_RESUME = 150_000;
const SETTLE = 8_000;
const PROBE_TITLE = 'M3-3 预算探针';
const PROBE_PROMPT = `${PROBE_TITLE}：只读列出工作区根目录下的文件名，把文件名列表写进结论即可，不要改任何文件。`;

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333 / A 段跑出一个真轮次，停进程改探针落库预算后重启走常规 resume',
  workspace: WORKSPACE,
  store: STORE,
  defaults: DEFAULT_TASK_BUDGET,
  checks: {},
  shots: [],
  backups: null,
  before: null,
  phaseA: {},
  phaseB: {},
  cleanup: [],
  error: null
};
let child = null;
let cdp = null;

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean);
  } catch { return []; }
}

function readStore() {
  if (!fs.existsSync(STORE)) return { tasks: [], rounds: [], events: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

function storeTask(taskId) {
  try { return (readStore().tasks ?? []).find(task => task.taskId === taskId) ?? null; } catch { return null; }
}

function roundCount(taskId) {
  try { return (readStore().rounds ?? []).filter(round => round.taskId === taskId).length; } catch { return 0; }
}

async function waitForPortFree(deadline) {
  while (Date.now() < deadline) {
    if (listenersOn(PORT).length === 0) return true;
    await sleep(400);
  }
  return false;
}

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
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (build) {
    execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
  }
  const log = fs.openSync(LOG, 'a');
  const env = { ...process.env };
  // 默认数据目录：任何隔离用的环境变量都要摘掉（AGENTS.md §10.2）。
  delete env.THINKFUSION_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log]
  });
  child.unref();
}

async function stopDev(signal) {
  if (cdp) { try { cdp.close(); } catch { /* 已断开 */ } cdp = null; }
  if (!child?.pid) { await waitForPortFree(Date.now() + 20000); return; }
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
  await waitForPortFree(Date.now() + 25000);
}

async function connectRenderer() {
  const deadline = Date.now() + 300000;
  let lastIssue = '没有匹配的 page 目标';
  while (Date.now() < deadline) {
    let targets = [];
    try { targets = await (await fetch(ENDPOINT)).json(); } catch { await sleep(1000); continue; }
    const candidates = targets.filter(item => item.type === 'page'
      && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
    if (candidates.length === 0) lastIssue = `目标里没有渲染页：${targets.map(item => item.type).join(',') || '空'}`;
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
  await sleep(1000);
  return true;
}

const taskEvents = id => ev(`window.agentAPI.getTaskEvents(${JSON.stringify(id)})`, 90000) ?? [];

/** 预算卡正文：卡片是 <section>，但只在「统计」页挂载，切页与读取要同一次会话里做。 */
async function budgetCard() {
  if (!(await openTab('统计'))) return { tabMissing: true };
  await sleep(600);
  return ev(`(() => {
    const card = [...document.querySelectorAll('.task-stats .card')].find(node =>
      (node.querySelector('h2')?.textContent ?? '').trim() === '预算');
    if (!card) return null;
    card.scrollIntoView({ block: 'center' });
    const rows = [...card.querySelectorAll('.stats-grid > div')].map(node =>
      (node.innerText ?? '').replace(/\\s+/g, ' ').trim());
    const input = card.querySelector('input[type="number"]');
    const button = [...card.querySelectorAll('button')].find(node => node.textContent.includes('追加并继续'));
    return {
      text: (card.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      head: (card.querySelector('.muted')?.textContent ?? '').trim(),
      rows,
      hasInput: Boolean(input),
      hasButton: Boolean(button),
      buttonDisabled: button ? Boolean(button.disabled) : null
    };
  })()`);
}

/** 活动流里那条停手旁注。 */
async function budgetNote() {
  if (!(await openTab('对话'))) return { tabMissing: true };
  await sleep(600);
  return ev(`(() => {
    const notes = [...document.querySelectorAll('.chat-note-text, .chat-note, [class*="note"]')]
      .map(node => (node.innerText ?? '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    // 「怎么回来」写在折叠详情里（<details> 收起时 innerText 读不到），只能取 textContent。
    const folded = [...document.querySelectorAll('.chat-note-detail')]
      .map(node => (node.textContent ?? '').replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
    const all = notes.concat(folded);
    const budgetish = all.filter(text => text.includes('预算'));
    // 停手那条要排在最前：它是这条断言的证据本体，别让「预算已更新」把采样位占满。
    const pausedHits = budgetish.filter(text => text.includes('预算用尽，任务已暂停'));
    return {
      hit: pausedHits.concat(budgetish.filter(text => !text.includes('预算用尽，任务已暂停'))).slice(0, 6),
      paused: pausedHits.length > 0,
      pausedText: pausedHits[0] ?? null,
      howBack: all.some(text => text.includes('追加预算后可继续'))
    };
  })()`);
}

/**
 * IPC 调用的原始回执：脏值必须被拒，而且要说清是被边界拒的（schema 报的字段名），
 * 不是主进程悄悄吞掉。
 */
async function callSetBudget(input) {
  return ev(`window.agentAPI.setTaskBudget(${JSON.stringify(input)}).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: String(error && error.message ? error.message : error) })
  )`, 60000);
}

/** 超限暂停与接回循环都要「点火 + 轮询」：resume 会在主进程里跑完一整轮，awaitPromise 会挂死 CDP。 */
async function fire(expression, mark) {
  await ev(`(() => {
    window.__m33${mark} = 'pending';
    ${expression}
      .then(value => { window.__m33${mark} = { ok: true, value }; })
      .catch(error => { window.__m33${mark} = { ok: false, error: String(error && error.message ? error.message : error) }; });
    return 'fired';
  })()`, 30000);
}

const firedState = mark => ev(`(() => {
  const raw = window.__m33${mark};
  return typeof raw === 'string' ? { state: raw } : { state: 'settled', ...raw };
})()`, 15000);

function writeJson(name, value) {
  fs.writeFileSync(path.join(OUT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
  return name;
}

async function cleanupProbe(taskId, conversationId) {
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  await sleep(2000);
  await ev(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  if (conversationId) await ev(`window.agentAPI.deleteConversation(${JSON.stringify(conversationId)})`, 30000).catch(() => null);
  await sleep(1500);
  const stillThere = (readStore().tasks ?? []).some(task => task.taskId === taskId);
  evidence.cleanup.push({ taskId, conversationId: conversationId ?? null, removed: !stillThere });
  return stillThere;
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'marker.txt'), 'm3-3-budget-probe\n');

  const storeBackup = path.join(OUT_DIR, 'agent-store.before.json');
  if (fs.existsSync(STORE)) fs.copyFileSync(STORE, storeBackup);
  evidence.backups = { store: fs.existsSync(storeBackup) ? path.relative(OUT_DIR, storeBackup) : 'store 还不存在，无需备份' };
  const stale = (readStore().tasks ?? [])
    .filter(task => String(task.userPrompt ?? task.title ?? '').includes(PROBE_TITLE))
    .map(task => task.taskId);
  evidence.before = { tasks: (readStore().tasks ?? []).length, staleProbes: stale };

  await startDev(true);
  cdp = await connectRenderer();
  evidence.rendererReadyAt = new Date().toISOString();
  for (const id of stale) await ev(`window.agentAPI.deleteTask(${JSON.stringify(id)})`, 30000).catch(() => null);

  // ── A 段：IPC 边界、落盘、只增不减、界面读数 ─────────────────────────────
  const defaults = await ev('window.agentAPI.getExecutionDefaults()');
  const created = await ev(`window.agentAPI.submitConversation(${JSON.stringify({
    text: PROBE_PROMPT,
    permissionPreset: 'read-only',
    workspaceRoot: WORKSPACE,
    workspaceMode: 'engineering',
    executionConfig: defaults,
    taskKindOverride: 'execution'
  })})`, 90000);
  const taskId = created?.taskId ?? created?.task?.taskId;
  const conversationId = created?.conversationId ?? null;
  assert.ok(taskId, `探针任务没创建出来：${JSON.stringify(created)}`);
  evidence.phaseA.taskId = taskId;
  evidence.phaseA.conversationId = conversationId;
  note('a-probe-created', true, `task=${String(taskId).slice(0, 8)} conv=${String(conversationId).slice(0, 8)}`);

  // 预算从建立那天就落盘：这条是「单点记账有持久化」的正面证据（老任务读不到才回落默认）。
  const born = await waitFor(async () => {
    const stored = storeTask(taskId);
    return stored?.budget ? stored : null;
  }, '探针任务落库带上 budget 字段', 60000).catch(() => storeTask(taskId));
  note('a-budget-persisted-on-create',
    Number(born?.budget?.maxRounds) === DEFAULT_TASK_BUDGET.maxRounds && Number(born?.maxRounds) === DEFAULT_TASK_BUDGET.maxRounds,
    `落库 budget=${JSON.stringify(born?.budget ?? null)}，显示别名 maxRounds=${String(born?.maxRounds)}`);

  await waitFor(async () => (roundCount(taskId) >= 1 ? true : null), '探针开出第 1 轮（记账要有真数）', WAIT_ROUND);
  const roundsAfterOpen = roundCount(taskId);
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  // 轮数必须冻住：门禁理由里的「轮数 N/M」要能和脚本用同一批纯函数反算的结果逐字对上，
  // 一边在涨一边比字符串只会得到假失败。取消落到终态就不再开轮了。
  const settled = await waitFor(async () => {
    const status = String(storeTask(taskId)?.status ?? '');
    return ['cancelled', 'failed', 'completed'].includes(status) ? status : null;
  }, '探针取消后落到终态（轮数冻住）', 150_000).catch(() => storeTask(taskId)?.status ?? null);
  note('a-probe-cancelled', ['cancelled', 'failed', 'completed'].includes(String(settled)),
    `状态 ${String(settled)}｜轮数 ${String(roundsAfterOpen)} → ${String(roundCount(taskId))}`);
  note('a-round-counted', roundsAfterOpen >= 1, `store.rounds 里这条任务有 ${String(roundsAfterOpen)} 轮`);

  const rejected = [];
  for (const bad of [
    { input: { taskId, maxRounds: 0 }, why: '脏值 0 会被读成「一开局就超限」' },
    { input: { taskId, maxRounds: -2 }, why: '负数同上' },
    { input: { taskId, maxRounds: 1.5 }, why: '小数轮数没有意义' },
    { input: { taskId, maxRounds: '12' }, why: '字符串轮数不能被当成数字' },
    { input: { taskId }, why: '一条维度都不指，改的是什么说不清' },
    { input: { taskId, maxRounds: 3, nonsense: 1 }, why: '多余键必须拒绝（strict），不能悄悄吞掉用户以为写了的字段' }
  ]) {
    const out = await callSetBudget(bad.input);
    rejected.push({ input: bad.input, why: bad.why, ...out });
    note(`a-dirty-rejected:${JSON.stringify(bad.input)}`,
      out.ok === false && /maxRounds|至少指出一条|Unrecognized|Received type/i.test(String(out.error ?? '')),
      out.ok ? `竟然通过了：${JSON.stringify(out.value).slice(0, 120)}` : `边界拒了：${String(out.error).slice(0, 160)}｜理由 ${bad.why}`);
  }
  evidence.phaseA.rejected = rejected;

  const raised = DEFAULT_TASK_BUDGET.maxRounds + 5;
  const first = await callSetBudget({ taskId, maxRounds: raised });
  const persisted = storeTask(taskId);
  const updatedEvents = (await taskEvents(taskId)).filter(item => item.type === 'task.budget.updated');
  const lastUpdated = updatedEvents.slice(-1)[0] ?? null;
  const expectGate = canOpenRound({
    budget: { maxRounds: raised },
    usage: { rounds: roundCount(taskId), modelCalls: null, tokens: null }
  });
  note('a-append-accepted', first.ok === true && first.value?.budget?.maxRounds === raised,
    `回执 ${JSON.stringify(first.value ?? first.error).slice(0, 220)}`);
  note('a-append-persisted',
    Number(persisted?.budget?.maxRounds) === raised && Number(persisted?.maxRounds) === raised,
    `重启后要读回来的那份：budget.maxRounds=${String(persisted?.budget?.maxRounds)}，别名 maxRounds=${String(persisted?.maxRounds)}`);
  note('a-append-emitted',
    updatedEvents.length === 1 && lastUpdated?.budget?.maxRounds === raised
      && lastUpdated?.previous?.maxRounds === DEFAULT_TASK_BUDGET.maxRounds
      && lastUpdated?.source === 'user' && lastUpdated?.gate?.ok === expectGate.ok
      && lastUpdated?.gate?.reason === expectGate.reason,
    `事件 ${String(updatedEvents.length)} 条｜previous=${JSON.stringify(lastUpdated?.previous ?? null)} gate=${JSON.stringify(lastUpdated?.gate ?? null)}`
    + `｜同口径反算 gate=${JSON.stringify(expectGate)}`);

  const shrunk = await callSetBudget({ taskId, maxRounds: 1 });
  const afterShrink = storeTask(taskId);
  const expectUnchanged = extendTaskBudget({ maxRounds: raised }, { maxRounds: 1 });
  note('a-shrink-refused',
    shrunk.ok === true && Number(shrunk.value?.budget?.maxRounds) === raised
      && Number(afterShrink?.budget?.maxRounds) === Number(expectUnchanged.maxRounds),
    `填小后回执 maxRounds=${String(shrunk.value?.budget?.maxRounds)}，落库=${String(afterShrink?.budget?.maxRounds)}`
    + `｜同口径反算应为 ${String(expectUnchanged.maxRounds)}（只增不减，原值仍可读）`);
  // 门禁仍放行不能靠猜：拿同一批纯函数反算，超限维度必须为空。
  const stateAfter = budgetStateOf({
    budget: normalizeTaskBudget(afterShrink?.budget ?? null),
    usage: { rounds: roundCount(taskId), modelCalls: null, tokens: null }
  });
  note('a-unknown-dimensions-honest',
    stateAfter.unknowns.length === 0 && stateAfter.tokenAccounting === 'unknown'
      && shrunk.value?.state?.usage?.modelCalls === null && shrunk.value?.state?.usage?.tokens === null,
    `主进程读数 usage=${JSON.stringify(shrunk.value?.state?.usage ?? null)} limits=${JSON.stringify(shrunk.value?.state?.limits ?? null)}`
    + `｜反算 unknowns=${JSON.stringify(stateAfter.unknowns)} tokenAccounting=${stateAfter.tokenAccounting}`);

  note('ui-shows-probe', await selectTaskRow(PROBE_TITLE, taskId), '侧栏选中探针');
  const cardA = await budgetCard();
  evidence.phaseA.card = cardA;
  note('ui-budget-card-visible',
    Boolean(cardA) && cardA.rows.some(row => row.includes('轮数') && row.includes(String(raised)))
      && cardA.rows.some(row => row.includes('模型调用') && row.includes('未设限'))
      && cardA.rows.some(row => row.includes('Token') && row.includes('未设限')),
    `默认预算只给轮数设限，另两条没写上限就该读「未设限」（不是 0、也不是未记账）｜${JSON.stringify(cardA?.rows ?? cardA ?? '没有预算卡').slice(0, 240)}`);
  note('ui-no-exhaust-control-before-pause',
    cardA?.hasInput !== true && cardA?.hasButton !== true,
    `还没停过手就不该给「追加并继续」：input=${String(cardA?.hasInput)} button=${String(cardA?.hasButton)}`);

  // 「记不了账」这条分支要真被走到：给模型调用设个上限，界面上只能出现「未记账」，
  // 门禁也不能因为读不到数就判超限（写成 0 是假话，判死是误停）。
  const withCalls = await callSetBudget({ taskId, maxRounds: raised, maxModelCalls: 40 });
  const expectUnknown = budgetStateOf({
    budget: { maxRounds: raised, maxModelCalls: 40 },
    usage: { rounds: roundCount(taskId), modelCalls: null, tokens: null }
  });
  const cardA2 = await waitFor(async () => {
    const snapshot = await budgetCard();
    return snapshot?.rows?.some(row => row.includes('模型调用') && row.includes('未记账')) ? snapshot : null;
  }, '预算卡把「设了上限但没账」的维度读成未记账', 25000).catch(async () => budgetCard());
  evidence.phaseA.unaccountedDim = {
    receipt: withCalls.value ?? withCalls.error,
    recompute: expectUnknown,
    card: cardA2
  };
  note('a-unaccounted-dim-honest',
    withCalls.ok === true && expectUnknown.unknowns.includes('model_calls') && expectUnknown.exceeded.length === 0
      && withCalls.value?.gate?.ok === true
      && String(withCalls.value?.gate?.reason ?? '').includes('模型调用已设上限但没有调用计数')
      && cardA2?.rows?.some(row => row.includes('模型调用') && row.includes('未记账')) === true
      && String(cardA2?.head ?? '').includes('仍可开新一轮'),
    `设了上限但没账：unknowns=${JSON.stringify(expectUnknown.unknowns)} exceeded=${JSON.stringify(expectUnknown.exceeded)}`
    + `｜门禁 ${JSON.stringify(withCalls.value?.gate ?? withCalls.error)}`
    + `｜界面行数 ${JSON.stringify(cardA2?.rows ?? []).slice(0, 220)}`);
  await shot('01-budget-append-from-ui.png');

  // ── B 段：把探针改成「轮数已见底」再重启，走常规恢复链路 ──────────────────
  await stopDev('SIGTERM');
  const rounds = roundCount(taskId);
  assert.ok(rounds >= 1, `探针没跑出轮次（${String(rounds)} 轮），超限前置条件造不出来`);
  const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const target = (raw.tasks ?? []).find(item => item.taskId === taskId);
  assert.ok(target, '停进程后 store 里找不到探针任务');
  // 等价于「老任务带着小上限被恢复」：轮数已用满，恢复要开新一轮 → 必须撞同一道门禁。
  // `currentPlanId` 一并摘掉，否则 M2-2 的续跑分支（不建新一轮）会在门禁之前接管，测不到这条落点。
  const patched = {
    ...target,
    status: 'interrupted',
    budget: { ...target.budget, maxRounds: rounds },
    maxRounds: rounds,
    updatedAt: Date.now()
  };
  delete patched.resumeStatus;
  delete patched.currentPlanId;
  raw.tasks = raw.tasks.map(item => (item.taskId === taskId ? patched : item));
  fs.writeFileSync(STORE, `${JSON.stringify(raw, null, 2)}\n`);
  evidence.phaseB.precondition = {
    rounds,
    budget: patched.budget,
    status: patched.status,
    note: '改的是探针自己的落库记录（备份见 backups.store）；判定/落点/事件/界面代码路径未绕'
  };
  note('b-precondition-written', Number(storeTask(taskId)?.budget?.maxRounds) === rounds,
    `轮数 ${String(rounds)}/${String(rounds)}，状态 interrupted，无当前计划（续跑分支不接管）`);

  await startDev(false);
  cdp = await connectRenderer();
  // 重启后默认没选中任务，工作台整块不挂载：不重新点侧栏行，下面所有界面读数都是假阴性。
  note('ui-reselect-after-restart', await selectTaskRow(PROBE_TITLE, taskId),
    '重启后重新选中探针，统计/对话页才真的挂着');
  const reloaded = storeTask(taskId);
  note('b-budget-survives-restart',
    Number(reloaded?.budget?.maxRounds) === rounds && String(reloaded?.status) === 'interrupted',
    `重启后读回 budget=${JSON.stringify(reloaded?.budget ?? null)} status=${String(reloaded?.status)}`);
  const eventsBefore = await taskEvents(taskId);
  note('b-no-exhaust-event-yet',
    !eventsBefore.some(item => item.type === 'task.budget.exhausted'),
    `接回去之前事件数 ${String(eventsBefore.length)}，超限暂停这条不该预先存在`);

  await fire(`window.agentAPI.resumeTask(${JSON.stringify(taskId)})`, 'Resume');
  let statusNow = null;
  let resumeOutcome = null;
  try {
    statusNow = await waitFor(async () => {
      const task = storeTask(taskId);
      return task && task.status !== 'interrupted' ? task : null;
    }, '恢复后任务状态离开 interrupted', WAIT_RESUME);
  } catch {
    resumeOutcome = await firedState('Resume');
  }
  await sleep(SETTLE);
  const pausedTask = storeTask(taskId);
  const eventsAfter = await taskEvents(taskId);
  writeJson('events.after-budget-exhausted.json', eventsAfter);
  const exhaustEvent = eventsAfter.slice().reverse().find(item => item.type === 'task.budget.exhausted') ?? null;
  const expectPause = canOpenRound({
    budget: normalizeTaskBudget(pausedTask?.budget ?? null),
    usage: { rounds: roundCount(taskId), modelCalls: null, tokens: null }
  });
  evidence.phaseB = {
    ...evidence.phaseB,
    rounds,
    resumeOutcome: resumeOutcome ?? (await firedState('Resume')),
    status: pausedTask?.status ?? null,
    error: pausedTask?.error ?? null,
    exhaustEvent,
    expectGate: expectPause,
    roundsAfterResume: roundCount(taskId)
  };
  note('b-status-pausable', String(pausedTask?.status) === 'budget_exhausted',
    `实际状态 ${String(pausedTask?.status)}（应为可恢复的 budget_exhausted，不是终态 failed）｜resume 回执 ${JSON.stringify(evidence.phaseB.resumeOutcome).slice(0, 160)}`);
  // 「没被判死」只能看超限之后：A 段取消/通道超时本来就会留一条 task.failed，
  // 全局搜这条记录会把别人的失败算到预算落点头上（上一轮真机就是这么误报的）。
  const exhaustIdx = exhaustEvent ? eventsAfter.indexOf(exhaustEvent) : -1;
  const afterPauseEvents = exhaustIdx >= 0 ? eventsAfter.slice(exhaustIdx + 1) : eventsAfter;
  const preexistingFailures = Math.max(exhaustIdx, 0) >= 0
    ? eventsAfter.slice(0, Math.max(exhaustIdx, 0)).filter(item => item.type === 'task.failed').length
    : eventsAfter.filter(item => item.type === 'task.failed').length;
  note('b-not-killed',
    String(pausedTask?.status) !== 'failed' && !afterPauseEvents.some(item => item.type === 'task.failed'),
    `超限之后没有 task.failed（暂停前已有的 ${String(preexistingFailures)} 条来自 A 段收尾，不算在这里）`
    + `｜任务状态=${String(pausedTask?.status)} error=「${String(pausedTask?.error ?? '').slice(0, 120)}」`);
  note('b-exhaust-event',
    Boolean(exhaustEvent) && exhaustEvent.reason === expectPause.reason
      && Number(exhaustEvent.budget?.maxRounds) === rounds
      && exhaustEvent.budgetUsage?.rounds === roundCount(taskId)
      && exhaustEvent.budgetUsage.modelCalls === null && exhaustEvent.budgetUsage.tokens === null,
    `事件 ${JSON.stringify({ reason: exhaustEvent?.reason, budget: exhaustEvent?.budget, budgetUsage: exhaustEvent?.budgetUsage }).slice(0, 240)}`
    + `｜同口径反算 reason=「${expectPause.reason}」blockedBy=${JSON.stringify(expectPause.blockedBy)}`);
  // 口径要分清：事件里的 `reason` 是门禁读数（「轮数 1/1」，与 `canOpenRound` 逐字相同），
  // 给人看的那句「为什么停、怎么回来」落在任务的 error 上——两个都是同一份核算的结果。
  note('b-exhaust-says-how-to-come-back',
    expectPause.ok === false && String(exhaustEvent?.reason ?? '') === expectPause.reason
      && /预算已用尽/.test(String(pausedTask?.error ?? ''))
      && String(pausedTask?.error ?? '').includes('追加预算'),
    `事件读数「${String(exhaustEvent?.reason ?? '').slice(0, 90)}」＝反算「${expectPause.reason}」`
    + `｜任务提示「${String(pausedTask?.error ?? '').slice(0, 120)}」`);
  note('b-no-new-round-while-paused',
    roundCount(taskId) === rounds,
    `停手期间不得再开轮：改前 ${String(rounds)} 轮，现在 ${String(roundCount(taskId))} 轮`);
  note('b-legacy-observe',
    (() => {
      const decision = eventsAfter.slice().reverse().find(item => item.type === 'cycle.decision.created') ?? null;
      return !decision || ['observe', 'repair', 'complete'].includes(String(decision.decision))
        || String(decision.nextAction ?? '') === 'pause_budget'
        || !eventsAfter.some(item => item.type === 'cycle.snapshot' && item.decision === 'fail_budget');
    })(),
    `兼容镜像里不该再出现把超限判死的旧落点｜snapshot=${JSON.stringify(
      (eventsAfter.filter(item => item.type === 'cycle.snapshot').slice(-1)[0] ?? {}).decision ?? null)}`);

  const noteB = await budgetNote();
  const cardB = await budgetCard();
  evidence.phaseB.note = noteB;
  evidence.phaseB.card = cardB;
  note('ui-exhaust-note', noteB.paused === true && noteB.howBack === true,
    `活动流要同时给出「为什么停」和「怎么回来」：停手旁注「${String(noteB.pausedText ?? '没找到')}」`
    + `｜折叠详情含「追加预算后可继续」=${String(noteB.howBack === true)}`);
  note('ui-exhaust-control', cardB?.hasInput === true && cardB?.hasButton === true,
    `停手之后才给入口：input=${String(cardB?.hasInput)} button=${String(cardB?.hasButton)}｜卡头「${String(cardB?.head ?? '')}」`);
  note('ui-exhaust-head',
    String(cardB?.head ?? '').includes('已用尽') && String(cardB?.head ?? '').includes(BUDGET_DIMENSION_TEXT.rounds),
    `卡头读数「${String(cardB?.head ?? '')}」｜行数=${String(cardB?.rows?.length ?? 0)}`);
  await shot('02-budget-exhausted-pause.png');

  // 追加预算 → 门禁放行 → 走常规 resume 接回循环（「可恢复」三个字的机器可证伪部分）。
  // 反算要用回执里那份合并后的预算：A 段给模型调用设过上限，只喂 maxRounds 会得到一条对不上的门禁理由。
  const extendTo = rounds + 2;
  const extended = await callSetBudget({ taskId, maxRounds: extendTo });
  const expectOpen = canOpenRound({
    budget: extended.value?.budget ?? { maxRounds: extendTo },
    usage: { rounds, modelCalls: null, tokens: null }
  });
  const updatedAfter = (await taskEvents(taskId)).filter(item => item.type === 'task.budget.updated').slice(-1)[0] ?? null;
  evidence.phaseB.extend = { request: extendTo, receipt: extended, expectOpen, event: updatedAfter };
  note('b-extend-opens-gate',
    extended.ok === true && extended.value?.gate?.ok === true && expectOpen.ok === true
      && extended.value?.gate?.reason === expectOpen.reason,
    `回执 gate=${JSON.stringify(extended.value?.gate ?? extended.error ?? null)}｜反算 gate=${JSON.stringify(expectOpen)}`);
  note('b-extend-persisted',
    Number(storeTask(taskId)?.budget?.maxRounds) === extendTo && Number(updatedAfter?.budget?.maxRounds) === extendTo
      && Number(updatedAfter?.previous?.maxRounds) === rounds,
    `落库=${String(storeTask(taskId)?.budget?.maxRounds)}｜事件 previous=${JSON.stringify(updatedAfter?.previous ?? null)} → budget=${JSON.stringify(updatedAfter?.budget ?? null)} gate=${JSON.stringify(updatedAfter?.gate ?? null)}`);

  let resumedTask = null;
  try {
    resumedTask = await waitFor(async () => {
      const task = storeTask(taskId);
      return task && task.status !== 'budget_exhausted' ? task : null;
    }, '追加预算后任务离开 budget_exhausted', WAIT_RESUME);
  } catch { resumedTask = storeTask(taskId); }
  await sleep(SETTLE);
  const afterResume = storeTask(taskId);
  const newRounds = roundCount(taskId);
  evidence.phaseB.afterResume = {
    status: afterResume?.status ?? null,
    error: afterResume?.error ?? null,
    rounds: newRounds,
    fired: await firedState('Resume')
  };
  note('b-resumed-into-loop',
    String(afterResume?.status) !== 'budget_exhausted' && !['failed', 'cancelled'].includes(String(afterResume?.status)),
    `加完预算后状态 ${String(afterResume?.status)}（离开可恢复暂停，回到循环里推进）`);
  note('b-resume-opened-round', newRounds > rounds,
    `轮数 ${String(rounds)} → ${String(newRounds)}（追加预算不是只改个数，要真开出下一轮）`);
  const cardC = await budgetCard();
  // 卡头读数是加完预算之后的实时值：这一轮可能又开了一轮，所以拿读卡片那一刻的轮数反算，
  // 而不是拿追加前的旧值硬比（上一轮真机就误报在这里）。
  const headRounds = roundCount(taskId);
  const expectHeadClears = canOpenRound({
    budget: storeTask(taskId)?.budget ?? { maxRounds: extendTo },
    usage: { rounds: headRounds, modelCalls: null, tokens: null }
  });
  evidence.phaseB.cardAfterResume = cardC;
  evidence.phaseB.headRounds = headRounds;
  note('ui-budget-head-clears',
    String(cardC?.head ?? '').includes(expectHeadClears.ok ? '仍可开新一轮' : '已用尽')
      && cardC?.rows?.some(row => row.includes('轮数') && row.includes(`${String(headRounds)}/${String(extendTo)}`)) === true,
    `卡头「${String(cardC?.head ?? '')}」（${String(headRounds)}/${String(extendTo)} 反算 gate=${expectHeadClears.ok}）`
    + `｜行数=${JSON.stringify(cardC?.rows ?? []).slice(0, 200)}`);
  await shot('03-budget-extended-resumed.png');

  const stillThere = await cleanupProbe(taskId, conversationId);
  note('probe-cleaned-up', stillThere === false, `删除后仍存在 ${String(stillThere)}`);
  note('tasks-back-to-baseline',
    (readStore().tasks ?? []).length <= evidence.before.tasks,
    `任务数 ${String(evidence.before.tasks)} → ${String((readStore().tasks ?? []).length)}`);
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
  await stopDev('SIGTERM');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const checks = Object.entries(evidence.checks);
  const failed = checks.filter(([, item]) => item.ok !== true);
  const receipts = evidence.cleanup ?? [];
  const probeLine = receipts.length > 0
    ? receipts.map(item => `'${String(item.taskId)}'（${item.removed ? '已删除' : '**删除回执缺失，需手工核对默认数据目录**'}）`).join('、')
    : '未创建或未走到收尾';
  const lines = [
    '# V4 P1 M3-3 真机验收：预算超限拦得下、说得清、加得回去、加完接回循环',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 墙钟：${String(Math.round((new Date(evidence.finishedAt).getTime() - new Date(evidence.startedAt).getTime()) / 1000))} 秒（A 段跑 1 个真轮次 + B 段一次真重启，用例刻意压短；「≥2 小时无人值守」是 M3 闸门项，不在本条范围内）`,
    `- 环境：${evidence.mode}`,
    `- 数据目录：\`${USER_DATA}\`（默认，未隔离）；store 备份：${evidence.backups?.store ?? '未生成'}`,
    `- 工作区：\`${WORKSPACE}\`（探针只在这里读文件）`,
    `- 默认预算：${JSON.stringify(DEFAULT_TASK_BUDGET)}（只有轮数有上限；模型调用与 token 现网没有任务级账本，如实记未记账）`,
    `- 探针任务：${probeLine}`,
    '',
    '## 超限前置条件怎么来的（如实记录）',
    '',
    `预算按设计只增不减，默认 20 轮不可能在验收窗口内自然跑满。A 段跑出 **${String(evidence.phaseB?.rounds ?? '?')} 个真轮次**后停进程，`,
    '把探针任务自己的落库记录改成「轮数已用满 + 无当前计划 + 状态 interrupted」（等价于「老任务带着小上限被恢复」这条真实形态），',
    '重启后走常规 `task:resume`。判定、落点、事件、界面读数的代码路径一行没绕；改动只涉及探针记录，动盘前已备份，跑完删探针。',
    '',
    '```json',
    JSON.stringify(evidence.phaseB?.precondition ?? null, null, 2),
    '```',
    '',
    '## A 段：IPC 边界 / 落盘 / 只增不减 / 界面读数',
    '',
    '```json',
    JSON.stringify(evidence.phaseA, null, 2),
    '```',
    '',
    '## B 段：超限暂停 → 追加预算 → 接回循环',
    '',
    '```json',
    JSON.stringify(evidence.phaseB, null, 2),
    '```',
    '',
    '## 中断原因',
    '',
    evidence.error ? evidence.error : '无。',
    '',
    '## 结论（四条主张逐条对上的实测）',
    '',
    `1. **拦得下**：超限后状态 \`${String(evidence.phaseB?.status ?? '?')}\`（不是终态 \`failed\`），停手期间轮数 ${String(evidence.phaseB?.rounds ?? '?')} → ${String(evidence.phaseB?.roundsAfterResume ?? '?')}（没有偷开新一轮）。`,
    `2. **说得清**：\`task.budget.exhausted.reason\`=「${String(evidence.phaseB?.exhaustEvent?.reason ?? '')}」与脚本用同一批纯函数反算的结果逐字相同；活动流旁注与折叠详情见 \`ui-exhaust-note\`。`,
    `3. **加得回去**：追加到 ${String(evidence.phaseB?.extend?.request ?? '?')} 轮后门禁放行，回执 gate=${JSON.stringify(evidence.phaseB?.extend?.receipt?.value?.gate ?? null)}，落库同步。`,
    `4. **接回循环**：加完预算状态 ${String(evidence.phaseB?.afterResume?.status ?? '?')}、轮数 ${String(evidence.phaseB?.rounds ?? '?')} → ${String(evidence.phaseB?.afterResume?.rounds ?? '?')}——真的开出下一轮，不是只改个数。`,
    '',
    '## 断言结果',
    '',
    '| 断言 | 结果 | 实测 |',
    '| --- | --- | --- |',
    ...checks.map(([name, item]) => `| ${name} | ${item.ok ? '通过' : '**未通过**'} | ${String(item.detail ?? '').replace(/\s*\|\s*/g, '｜').replace(/\s+/g, ' ')} |`),
    '',
    `合计 ${String(checks.length)} 项，未通过 ${String(failed.length)} 项${failed.length ? `：${failed.map(([name]) => name).join('、')}` : ''}。`,
    '',
    '## 截图',
    '',
    ...(evidence.shots.length ? evidence.shots.map(item => `- \`${item}\``) : ['- 无']),
    '',
    '事件原文：`events.after-budget-exhausted.json`（超限暂停到手后的完整事件流）。'
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), `${lines.join('\n')}\n`);
  console.log(`EVIDENCE ${path.relative(ROOT, path.join(OUT_DIR, 'EVIDENCE.md'))}`);
  process.exitCode = failed.length > 0 || evidence.error ? 1 : 0;
}
