/**
 * P0-5 场景③：强制退出后重启，中断任务必须按新状态机核对再继续。
 *
 * 默认数据目录（AGENTS.md §10.2），不隔离、不复制用户数据。固定工作流跑到
 * shell 执行中后 SIGKILL；重启后断言 interrupted，继续时发 version.consistency
 * 并带上逐层取源，旧标记文件不出现。探针任务用完删除。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'p0-5-current-baseline-20261127');
const USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const STORE = path.join(USER_DATA, 'agent-store.json');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const LOG = path.join(OUT_DIR, 'dev.log');
const MARKER = path.join(os.tmpdir(), `tf-p0-5-marker-${Date.now()}.txt`);
// submitWorkflow 会统一给任务标题加「工作流：」前缀；脚本里只写业务名，
// 清场和 UI 选择都按这段唯一业务名匹配，不碰用户任务。
const PROBE_TITLE = 'P0-5 重启恢复探针';

const evidence = {
  startedAt: new Date().toISOString(),
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333 / SIGKILL 后重启',
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

async function waitForPortFree(deadline) {
  while (Date.now() < deadline) {
    if (listenersOn(PORT).length === 0) return;
    await sleep(400);
  }
  throw new Error(`CDP 端口 ${PORT} 在重启后仍被占用`);
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
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { /* 已退出 */ }
  if (signal === 'SIGKILL') {
    await waitForPortFree(Date.now() + 20000);
    child = null;
    return;
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0); } catch { child = null; return; }
    await sleep(300);
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  await waitForPortFree(Date.now() + 20000);
  child = null;
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

/** 当前执行档允许在重启后重建的规划成员；web 档本来就走网页，不在此断言。 */
async function expectedPlannerIds() {
  const config = await ev('window.agentAPI.getExecutionDefaults()', 20000);
  if (!config || config.executionMode === 'web') return [];
  return [
    ...(config.leadAgentId ? [config.leadAgentId] : []),
    ...(config.selectedCloudModels ?? []),
    ...(config.selectedCliAgents ?? [])
  ];
}

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(ROOT, file));
}

async function selectProbeInUi() {
  // 侧栏是异步加载的：先等探针行真的出现，不能对着空列表点一下就算选中。
  await waitFor(async () => ev(`(() => {
    const target = [...document.querySelectorAll('.task-item')]
      .find(node => (node.getAttribute('title') ?? '').includes(${JSON.stringify(PROBE_TITLE)}));
    return target ? (target.getAttribute('title') ?? '') : null;
  })()`), '侧栏出现 P0-5 探针', 15000);
  await ev(`(() => {
    const target = [...document.querySelectorAll('.task-item')]
      .find(node => (node.getAttribute('title') ?? '').includes(${JSON.stringify(PROBE_TITLE)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  // 点到以后还要等 active 落到这条探针上，截图才算证据。
  return waitFor(async () => ev(`(() => {
    const active = document.querySelector('.task-item.active');
    return active && (active.getAttribute('title') ?? '').includes(${JSON.stringify(PROBE_TITLE)})
      ? (active.getAttribute('title') ?? '')
      : null;
  })()`), '侧栏选中 P0-5 探针', 15000);
}

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用`);
  fs.rmSync(MARKER, { force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  await startDev();
  cdp = await connectRenderer();
  note('renderer-ready-first-run', true, 'CDP 已连接');

  const stale = JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? [];
  for (const old of stale.filter(item => (item.title ?? '').includes(PROBE_TITLE))) {
    await ev(`window.agentAPI.deleteTask(${JSON.stringify(old.taskId)})`);
  }
  await sleep(400);
  const before = taskIds();
  evidence.taskIdsBefore = before;

  const created = await ev(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: {
      id: 'p0-5-restart-probe',
      title: PROBE_TITLE,
      nodes: [{
        id: 'long-shell',
        capabilityId: 'shell.run',
        title: '长命令，强制退出后不得继续写标记文件',
        args: { command: `echo began; sleep 30; echo finished > ${JSON.stringify(MARKER)}`, timeoutMs: 60000 }
      }]
    },
    permissionPreset: 'danger-full-access',
    workspaceRoot: '/tmp',
    goal: 'P0-5 强制退出重启恢复探针'
  })})`);
  taskId = created?.taskId;
  evidence.taskId = taskId;
  note('probe-task-created', Boolean(taskId), taskId);
  assert.ok(taskId, '探针任务没创建出来');

  const createdTask = await state();
  const plannerIds = await expectedPlannerIds();
  const persistedIds = createdTask?.debateAgentIds ?? [];
  const plannerPersisted = plannerIds.length === 0 || plannerIds.some(id => persistedIds.includes(id));
  note('planner-member-persisted-for-restart', plannerPersisted,
    JSON.stringify({ expected: plannerIds, persisted: persistedIds }));
  assert.ok(plannerPersisted, '执行档有规划成员，但工作流任务没记下来；重启后会退回网页');

  await waitFor(async () => ['executing', 'plan_ready', 'awaiting_approval'].includes((await state())?.status) ? 'ready' : null,
    '探针进入执行态', 30000);
  const started = await waitFor(async () => (await events()).find(event =>
    event.type === 'step.started' && event.tool === 'shell.run') ?? null, 'shell 步骤开始', 30000);
  note('shell-step-started-before-kill', Boolean(started), String(started?.at ?? null));
  await killDev('SIGKILL');
  note('forced-exit', !fs.existsSync(MARKER), MARKER);

  await startDev();
  cdp = await connectRenderer();
  note('renderer-ready-after-restart', true, 'CDP 已连接');
  const restarted = await waitFor(async () => (await state())?.status === 'interrupted' ? 'interrupted' : null,
    '重启后任务标 interrupted', 30000);
  note('restarted-as-interrupted', restarted === 'interrupted', restarted);
  assert.equal(restarted, 'interrupted');

  const selected = await selectProbeInUi();
  note('probe-task-selected-in-ui', Boolean(selected), String(selected));
  await sleep(500);
  await shot('01-restarted-interrupted.png');

  await ev(`window.agentAPI.resumeTask(${JSON.stringify(taskId)})`, 30000);
  const consistency = await waitFor(async () => (await events()).find(event =>
    event.type === 'version.consistency') ?? null, '恢复时版本链核对', 30000);
  note('version-chain-rechecked', Boolean(consistency), JSON.stringify(consistency ?? null));
  assert.ok(consistency, '恢复时没有发 version.consistency');
  assert.ok(consistency.sources, 'version.consistency 没有逐层取源');

  const resumed = await state();
  const acceptable = ['planning', 'executing', 'verifying', 'blocked'].includes(resumed?.status);
  note('resume-proceeds-or-blocks', acceptable, resumed?.status ?? null);
  assert.ok(acceptable, `恢复后状态不可接受：${resumed?.status}`);

  const logText = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const usedWebFallback = logText.includes('ChatGPT 页面尚未就绪');
  note('no-web-planner-after-resume', !usedWebFallback,
    usedWebFallback ? 'dev.log 出现 ChatGPT 页面尚未就绪' : 'dev.log 未出现 ChatGPT 页面失败');
  assert.equal(usedWebFallback, false, '恢复时又退回网页规划器');

  const all = await events();
  evidence.events = all.filter(event => [
    'step.started', 'task.updated', 'version.consistency', 'context.event', 'context.checkpoint.paused'
  ].includes(event.type)).map(event => ({
    type: event.type,
    at: event.at,
    status: event.task?.status ?? null,
    event: event.event ?? null,
    requiresReplan: event.requiresReplan ?? null,
    actedOnReplan: event.actedOnReplan ?? null,
    sources: event.sources ?? null
  }));

  await ev(`window.agentAPI.cancelTask(${JSON.stringify(taskId)})`, 30000).catch(() => {});
  await sleep(800);
  await ev(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000);
  const after = taskIds();
  evidence.taskIdsAfter = after;
  note('probe-task-deleted', !after.includes(taskId) && before.length === after.length,
    `before=${before.length} after=${after.length}`);
  note('late-write-never-happened', !fs.existsSync(MARKER), MARKER);
  assert.equal(fs.existsSync(MARKER), false, '强制退出后在途 shell 仍写出了标记文件');
}

try {
  await main();
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${evidence.error}`);
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (cdp) cdp.close();
  await killDev('SIGKILL');
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const lines = [
    '# P0-5 场景③：强制退出重启恢复',
    '',
    `- 启动方式：${evidence.mode}`,
    '- 数据目录：默认 `~/Library/Application Support/thinkfusion-ai`',
    `- 探针任务：${evidence.taskId ?? '未创建'}（验收后删除；用户任务数 ${evidence.taskIdsBefore?.length ?? '?'} → ${evidence.taskIdsAfter?.length ?? '?'}）`,
    `- 标记文件：\`${MARKER}\`（强制退出后若 shell 继续跑完就会出现）`,
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
