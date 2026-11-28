/**
 * M2-2 真机验收：暂停 → 强退 → 重启 → 从检查点续跑（并留下重规划那条路的反例）。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据。探针任务用完删除，
 * 动磁盘前先整份备份进验收目录（context-checkpoints + agent-store.json）。
 *
 * 三条判据：
 * 1) 续跑正例：暂停时留下 fresh 检查点、副作用账本没有未知缺口 → 重启后点「继续」，
 *    恢复后的第一个执行事件是 `step.reused`/`step.started`（沿用被中断那份 planId），
 *    中间不出现 `round.started`/`plan.ready`（不是重新规划）；剩下的步骤真跑完。
 * 2) 重规划反例：暂停时留着一个「起了但没有路径可核对」的在途写步骤（shell.run）→
 *    重启后继续必须走重规划，理由点名「结局未知且无路径可核对」，并新开一轮。
 * 3) 垃圾回收：启动扫描只收「任务表里查不到」的归属文件与孤儿目标，活任务的一份不动；
 *    删除探针任务时它自己的检查点文件与目标实体也跟着消失，磁盘上不残留。
 *
 * 探针刻意用固定工作流（`workflow:run`）而不是让模型规划：模型每轮的步骤 id 与步数
 * 都不固定，「暂停时还剩几步」就无法控制，这两条路就验不出确定性。
 * 收尾步骤用 shell.run 跑 `node --test .`：test.run 只认写死的 npm 命令白名单，
 * 临时工作区里没有 package.json，用它只会得到一条无意义的失败。
 *
 * Run: node scripts/verify-v4-p1-m2-2-cdp.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';
// 判据用产品代码同一份口径：段名拼法与「目标下还有没有任务」都不在脚本里重抄。
import { contextOwnerSegment } from '../out-test/shared/context.js';
import { tasksUnderGoal } from '../out-test/shared/goal-entity.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m2-2-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const CP_BASE = path.join(USER_DATA, 'context-checkpoints');
const CP_OWNERS = path.join(CP_BASE, 'owners', 'agent-task');
const CP_ARCHIVE = path.join(CP_BASE, 'archive', 'agent-task');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKSPACE = path.join(os.tmpdir(), `tf-m2-2-ws-${String(Date.now())}`);
const PROBE_A = 'M2-2 检查点续跑探针';
const PROBE_B = 'M2-2 未知缺口重规划探针';
/** 探针 A 的写步骤数：够多才能保证暂停点后面还剩步骤，而不是整份计划已跑完。 */
const A_WRITE_STEPS = 12;
/** 暂停触发点：第 4 个写步骤落地就停手，剩下 8 步留给续跑。 */
const A_PAUSE_AFTER = 'write-4';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333 / SIGKILL 后重启',
  workspace: WORKSPACE,
  checks: {},
  shots: [],
  before: null,
  afterSweep: null,
  staleProbes: [],
  probeA: null,
  probeB: null,
  continued: null,
  replanned: null,
  pauseLedger: {},
  eventTail: {},
  cleanup: [],
  statusSequences: {},
  statusAfterResume: {},
  uiText: {},
  reportA: null,
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

function storedTask(id) {
  return (readStore().tasks ?? []).find(item => item.taskId === id) ?? null;
}

function checkpointFile(taskId) {
  return path.join(CP_OWNERS, `${contextOwnerSegment(taskId)}.json`);
}

/**
 * 段名口径必须与产品一致：`ContextCheckpointStore.listOwnerSegments()` 去掉 `.json`
 * 之后才和 `contextOwnerSegment(taskId)` 可比。带着扩展名比会把每一条活任务的残留
 * 都当成孤儿（真机第一轮就是这么假红的）。
 */
function listSegments(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .sort();
  } catch { return []; }
}

/**
 * 暂停检查点里那条实测账本：`commitPauseCheckpoint` 把它写进
 * summary.constraints 的「工具执行状态：…applied A / missing M / needs_reconciliation R」。
 * 判据读磁盘上真正落库的那份，不从事件里抄一遍数字。
 */
function pauseLedgerOf(taskId) {
  try {
    const file = JSON.parse(fs.readFileSync(checkpointFile(taskId), 'utf8'));
    const last = (file.checkpoints ?? []).at(-1);
    const line = (last?.summary?.constraints ?? []).find(text => String(text).includes('副作用核对'));
    const nums = String(line ?? '').match(/applied (\d+) \/ missing (\d+) \/ needs_reconciliation (\d+)/);
    return {
      checkpointId: last?.checkpointId ?? null,
      line: line ?? null,
      applied: nums ? Number(nums[1]) : null,
      missing: nums ? Number(nums[2]) : null,
      needsReconciliation: nums ? Number(nums[3]) : null
    };
  } catch {
    return { checkpointId: null, line: null, applied: null, missing: null, needsReconciliation: null };
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

/** build=true 只用于第一次：重启阶段必须跑同一份编译产物、同一份 store。 */
async function startDev(build) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (build) {
    // agent runtime 由 build:agent 单独编译；判据还要 import out-test 里的口径函数。
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
  if (signal === 'SIGKILL') {
    child = null;
    await waitForPortFree(Date.now() + 25000);
    return;
  }
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
 * 连上应用自己的渲染进程。
 *
 * 第一轮 dev 启动常会触发 vite 依赖重新预构建（日志里那句
 * "Re-optimizing dependencies because vite config has changed"），页面会整页重载，
 * 只等一次 40s 就会把「还没注入」误判成「没有渲染进程」。所以这里对目标列表
 * 整轮重试，每个目标单独给足时间。
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
  // 相对验收目录，不是相对 ROOT：EVIDENCE.md 就在验收目录里渲染，`../docs/…` 会指到不存在的层级。
  evidence.shots.push(path.relative(OUT_DIR, file));
}

/**
 * 打开工程工作台页签。
 *
 * 页签文案在会话页与工作台里重复出现，只按文案找会点到会话页那一排，于是工作台根本没切过去，
 * 界面断言就变成「投影有、界面 0 条」这种假失败（口径同 verify-v4-p1-m1-cdp.mjs）。
 */
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
 * 读工作台某个页签里的可见文字，并把面板里每条详情展开。
 *
 * 页签口径（`EngineeringWorkbenchBar.tsx:15`）：执行时间线挂在「输出」（`output`），
 * 对话流挂在「对话」（`conversation`），「轨迹」是阶段先后关系、不含这两类文案——
 * 2026-11-28 第一次就按「轨迹」找，读回来是空串，把已经渲染出来的文案判成没渲染。
 *
 * 详情是 `<details>` 里的 JSON，收起时 innerText 取不到；AGENTS.md §8 要求「详情检查入口」
 * 真能在界面上点开，所以展开与读取必须在同一次 evaluate 里：探针 B 这时还在出事件，
 * React 一重渲染就会把 `<details>` 收回，分两步读就成了「详情明明有、界面读不到」。
 */
async function tabText(label) {
  if (!(await openTab(label))) {
    // 页签没找到时把现存的页签名记进证据：否则「读回来是空」分不清是没切过去还是面板没渲染。
    evidence.uiText.tabLabels = await ev(`(() => {
      const scope = document.querySelector('.wb-tabs');
      return scope ? [...scope.querySelectorAll('button[role="tab"]')].map(node => (node.textContent ?? '').trim()).join('|') : '没有 .wb-tabs（工作台没打开？）';
    })()`).catch(() => 'evaluate 失败');
    return '';
  }
  return waitFor(async () => {
    const text = await ev(`(() => {
      document.querySelectorAll('details').forEach(node => { node.open = true; });
      return document.body.innerText;
    })()`);
    return typeof text === 'string' && text.trim().length > 0 ? text : null;
  }, `${label}页签渲染`, 30000).catch(() => '');
}

/**
 * 从界面文字里按关键词取整行。
 *
 * 证据里存「正文前 6000 字」是没用的：正文比这长得多，判据命中的行会被截掉，
 * 事后翻 evidence.json 只看到一排 MISS，分不清界面真没渲染还是取证取错了。
 */
function uiLines(text, keyword) {
  return String(text).split('\n').filter(line => line.includes(keyword)).slice(0, 8);
}

/**
 * 把界面里第一条含该文案的行滚进视口，并回答「这行到底在不在行集合里」。
 *
 * `innerText` 命中只说明 DOM 里有这段文字；「输出」页一屏装不下 184 条事件，
 * 截图里看不到那句里程碑，就等于没交付「界面可核对」。滚一次，截图与判据同时成立。
 */
async function scrollUiRowIntoView(keyword) {
  return ev(`(() => {
    const nodes = [...document.querySelectorAll('.execution-timeline .exec-list > *, .chat-note')];
    const target = nodes.find(node => (node.textContent ?? '').includes(${JSON.stringify(keyword)}));
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    return true;
  })()`);
}

/** 侧栏行的 title 来自任务标题，可能是「工作流：…」原文，也可能是模型给的短标题：两种都试。 */
async function selectTaskRow(...markers) {
  const list = markers.filter(marker => typeof marker === 'string' && marker.trim());
  const hit = await waitFor(async () => ev(`(() => {
    const markers = ${JSON.stringify(list)};
    const rows = [...document.querySelectorAll('.task-item')];
    const row = rows.find(node => markers.some(marker =>
      (node.getAttribute('title') ?? '').includes(marker) ||
      (node.querySelector('.task-title')?.textContent ?? '').includes(marker)));
    if (!row) return null;
    row.click();
    return row.getAttribute('title') ?? row.textContent ?? '';
  })()`), `侧栏出现「${list[0]}」`, 30000).catch(() => null);
  if (!hit) return false;
  await sleep(600);
  return true;
}

const getTask = id => ev(`window.agentAPI.getTask(${JSON.stringify(id)})`, 20000);
const taskEvents = id => ev(`window.agentAPI.getTaskEvents(${JSON.stringify(id)})`, 40000) ?? [];

/** 固定工作流要过审批门：完全权限自动批，但分解门禁可能把它留在 awaiting_approval。 */
async function runWorkflowAndExecute(payload, label) {
  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify(payload)})`, 60000);
  const taskId = created?.taskId;
  assert.ok(taskId, `${label} 任务没创建出来：${JSON.stringify(created)}`);
  const approved = await waitFor(async () => {
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
  return { taskId, approved };
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

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(LOG, { force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // ── 动磁盘前先把现状整份留档，验收目录里能还原 ──
  evidence.before = {
    tasks: (readStore().tasks ?? []).length,
    goals: (readStore().goals ?? []).map(goal => goal.goalId),
    ownerSegments: listSegments(CP_OWNERS),
    archiveSegments: listSegments(CP_ARCHIVE)
  };
  const backup = path.join(OUT_DIR, 'context-checkpoints.before.tgz');
  if (fs.existsSync(CP_BASE)) {
    execFileSync('tar', ['-czf', backup, '-C', CP_BASE, '.'], { stdio: 'inherit' });
  }
  const storeBackup = path.join(OUT_DIR, 'agent-store.before.json');
  fs.copyFileSync(STORE, storeBackup);
  evidence.backups = { checkpoints: path.relative(OUT_DIR, backup), store: path.relative(OUT_DIR, storeBackup) };

  // 上一轮失败留下的探针任务会干扰判据（同名行、残留检查点），取样之后再清。
  evidence.staleProbes = (readStore().tasks ?? [])
    .filter(task => [task.title, task.prompt, task.userPrompt].some(text =>
      String(text ?? '').includes('M2-2 ')))
    .map(task => task.taskId);

  await startDev(true);
  cdp = await connectRenderer();
  note('renderer-ready', true, 'CDP 已连接');

  // ── ① 启动扫描：只收无人认领的残留 ──
  // 必须在删探针之前取样，否则「删除时回收」会把数字算到启动扫描头上。
  await sleep(3000);
  const tasksAtSweep = readStore().tasks ?? [];
  const liveSegments = new Set(tasksAtSweep.map(task => contextOwnerSegment(task.taskId)));
  evidence.afterSweep = {
    ownerSegments: listSegments(CP_OWNERS),
    archiveSegments: listSegments(CP_ARCHIVE),
    goals: (readStore().goals ?? []).map(goal => goal.goalId),
    tasks: tasksAtSweep.length
  };
  const survivors = evidence.afterSweep.ownerSegments.filter(name => !liveSegments.has(name));
  note('startup-sweep-removed-orphans', survivors.length === 0,
    `扫前 ${String(evidence.before.ownerSegments.length)} 个归属文件 → 扫后 ${String(evidence.afterSweep.ownerSegments.length)} 个；`
    + `扫后仍无人认领的：${survivors.length ? survivors.join(', ') : '无'}`);
  const goalSurvivors = (readStore().goals ?? []).filter(
    goal => tasksUnderGoal(goal.goalId, tasksAtSweep).length === 0
  ).map(goal => goal.goalId);
  note('startup-sweep-removed-orphan-goals', goalSurvivors.length === 0,
    `扫前 ${String(evidence.before.goals.length)} 条目标 → 扫后 ${String(evidence.afterSweep.goals.length)} 条（任务表 ${String(tasksAtSweep.length)} 条）；`
    + `扫后仍无任务绑定的：${goalSurvivors.length ? goalSurvivors.join(', ') : '无'}`);
  const keptForLive = evidence.afterSweep.ownerSegments.filter(name => liveSegments.has(name));
  note('startup-sweep-keeps-live-task-artifacts',
    tasksAtSweep.length === 0 || keptForLive.length > 0,
    `任务表 ${String(tasksAtSweep.length)} 条，其中 ${String(keptForLive.length)} 个归属文件被保留`
    + `${tasksAtSweep.length === 0 ? '（本轮任务表为空，活任务保留这条由 test:pause-checkpoint 覆盖）' : ''}`);

  for (const stale of evidence.staleProbes) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(stale)})`, 30000).catch(() => null);
  }

  // ── ② 续跑正例：fresh 检查点 + 账本无未知缺口 ──
  // 写步骤分两个目录：单一目录归纳不出 L2 子任务，会触发 GCE 分解门禁（只影响
  // 自动批准，脚本会自己点批准），但白多一次交互与一条 warn 事件。
  const aFiles = Array.from({ length: A_WRITE_STEPS }, (_, index) =>
    `${index < A_WRITE_STEPS / 2 ? 'd1' : 'd2'}/f${String(index + 1)}.txt`);
  const aPaths = aFiles.map(file => path.join(WORKSPACE, file));
  const createdA = await runWorkflowAndExecute({
    workflow: {
      id: 'm2-2-checkpoint-resume-probe',
      title: PROBE_A,
      nodes: [
        writeNode('seed-test', 'probe.test.mjs', [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import fs from 'node:fs';",
          "import path from 'node:path';",
          `const dir = ${JSON.stringify(WORKSPACE)};`,
          `test('暂停前写下的 ${A_PAUSE_AFTER} 仍然存在', () => {`,
          `  assert.ok(fs.existsSync(path.join(dir, 'd1/f4.txt')));`,
          '});',
          // 这份测试在暂停前就写好、收尾时才执行：断言 12 个写文件齐了，等于让收尾
          // 那一步亲自核对「续跑把剩下的步骤真跑了」，而不是靠脚本站在外面数文件。
          'test(\'续跑把暂停时剩下的写步骤都补完了\', () => {',
          `  const missing = ${JSON.stringify(aFiles)}.filter(file => !fs.existsSync(path.join(dir, file)));`,
          '  assert.deepEqual(missing, []);',
          '});',
          ''
        ].join('\n')),
        ...aFiles.map((file, index) => writeNode(`write-${String(index + 1)}`, file, `续跑证据 ${String(index + 1)}\n`)),
        {
          id: 'final-gate',
          capabilityId: 'shell.run',
          title: '跑探针自带断言：续跑把整份计划收尾的证据',
          // 必须点名文件：这里的 node 对 `node --test .` 回的是「Could not find '.'」，
          // 目录写法会让收尾永远以退出码 1 失败，把续跑的真实结局盖成一条假红。
          args: { command: 'node --test probe.test.mjs', cwd: WORKSPACE, timeoutMs: 60000 }
        }
      ]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: 'M2-2 重启后从检查点续跑真机探针'
  }, '探针 A');
  const taskA = createdA.taskId;
  const taskAInfo = await getTask(taskA);
  evidence.probeA = { taskId: taskA, autoApproved: createdA.approved === 'executing', files: aFiles };

  // 暂停点：跑到第 4 步就停手，剩下的步骤必须留给续跑，否则「都跑完了」会直接转重规划。
  const aEvents = () => taskEvents(taskA);
  await waitFor(async () => (await aEvents()).find(event =>
    event.type === 'step.completed' && event.stepId === A_PAUSE_AFTER) ?? null,
  `探针 A 跑到 ${A_PAUSE_AFTER}`, 120000);
  await pauseWhileExecuting(taskA, '探针 A');

  const pausedA = await getTask(taskA);
  const pauseEventA = (await aEvents()).filter(event => event.type === 'context.checkpoint.paused').at(-1);
  evidence.pauseLedger.A = pauseLedgerOf(taskA);
  assert.ok(pauseEventA?.checkpointId, '暂停没有落检查点');
  note('A-pause-checkpoint-committed',
    pausedA?.checkpointId === pauseEventA.checkpointId && pausedA?.contextId === pauseEventA.contextId &&
    pausedA?.activeRunId === pauseEventA.activeRunId && fs.existsSync(checkpointFile(taskA)),
    `指针 ${JSON.stringify({ contextId: pausedA?.contextId, checkpointId: pausedA?.checkpointId, activeRunId: pausedA?.activeRunId })}`
    + `｜磁盘 ${path.relative(USER_DATA, checkpointFile(taskA))}｜文件里的 checkpointId=${String(evidence.pauseLedger.A.checkpointId)}`);
  note('A-pause-ledger-has-no-gap',
    evidence.pauseLedger.A.missing === 0 && evidence.pauseLedger.A.needsReconciliation === 0 &&
    evidence.pauseLedger.A.applied >= 1 && pauseEventA?.needsReconciliation === 0,
    `检查点里的账本：${String(evidence.pauseLedger.A.line ?? '读不到')}｜暂停事件 needsReconciliation=${String(pauseEventA?.needsReconciliation ?? null)}`);
  // 用户点的是「暂停」，Runtime 回的是 status='cancelled' 那份报告：收尾流程不能把
  // paused 带去 cancelled，否则「继续」按钮根本点不动（本轮修的产品缺陷之二）。
  const settled = await getTask(taskA);
  await sleep(4000);
  const afterReportA = await getTask(taskA);
  evidence.statusSequences.A_pause = (await aEvents())
    .filter(event => event.type === 'task.updated' && event.task?.taskId === taskA)
    .map(event => event.task.status)
    .filter((status, index, all) => index === 0 || status !== all[index - 1]);
  note('A-paused-survives-late-cancel-report',
    settled?.status === 'paused' && afterReportA?.status === 'paused' &&
    !evidence.statusSequences.A_pause.includes('cancelled'),
    `暂停落地后 ${String(settled?.status)}，再等 4s（报告收尾应已到）→ ${String(afterReportA?.status)}；状态序列 ${evidence.statusSequences.A_pause.join(' → ')}`);
  note('ui-shows-paused-probe', await selectTaskRow(PROBE_A, taskAInfo?.title, taskA),
    '侧栏选中探针 A（界面要能核对暂停态与计划进度）');
  await shot('01-A-paused-with-checkpoint.png');

  // 强退 + 重启：恢复只能靠磁盘上的检查点，内存里什么都没了。
  await stopDev('SIGKILL');
  note('A-forced-exit', true, 'SIGKILL 后端口已释放');
  await startDev(false);
  cdp = await connectRenderer();
  const restartedA = await waitFor(async () => {
    const current = await getTask(taskA);
    return current && current.status !== 'planning' ? current : null;
  }, '重启后探针 A 可读', 150000);
  note('A-restarted-resumable',
    ['paused', 'interrupted'].includes(restartedA?.status) && restartedA?.resumeStatus === 'executing' &&
    Boolean(restartedA?.checkpointId),
    `状态 ${String(restartedA?.status)}，resumeStatus=${String(restartedA?.resumeStatus ?? null)}，checkpointId=${String(restartedA?.checkpointId ?? null)}`);
  // 回收只删「任务表里查不到」的段——本轮开头任务表是空的，那条保留判据其实是空跑，
  // 真机这一跳才是「活任务的归属文件必须穿过启动扫描」的正面证据。
  note('startup-sweep-keeps-paused-live-task', fs.existsSync(checkpointFile(taskA)),
    `重启后 owners/agent-task/${taskA}.json 仍在：${String(fs.existsSync(checkpointFile(taskA)))}｜任务表 ${(readStore().tasks ?? []).length} 条`);

  const resumeAt = Date.now();
  // 恢复本身报错要记 FAIL，但不能因此跳过探针 B 与收尾回收：那是另一条路径的证据。
  // 2026-11-28 真机就是这样炸的——Runtime 报告带 reusedFrom，契约校验判非法，
  // resumeTask 抛错，整轮只剩半份证据。
  let resumeError = null;
  try {
    // `task:resume` 的 IPC 回包要等续跑这一轮执行完（上一轮报告落地才返回），
    // 12 步 + 收尾命令远不止 30 秒；超时不是缺陷，判据看下面的事件与报告。
    await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskA)})`, 300000);
  } catch (error) {
    resumeError = String(error?.message ?? error).slice(0, 600);
  }
  note('A-resume-ipc-accepted', resumeError === null, resumeError ?? 'resumeTask 正常返回');
  const aResumeEvent = await waitFor(async () => (await aEvents()).find(event =>
    event.type === 'context.event' &&
    (event.event === 'context.resume.continued' || event.event === 'context.resume.replanned') &&
    event.at >= resumeAt - 2000) ?? null, '探针 A 恢复打点', 90000);
  evidence.continued = {
    event: aResumeEvent?.event ?? null,
    at: aResumeEvent?.at ?? null,
    context: aResumeEvent?.context ?? null
  };
  note('A-resume-takes-continuation', aResumeEvent?.event === 'context.resume.continued',
    `实际 ${String(aResumeEvent?.event ?? null)}；理由 ${JSON.stringify(aResumeEvent?.context?.resume?.reasons ?? [])}`);
  note('A-resume-reads-the-pause-checkpoint',
    aResumeEvent?.context?.checkpointId === pausedA?.checkpointId,
    `恢复用的是 ${String(aResumeEvent?.context?.checkpointId ?? null)}（暂停点 ${String(pausedA?.checkpointId ?? null)}）`);

  const resumeList = await aEvents();
  // 事件每读一次都是重新解析出来的新对象，`event === aResumeEvent` 永远不成立；
  // 上一轮就是因此拿到 -1，把整条事件流当成「恢复之后」，几条判据全在空转。
  const resumeIndex = resumeList.findIndex(event =>
    event.type === 'context.event' && event.at === aResumeEvent?.at && event.event === aResumeEvent?.event);
  const markerAt = aResumeEvent?.at ?? 0;
  const afterResume = resumeIndex >= 0
    ? resumeList.slice(resumeIndex + 1)
    : resumeList.filter(event => (event.at ?? 0) > markerAt);
  note('A-resume-marker-located-in-event-stream', resumeIndex >= 0,
    `恢复打点在事件流下标 ${String(resumeIndex)}（共 ${String(resumeList.length)} 条，按 at=${String(markerAt)} 取后段 ${String(afterResume.length)} 条）`);
  const planReadyBefore = resumeList.find(event => event.type === 'plan.ready');
  // 事件流按任务配额裁剪过，早先的 plan.ready 可能已被删；任务字段上的
  // currentPlanId 就是被中断那份计划，两个来源取一个能用的。
  const pausedPlanId = planReadyBefore?.plan?.planId ?? pausedA?.currentPlanId ?? null;
  const isExec = event => ['step.reused', 'step.started'].includes(event.type);
  const isPlanning = event => ['round.started', 'plan.ready'].includes(event.type);
  const firstExecIdx = afterResume.findIndex(isExec);
  const firstAnyIdx = afterResume.findIndex(event => isExec(event) || isPlanning(event));
  const execTail = afterResume[firstAnyIdx];
  note('A-first-event-after-checkpoint-is-step-not-planning',
    firstAnyIdx >= 0 && firstAnyIdx === firstExecIdx,
    `恢复打点之后第一个执行/规划事件：${String(execTail?.type ?? '无')}（${String(execTail?.stepId ?? '')}）`
    + `｜第一个规划类事件在下标 ${String(afterResume.findIndex(isPlanning))}`);
  evidence.eventTail.A = [
    `marker:${String(aResumeEvent?.event ?? '无')}`,
    ...afterResume.slice(0, 16).map(event =>
      `${event.type}${event.stepId ? `:${event.stepId}` : ''}${event.planId ? `@${String(event.planId).slice(-6)}` : ''}`)
  ];
  const reusedA = afterResume.filter(event => event.type === 'step.reused');
  note('A-reused-steps-carry-the-checkpoint-id',
    reusedA.length >= 4 && reusedA.every(event => event.checkpointId === pausedA?.checkpointId) &&
    reusedA.every(event => Number.isFinite(event.executedAt) && event.executedAt > 0),
    `复用 ${String(reusedA.length)} 步：${reusedA.map(event => event.stepId).join(', ')}｜执行时间戳都在`);
  const resumed = aResumeEvent?.context?.resume ?? null;
  note('A-reuses-interrupted-plan',
    resumed !== null && resumed.planId === pausedPlanId &&
    afterResume.filter(event => event.type === 'step.started')
      .every(event => (resumed.pendingStepIds ?? []).includes(event.stepId)),
    `续跑 planId=${String(resumed?.planId ?? null)} 与被中断那份计划一致（暂停时任务上的 ${String(pausedPlanId ?? null)}）；`
    + `复用 ${JSON.stringify(resumed?.reusedStepIds ?? [])}，续跑 ${JSON.stringify(resumed?.pendingStepIds ?? [])}`);
  note('A-no-round-opened-by-resume',
    firstAnyIdx >= 0 && afterResume.slice(0, firstAnyIdx).every(event => !isPlanning(event)) &&
    (resumed?.reusedStepIds ?? []).length >= 4 &&
    (resumed?.pendingStepIds ?? []).length >= 2,
    `恢复打点到第一个执行事件之间没有 round.started / plan.ready；打点之后 round.started 共 ${String(afterResume.filter(event => event.type === 'round.started').length)} 条`);

  await waitFor(async () => (fs.existsSync(aPaths[A_WRITE_STEPS - 1]) ? 'written' : null),
    `续跑写出 ${aFiles[A_WRITE_STEPS - 1]}`, 240000).catch(() => null);
  // 收尾步骤要么跑完要么明确失败，两种都要拿到：只看 completed 时，失败会让这条判据
  // 变成「等不到」，看起来像续跑没做完。
  const gateEvent = await waitFor(async () => (await aEvents()).find(event =>
    event.stepId === 'final-gate' && ['step.completed', 'step.failed'].includes(event.type)) ?? null,
  '探针 A 收尾步骤有结局', 240000).catch(() => null);
  note('A-remaining-steps-actually-ran',
    aPaths.every(file => fs.existsSync(file)) && gateEvent?.type === 'step.completed' &&
    gateEvent?.result?.exitCode === 0,
    `${aFiles.length} 个写步骤文件都在；收尾 shell.run ${String(gateEvent?.type ?? '无结局')}，退出码 ${String(gateEvent?.result?.exitCode ?? null)}`
    + `${gateEvent?.error ? `，错误 ${String(gateEvent.error).slice(0, 160)}` : ''}`);

  // 续跑那份报告（落磁盘的那份，不抄事件）：复用的步骤必须还原成上轮的真实结果，
  // 否则「报告 completed 但交付文件少一截」——schema 拒掉 reusedFrom 时这里必然为空。
  const finishedA = await waitFor(async () => {
    const reports = (readStore().reports ?? []).filter(report => report.taskId === taskA);
    const withReuse = reports.map(report => ({
      roundId: report.roundId,
      planId: report.planId,
      status: report.status,
      verified: report.verification?.verified ?? null,
      fullyVerified: report.verification?.fullyVerified ?? null,
      results: (report.results ?? []).map(item =>
        `${item.stepId}:${item.status}${item.reusedFrom ? '(复用)' : ''}${typeof item.result?.exitCode === 'number' ? `#${String(item.result.exitCode)}` : ''}`)
    })).find(report => report.results.some(line => line.endsWith('(复用)') || line.includes('(复用)#'))) ?? null;
    return withReuse;
  }, '探针 A 续跑报告落库', 240000).catch(() => null);
  evidence.reportA = finishedA;
  evidence.statusAfterResume.A = (await aEvents())
    .filter(event => event.type === 'task.updated' && (event.at ?? 0) >= markerAt)
    .map(event => event.task?.status)
    .filter((status, index, all) => index === 0 || status !== all[index - 1]);
  const reusedInReport = (finishedA?.results ?? []).filter(line => line.includes('(复用)'));
  note('A-resumed-report-restores-reused-steps',
    reusedInReport.length >= 4 && reusedInReport.every(line => line.includes(':completed')),
    `报告 ${String(finishedA?.roundId ?? '无')}（计划 ${String(finishedA?.planId ?? null).slice(-6)}，${String(finishedA?.status ?? '无')}）里标了复用的步骤：`
    + `${reusedInReport.join(' ') || '无'}｜整份 ${JSON.stringify(finishedA?.results ?? [])}`);
  note('A-resume-completes-with-verified-report',
    finishedA !== null && !['failed', 'blocked'].includes(storedTask(taskA)?.status),
    `任务状态 ${String(storedTask(taskA)?.status)}，续跑后的状态序列 ${evidence.statusAfterResume.A.join(' → ') || '无'}`);
  note('ui-shows-resumed-probe', await selectTaskRow(PROBE_A, taskAInfo?.title, taskA), '侧栏选中探针 A');
  await shot('02-A-resumed-from-checkpoint.png');
  // 界面核对（AGENTS.md §8）：暂停留下了哪份检查点、恢复走的是续跑还是重规划，必须能在界面上
  // 读到并点开详情。只写进投影单测的话，用户端仍然是「只能去翻磁盘文件」。
  const outputA = await tabText('输出');
  evidence.uiText.outputA = {
    chars: outputA.length,
    checkpoint: uiLines(outputA, '暂停已提交检查点'),
    resume: uiLines(outputA, '已从检查点续跑'),
    reused: uiLines(outputA, '复用自上次执行')
  };
  note('ui-timeline-shows-pause-checkpoint-and-continuation',
    /暂停已提交检查点 cp_/.test(outputA) && /已从检查点续跑：沿用已批准计划/.test(outputA) &&
    /复用自上次执行/.test(outputA),
    `检查点行 ${outputA.match(/暂停已提交检查点 \S+/)?.[0] ?? '无'}｜续跑行 ${outputA.match(/已从检查点续跑[^\n]*/)?.[0] ?? '无'}`
    + `｜「复用自上次执行」出现 ${String((outputA.match(/复用自上次执行/g) ?? []).length)} 次`);
  const scrolledResume = await scrollUiRowIntoView('已从检查点续跑');
  await shot('05-A-output-timeline-checkpoint.png');
  note('ui-resume-milestone-is-a-row-in-output-panel', scrolledResume === true,
    '「已从检查点续跑」是输出页时间线里的一行，截图前已滚进视口（时间线一屏装不下 184 条事件）');
  const conversationA = await tabText('对话');
  evidence.uiText.conversationA = {
    chars: conversationA.length,
    checkpoint: uiLines(conversationA, '暂停已提交检查点'),
    resume: uiLines(conversationA, '已从检查点续跑')
  };
  note('ui-conversation-shows-context-notes-on-resume',
    /暂停已提交检查点 cp_/.test(conversationA) && /已从检查点续跑/.test(conversationA),
    `对话流检查点行 ${conversationA.match(/暂停已提交检查点 \S+/)?.[0] ?? '无'}｜续跑行 `
    + `${conversationA.match(/已从检查点续跑[^\n]*/)?.[0] ?? '无'}`);
  const scrolledNote = await scrollUiRowIntoView('已从检查点续跑');
  await shot('06-A-conversation-context-notes.png');
  note('ui-context-note-is-a-row-in-conversation', scrolledNote === true,
    '「已从检查点续跑」在对话流里是一条 chat-note，截图前已滚进视口');

  // ── ③ 重规划反例：暂停时留一个「起了但没有路径可核对」的在途写 ──
  const lateFile = path.join(WORKSPACE, 'late-from-killed-shell.txt');
  const createdB = await runWorkflowAndExecute({
    workflow: {
      id: 'm2-2-unknown-gap-probe',
      title: PROBE_B,
      nodes: [
        writeNode('write-1', 'b1.txt', 'step-1\n'),
        {
          id: 'long-shell',
          capabilityId: 'shell.run',
          title: '长命令：强退时它到底写没写过后到文件，无人能核对',
          args: {
            command: `echo began; sleep 30; echo late > ${JSON.stringify(lateFile)}`,
            cwd: WORKSPACE,
            timeoutMs: 60000
          }
        },
        writeNode('write-3', 'b3.txt', 'never-reached\n')
      ]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: WORKSPACE,
    goal: 'M2-2 未知副作用缺口必须回到重规划的真机探针'
  }, '探针 B');
  const taskB = createdB.taskId;
  const taskBInfo = await getTask(taskB);
  evidence.probeB = { taskId: taskB, lateFile: path.basename(lateFile) };
  const bEvents = () => taskEvents(taskB);
  await waitFor(async () => (await bEvents()).find(event =>
    event.type === 'step.started' && event.stepId === 'long-shell') ?? null, '探针 B 的 shell 步骤开始', 120000);
  await pauseWhileExecuting(taskB, '探针 B');

  const pauseEventB = (await bEvents()).filter(event => event.type === 'context.checkpoint.paused').at(-1);
  evidence.pauseLedger.B = pauseLedgerOf(taskB);
  note('B-pause-checkpoint-reports-gap',
    Boolean(pauseEventB?.checkpointId) &&
    ((pauseEventB?.needsReconciliation ?? 0) > 0 || (evidence.pauseLedger.B.needsReconciliation ?? 0) > 0),
    `暂停事件 needsReconciliation=${String(pauseEventB?.needsReconciliation ?? null)}；检查点账本 ${String(evidence.pauseLedger.B.line ?? '读不到')}`);
  evidence.statusSequences.B_pause = (await bEvents())
    .filter(event => event.type === 'task.updated' && event.task?.taskId === taskB)
    .map(event => event.task.status)
    .filter((status, index, all) => index === 0 || status !== all[index - 1]);
  note('ui-shows-paused-gap-probe', await selectTaskRow(PROBE_B, taskBInfo?.title, taskB), '侧栏选中探针 B');
  await shot('03-B-paused-with-unknown-gap.png');

  await stopDev('SIGKILL');
  await startDev(false);
  cdp = await connectRenderer();
  const resumeAtB = Date.now();
  let resumeErrorB = null;
  try {
    await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskB)})`, 30000);
  } catch (error) {
    resumeErrorB = String(error?.message ?? error).slice(0, 600);
  }
  note('B-resume-ipc-accepted', resumeErrorB === null, resumeErrorB ?? 'resumeTask 正常返回');
  const bResumeEvent = await waitFor(async () => (await bEvents()).find(event =>
    event.type === 'context.event' &&
    (event.event === 'context.resume.continued' || event.event === 'context.resume.replanned') &&
    event.at >= resumeAtB - 2000) ?? null, '探针 B 恢复打点', 90000);
  evidence.replanned = {
    event: bResumeEvent?.event ?? null,
    at: bResumeEvent?.at ?? null,
    context: bResumeEvent?.context ?? null
  };
  const bReasons = [
    String(bResumeEvent?.context?.reason ?? ''),
    ...(bResumeEvent?.context?.resume?.reasons ?? [])
  ];
  note('B-resume-falls-back-to-replan', bResumeEvent?.event === 'context.resume.replanned',
    `实际 ${String(bResumeEvent?.event ?? null)}；理由 ${bReasons.join(' / ')}`);
  note('B-replan-reason-names-the-gap',
    bReasons.some(line => /结局未知且无路径可核对/.test(line)),
    bReasons.join(' / '));
  const bTail = await waitFor(async () => (await bEvents()).find(event =>
    event.type === 'round.started' && (event.at ?? 0) >= (bResumeEvent?.at ?? 0)) ?? null,
  '反例新开一轮规划', 90000).catch(() => null);
  note('B-replan-opens-new-round', Boolean(bTail),
    bTail ? `新轮 ${String(bTail.roundId ?? '')}；任务状态 ${String((await getTask(taskB))?.status)}` : '没等到 round.started');
  // 被强退的 shell 到底有没有把文件写出来，取决于孤儿进程的下场——这恰恰是
  // 「无路径可核对就不能续跑」的理由本身，只记事实，不当判据。
  evidence.probeB.lateFileAppearedAfterKill = fs.existsSync(lateFile);
  note('ui-shows-replanned-probe', await selectTaskRow(PROBE_B, taskBInfo?.title, taskB), '侧栏选中探针 B');
  await shot('04-B-replanned-with-unknown-gap.png');
  // 反例同样要在界面可核对：被迫重规划要说成提醒色那条文案，且详情里点名是哪一步结局未知。
  const outputB = await tabText('输出');
  evidence.uiText.outputB = {
    chars: outputB.length,
    checkpoint: uiLines(outputB, '暂停已提交检查点'),
    replan: uiLines(outputB, '已重新规划'),
    gapReason: uiLines(outputB, '无路径可核对')
  };
  note('ui-timeline-shows-replan-naming-the-gap',
    /暂停已提交检查点 cp_/.test(outputB) && /已重新规划/.test(outputB) &&
    /结局未知且无路径可核对/.test(outputB),
    `检查点行 ${outputB.match(/暂停已提交检查点 \S+/)?.[0] ?? '无'}｜重规划行 ${outputB.match(/已重新规划[^\n]*/)?.[0] ?? '无'}`
    + `｜详情点名 ${outputB.match(/无路径可核对[：:][^\n]*/)?.[0]?.slice(0, 80) ?? '无'}`);
  const scrolledReplan = await scrollUiRowIntoView('已重新规划');
  await shot('07-B-output-timeline-replan.png');
  note('ui-replan-milestone-is-a-row-in-output-panel', scrolledReplan === true,
    '「已重新规划：检查点不足以安全续跑」是输出页时间线里的一行，截图前已滚进视口');
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskB)})`, 30000).catch(() => null);
  await sleep(2000);

  // ── ④ 删除任务时的回收（真磁盘） ──
  for (const [tag, title, id] of [['A', PROBE_A, taskA], ['B', PROBE_B, taskB]]) {
    const beforeFile = fs.existsSync(checkpointFile(id));
    const goalId = storedTask(id)?.goalId ?? null;
    const cleanup = await ev(`window.agentAPI.deleteTask(${JSON.stringify(id)})`, 30000);
    evidence.cleanup.push({ tag, taskId: id, checkpointExistedBeforeDelete: beforeFile, goalId, cleanup });
    note(`${tag}-delete-reclaims-checkpoint`,
      beforeFile
        ? cleanup?.checkpointsRemoved === true && !fs.existsSync(checkpointFile(id))
        // 探针 B 可能从没落过检查点以外的情形：没文件可回收时也必须报 false，不能凭空报「已回收」。
        : cleanup?.checkpointsRemoved === false,
      `删前文件 ${String(beforeFile)}，回收结果 ${JSON.stringify(cleanup)}`);
    note(`${tag}-delete-reclaims-goal`,
      !goalId || !(readStore().goals ?? []).some(goal => goal.goalId === goalId),
      `目标 ${String(goalId)} 还在不在：${String((readStore().goals ?? []).some(goal => goal.goalId === goalId))}`);
  }

  const liveNow = new Set((readStore().tasks ?? []).map(task => contextOwnerSegment(task.taskId)));
  const leftover = listSegments(CP_OWNERS).filter(name => !liveNow.has(name));
  note('disk-has-no-orphan-after-run', leftover.length === 0,
    leftover.length ? `残留 ${leftover.join(', ')}` : '探针之外没有无人认领的归属文件');
  const stillThere = (readStore().tasks ?? []).filter(task => [taskA, taskB].includes(task.taskId));
  note('probe-tasks-cleaned-up', stillThere.length === 0,
    `任务数 ${String(evidence.before.tasks)} → ${String((readStore().tasks ?? []).length)}`);
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
    '# V4 P1 M2-2 真机验收：从检查点续跑成为常规路径',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 环境：${evidence.mode}`,
    `- 工作区：\`${WORKSPACE}\`（探针只在这里写文件）`,
    `- 探针任务：A 续跑 \`${evidence.probeA?.taskId ?? '未创建'}\`、B 反例 \`${evidence.probeB?.taskId ?? '未创建'}\`（收尾已删除）`,
    `- 备份：${evidence.backups?.checkpoints ?? '未生成'}、${evidence.backups?.store ?? '未生成'}`,
    '',
    '## 扫盘前 → 启动扫描后',
    '',
    '```json',
    JSON.stringify({ before: evidence.before, afterSweep: evidence.afterSweep, staleProbes: evidence.staleProbes }, null, 2),
    '```',
    '',
    '## 两条路径的暂停账本（读磁盘上的检查点，不抄事件）',
    '',
    '```json',
    JSON.stringify(evidence.pauseLedger, null, 2),
    '```',
    '',
    '## 两条路径的恢复打点',
    '',
    '```json',
    JSON.stringify({ continued: evidence.continued, replanned: evidence.replanned }, null, 2),
    '```',
    '',
    '## 恢复打点附近的事件序列',
    '',
    '```json',
    JSON.stringify(evidence.eventTail, null, 2),
    '```',
    '',
    '## 状态序列',
    '',
    '```json',
    JSON.stringify(evidence.statusSequences, null, 2),
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
