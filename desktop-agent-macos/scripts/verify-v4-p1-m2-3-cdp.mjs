/**
 * M2-3 真机验收：暂停 → 恢复一次之后，「上下文」段能不能把核对结果与重建原因摆在界面上。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据；探针任务收尾删除，
 * 动磁盘前先把 context-checkpoints 与 agent-store.json 备进验收目录。
 *
 * 四条判据：
 * 1) 暂停后：界面上的 contextId / 检查点 id / 待核对条数，要与 store 里那条
 *    `context.checkpoint.paused` 事件、以及磁盘上真正落库的检查点文件三方一致。
 *    暂停事件只带待核对条数，「存在 / 已消失」必须写成「未记录」——界面拿 0 顶上去，
 *    用户就会以为真核对过。
 * 2) 恢复后：`context.recovered` 的副作用账本与续跑/重规划的理由，要原样出现在
 *    「副作用核对」「重建原因」「续跑判定」三栏里；指针来源（任务字段 / 事件流重建）
 *    必须看得见，否则字段与事件不一致时无从发现。「逐条原文」还要能展开出事件 payload，
 *    那才是 §8 说的详情检查入口。
 * 3) 反例：一个从没暂停过的任务，这一段不许凭空造出检查点或重建记录。
 * 4) 另一条反例：暂停时留一条「起了但没有路径可核对」的在途命令，恢复必须判成重规划，
 *    而且界面要说得出是哪一步核对不了（`resume.reasons` 上屏 + 提醒色），
 *    不能只留一句「已重新规划」。
 *
 * 判据一律读 `.task-context-card` 里一格一格的值，而不是整页 innerText 搜关键词：
 * 「统计」页同时有 TaskStats 的计数（恢复 N 次），搜到「恢复」不代表这一栏的数值是对的。
 *
 * Run: node scripts/verify-v4-p1-m2-3-cdp.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';
// 判据用产品同一份口径：检查点段名拼法与上下文事件的措辞都不在脚本里重抄。
import { contextEventView, contextOwnerSegment } from '../out-test/shared/context.js';
import { contextStateSummary } from '../out-test/shared/context-state.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m2-3-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const CP_BASE = path.join(USER_DATA, 'context-checkpoints');
const CP_OWNERS = path.join(CP_BASE, 'owners', 'agent-task');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKSPACE = path.join(os.tmpdir(), `tf-m2-3-ws-${String(Date.now())}`);
const PROBE_A = 'M2-3 上下文状态探针';
const PROBE_B = 'M2-3 无上下文事件反例';
const PROBE_C = 'M2-3 重规划理由上屏探针';
/** 写步骤要够多：暂停点之后还剩步骤，恢复才有「续跑 / 重规划」可打点。 */
const WRITE_STEPS = 8;
const PAUSE_AFTER = 'write-4';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333 / 同一进程内暂停→恢复',
  workspace: WORKSPACE,
  checks: {},
  shots: [],
  before: null,
  backups: null,
  staleProbes: [],
  probeA: null,
  probeB: null,
  probeC: null,
  pauseProjection: null,
  resumeProjection: null,
  pauseCard: null,
  resumeCard: null,
  emptyCard: null,
  replanProjection: null,
  replanCard: null,
  rawEvents: {},
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
  if (!fs.existsSync(STORE)) return { tasks: [], goals: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}

function checkpointFile(taskId) {
  return path.join(CP_OWNERS, `${contextOwnerSegment(taskId)}.json`);
}

function listOwnerSegments() {
  try {
    return fs.readdirSync(CP_OWNERS).filter(name => name.endsWith('.json')).sort();
  } catch { return []; }
}

/** 磁盘上那份检查点尾部的 id 与账本行：界面上的数字要能在落库文件里找到出处。 */
function diskCheckpointTail(taskId) {
  try {
    const file = JSON.parse(fs.readFileSync(checkpointFile(taskId), 'utf8'));
    const last = (file.checkpoints ?? []).at(-1);
    const line = (last?.summary?.constraints ?? []).find(text => String(text).includes('副作用核对'));
    const nums = String(line ?? '').match(/applied (\d+) \/ missing (\d+) \/ needs_reconciliation (\d+)/);
    return {
      count: (file.checkpoints ?? []).length,
      checkpointId: last?.checkpointId ?? null,
      line: line ?? null,
      applied: nums ? Number(nums[1]) : null,
      missing: nums ? Number(nums[2]) : null,
      needsReconciliation: nums ? Number(nums[3]) : null
    };
  } catch {
    return { count: 0, checkpointId: null, line: null, applied: null, missing: null, needsReconciliation: null };
  }
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
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

/** build=true 只在第一次：之后复用同一份编译产物，免得中途重编译把界面刷没。 */
async function startDev(build) {
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

/**
 * 连上应用自己的渲染进程。第一次 dev 启动常触发 vite 依赖重新预构建、页面整页重载，
 * 只等一次会把「还没注入」误判成「没有渲染进程」（口径同 verify-v4-p1-m2-2-cdp.mjs）。
 */
async function connectRenderer() {
  const deadline = Date.now() + 300000;
  let lastIssue = '没有匹配的 page 目标';
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await (await fetch(ENDPOINT)).json();
    } catch {
      await sleep(1000);
      continue;
    }
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

const ev = (expression, timeoutMs = 40000) => cdp.evaluate(expression, timeoutMs);

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  // 相对验收目录：EVIDENCE.md 就在这个目录里渲染，写 `../docs/…` 会指到不存在的层级。
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

/**
 * 把「上下文」折叠段读成结构化数据。
 *
 * 展开与读取必须在同一次 evaluate 里：`<details>` 收起时 innerText 取不到内容，
 * 而 React 一重渲染又会把它收回（口径同 M2-2 的 tabText）。
 *
 * 必须等到「读取中…」消失才算渲染完成：卡片自己发一次 `getTaskContext`，
 * 首轮真机就是在这一步拿到 8 个字符的壳子，把「投影有、界面空」判成了产品缺陷。
 */
async function contextCard() {
  if (!(await openTab('统计'))) {
    evidence.rawEvents.tabLabels = await ev(`(() => {
      const scope = document.querySelector('.wb-tabs');
      return scope ? [...scope.querySelectorAll('button[role="tab"]')].map(node => (node.textContent ?? '').trim()).join('|') : '没有 .wb-tabs（工作台没打开？）';
    })()`).catch(() => 'evaluate 失败');
    return { tabMissing: true };
  }
  let last = null;
  const read = async () => ev(`(() => {
    const card = document.querySelector('.task-context-card');
    if (!card) return null;
    card.open = true;
    const cells = {};
    card.querySelectorAll('.stats-grid > div').forEach(node => {
      const key = node.querySelector('.task-progress-key')?.textContent?.trim();
      if (key) cells[key] = (node.querySelector('b')?.innerText ?? '').replace(/\\s+/g, ' ').trim();
    });
    const rows = [...card.querySelectorAll('.ctx-row')].map(node => {
      // 「步骤清单」是行内嵌套的 details：整张卡本身就在一个 details 里，
      // 用 "details .ctx-line" 会把祖先算进来（真机第一轮因此把普通行当成步骤清单，
      // 「步骤清单可见」这条判据其实是空跑的）。只认直接子层。
      node.querySelectorAll('details').forEach(inner => { inner.open = true; });
      return {
        head: (node.querySelector('.ctx-row-head')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
        // 配色本身就是判据：重规划必须标成提醒色，否则「已重新规划」和「续跑」看着一样。
        tone: node.className.split(' ').find(name => name.startsWith('t-')) ?? '',
        lines: [...node.querySelectorAll(':scope > .ctx-line')].map(item => item.innerText.replace(/\\s+/g, ' ').trim()),
        reasons: [...node.querySelectorAll('.ctx-reasons li')].map(item => item.textContent.trim()),
        steps: [...node.querySelectorAll('details > .ctx-line')].map(item => item.innerText.replace(/\\s+/g, ' ').trim())
      };
    });
    const entries = [...card.querySelectorAll('.ctx-entry')];
    entries.forEach(node => { node.open = true; });
    const text = card.innerText;
    return {
      summary: (card.querySelector('summary')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      cells,
      rows,
      entryCount: entries.length,
      entryPayloads: entries.map(node => node.querySelector('pre')?.textContent ?? ''),
      entryTypes: entries.map(node => node.querySelector('.ctx-entry-type')?.textContent?.trim() ?? ''),
      emptyState: text.includes('这个任务没有记录到上下文事件'),
      noZeroNote: text.includes('不拿 0 代替没核对'),
      loading: text.includes('读取中'),
      errorText: card.querySelector('.settings-error')?.textContent ?? '',
      charLen: text.length,
      text: text.slice(0, 4000)
    };
  })()`);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) last = value;
    if (value && !value.loading && !value.errorText) return value;
    await sleep(500);
  }
  return last ?? { renderTimeout: true };
}

async function scrollIntoView(selector) {
  return ev(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
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
  })()`), `侧栏出现「${list[0]}」`, 30000).catch(() => null);
  if (!hit) return false;
  await sleep(800);
  return true;
}

const getTask = id => ev(`window.agentAPI.getTask(${JSON.stringify(id)})`, 20000);
const taskEvents = id => ev(`window.agentAPI.getTaskEvents(${JSON.stringify(id)})`, 40000) ?? [];
const taskContext = id => ev(`window.agentAPI.getTaskContext(${JSON.stringify(id)})`, 40000);

/** 固定工作流要过审批门：完全权限自动批，但分解门禁可能把它留在 awaiting_approval。 */
async function runWorkflowAndExecute(payload, label) {
  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify(payload)})`, 60000);
  const taskId = created?.taskId;
  assert.ok(taskId, `${label} 任务没创建出来：${JSON.stringify(created)}`);
  await waitFor(async () => {
    const current = await getTask(taskId);
    if (current?.status === 'executing') return 'executing';
    if (current?.status === 'awaiting_approval' && current.currentRoundId && current.currentPlanId) {
      await ev(`window.agentAPI.approvePlan(${JSON.stringify({
        taskId, roundId: current.currentRoundId, planId: current.currentPlanId, approved: true
      })})`, 30000).catch(() => null);
      return 'approved';
    }
    if (['failed', 'cancelled'].includes(current?.status)) {
      throw new Error(`${label} 没进执行态：${String(current?.status)} ${String(current?.error ?? '')}`);
    }
    if (current?.status === 'blocked') {
      throw new Error(`${label} 停在分解门禁：${String(current?.error ?? '未给出理由')}`);
    }
    return null;
  }, `${label} 进入执行态`, 120000);
  await waitFor(async () => (await getTask(taskId))?.status === 'executing' ? 'executing' : null,
    `${label} 状态 executing`, 60000);
  return taskId;
}

async function pauseWhileExecuting(taskId, label) {
  await ev(`window.agentAPI.pauseTask(${JSON.stringify(taskId)})`, 30000);
  await waitFor(async () => ['paused', 'interrupted'].includes((await getTask(taskId))?.status)
    ? 'paused' : null, `${label} 暂停落地`, 60000);
}

function writeNode(id, file, content) {
  return {
    id,
    capabilityId: 'fs.writeFile',
    title: `写 ${file}`,
    args: { path: path.join(WORKSPACE, file), content }
  };
}

/** 投影摘要进证据文件：事后只看这份就知道界面当时应当显示什么。 */
function projectionDigest(view) {
  return {
    hasEvents: view?.hasEvents ?? null,
    contextId: view?.contextId ?? null,
    contextIdFrom: view?.contextIdFrom ?? null,
    checkpoints: (view?.checkpoints ?? []).map(row => `${row.source}:${row.checkpointId ?? '无'}:nr=${String(row.needsReconciliation)}`),
    rebuilds: (view?.rebuilds ?? []).map(row => `${row.kind}:ptr=${String(row.pointerSource ?? null)}`),
    lastRebuild: view?.lastRebuild ? { kind: view.lastRebuild.kind, at: view.lastRebuild.at, reason: view.lastRebuild.reason } : null,
    reconciliation: view?.lastReconciliation ?? null,
    budget: view?.budget ?? null,
    entryCount: (view?.entries ?? []).length,
    summary: view ? contextStateSummary(view) : null
  };
}

/** 判定行的措辞由产品那份 `contextEventView` 定，脚本不复述句子。 */
function contextEventText(event) {
  return event ? contextEventView(event.event).text : '__没有判定事件__';
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  evidence.before = { tasks: (readStore().tasks ?? []).length, ownerSegments: listOwnerSegments() };
  const backup = path.join(OUT_DIR, 'context-checkpoints.before.tgz');
  if (fs.existsSync(CP_BASE)) {
    execFileSync('tar', ['-czf', backup, '-C', CP_BASE, '.'], { stdio: 'inherit' });
  }
  const storeBackup = path.join(OUT_DIR, 'agent-store.before.json');
  fs.copyFileSync(STORE, storeBackup);
  evidence.backups = { checkpoints: path.relative(OUT_DIR, backup), store: path.relative(OUT_DIR, storeBackup) };

  // 上一轮失败留下的同名探针会干扰侧栏选中与残留统计，取样后再清。
  evidence.staleProbes = (readStore().tasks ?? [])
    .filter(task => [task.title, task.prompt, task.userPrompt].some(text => String(text ?? '').includes('M2-3 ')))
    .map(task => task.taskId);

  await startDev(true);
  cdp = await connectRenderer();
  note('renderer-ready', true, 'CDP 已连接');

  for (const stale of evidence.staleProbes) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(stale)})`, 30000).catch(() => null);
  }

  // ── ① 暂停后：界面上每个数字都要能追到事件与落库文件 ──
  // 写文件分两个目录：单一目录归纳不出 L2 子任务，会多绕一次分解门禁。
  const files = Array.from({ length: WRITE_STEPS }, (_, index) =>
    `${index < WRITE_STEPS / 2 ? 'd1' : 'd2'}/f${String(index + 1)}.txt`);
  const taskA = await runWorkflowAndExecute({
    workflow: {
      id: 'm2-3-context-state-probe',
      title: PROBE_A,
      nodes: files.map((file, index) => writeNode(`write-${String(index + 1)}`, file, `上下文状态证据 ${String(index + 1)}\n`))
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: 'M2-3 上下文重建显性化的真机探针'
  }, '探针 A');
  const taskAInfo = await getTask(taskA);
  evidence.probeA = { taskId: taskA, title: taskAInfo?.title ?? null, files };

  await waitFor(async () => (await taskEvents(taskA)).find(event =>
    event.type === 'step.completed' && event.stepId === PAUSE_AFTER) ?? null,
  `探针 A 跑到 ${PAUSE_AFTER}`, 240000);
  await pauseWhileExecuting(taskA, '探针 A');
  await sleep(2000);

  const pauseEvent = (await taskEvents(taskA)).filter(event => event.type === 'context.checkpoint.paused').at(-1);
  const diskTail = diskCheckpointTail(taskA);
  evidence.rawEvents.pauseEvent = pauseEvent ?? null;
  evidence.rawEvents.diskTail = diskTail;
  const viewPaused = await taskContext(taskA);
  evidence.pauseProjection = projectionDigest(viewPaused);

  note('ipc-pause-projects-checkpoint',
    viewPaused?.hasEvents === true &&
    (viewPaused?.checkpoints?.length ?? 0) >= 1 &&
    viewPaused.checkpoints.at(-1).source === 'pause' &&
    viewPaused.checkpoints.at(-1).checkpointId === pauseEvent?.checkpointId &&
    viewPaused.checkpoints.at(-1).checkpointId === diskTail.checkpointId &&
    viewPaused.checkpoints.at(-1).needsReconciliation === pauseEvent?.needsReconciliation,
    `投影 ${JSON.stringify(viewPaused?.checkpoints)}｜事件 cp=${String(pauseEvent?.checkpointId ?? null)} nr=${String(pauseEvent?.needsReconciliation ?? null)}`
    + `｜磁盘 cp=${String(diskTail.checkpointId ?? '读不到')}（${String(diskTail.line ?? '无账本行')}，共 ${String(diskTail.count)} 份）`);
  note('ipc-pause-keeps-unreconciled-as-null',
    !viewPaused?.lastReconciliation
      ? false
      : (viewPaused.lastReconciliation.applied === null && viewPaused.lastReconciliation.missing === null
        && viewPaused.lastReconciliation.source === 'pause'),
    `暂停只给待核对条数，不给存在/已消失：${JSON.stringify(viewPaused?.lastReconciliation ?? null)}`);
  note('ipc-task-context-is-read-only',
    JSON.stringify(await taskContext(taskA)) === JSON.stringify(viewPaused),
    '同一任务连读两次投影完全一致（不写盘、不推进状态、不补数据）');

  note('ui-shows-paused-probe', await selectTaskRow(PROBE_A, taskAInfo?.title, taskA), '侧栏选中探针 A');
  const cardPaused = await contextCard();
  evidence.pauseCard = {
    tabMissing: cardPaused?.tabMissing ?? null,
    renderTimeout: cardPaused?.renderTimeout ?? null,
    loading: cardPaused?.loading ?? null,
    errorText: cardPaused?.errorText ?? null,
    summary: cardPaused?.summary ?? null,
    cells: cardPaused?.cells ?? null,
    rows: cardPaused?.rows ?? null,
    entryCount: cardPaused?.entryCount ?? 0,
    entryTypes: cardPaused?.entryTypes ?? null
  };
  note('ui-context-card-renders', Boolean(cardPaused?.cells) && !cardPaused?.loading && !cardPaused?.errorText,
    `状态 ${JSON.stringify({ tabMissing: cardPaused?.tabMissing, timeout: cardPaused?.renderTimeout, loading: cardPaused?.loading, error: cardPaused?.errorText, chars: cardPaused?.charLen })}`);
  note('ui-summary-line-matches-projection',
    (cardPaused?.summary ?? '').includes(contextStateSummary(viewPaused)),
    `界面「${String(cardPaused?.summary ?? '')}」 vs 投影「${contextStateSummary(viewPaused)}」`);
  const pausedCpCell = cardPaused?.cells?.['最近检查点'] ?? '';
  note('ui-checkpoint-cell-matches-event',
    pausedCpCell.includes(String(pauseEvent?.checkpointId ?? '\u0000')) && pausedCpCell.includes('暂停存档') &&
    (cardPaused?.cells?.['存档时间'] ?? '') !== '未记录' && (cardPaused?.cells?.['存档时间'] ?? '') !== '',
    `最近检查点「${pausedCpCell}」｜存档时间「${String(cardPaused?.cells?.['存档时间'] ?? '')}」`);
  note('ui-pause-reconciliation-says-unrecorded',
    /待核对/.test(cardPaused?.cells?.['副作用核对'] ?? '') &&
    (cardPaused?.cells?.['副作用核对'] ?? '').split('·').filter(part => part.includes('未记录')).length === 2 &&
    cardPaused?.noZeroNote === true,
    `副作用核对「${String(cardPaused?.cells?.['副作用核对'] ?? '')}」｜口径说明 ${String(Boolean(cardPaused?.noZeroNote))}`);
  note('ui-pause-no-rebuild-claim',
    (cardPaused?.cells?.['上次重建'] ?? '') === '未重建' && (cardPaused?.cells?.['重建原因'] ?? '') === '未记录',
    `上次重建「${String(cardPaused?.cells?.['上次重建'] ?? '')}」｜重建原因「${String(cardPaused?.cells?.['重建原因'] ?? '')}」`);
  note('ui-pause-entries-are-raw-payloads',
    (cardPaused?.entryCount ?? 0) === (viewPaused?.entries?.length ?? -1) &&
    (cardPaused?.entryTypes ?? []).includes('context.checkpoint.paused') &&
    (cardPaused?.entryPayloads ?? []).every(text => { try { return typeof JSON.parse(text) === 'object'; } catch { return false; } }),
    `原文 ${String(cardPaused?.entryCount ?? 0)} 条 vs 投影 ${String(viewPaused?.entries?.length ?? 0)} 条；类型 ${String((cardPaused?.entryTypes ?? []).join(','))}`);
  note('ui-pause-card-scrolled', await scrollIntoView('.task-context-card') === true, '截图前把「上下文」段滚进视口');
  await shot('01-A-paused-context-card.png');

  // ── ② 恢复一次：核对结果与重建原因要摆在同一栏里 ──
  // `task:resume` 的回包要等续跑这一轮执行完（M2-2 实测），8 步写入 + 收尾报告远超 30s；
  // 超时不是缺陷，判据看下面的事件与投影。
  const resumeAt = Date.now();
  let resumeError = null;
  try {
    await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskA)})`, 300000);
  } catch (error) {
    resumeError = String(error?.message ?? error).slice(0, 500);
  }
  const recoveredEvent = await waitFor(async () => (await taskEvents(taskA)).find(event =>
    event.type === 'context.event' && event.event === 'context.recovered' && (event.at ?? 0) >= resumeAt - 3000) ?? null,
  '恢复打点 context.recovered', 120000).catch(() => null);
  const decisionEvent = await waitFor(async () => (await taskEvents(taskA)).find(event =>
    event.type === 'context.event' && ['context.resume.continued', 'context.resume.replanned'].includes(event.event)
    && (event.at ?? 0) >= resumeAt - 3000) ?? null,
  '续跑/重规划打点', 120000).catch(() => null);
  evidence.rawEvents.resumeError = resumeError;
  evidence.rawEvents.recoveredEvent = recoveredEvent?.context ?? null;
  evidence.rawEvents.decisionEvent = decisionEvent?.context ?? null;
  evidence.rawEvents.decisionType = decisionEvent?.event ?? null;

  const viewResumed = await taskContext(taskA);
  evidence.resumeProjection = projectionDigest(viewResumed);
  note('resume-ipc-accepted', Boolean(recoveredEvent) && Boolean(decisionEvent),
    `${resumeError ? `回包：${resumeError.slice(0, 120)}｜` : ''}recovered=${String(recoveredEvent?.at ?? null)}，判定=${String(decisionEvent?.event ?? null)}`);

  const ledger = recoveredEvent?.context?.sideEffects ?? null;
  const recoveredRow = (viewResumed?.rebuilds ?? []).find(row => row.kind === 'recovered') ?? null;
  note('ipc-resume-projects-reconciled-ledger',
    Boolean(ledger) && recoveredRow?.sideEffects?.applied === ledger.applied
    && recoveredRow.sideEffects.missing === ledger.missing
    && recoveredRow.sideEffects.needsReconciliation === ledger.needsReconciliation
    && viewResumed.lastReconciliation?.source === 'recovered'
    && viewResumed.lastReconciliation.applied === ledger.applied,
    `事件 sideEffects=${JSON.stringify(ledger)}｜投影行 ${JSON.stringify(recoveredRow?.sideEffects ?? null)}｜lastReconciliation ${JSON.stringify(viewResumed?.lastReconciliation ?? null)}`);
  note('ipc-resume-projects-pointer-source',
    Boolean(recoveredRow) && recoveredRow.pointerSource === (recoveredEvent?.context?.pointerSource ?? null),
    `投影 ${String(recoveredRow?.pointerSource ?? null)}｜事件 ${String(recoveredEvent?.context?.pointerSource ?? null)}`);
  const decisionRow = (viewResumed?.rebuilds ?? []).find(
    row => row.kind === 'resume-continue' || row.kind === 'resume-replan') ?? null;
  note('ipc-resume-projects-rebuild-reason',
    Boolean(viewResumed?.lastRebuild?.reason) && Boolean(decisionRow) &&
    JSON.stringify(decisionRow?.resume?.reasons ?? []) === JSON.stringify(decisionEvent?.context?.resume?.reasons ?? []) &&
    decisionRow?.resume?.reusedStepIds?.length === (decisionEvent?.context?.resume?.reusedStepIds ?? []).length &&
    decisionRow?.resume?.pendingStepIds?.length === (decisionEvent?.context?.resume?.pendingStepIds ?? []).length,
    `lastRebuild.reason=${String(viewResumed?.lastRebuild?.reason ?? null)}｜判定行 resume=${JSON.stringify(decisionRow?.resume ?? null)}`);

  // 界面要跟着补上：卡片靠 refreshKey={events.length} 自重取，恢复打点落地后 React 会重渲染。
  const cardResumed = await waitFor(async () => {
    const next = await contextCard();
    return ledger && (next?.cells?.['副作用核对'] ?? '').includes(`存在 ${String(ledger.applied)}`) ? next : null;
  }, '界面把恢复账本补上', 90000).catch(async () => contextCard());
  evidence.resumeCard = {
    loading: cardResumed?.loading ?? null,
    errorText: cardResumed?.errorText ?? null,
    summary: cardResumed?.summary ?? null,
    cells: cardResumed?.cells ?? null,
    rows: cardResumed?.rows ?? null,
    entryCount: cardResumed?.entryCount ?? 0,
    entryTypes: cardResumed?.entryTypes ?? null
  };
  const expectedLedgerLine = ledger
    ? `存在 ${String(ledger.applied)} · 已消失 ${String(ledger.missing)} · 待核对 ${String(ledger.needsReconciliation)}`
    : null;
  note('ui-resume-reconciliation-matches-event',
    expectedLedgerLine !== null && (cardResumed?.cells?.['副作用核对'] ?? '') === expectedLedgerLine &&
    (cardResumed?.cells?.['核对来源'] ?? '').includes('恢复时核对'),
    `界面「${String(cardResumed?.cells?.['副作用核对'] ?? '')}」｜应为「${String(expectedLedgerLine)}」｜核对来源「${String(cardResumed?.cells?.['核对来源'] ?? '')}」`);
  note('ui-resume-rebuild-reason-visible',
    (cardResumed?.cells?.['上次重建'] ?? '').includes(contextEventText(decisionEvent)) &&
    (cardResumed?.cells?.['重建原因'] ?? '') === (decisionEvent?.context?.reason ?? '\u0000'),
    `上次重建「${String(cardResumed?.cells?.['上次重建'] ?? '')}」｜重建原因「${String(cardResumed?.cells?.['重建原因'] ?? '')}」｜事件 reason=${String(decisionEvent?.context?.reason ?? null)}`);
  note('ui-resume-pointer-source-visible',
    (cardResumed?.rows ?? []).some(row => row.head.includes('指针来自')),
    (cardResumed?.rows ?? []).map(row => row.head).join(' ⏎ ').slice(0, 400));
  const expectedDecisionHead = decisionEvent?.context?.resume
    ? `复用 ${String((decisionEvent.context.resume.reusedStepIds ?? []).length)} 步 · 本轮执行 ${String((decisionEvent.context.resume.pendingStepIds ?? []).length)} 步`
    : null;
  note('ui-resume-decision-row-counts-steps',
    (cardResumed?.rows ?? []).some(row => row.head.includes(contextEventText(decisionEvent))) &&
    (expectedDecisionHead === null || (cardResumed?.rows ?? []).some(row => row.head.includes(expectedDecisionHead))),
    `应有步数行「${String(expectedDecisionHead)}」｜界面行 ${JSON.stringify((cardResumed?.rows ?? []).map(row => row.head)).slice(0, 500)}`);
  note('ui-resume-reasons-listed',
    ((decisionEvent?.context?.resume?.reasons ?? []).length === 0)
      ? (cardResumed?.rows ?? []).every(row => row.reasons.length === 0)
      : (cardResumed?.rows ?? []).some(row => row.reasons.length === (decisionEvent.context.resume.reasons ?? []).length),
    `事件理由 ${JSON.stringify(decisionEvent?.context?.resume?.reasons ?? [])}｜界面理由 ${JSON.stringify((cardResumed?.rows ?? []).flatMap(row => row.reasons)).slice(0, 400)}`);
  // 复用/本轮的步骤清单要说得出具体步骤 id，只有一句「复用 5 步」不算核对得到。
  const reusedFirst = (decisionEvent?.context?.resume?.reusedStepIds ?? [])[0] ?? '';
  const pendingFirst = (decisionEvent?.context?.resume?.pendingStepIds ?? [])[0] ?? '';
  const stepLines = (cardResumed?.rows ?? []).flatMap(row => row.steps);
  note('ui-resume-step-list-names-steps',
    reusedFirst !== '' && pendingFirst !== '' &&
    stepLines.some(line => line.includes('复用') && line.includes(reusedFirst)) &&
    stepLines.some(line => line.includes('本轮') && line.includes(pendingFirst)) &&
    stepLines.some(line => line.includes('计划') && line.includes(String(decisionEvent?.context?.resume?.planId ?? '\u0000').slice(0, 8))),
    `事件复用首步 ${reusedFirst}、本轮首步 ${pendingFirst}、计划 ${String(decisionEvent?.context?.resume?.planId ?? null)}｜界面行 ${JSON.stringify(stepLines).slice(0, 500)}`);
  note('ui-resume-entries-cover-both-phases',
    (cardResumed?.entryTypes ?? []).includes('context.checkpoint.paused') &&
    (cardResumed?.entryTypes ?? []).includes('context.event:context.recovered') &&
    (cardResumed?.entryTypes ?? []).includes(`context.event:${String(decisionEvent?.event ?? '')}`) &&
    (cardResumed?.entryCount ?? 0) === (viewResumed?.entries?.length ?? -1),
    `界面 ${String(cardResumed?.entryCount ?? 0)} 条 ${String((cardResumed?.entryTypes ?? []).join(','))}｜投影 ${String(viewResumed?.entries?.length ?? 0)} 条`);
  note('ui-resume-detail-payload-carries-ledger',
    (cardResumed?.entryPayloads ?? []).some(text => text.includes('sideEffects') && text.includes('"applied"')),
    (cardResumed?.entryPayloads ?? []).find(text => text.includes('sideEffects'))?.slice(0, 260) ?? '没有带 sideEffects 的原文');
  note('ui-resume-card-scrolled', await scrollIntoView('.task-context-card') === true, '截图前把「上下文」段滚进视口');
  await shot('02-A-resumed-context-card.png');
  const entriesScrolled = await scrollIntoView('.ctx-entries');
  await shot('03-A-context-detail-entries.png');
  note('ui-detail-entries-are-visible', entriesScrolled === true && (cardResumed?.entryCount ?? 0) > 0,
    `逐条原文展开 ${String(cardResumed?.entryCount ?? 0)} 条，截图前已滚进视口`);

  // ── ③ 反例：没暂停过的任务，这一段不许凭空造出检查点或重建记录 ──
  const taskB = await runWorkflowAndExecute({
    workflow: {
      id: 'm2-3-no-context-probe',
      title: PROBE_B,
      nodes: [writeNode('write-1', 'solo.txt', '反例：整轮没有暂停过\n')]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: 'M2-3 没有上下文事件时不许编出检查点'
  }, '探针 B');
  const taskBInfo = await getTask(taskB);
  evidence.probeB = { taskId: taskB, title: taskBInfo?.title ?? null };
  await sleep(1500);
  const viewB = await taskContext(taskB);
  evidence.rawEvents.B = (await taskEvents(taskB))
    .filter(event => String(event.type).startsWith('context'))
    .map(event => event.type === 'context.event' ? `context.event:${event.event}` : event.type);
  note('ipc-no-context-probe-has-no-checkpoint',
    (viewB?.checkpoints ?? []).every(row => row.source === 'compaction') &&
    (viewB?.rebuilds ?? []).every(row => row.kind !== 'recovered' && row.kind !== 'checkpoint-missing') &&
    (viewB?.lastReconciliation ?? null) === null,
    `投影 ${JSON.stringify(projectionDigest(viewB))}｜上下文事件 ${String(evidence.rawEvents.B.join(',') || '无')}`);

  note('ui-shows-empty-probe', await selectTaskRow(PROBE_B, taskBInfo?.title, taskB), '侧栏选中探针 B');
  const cardEmpty = await contextCard();
  evidence.emptyCard = {
    summary: cardEmpty?.summary ?? null,
    cells: cardEmpty?.cells ?? null,
    entryCount: cardEmpty?.entryCount ?? 0,
    emptyState: cardEmpty?.emptyState ?? null,
    loading: cardEmpty?.loading ?? null,
    errorText: cardEmpty?.errorText ?? null,
    renderTimeout: cardEmpty?.renderTimeout ?? null
  };
  note('ui-empty-probe-says-nothing-happened',
    viewB?.hasEvents === false
      ? cardEmpty?.emptyState === true
      : (cardEmpty?.cells?.['上次重建'] ?? '') === '未重建' && (cardEmpty?.cells?.['副作用核对'] ?? '') === '未做核对',
    `摘要「${String(cardEmpty?.summary ?? '')}」｜空态文案 ${String(cardEmpty?.emptyState)}｜最近检查点「${String(cardEmpty?.cells?.['最近检查点'] ?? '')}」`);
  note('ui-empty-probe-leaks-no-other-task',
    !(cardEmpty?.text ?? '').includes(String(pauseEvent?.checkpointId ?? '\u0000')) &&
    !(cardEmpty?.text ?? '').includes(String(recoveredEvent?.context?.contextId ?? '\u0001')),
    `探针 B 的原文里出现探针 A 的 cp=${String(pauseEvent?.checkpointId)}：${String((cardEmpty?.text ?? '').includes(String(pauseEvent?.checkpointId)))}`);
  await scrollIntoView('.task-context-card');
  await shot('04-B-no-context-card.png');

  // ── ④ 第二条路：核对不过时要回到重规划，界面得点名是哪一步核对不了 ──
  // M2-2 已验这条链路的落库事件，那一段没有取上下文卡的 DOM 样本：卡片的 warn 配色与
  // `resume.reasons` 清单只在投影单测里跑过。这里补一份真机读数，别把「单测绿」当「界面会显示」。
  const lateFileC = path.join(WORKSPACE, 'late-from-paused-shell.txt');
  const taskC = await runWorkflowAndExecute({
    workflow: {
      id: 'm2-3-replan-probe',
      title: PROBE_C,
      nodes: [
        writeNode('write-1', 'c1.txt', 'replan-step-1\n'),
        {
          id: 'long-shell',
          capabilityId: 'shell.run',
          title: '长命令：暂停时它到底写没写过，无人能核对',
          args: {
            command: `echo began; sleep 30; echo late > ${JSON.stringify(lateFileC)}`,
            cwd: WORKSPACE,
            timeoutMs: 60000
          }
        },
        writeNode('write-3', 'c3.txt', 'never-reached\n')
      ]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: 'M2-3 重规划理由要上屏的真机探针'
  }, '探针 C');
  const taskCInfo = await getTask(taskC);
  evidence.probeC = { taskId: taskC, lateFile: path.basename(lateFileC) };
  const cEvents = () => taskEvents(taskC);
  await waitFor(async () => (await cEvents()).find(event =>
    event.type === 'step.started' && event.stepId === 'long-shell') ?? null, '探针 C 的 shell 步骤开始', 120000);
  await pauseWhileExecuting(taskC, '探针 C');
  await sleep(1500);
  const pauseEventC = (await cEvents()).filter(event => event.type === 'context.checkpoint.paused').at(-1);
  const diskTailC = diskCheckpointTail(taskC);
  evidence.rawEvents.pauseEventC = pauseEventC ?? null;
  evidence.rawEvents.diskTailC = diskTailC;

  // 暂停刚落地就点继续：那条 shell 还在途，账本里的未知缺口才不会被迟到的报告抹平。
  const resumeAtC = Date.now();
  let resumeErrorC = null;
  try {
    await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskC)})`, 300000);
  } catch (error) {
    resumeErrorC = String(error?.message ?? error).slice(0, 600);
  }
  const recoveredEventC = await waitFor(async () => (await cEvents()).find(event =>
    event.type === 'context.event' && event.event === 'context.recovered' && (event.at ?? 0) >= resumeAtC - 3000) ?? null,
  '探针 C 的恢复打点', 120000).catch(() => null);
  const decisionEventC = await waitFor(async () => (await cEvents()).find(event =>
    event.type === 'context.event' && event.event === 'context.resume.replanned' && (event.at ?? 0) >= resumeAtC - 3000) ?? null,
  '探针 C 的重规划判定', 120000).catch(() => null);
  evidence.rawEvents.resumeErrorC = resumeErrorC;
  evidence.rawEvents.recoveredEventC = recoveredEventC?.context ?? null;
  evidence.rawEvents.decisionEventC = decisionEventC?.context ?? null;

  const ledgerC = recoveredEventC?.context?.sideEffects ?? null;
  const viewReplanned = await taskContext(taskC);
  evidence.replanProjection = projectionDigest(viewReplanned);
  note('ipc-replan-projects-gap-and-decision',
    Boolean(decisionEventC) && (ledgerC?.needsReconciliation ?? 0) > 0 &&
    (viewReplanned?.rebuilds ?? []).some(row => row.kind === 'resume-replan') &&
    viewReplanned?.lastRebuild?.kind === 'resume-replan',
    `判定=${String(decisionEventC?.event ?? null)}｜恢复账本 ${JSON.stringify(ledgerC)}｜投影 rebuilds ${JSON.stringify(viewReplanned?.rebuilds ?? [])}`);
  note('ipc-replan-listens-to-event-reasons',
    JSON.stringify(viewReplanned?.lastRebuild?.resume?.reasons ?? []) ===
      JSON.stringify(decisionEventC?.context?.resume?.reasons ?? []) &&
    (decisionEventC?.context?.resume?.reasons ?? []).length > 0,
    `事件理由 ${JSON.stringify(decisionEventC?.context?.resume?.reasons ?? [])}｜投影理由 ${JSON.stringify(viewReplanned?.lastRebuild?.resume?.reasons ?? [])}`);

  note('ui-shows-replan-probe', await selectTaskRow(PROBE_C, taskCInfo?.title, taskC), '侧栏选中探针 C');
  const cardReplanned = await waitFor(async () => {
    const next = await contextCard();
    return (next?.rows ?? []).some(row => row.head.includes('已重新规划')) ? next : null;
  }, '界面把重规划行补上', 90000).catch(async () => contextCard());
  evidence.replanCard = {
    loading: cardReplanned?.loading ?? null,
    errorText: cardReplanned?.errorText ?? null,
    summary: cardReplanned?.summary ?? null,
    cells: cardReplanned?.cells ?? null,
    rows: cardReplanned?.rows ?? null,
    entryCount: cardReplanned?.entryCount ?? 0,
    entryTypes: cardReplanned?.entryTypes ?? null
  };
  const replanRow = (cardReplanned?.rows ?? []).find(row => row.head.includes('已重新规划')) ?? null;
  note('ui-replan-card-says-replanned',
    (cardReplanned?.cells?.['上次重建'] ?? '').includes(contextEventText(decisionEventC)) &&
    (cardReplanned?.cells?.['续跑判定'] ?? '').includes('已重新规划'),
    `上次重建「${String(cardReplanned?.cells?.['上次重建'] ?? '')}」｜续跑判定「${String(cardReplanned?.cells?.['续跑判定'] ?? '')}」`);
  note('ui-replan-reason-names-the-gap',
    (cardReplanned?.cells?.['重建原因'] ?? '') === (decisionEventC?.context?.reason ?? '\u0000') &&
    (replanRow?.reasons ?? []).some(text => text === (decisionEventC?.context?.resume?.reasons ?? [])[0]) &&
    (replanRow?.reasons ?? []).some(text => text.includes('long-shell')),
    `重建原因「${String(cardReplanned?.cells?.['重建原因'] ?? '')}」｜界面理由 ${JSON.stringify(replanRow?.reasons ?? [])}`);
  note('ui-replan-row-is-warn-toned', replanRow?.tone === 't-warn',
    `行的配色类名「${String(replanRow?.tone ?? '')}」｜行头「${String(replanRow?.head ?? '')}」`);
  note('ui-replan-row-says-no-reuse',
    (replanRow?.head ?? '').includes('不复用上一轮步骤') && !(replanRow?.head ?? '').includes('复用 0 步'),
    `行头「${String(replanRow?.head ?? '')}」`);
  note('ui-replan-gap-is-a-number-not-zero',
    ledgerC !== null && (cardReplanned?.cells?.['副作用核对'] ?? '') ===
      `存在 ${String(ledgerC.applied)} · 已消失 ${String(ledgerC.missing)} · 待核对 ${String(ledgerC.needsReconciliation)}` &&
      ledgerC.needsReconciliation > 0,
    `界面「${String(cardReplanned?.cells?.['副作用核对'] ?? '')}」｜事件 ${JSON.stringify(ledgerC)}`);
  note('ui-replan-keeps-the-checkpoint-it-rejected',
    (cardReplanned?.cells?.['最近检查点'] ?? '').includes(String(pauseEventC?.checkpointId ?? '\u0000')),
    `最近检查点「${String(cardReplanned?.cells?.['最近检查点'] ?? '')}」｜磁盘 ${String(diskTailC.line ?? '读不到')}`);
  note('ui-replan-entries-cover-the-decision',
    (cardReplanned?.entryTypes ?? []).includes('context.checkpoint.paused') &&
    (cardReplanned?.entryTypes ?? []).includes('context.event:context.resume.replanned') &&
    (cardReplanned?.entryPayloads ?? []).some(text => text.includes('needs_reconciliation') || text.includes('reasons')),
    `原文 ${String(cardReplanned?.entryCount ?? 0)} 条 ${String((cardReplanned?.entryTypes ?? []).join(','))}`);
  note('ui-replan-card-scrolled', await scrollIntoView('.task-context-card') === true, '截图前把「上下文」段滚进视口');
  await shot('05-C-replanned-context-card.png');

  // ── ⑤ 收尾：探针任务与它的检查点文件都不许残留 ──
  for (const [tag, id] of [['A', taskA], ['B', taskB], ['C', taskC]]) {
    await ev(`window.agentAPI.cancelTask(${JSON.stringify(id)})`, 30000).catch(() => null);
    await sleep(2500);
    const beforeFile = fs.existsSync(checkpointFile(id));
    const cleanup = await ev(`window.agentAPI.deleteTask(${JSON.stringify(id)})`, 30000);
    evidence.cleanup.push({ tag, taskId: id, checkpointExistedBeforeDelete: beforeFile, cleanup });
    note(`${tag}-delete-reclaims-checkpoint`,
      beforeFile
        ? cleanup?.checkpointsRemoved === true && !fs.existsSync(checkpointFile(id))
        // 没有文件可回收时也必须如实报 false，不能凭空报「已回收」。
        : cleanup?.checkpointsRemoved === false,
      `删前文件 ${String(beforeFile)}，回收结果 ${JSON.stringify(cleanup)}`);
  }
  const liveNow = new Set((readStore().tasks ?? []).map(task => contextOwnerSegment(task.taskId)));
  const leftover = listOwnerSegments().filter(name => !liveNow.has(name));
  note('disk-has-no-orphan-after-run', leftover.length === 0,
    leftover.length ? `残留 ${leftover.join(', ')}` : '探针之外没有无人认领的归属文件');
  const stillThere = (readStore().tasks ?? []).filter(task => [taskA, taskB].includes(task.taskId));
  note('probe-tasks-cleaned-up', stillThere.length === 0,
    `任务数 ${String(evidence.before.tasks)} → ${String((readStore().tasks ?? []).length)}（扫前的 ${String(evidence.before.ownerSegments.length)} 个归属文件里，上一轮中断留下的探针 ${String(evidence.staleProbes.length)} 条已在开头删掉）`);
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
  const lines = [
    '# V4 P1 M2-3 真机验收：上下文重建显性化',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 环境：${evidence.mode}`,
    `- 工作区：\`${WORKSPACE}\`（探针只在这里写文件）`,
    `- 探针任务：A 暂停→续跑 \`${evidence.probeA?.taskId ?? '未创建'}\`、B 无上下文事件反例 \`${evidence.probeB?.taskId ?? '未创建'}\`、C 在途命令不可核对→重规划 \`${evidence.probeC?.taskId ?? '未创建'}\`（收尾已删除）`,
    `- 备份：${evidence.backups?.checkpoints ?? '未生成'}、${evidence.backups?.store ?? '未生成'}`,
    '',
    '## 取样前',
    '',
    '```json',
    JSON.stringify({ before: evidence.before, staleProbes: evidence.staleProbes }, null, 2),
    '```',
    '',
    '## 三方对照：暂停事件 / 磁盘检查点 / 投影',
    '',
    '```json',
    JSON.stringify({
      pauseEvent: evidence.rawEvents.pauseEvent,
      diskTail: evidence.rawEvents.diskTail,
      projectionAfterPause: evidence.pauseProjection,
      projectionAfterResume: evidence.resumeProjection
    }, null, 2),
    '```',
    '',
    '## 恢复打点（界面上的数字就是从这里来的）',
    '',
    '```json',
    JSON.stringify({
      resumeError: evidence.rawEvents.resumeError,
      recovered: evidence.rawEvents.recoveredEvent,
      decisionType: evidence.rawEvents.decisionType,
      decision: evidence.rawEvents.decisionEvent
    }, null, 2),
    '```',
    '',
    '## 「上下文」段实测渲染值',
    '',
    '### 暂停后',
    '',
    '```json',
    JSON.stringify(evidence.pauseCard, null, 2),
    '```',
    '',
    '### 恢复后',
    '',
    '```json',
    JSON.stringify(evidence.resumeCard, null, 2),
    '```',
    '',
    '### 反例（没暂停过）',
    '',
    '```json',
    JSON.stringify({ ...evidence.emptyCard, contextEvents: evidence.rawEvents.B }, null, 2),
    '```',
    '',
    '## 第二条路：核对不过时重规划（探针 C）',
    '',
    '```json',
    JSON.stringify({
      pauseEvent: evidence.rawEvents.pauseEventC,
      diskTail: evidence.rawEvents.diskTailC,
      resumeError: evidence.rawEvents.resumeErrorC,
      recovered: evidence.rawEvents.recoveredEventC,
      decision: evidence.rawEvents.decisionEventC,
      projection: evidence.replanProjection,
      card: evidence.replanCard
    }, null, 2),
    '```',
    '',
    '## 删除任务时的回收',
    '',
    '```json',
    JSON.stringify(evidence.cleanup, null, 2),
    '```',
    '',
    '## 断言结果',
    '',
    '| 断言 | 结果 | 实测 |',
    '| --- | --- | --- |',
    ...checks.map(([name, item]) => `| ${name} | ${item.ok ? '通过' : '**未通过**'} | ${item.detail ?? ''} |`),
    '',
    `合计 ${String(checks.length)} 项，未通过 ${String(failed.length)} 项${failed.length ? `：${failed.map(([name]) => name).join('、')}` : ''}。`,
    '',
    '## 截图',
    '',
    ...(evidence.shots.length ? evidence.shots.map(item => `- \`${item}\``) : ['- 无']),
    '',
    evidence.error ? `## 中断原因\n\n${evidence.error}\n` : '## 中断原因\n\n无。'
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), `${lines.join('\n')}\n`);
  console.log(`EVIDENCE ${path.relative(ROOT, path.join(OUT_DIR, 'EVIDENCE.md'))}`);
  process.exitCode = failed.length > 0 || evidence.error ? 1 : 0;
}



