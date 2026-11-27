/**
 * P0-4 真机验收：暂停必须走请求态/停止中/已暂停，并留下可恢复检查点。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据。固定工作流跑
 * `sleep 8` 后写标记文件；执行中暂停，断言状态序列、检查点事件、检查点文件
 * 内容，以及标记文件未出现。探针任务用完删除。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'p0-4-pause-checkpoint-20261127');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const MARKER = path.join(os.tmpdir(), `tf-p0-4-marker-${Date.now()}.txt`);
const PROBE_TITLE = '工作流：P0-4 暂停检查点探针';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333',
  marker: MARKER,
  checks: {},
  statusSequence: [],
  events: [],
  shots: [],
  taskId: null
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
  // UtilityProcess 的 agent runtime 是 build:agent 单独编译的；只起 electron-vite
  // 会跑上一版 runtime，收不到新的暂停检查点链路。
  execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const log = fs.openSync(path.join(OUT_DIR, 'dev.log'), 'w');
  const env = { ...process.env };
  delete env.THINKFUSION_USER_DATA;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log]
  });
  child.unref();
}

async function stopDev() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch { return; }
    await sleep(300);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
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

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用`);
  fs.rmSync(MARKER, { force: true });
  await startDev();
  const targets = await waitForEndpoint(Date.now() + 120000);
  const candidates = targets.filter(item => item.type === 'page'
    && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
  for (const candidate of candidates) {
    const probe = await connect(candidate);
    const ready = await waitFor(async () => {
      try { return await probe.evaluate('typeof window.agentAPI', 5000, null) === 'object' ? 'ready' : null; }
      catch { return null; }
    }, `agentAPI 注入 ${candidate.url}`, 30000).catch(() => null);
    if (ready) { cdp = probe; break; }
    probe.close();
  }
  if (!cdp) throw new Error('没有找到注入 agentAPI 的渲染进程');
  note('renderer-ready', true, 'CDP 已连接');

  const stale = JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? [];
  for (const old of stale.filter(item => item.title === PROBE_TITLE)) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(old.taskId)})`);
  }
  const before = taskIds();
  evidence.taskIdsBefore = before;

  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: {
      id: 'p0-4-pause-checkpoint-probe',
      title: PROBE_TITLE,
      nodes: [{
        id: 'long-shell',
        capabilityId: 'shell.run',
        title: '长命令，暂停时不得继续写标记文件',
        args: { command: `echo began; sleep 8; echo finished > ${JSON.stringify(MARKER)}`, timeoutMs: 30000 }
      }]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: '/tmp',
    goal: 'P0-4 暂停状态机与检查点真机探针'
  })})`);
  taskId = created?.taskId;
  evidence.taskId = taskId;
  note('probe-task-created', Boolean(taskId), taskId);
  assert.ok(taskId, '探针任务没创建出来');

  await waitFor(async () => ['executing', 'plan_ready', 'awaiting_approval'].includes((await state())?.status) ? 'ready' : null,
    '探针进入执行态', 30000);
  await waitFor(async () => (await events()).find(event =>
    event.type === 'step.started' && event.tool === 'shell.run') ?? null, 'shell 步骤开始', 30000);

  await ev(`window.agentAPI.pauseTask(${JSON.stringify(taskId)})`, 30000);
  await waitFor(async () => (await state())?.status === 'paused' ? 'paused' : null, '任务暂停', 20000);

  const all = await events();
  const rawStatuses = all
    .filter(event => event.type === 'task.updated' && event.task?.taskId === taskId)
    .map(event => event.task.status);
  evidence.statusSequence = rawStatuses.filter((status, index) => index === 0 || status !== rawStatuses[index - 1]);
  const pauseEvent = all.find(event => event.type === 'context.checkpoint.paused' && event.taskId === taskId);
  evidence.events = all.filter(event => [
    'task.updated', 'context.checkpoint.paused', 'step.started', 'step.failed', 'step.completed'
  ].includes(event.type)).map(event => ({
    type: event.type,
    at: event.at,
    status: event.task?.status ?? null,
    reason: event.reason ?? null,
    taskRevision: event.taskRevision ?? null,
    needsReconciliation: event.needsReconciliation ?? null,
    checkpointId: event.checkpointId ?? null,
    tool: event.tool ?? null,
    error: event.error ?? null
  }));

  const expected = ['pause_requested', 'pausing', 'paused'];
  let cursor = -1;
  const ordered = expected.every(status => {
    cursor = evidence.statusSequence.indexOf(status, cursor + 1);
    return cursor >= 0;
  });
  note('state-machine-sequence', ordered, evidence.statusSequence.join(' → '));
  assert.ok(ordered, `状态没有按顺序经过 ${expected.join(' → ')}`);

  note('checkpoint-event', Boolean(pauseEvent), JSON.stringify(pauseEvent ?? null));
  assert.ok(pauseEvent, '没有 context.checkpoint.paused 事件');
  assert.equal(pauseEvent.reason, 'pause');
  assert.ok(pauseEvent.taskRevision >= 0);
  assert.ok(pauseEvent.needsReconciliation >= 1, 'shell.run 没有路径，必须如实标 needs_reconciliation');
  assert.ok(pauseEvent.checkpointId, '事件没有 checkpointId');

  const checkpointFile = path.join(USER_DATA, 'context-checkpoints', 'owners', 'agent-task', `${taskId}.json`);
  const ownerFile = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  const checkpoint = (ownerFile.checkpoints ?? []).find(item => item.checkpointId === pauseEvent.checkpointId);
  note('checkpoint-file', Boolean(checkpoint), checkpointFile);
  assert.ok(checkpoint, '检查点文件里没有对应 checkpointId');
  note('checkpoint-goal-and-revision',
    checkpoint.summary.constraints.some(line => line.includes('目标版本 v'))
    && checkpoint.summary.constraints.some(line => line.includes('任务树 revision'))
    && checkpoint.summary.constraints.some(line => line.includes('工具执行状态')),
    checkpoint.summary.constraints.join(' / '));
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('目标版本 v')));
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('任务树 revision')));
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('工具执行状态')));

  await sleep(600);
  note('late-write-never-happened', !fs.existsSync(MARKER), MARKER);
  assert.equal(fs.existsSync(MARKER), false, '暂停后在途 shell 还写出了标记文件');

  // 截图要落在探针任务上，不能拍到空白首页。
  const selected = await ev(`(() => {
    const title = ${JSON.stringify(PROBE_TITLE)};
    const nodes = [...document.querySelectorAll('button, a, div, span')];
    const target = nodes.filter(node => (node.textContent ?? '').includes(title)).at(-1);
    if (!target) return false;
    target.click();
    return true;
  })()`);
  note('probe-task-selected-in-ui', Boolean(selected), String(selected));
  await sleep(500);
  await shot('01-pause-checkpoint.png');

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
  if (cdp) { try { await cdp.send('Browser.close', {}, 5000); } catch { /* 已断开 */ } }
  await stopDev();
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const lines = [
    '# P0-4 真机验收：暂停状态机与检查点',
    '',
    `- 启动方式：${evidence.mode}`,
    '- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`',
    `- 探针任务：${evidence.taskId ?? '未创建'}（验收后删除；用户任务数 ${evidence.taskIdsBefore?.length ?? '?'} → ${evidence.taskIdsAfter?.length ?? '?'}）`,
    `- 标记文件：\`${MARKER}\`（暂停后若 shell 继续跑完就会出现）`,
    '',
    '## 状态序列',
    '',
    evidence.statusSequence.join(' → ') || '未采集',
    '',
    '## 结果',
    '',
    ...Object.entries(evidence.checks).map(([key, value]) => `- ${key}：${value.ok ? '通过' : '失败'} — ${value.detail ?? '无'}`),
    '',
    '## 事件摘要',
    '',
    '```json',
    JSON.stringify(evidence.events, null, 2),
    '```',
    '',
    ...(evidence.error ? ['## 错误', '', evidence.error, ''] : [])
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), lines.join('\n'));
  const failed = Object.values(evidence.checks).filter(item => !item.ok);
  process.exitCode = evidence.error || failed.length > 0 ? 1 : 0;
}
