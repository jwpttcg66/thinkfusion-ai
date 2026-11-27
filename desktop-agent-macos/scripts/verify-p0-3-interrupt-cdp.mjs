/**
 * P0-3 真机验收：暂停要真中断在途 shell.run，并等 Runtime 确认终止。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据。固定工作流跑
 * `sleep 30` 后写标记文件；执行中暂停，断言标记文件不存在、步骤结果为中断、
 * 主进程等到 Runtime 回执后才落 paused。探针任务用完删除。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'p0-3-shell-interrupt-20261127');
const STORE = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai', 'agent-store.json');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const MARKER = path.join(os.tmpdir(), `tf-p0-3-marker-${Date.now()}.txt`);
const PROBE_TITLE = '工作流：P0-3 中断探针';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333',
  marker: MARKER,
  checks: {},
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
  // 会跑上一版 runtime，取消信号根本还没接上。
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
const state = () => taskId ? ev(`window.agentAPI.getTask(${JSON.stringify(taskId)})`, 20000, null) : null;
const events = () => taskId ? ev(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 30000, []) ?? [] : [];

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
      id: 'p0-3-interrupt-probe',
      title: 'P0-3 中断探针',
      nodes: [{
        id: 'long-shell',
        capabilityId: 'shell.run',
        title: '长命令，取消时不得继续写标记文件',
        args: { command: `echo began; sleep 30; echo finished > ${JSON.stringify(MARKER)}`, timeoutMs: 60000 }
      }]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: '/tmp',
    goal: 'P0-3 在途 shell 中断真机探针'
  })})`);
  taskId = created?.taskId;
  evidence.taskId = taskId;
  note('probe-task-created', Boolean(taskId), taskId);

  await waitFor(async () => ['executing', 'plan_ready', 'awaiting_approval'].includes((await state())?.status) ? 'ready' : null,
    '探针进入执行态', 30000);
  const stepStart = await waitFor(async () => (await events()).find(event =>
    event.type === 'step.started' && event.tool === 'shell.run') ?? null, 'shell 步骤开始', 30000);
  note('shell-step-started', Boolean(stepStart), String(stepStart?.at ?? null));

  const pauseAt = Date.now();
  await ev(`window.agentAPI.pauseTask(${JSON.stringify(taskId)})`, 30000);
  const paused = await waitFor(async () => (await state())?.status === 'paused' ? 'paused' : null, '任务暂停', 20000);
  note('pause-waited-for-runtime', paused === 'paused', `paused=${paused}`);

  await waitFor(async () => {
    const list = await events();
    return list.some(event => event.type === 'step.failed' && /中断/.test(event.error ?? '')) ? 'failed' : null;
  }, '中断步骤回报', 20000);
  const all = await events();
  await waitFor(async () => (await events()).some(event => event.type === 'report.ready') ? 'report' : null,
    '取消后的执行报告', 15000);
  const reported = await events();
  evidence.events = reported.filter(event => ['step.started', 'step.failed', 'step.completed', 'report.ready'].includes(event.type))
    .map(event => ({
      type: event.type, at: event.at, tool: event.tool ?? null, error: event.error ?? null,
      status: event.report?.status ?? null,
      errors: event.report?.errors ?? null
    }));
  const failed = all.find(event => event.type === 'step.failed' && /中断/.test(event.error ?? ''));
  const reportError = reported.find(event => event.type === 'report.ready'
    && (event.report?.errors ?? []).some(item => item.code === 'COMMAND_INTERRUPTED'));
  note('step-result-interrupted', Boolean(failed), failed?.error ?? null);
  note('report-marks-interrupted', Boolean(reportError), JSON.stringify(reportError?.report?.errors ?? []));
  if (stepStart?.at && failed?.at) {
    note('terminated-promptly', failed.at - stepStart.at < 5000, `${String(failed.at - stepStart.at)}ms`);
  }

  await sleep(600);
  note('late-write-never-happened', !fs.existsSync(MARKER), MARKER);
  await shot('01-shell-interrupted.png');
  evidence.pauseAt = pauseAt;

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
    '# P0-3 真机验收：在途 shell.run 中断',
    '',
    `- 启动方式：${evidence.mode}`,
    '- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`',
    `- 探针任务：${evidence.taskId ?? '未创建'}（验收后删除；用户任务数 ${evidence.taskIdsBefore?.length ?? '?'} → ${evidence.taskIdsAfter?.length ?? '?'}）`,
    `- 标记文件：\`${MARKER}\`（在途进程若继续跑完就会出现）`,
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
