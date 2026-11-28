/**
 * M2-1 真机验收：检查点指针只有一个写者，恢复路径可观测。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据。
 * 跑两遍：
 * 1) 在跑的任务暂停 → 任务上的 contextId/checkpointId/activeRunId 必须与
 *    磁盘检查点文件逐项一致，且暂停事件带完整指针；
 * 2) 停进程、把探针任务的指针字段抹掉（模拟半套落库）、重启后点「继续」→
 *    恢复必须走事件流重建，并在 context.recovered 里标出 pointerSource。
 * 探针任务用完删除；抹字段前的整份 store 备份进验收目录。
 *
 * Run: node scripts/verify-v4-p1-m2-1-cdp.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'v4-p1-m2-1-20261128');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const CP_DIR = path.join(USER_DATA, 'context-checkpoints', 'owners', 'agent-task');
const LOG = path.join(OUT_DIR, 'dev.log');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const PROBE_TITLE = '工作流：M2-1 检查点指针探针';
const WRITTEN = path.join(os.tmpdir(), `tf-m2-1-written-${Date.now()}.txt`);
const LATE = path.join(os.tmpdir(), `tf-m2-1-late-${Date.now()}.txt`);

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333',
  checks: {},
  shots: [],
  taskId: null,
  pointer: null,
  checkpointFile: null,
  pauseEvent: null,
  statusSequence: [],
  replay: null
};
let child = null;
let cdp = null;
let taskId = null;

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean);
  } catch { return []; }
}

function taskIds() {
  if (!fs.existsSync(STORE)) return [];
  return (JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? [])
    .map(task => task.taskId ?? task.id).filter(Boolean).sort();
}

function readStoredTask(id) {
  if (!fs.existsSync(STORE)) return null;
  return (JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? [])
    .find(item => item.taskId === id) ?? null;
}

function readCheckpoint(id, checkpointId) {
  const file = path.join(CP_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const ownerFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (ownerFile.checkpoints ?? []).find(item => item.checkpointId === checkpointId) ?? null;
}

async function waitForEndpoint(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ENDPOINT);
      if (response.ok) return await response.json();
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error(`CDP ${ENDPOINT} 没有起来`);
}

async function waitForPortFree(deadline) {
  while (Date.now() < deadline) {
    if (listenersOn(PORT).length === 0) return true;
    await sleep(400);
  }
  return false;
}

async function waitFor(read, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(400);
  }
  throw new Error(`等待超时：${label}`);
}

async function startDev() {
  // agent runtime 由 build:agent 单独编译，只起 electron-vite 会跑上一版检查点链路。
  execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
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

async function killDev(signal = 'SIGTERM') {
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
  await waitForPortFree(Date.now() + 20000);
}

async function connectRenderer() {
  const targets = await waitForEndpoint(Date.now() + 120000);
  const candidates = targets.filter(item => item.type === 'page'
    && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
  for (const candidate of candidates) {
    const probe = await connect(candidate);
    const ready = await waitFor(async () => {
      try { return await probe.evaluate('typeof window.agentAPI', 5000, null) === 'object' ? 'ready' : null; }
      catch { return null; }
    }, `agentAPI 注入 ${candidate.url}`, 30000).catch(() => null);
    if (ready) return probe;
    probe.close();
  }
  throw new Error('没有找到注入 agentAPI 的渲染进程');
}

const ev = (expression, timeoutMs = 30000) => cdp.evaluate(expression, timeoutMs);
const state = () => taskId ? ev(`window.agentAPI.getTask(${JSON.stringify(taskId)})`, 20000) : null;
const events = () => taskId ? ev(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 30000) ?? [] : [];

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(ROOT, file));
}

async function selectProbeTask() {
  return ev(`(() => {
    const title = ${JSON.stringify(PROBE_TITLE)};
    const nodes = [...document.querySelectorAll('button, a, div, span')];
    const target = nodes.filter(node => (node.textContent ?? '').includes(title)).at(-1);
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

function pointerOf(task) {
  return {
    contextId: task?.contextId ?? null,
    checkpointId: task?.checkpointId ?? null,
    activeRunId: task?.activeRunId ?? null
  };
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用：先停掉现有实例`);
  fs.rmSync(WRITTEN, { force: true });
  fs.rmSync(LATE, { force: true });

  await startDev();
  cdp = await connectRenderer();
  note('renderer-ready', true, 'CDP 已连接');

  for (const old of (JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? [])
    .filter(item => item.title === PROBE_TITLE)) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(old.taskId)})`);
  }
  const before = taskIds();
  evidence.taskIdsBefore = before;

  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: {
      id: 'm2-1-checkpoint-pointer-probe',
      title: PROBE_TITLE,
      nodes: [
        {
          id: 'write-first',
          capabilityId: 'fs.writeFile',
          title: '先写一个文件，让检查点带上可核对的证据',
          args: { path: WRITTEN, content: 'written-before-pause' }
        },
        {
          id: 'long-shell',
          capabilityId: 'shell.run',
          title: '长命令，暂停后不得写出迟到文件',
          args: { command: `echo began; sleep 10; echo late > ${JSON.stringify(LATE)}`, timeoutMs: 40000 }
        }
      ]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: '/tmp',
    goal: 'M2-1 检查点指针一致性与恢复路径真机探针'
  })})`);
  taskId = created?.taskId;
  evidence.taskId = taskId;
  note('probe-task-created', Boolean(taskId), taskId);
  assert.ok(taskId, '探针任务没创建出来');

  await waitFor(async () => ['executing', 'plan_ready', 'awaiting_approval'].includes((await state())?.status)
    ? 'ready' : null, '探针进入执行态', 60000);
  await waitFor(async () => (await events()).find(event =>
    event.type === 'step.started' && event.tool === 'shell.run') ?? null, 'shell 步骤开始', 60000);

  await ev(`window.agentAPI.pauseTask(${JSON.stringify(taskId)})`, 30000);
  await waitFor(async () => (await state())?.status === 'paused' ? 'paused' : null, '任务暂停', 30000);

  // ── ① 指针一致性：界面读到的任务字段 = 磁盘上的检查点文件 ──
  const live = await state();
  const onDisk = readStoredTask(taskId);
  const pointer = pointerOf(live);
  evidence.pointer = pointer;
  evidence.statusSequence = (await events())
    .filter(event => event.type === 'task.updated' && event.task?.taskId === taskId)
    .map(event => event.task.status)
    .filter((status, index, all) => index === 0 || status !== all[index - 1]);

  note('pointer-fields-complete',
    Boolean(pointer.contextId) && Boolean(pointer.checkpointId) && Boolean(pointer.activeRunId),
    JSON.stringify(pointer));
  assert.ok(pointer.checkpointId && pointer.contextId && pointer.activeRunId,
    '任务指针字段不全：Journal 事务之外还有第二个写者');
  note('pointer-fields-persisted-to-store',
    JSON.stringify(pointerOf(onDisk)) === JSON.stringify(pointer),
    JSON.stringify(pointerOf(onDisk)));

  const checkpoint = readCheckpoint(taskId, pointer.checkpointId);
  evidence.checkpointFile = {
    file: path.join(CP_DIR, `${taskId}.json`),
    contextId: checkpoint?.contextId ?? null,
    runId: checkpoint?.runId ?? null,
    status: checkpoint?.status ?? null,
    constraints: checkpoint?.summary?.constraints ?? null,
    evidencePaths: (checkpoint?.summary?.evidence ?? []).map(item => item.path)
  };
  note('pointer-matches-checkpoint-file',
    Boolean(checkpoint) && checkpoint.contextId === pointer.contextId &&
    checkpoint.runId === pointer.activeRunId,
    `文件 contextId=${String(checkpoint?.contextId ?? null)} runId=${String(checkpoint?.runId ?? null)}`);
  assert.ok(checkpoint, '任务指针指向的检查点文件不存在');
  assert.equal(checkpoint.contextId, pointer.contextId);
  assert.equal(checkpoint.runId, pointer.activeRunId);

  // ── ② 暂停事件带完整指针（字段丢了也能靠它重建） ──
  const pauseEvent = (await events()).filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === taskId
  ).at(-1);
  evidence.pauseEvent = pauseEvent ?? null;
  note('pause-event-carries-full-pointer',
    pauseEvent?.contextId === pointer.contextId &&
    pauseEvent?.checkpointId === pointer.checkpointId &&
    pauseEvent?.activeRunId === pointer.activeRunId,
    `事件 contextId=${String(pauseEvent?.contextId ?? null)} activeRunId=${String(pauseEvent?.activeRunId ?? null)}`);
  assert.ok(pauseEvent, '没有 context.checkpoint.paused 事件');
  note('checkpoint-summary-truthful',
    (checkpoint.summary.constraints ?? []).some(line => line.includes('目标版本 v')) &&
    (checkpoint.summary.constraints ?? []).some(line => line.includes('任务树 revision')) &&
    (checkpoint.summary.constraints ?? []).some(line => line.includes('工具执行状态')),
    `${checkpoint.summary.constraints.join(' / ')} ｜ 证据 ${JSON.stringify(evidence.checkpointFile.evidencePaths)}`);

  await sleep(600);
  note('late-write-never-happened', !fs.existsSync(LATE), LATE);
  note('written-file-still-there', fs.existsSync(WRITTEN), WRITTEN);

  note('probe-task-selected-in-ui', Boolean(await selectProbeTask()), '任务详情页');
  await sleep(500);
  await shot('01-pointer-consistency.png');

  // ── ③ 半套指针：抹掉任务字段后重启，恢复必须走事件流重建 ──
  await killDev('SIGTERM');
  const backup = path.join(OUT_DIR, 'agent-store.before-strip.json');
  fs.copyFileSync(STORE, backup);
  evidence.storeBackup = path.relative(ROOT, backup);
  const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const target = (raw.tasks ?? []).find(item => item.taskId === taskId);
  assert.ok(target, '重启前 store 里找不到探针任务');
  const strippedFrom = {
    contextId: target.contextId ?? null,
    checkpointId: target.checkpointId ?? null,
    activeRunId: target.activeRunId ?? null
  };
  delete target.contextId;
  delete target.checkpointId;
  delete target.activeRunId;
  fs.writeFileSync(STORE, JSON.stringify(raw, null, 2), 'utf8');
  const afterStrip = readStoredTask(taskId);
  note('pointer-fields-stripped-offline',
    !afterStrip?.contextId && !afterStrip?.checkpointId && !afterStrip?.activeRunId,
    `抹掉的是 ${JSON.stringify(strippedFrom)}，备份 ${path.relative(ROOT, backup)}`);

  await startDev();
  cdp = await connectRenderer();
  note('renderer-ready-after-restart', true, 'CDP 已连接（未重编译，读的是同一份 store）');
  const restarted = await waitFor(async () => {
    const current = await state();
    return current && current.status !== 'planning' ? current.status : null;
  }, '重启后任务可读', 60000);
  note('restarted-still-paused-without-pointer',
    restarted === 'paused' && !pointerOf(await state()).checkpointId,
    `状态 ${String(restarted)}，指针 ${JSON.stringify(pointerOf(await state()))}`);
  await selectProbeTask();
  await sleep(400);
  await shot('02-pointer-lost-after-restart.png');

  await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskId)})`, 30000);
  const recoveredEvent = await waitFor(async () => (await events()).find(event =>
    event.type === 'context.event' && event.taskId === taskId &&
    event.event === 'context.recovered') ?? null, '恢复事件落库', 40000).catch(() => null);
  evidence.replay = recoveredEvent ? {
    pointerSource: recoveredEvent.context?.pointerSource ?? null,
    contextId: recoveredEvent.context?.contextId ?? null,
    checkpointId: recoveredEvent.context?.checkpointId ?? null,
    reason: recoveredEvent.context?.reason ?? null,
    sideEffects: recoveredEvent.context?.sideEffects ?? null
  } : null;
  note('recovered-event-emitted', Boolean(recoveredEvent), JSON.stringify(evidence.replay));
  assert.ok(recoveredEvent, '重启后继续没有产生 context.recovered 事件');
  note('recovery-path-is-observable',
    recoveredEvent.context?.pointerSource === 'events-replay',
    `pointerSource=${String(recoveredEvent.context?.pointerSource ?? null)}`);
  note('rebuilt-pointer-points-at-pause-checkpoint',
    recoveredEvent.context?.checkpointId === strippedFrom.checkpointId,
    `重建 ${String(recoveredEvent.context?.checkpointId ?? null)} / 暂停 ${String(strippedFrom.checkpointId ?? null)}`);
  note('recovered-side-effect-ledger',
    Boolean(recoveredEvent.context?.sideEffects),
    JSON.stringify(recoveredEvent.context?.sideEffects ?? null));
  await selectProbeTask();
  await sleep(500);
  await shot('03-replay-pointer-recovered.png');

  // 恢复会重开一轮：探针只要拿到打点就停，不真跑完。
  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => null);
  await waitFor(async () => ['cancelled', 'failed', 'cancelling'].includes((await state())?.status)
    ? 'settled' : null, '探针收尾', 40000).catch(() => null);

  await ev(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000);
  const after = taskIds();
  evidence.taskIdsAfter = after;
  note('probe-task-deleted', !after.includes(taskId) && before.length === after.length,
    `before=${before.length} after=${after.length}`);
}

try {
  await main();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${evidence.error}`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  await killDev('SIGTERM');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const checks = Object.entries(evidence.checks);
  const failed = checks.filter(([, item]) => item.ok !== true);
  const lines = [
    '# V4 P1 M2-1 真机验收：检查点指针一致性与恢复路径',
    '',
    `- 时间：${evidence.startedAt} ~ ${evidence.finishedAt}`,
    `- 环境：${evidence.mode}`,
    `- 探针任务：\`${evidence.taskId ?? '未创建'}\`（收尾已删除）`,
    `- 落库指针：${JSON.stringify(evidence.pointer)}`,
    `- 检查点文件：${evidence.checkpointFile?.file ?? '未读到'}（contextId=${String(evidence.checkpointFile?.contextId ?? null)} runId=${String(evidence.checkpointFile?.runId ?? null)}）`,
    `- 暂停事件指针：${JSON.stringify({
      contextId: evidence.pauseEvent?.contextId ?? null,
      checkpointId: evidence.pauseEvent?.checkpointId ?? null,
      activeRunId: evidence.pauseEvent?.activeRunId ?? null
    })}`,
    `- 状态序列：${evidence.statusSequence.join(' → ')}`,
    `- 抹掉指针重启后的恢复打点：${JSON.stringify(evidence.replay)}`,
    `- store 备份：${evidence.storeBackup ?? '未生成'}`,
    '',
    '## 断言结果',
    '',
    '| 断言 | 结果 | 实测 |',
    '| --- | --- | --- |',
    ...checks.map(([name, item]) => `| ${name} | ${item.ok ? '通过' : '**未通过**'} | ${item.detail ?? ''} |`),
    '',
    `合计 ${String(checks.length)} 项，未通过 ${String(failed.length)} 项${failed.length ? `：${failed.map(([name]) => name).join('、')}` : ''}。`,
    '',
    '## 未覆盖项',
    '',
    '- 正常路径（指针字段齐全）的 `context.recovered` 打点只由自动化测试覆盖：真机这一轮',
    '  重启后刻意抹掉字段，走的是重建路径；字段齐全时的 `pointerSource=task-fields` 见',
    '  `test:checkpoint-pointer`。',
    '- `context.checkpoint.paused` 带 `contextId/activeRunId` 后，检查点文件与事件谁先落盘',
    '  仍未验证（Journal 事务里事件与指针同写，但「事件落库、文件没落」的窗口没有测）。',
    '- 探针任务删除后 `context-checkpoints/owners/agent-task/<taskId>.json` 仍留在盘上，',
    '  属 M2-2 的回收缺口，本脚本不删用户数据。',
    '',
    evidence.error ? `## 中断原因\n\n${evidence.error}\n` : '## 中断原因\n\n无。'
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), `${lines.join('\n')}\n`);
  console.log(`EVIDENCE ${path.relative(ROOT, path.join(OUT_DIR, 'EVIDENCE.md'))}`);
  process.exitCode = failed.length > 0 || evidence.error ? 1 : 0;
}
