/**
 * P0-1 真机验收：恢复时版本链取源不再同源。
 *
 * 只用默认数据目录（AGENTS.md §10.2）：不设 THINKFUSION_USER_DATA、不复制用户数据。
 * 用固定工作流造一个长在执行的新任务，修订目标但不重打子任务版本，暂停后恢复，
 * 从真实事件流读 version.consistency.sources 与过期判定；结束后删除探针任务，
 * 并核对原有任务清单未变化。一条脚本跑完：起 dev → CDP → 验收 → 截图 → 清理 → kill。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '..', 'docs', 'implementation', 'acceptance', 'p0-1-version-chain-20261127');
const STORE = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai', 'agent-store.json');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const WORKFLOW = {
  id: 'p0-1-version-chain-probe',
  title: 'P0-1 版本链取源探针',
  nodes: [{
    id: 'wait',
    capabilityId: 'shell.run',
    title: '保持执行态，覆盖暂停与恢复',
    args: { command: 'sleep 45', timeoutMs: 60000 }
  }]
};

const evidence = {
  startedAt: new Date().toISOString(),
  checks: {},
  events: [],
  shots: [],
  taskId: null,
  mode: '默认数据目录 / ThinkFusion Dev / CDP 9333'
};
let child = null;
let cdp = null;
let taskId = null;

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
}

function taskIds() {
  if (!fs.existsSync(STORE)) return [];
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  return (store.tasks ?? []).map(task => task.taskId ?? task.id).filter(Boolean).sort();
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
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

async function startDev() {
  // agent runtime 单独编译；不跑 build:agent 会用旧 runtime 验证新代码。
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

async function invoke(expression, timeoutMs = 30000) {
  return cdp.evaluate(expression, timeoutMs);
}

async function evaluate(expression, timeoutMs = 30000, fallback = null) {
  try {
    return await cdp.evaluate(expression, timeoutMs);
  } catch (error) {
    console.log(`     (poll) ${error?.message ?? error}`);
    return fallback;
  }
}

async function taskState() {
  if (!taskId) return null;
  return evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`, 20000, null);
}

async function taskEvents() {
  if (!taskId) return [];
  return evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 30000, []) ?? [];
}

async function waitFor(predicate, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`等待超时：${label}`);
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

async function main() {
  note('default-store-readable', fs.existsSync(STORE), STORE);
  if (listenersOn(PORT).length > 0) throw new Error(`CDP 端口 ${PORT} 已被占用，不抢别人的实例`);

  await startDev();
  const targets = await waitForEndpoint(Date.now() + 120000);
  evidence.targets = targets.map(item => ({ type: item.type, url: item.url }));
  const candidates = targets.filter(item => item.type === 'page'
    && (item.url.includes('localhost:5173') || item.url.includes('localhost:5174') || item.url.startsWith('file:')));
  let target = null;
  for (const candidate of candidates) {
    const probe = await connect(candidate);
    const ready = await waitFor(async () => {
      try {
        return await probe.evaluate('typeof window.agentAPI', 5000, null) === 'object' ? 'ready' : null;
      } catch { return null; }
    }, `agentAPI 注入 ${candidate.url}`, 30000).catch(() => null);
    if (ready) {
      target = candidate;
      cdp = probe;
      break;
    }
    probe.close();
  }
  if (!target) throw new Error(`没有找到注入 agentAPI 的渲染进程：${JSON.stringify(evidence.targets)}`);
  note('renderer-ready', true, target.url);

  // 清掉上一次中断留下的同名探针；只认本脚本的标题，绝不碰用户任务。
  const stale = JSON.parse(fs.readFileSync(STORE, 'utf8')).tasks ?? [];
  for (const old of stale.filter(item => item.title === '工作流：P0-1 版本链取源探针')) {
    await evaluate(`window.agentAPI.deleteTask(${JSON.stringify(old.taskId)})`);
  }
  const before = taskIds();
  evidence.taskIdsBefore = before;

  const created = await evaluate(`window.agentAPI.runWorkflow(${JSON.stringify({
    workflow: WORKFLOW,
    permissionPreset: 'danger-full-access',
    workspaceRoot: '/tmp',
    goal: 'P0-1 版本链取源真机探针'
  })})`);
  taskId = created?.taskId;
  evidence.taskId = taskId;
  note('probe-task-created', Boolean(taskId), taskId);

  const executing = await waitFor(async () => {
    const task = await taskState();
    return ['executing', 'plan_ready', 'awaiting_approval'].includes(task?.status) ? task.status : null;
  }, '探针进入执行态', 30000);
  note('probe-executing', true, executing);

  const revision = await evaluate(`window.agentAPI.reviseTaskGoal(${JSON.stringify({
    taskId,
    nextCriteria: ['P0-1 验收：恢复时的目标版本取自契约更新事件'],
    userConfirmedChange: true,
    // 故意不重打在途子任务：让任务树停在 v1、契约抬到 v2。
    changedTaskIds: ['p0-1-not-a-real-task']
  })})`);
  note('goal-revised-to-v2', revision?.versionChanged === true && revision?.nextVersion === 2, JSON.stringify(revision));

  await evaluate(`window.agentAPI.pauseTask(${JSON.stringify(taskId)})`);
  const paused = await waitFor(async () => (await taskState())?.status === 'paused' ? 'paused' : null, '任务暂停', 20000);
  note('probe-paused', paused === 'paused', paused);

  const resumeAt = Date.now();
  // P0-3 尚未实施：pause 不会打断在途 shell，Runtime 的 busy 要等它自己结束。
  // 这里重试直到 Runtime 真正接手恢复，避免把「仍在跑」误记成恢复失败。
  let resumed = false;
  const resumeDeadline = Date.now() + 90000;
  while (!resumed && Date.now() < resumeDeadline) {
    try {
      await invoke(`window.agentAPI.resumeTask(${JSON.stringify(taskId)})`, 20000);
      resumed = true;
    } catch (error) {
      if (!/正在执行或恢复中/.test(error?.message ?? '')) throw error;
      await sleep(1000);
    }
  }
  note('resume-accepted', resumed, `重试后 Runtime 接手恢复：${resumed}`);
  const consistency = await waitFor(async () => {
    const events = await taskEvents();
    return events.find(event => event.type === 'version.consistency' && (event.at ?? 0) >= resumeAt) ?? null;
  }, '恢复发出 version.consistency', 60000);

  evidence.consistency = consistency;
  const allEvents = await taskEvents();
  const afterResume = await taskState();
  note('acted-on-replan', consistency?.actedOnReplan === true, String(consistency?.actedOnReplan));
  note('gate-blocks-planning', afterResume?.status === 'blocked', String(afterResume?.status ?? null));
  note('no-new-planning-round', !allEvents.some(event => event.type === 'round.started' && (event.at ?? 0) >= resumeAt),
    `resumeAt=${resumeAt}`);
  note('wait-user-decision', allEvents.some(event => event.type === 'cycle.decision.created'
    && event.decisionType === 'WAIT_USER' && (event.at ?? 0) >= resumeAt), 'cycle.decision.created=WAIT_USER');
  note('old-worktasks-invalidated', allEvents.some(event => event.type === 'work.breakdown.replanned'
    && (event.at ?? 0) >= resumeAt), 'work.breakdown.replanned');
  evidence.events = allEvents.filter(event => [
    'version.consistency', 'goal.contract.updated', 'work.task.upserted',
    'work.breakdown.replanned', 'cycle.decision.created', 'round.started'
  ].includes(event.type)).map(event => ({
    type: event.type,
    at: event.at,
    sources: event.sources ?? null,
    actedOnReplan: event.actedOnReplan ?? null,
    decisionType: event.decisionType ?? null,
    impactedIds: event.impactedIds ?? null,
    version: event.contract?.goalVersion ?? event.task?.goalVersion ?? null,
    issues: event.issues ?? null,
    requiresReplan: event.requiresReplan ?? null
  }));

  note('sources-emitted', Boolean(consistency?.sources), JSON.stringify(consistency?.sources ?? null));
  note('current-goal-from-contract-event', consistency?.sources?.currentGoalVersion === 'goal.contract.updated',
    String(consistency?.sources?.currentGoalVersion ?? null));
  const currentVersion = consistency?.sources?.currentGoalVersion === 'goal.contract.updated' ? 2 : null;
  note('current-goal-version-is-v2', currentVersion === 2, `v${String(currentVersion)}`);
  note('stale-worktask-detected', (consistency?.issues ?? []).some(issue => issue.layer === 'worktask'),
    JSON.stringify(consistency?.issues ?? []));
  note('replan-required', consistency?.requiresReplan === true, String(consistency?.requiresReplan));

  await shot('01-version-consistency.png');

  // P0-1 只验证取源；恢复继续开新一轮不是本项范围，立即删掉探针任务。
  await invoke(`window.agentAPI.deleteTask(${JSON.stringify(taskId)})`, 30000);
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
  if (cdp) {
    try { await cdp.send('Browser.close', {}, 5000); } catch { /* 连接可能已断 */ }
  }
  await stopDev();
  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const lines = [
    '# P0-1 真机验收：恢复时版本链取源',
    '',
    `- 启动方式：${evidence.mode}`,
    `- 数据目录：默认 \`~/Library/Application Support/thinkfusion-ai\`（未设置隔离目录）`,
    `- 探针任务：${evidence.taskId ?? '未创建'}（验收后删除；原有任务数 ${evidence.taskIdsBefore?.length ?? '?'} → ${evidence.taskIdsAfter?.length ?? '?'}）`,
    '',
    '## 结果',
    '',
    ...Object.entries(evidence.checks).map(([key, value]) => `- ${key}：${value.ok ? '通过' : '失败'} — ${value.detail ?? '无'}`),
    '',
    ...(evidence.consistency
      ? [`## version.consistency 原文`, '', '```json', JSON.stringify(evidence.consistency, null, 2), '```']
      : []),
    ...(evidence.error ? ['', `## 错误`, '', evidence.error] : []),
    ''
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'EVIDENCE.md'), lines.join('\n'));
  const failed = Object.values(evidence.checks).filter(item => !item.ok);
  process.exitCode = evidence.error || failed.length > 0 ? 1 : 0;
}
