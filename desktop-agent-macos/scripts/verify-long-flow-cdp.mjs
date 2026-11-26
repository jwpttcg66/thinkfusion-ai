/**
 * 真机 CDP 复验：工程任务会不会又走进「同一件事做三遍」的长流程。
 *
 * 2026-11-26 修了四处（评审误判、acceptance 让计划非法、无新证据仍开修复轮、
 * 基准材料来源写死网页）。这里真跑一个「改文件 + npm test 验证」的工程任务，
 * 只读观察事件流：报告、评审、cycle.snapshot、轮次数与真实耗时。不做任何
 * 推动动作：不点接受未验证、不手动 recheckVerification、不取消任务。
 *
 * 一条脚本跑完（dev 进程会随命令结束被回收，不要分开调）：
 *   build:test → 隔离 userData → 起 dev → 连 CDP → 真跑任务 → 采事件/截图
 *   → kill → 断言真实 agent-store.json sha256 前后一致。
 *
 * 用法：
 *   node scripts/verify-long-flow-cdp.mjs
 *   KEEP_RUNNING=1 node scripts/verify-long-flow-cdp.mjs   # 验收后留着实例自己看
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connect, sleep } from './lib/cdp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'thinkfusion-ai');
const REAL_STORE = path.join(REAL_USER_DATA, 'agent-store.json');
const ISO_USER_DATA = process.env.ISO_USER_DATA ?? '/tmp/tf-long-flow-userdata';
const WORKSPACE = process.env.LONG_FLOW_WORKSPACE ?? '/tmp/tf-long-flow-workspace';
const OUT_DIR = process.env.LONG_FLOW_EVIDENCE_DIR
  ? path.resolve(process.env.LONG_FLOW_EVIDENCE_DIR)
  : path.join(ROOT, '..', 'docs', 'spec', 'evidence', 'long-flow-20261126');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ENDPOINT = `http://127.0.0.1:${PORT}/json`;
const PROMPT = process.env.LONG_FLOW_PROMPT ?? (
  '把工作区 package.json 里的 test 脚本改成输出 hello everybody，然后真的运行一次 npm test，' +
  '把 stdout 原文告诉我；不要改其它文件。'
);
const MAX_WAIT_MS = Number(process.env.LONG_FLOW_TIMEOUT_MS ?? 7 * 60 * 1000);

/** 只搬配置，不搬历史任务与索引：避免真用户数据与验收实例互写。 */
const CONFIG_FILES = [
  'api-keys.json', 'cloud-config.json', 'execution-defaults.json', 'permission-preset.json',
  'sources.json', 'settings.json', 'capabilities.json', 'cli-agents.json', 'cli-capabilities.json',
  'collaboration-mode.json', 'expertise.json', 'profile.json', 'workspaces.json',
  'workspace-state.json', 'code-intelligence.json'
];

const evidence = {
  startedAt: new Date().toISOString(),
  prompt: PROMPT,
  checks: {},
  events: [],
  shots: [],
  rounds: [],
  reviews: [],
  snapshots: [],
  guards: []
};
let child = null;
let cdp = null;

function sha256(file) {
  if (!fs.existsSync(file)) return null;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function note(name, ok, detail) {
  evidence.checks[name] = { ok: Boolean(ok), detail: detail ?? null, at: new Date().toISOString() };
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function prepareIsolation() {
  fs.rmSync(ISO_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(ISO_USER_DATA, { recursive: true });
  const copied = [];
  for (const name of CONFIG_FILES) {
    const from = path.join(REAL_USER_DATA, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(ISO_USER_DATA, name));
    copied.push(name);
  }
  evidence.copiedConfig = copied;
}

function prepareWorkspace() {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'long-flow live check workspace\n');
  fs.writeFileSync(
    path.join(WORKSPACE, 'package.json'),
    `${JSON.stringify(
      { name: 'long-flow-workspace', version: '1.0.0', private: true, scripts: { test: 'node -e "console.log(\'not yet\')"' } },
      null,
      2
    )}\n`
  );
}

function listenersOn(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n').map(item => item.trim()).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function ensurePortFree() {
  // 只清本次要用的 CDP 端口。5173 可能是用户正在用的 dev 实例，绝不能 kill；
  // electron-vite 看到 5173 被占会自动换 5174，findRenderer 两者都认。
  const stale = [...new Set(listenersOn(PORT))];
  if (stale.length === 0) return [];
  for (const pid of stale) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
  for (let index = 0; index < 20 && listenersOn(PORT).length > 0; index += 1) await sleep(300);
  if (listenersOn(PORT).length > 0) throw new Error(`端口 ${PORT} 仍被占用：${listenersOn(PORT).join(',')}`);
  console.log(`     清掉残留实例 pid=${stale.join(',')}`);
  return stale;
}

async function waitForEndpoint(deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ENDPOINT);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`CDP ${ENDPOINT} 一直没起来：${lastError?.message ?? 'timeout'}`);
}

function findRenderer(targets) {
  return targets.find(target =>
    target.type === 'page' &&
    (target.url.includes('localhost:5173') || target.url.includes('localhost:5174') || target.url.startsWith('file:'))
  ) ?? null;
}

function startDev() {
  execFileSync('npm', ['run', 'build:agent'], { cwd: ROOT, stdio: 'inherit' });
  const logFile = path.join(OUT_DIR, 'dev.log');
  const out = fs.openSync(logFile, 'w');
  const env = { ...process.env, THINKFUSION_USER_DATA: ISO_USER_DATA };
  // 宿主注入的 shim 会让 Electron 以纯 Node 运行 / 崩在 app.setName。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  child = spawn('npx', ['electron-vite', 'dev', '--noSandbox', '--remoteDebuggingPort', String(PORT)], {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', out, out]
  });
  child.unref();
  return logFile;
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

async function shot(name) {
  const buffer = Buffer.from(
    (await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000)).data,
    'base64'
  );
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  evidence.shots.push(path.relative(ROOT, file));
  console.log(`     shot ${path.relative(ROOT, file)}（${String(buffer.length)}B）`);
  return file;
}

async function tryEval(expression, timeoutMs = 45000, fallback = null) {
  try {
    return await cdp.evaluate(expression, timeoutMs);
  } catch (error) {
    evidence.pollMisses = (evidence.pollMisses ?? 0) + 1;
    console.log(`     (poll) ${error?.message ?? error}`);
    return fallback;
  }
}

async function approveIfNeeded(task, events, approvedPlans, approvedSteps) {
  if (task?.status === 'awaiting_approval') {
    const pending = [...events].reverse().find(event => event.type === 'plan.ready' && event.plan?.planId);
    if (pending && !approvedPlans.has(pending.plan.planId)) {
      await tryEval(`window.agentAPI.approvePlan(${JSON.stringify({
        taskId: task.taskId, roundId: pending.roundId, planId: pending.plan.planId, approved: true
      })})`);
      approvedPlans.add(pending.plan.planId);
      console.log(`     approved plan ${pending.plan.planId}`);
      return;
    }
  }
  const resolved = new Set(events.filter(event => event.type === 'step.approval-resolved').map(event => event.stepId));
  for (const event of events) {
    if (event.type !== 'step.approval' || resolved.has(event.stepId) || approvedSteps.has(event.stepId)) continue;
    await tryEval(`window.agentAPI.approveStep(${JSON.stringify({
      taskId: task?.taskId ?? event.taskId, stepId: event.stepId
    })})`);
    approvedSteps.add(event.stepId);
    console.log(`     approved step ${event.stepId} (${event.tool ?? '?'})`);
  }
}

/** 只留判断长流程需要的字段，避免把整份报告塞进证据文件。 */
function compactEvent(event, evidenceFacts) {
  const base = { type: event.type, at: event.at ?? null, roundId: event.roundId ?? null };
  switch (event.type) {
    case 'plan.ready':
      return { ...base, planId: event.plan?.planId ?? null, steps: event.plan?.steps?.length ?? null, title: event.plan?.title ?? null };
    case 'report.ready': {
      const report = event.report ?? {};
      return {
        ...base,
        status: report.status ?? null,
        nextAction: report.nextAction ?? null,
        results: report.results?.length ?? null,
        steps: report.results?.map(item => {
          const result = item.result && typeof item.result === 'object' ? item.result : {};
          return {
            tool: item.tool,
            status: item.status,
            args: item.args ?? null,
            exitCode: result.exitCode ?? null,
            stdout: typeof result.stdout === 'string' ? result.stdout.slice(0, 300) : null
          };
        }) ?? [],
        verified: report.verification?.verified ?? null,
        reasons: report.verification?.reasons ?? [],
        facts: evidenceFacts(report)
      };
    }
    case 'review.ready':
      return { ...base, reviewer: event.reviewer ?? null, verdict: event.verdict ?? null, issues: event.issues ?? [], needsFix: Boolean(event.needsFix) };
    case 'cycle.snapshot':
      return { ...base, decision: event.decision ?? null, conclusionType: event.conclusionType ?? null, nextAction: event.nextAction ?? null };
    case 'log':
      return { ...base, level: event.level ?? null, message: event.message ?? null };
    case 'step.failed':
      return { ...base, stepId: event.stepId ?? null, tool: event.tool ?? null, error: event.error ?? null };
    case 'task.completed':
    case 'task.failed':
    case 'task.cancelled':
      return { ...base, summary: event.summary ?? event.error ?? null };
    default:
      return base;
  }
}

function issueKey(issues) {
  return [...(issues ?? [])].map(item => String(item).replace(/\s+/g, '')).sort().join('|');
}

function fingerprintKey(facts) {
  return [...(facts ?? [])].sort().join('|');
}

function classify() {
  // 轮次按 round.started 数：修复轮可能以 task_complete 收尾，根本没有 plan.ready / report.ready，
  // 只数计划会把「两轮」误记成「一轮」（2026-11-26 真机 r2 就是这样）。
  const rounds = evidence.events.filter(event => event.type === 'round.started');
  const plans = evidence.events.filter(event => event.type === 'plan.ready');
  const reports = evidence.events.filter(event => event.type === 'report.ready');
  const reviews = evidence.events.filter(event => event.type === 'review.ready');
  const snapshots = evidence.events.filter(event => event.type === 'cycle.snapshot');
  const guards = evidence.events.filter(event => event.type === 'log' && /停止自动修复/.test(event.message ?? ''));
  const elapsed = evidence.finishedAtValue - evidence.startedValue;
  const reportKeys = reports.map(item => fingerprintKey(item.facts));
  const reviewKeys = reviews.map(item => issueKey(item.issues));
  const repeatedEvidence = reportKeys.length >= 2 && new Set(reportKeys).size < reportKeys.length;
  const repeatedReview = reviewKeys.length >= 2 && new Set(reviewKeys).size < reviewKeys.length;
  const terminal = evidence.terminal?.status ?? null;
  let verdict;
  if (guards.length > 0) verdict = 'stopped-by-guard';
  else if (rounds.length >= 3 || elapsed >= MAX_WAIT_MS) verdict = 'long-flow';
  else if (terminal === 'completed' && rounds.length <= 2) verdict = 'no-long-flow';
  else verdict = 'incomplete';
  return {
    verdict,
    rounds: rounds.length,
    plans: plans.length,
    reports: reports.length,
    reviews: reviews.length,
    snapshots: snapshots.map(item => ({ decision: item.decision, conclusionType: item.conclusionType })),
    guards: guards.map(item => item.message),
    repeatedEvidence,
    repeatedReview,
    elapsedMs: elapsed,
    terminal
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 用生产里的同一个证据指纹函数，口径和闸门一致。
  execFileSync('npm', ['run', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
  const { evidenceFacts } = await import(pathToFileURL(path.join(ROOT, 'out-test', 'shared', 'repair-loop.js')).href);

  const storeBefore = sha256(REAL_STORE);
  evidence.storeBefore = storeBefore;
  note('real-store-readable', Boolean(storeBefore), REAL_STORE);
  prepareIsolation();
  prepareWorkspace();
  evidence.clearedStale = await ensurePortFree();
  const logFile = startDev();
  console.log(`dev 启动中（隔离 userData=${ISO_USER_DATA}，日志 ${logFile}）`);

  const targets = await waitForEndpoint(Date.now() + 120000);
  if (fs.readFileSync(logFile, 'utf8').includes('Cannot start http server for devtools')) {
    throw new Error('devtools 端口被旧实例占用（日志：Cannot start http server for devtools）');
  }
  let target = findRenderer(targets);
  for (let index = 0; index < 60 && !target; index += 1) {
    await sleep(1000);
    target = findRenderer(await (await fetch(ENDPOINT)).json());
  }
  assert.ok(target, `找不到渲染进程；targets=${JSON.stringify(targets.map(item => item.url))}`);
  cdp = await connect(target);
  await cdp.send('Page.enable');

  let ready = false;
  for (let index = 0; index < 80 && !ready; index += 1) {
    ready = Boolean(await cdp.evaluate(`typeof window.agentAPI?.submitConversation === 'function'`).catch(() => false));
    if (!ready) await sleep(500);
  }
  assert.ok(ready, 'agentAPI 未注入');
  note('renderer-ready', true, target.url);

  const defaults = await cdp.evaluate('window.agentAPI.getExecutionDefaults()');
  evidence.executionDefaults = defaults;
  note('model-configured', Boolean(defaults?.selectedCloudModels?.length), JSON.stringify(defaults?.selectedCloudModels ?? []));

  evidence.startedValue = Date.now();
  const conversation = await cdp.evaluate(
    `window.agentAPI.submitConversation(${JSON.stringify({
      text: PROMPT,
      // /tmp 一次性工作区；完全权限只为绕开 workspace-write 对 shell 组合符的拒绝。
      permissionPreset: 'danger-full-access',
      workspaceRoot: WORKSPACE,
      workspaceMode: 'engineering',
      executionConfig: defaults,
      taskKindOverride: 'execution'
    })})`
  );
  const taskId = conversation.taskId;
  assert.ok(taskId, `submitConversation 未返回 taskId：${JSON.stringify(conversation)}`);
  evidence.taskId = taskId;
  evidence.conversationId = conversation.conversationId;
  console.log(`task ${taskId}`);

  const approvedPlans = new Set();
  const approvedSteps = new Set();
  let awaitingApprovalSeen = false;
  let printed = 0;
  let terminal = null;
  let shotSecondPlan = false;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(800);
    const task = await tryEval(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
    if (task?.status === 'awaiting_approval') awaitingApprovalSeen = true;
    const events = (await tryEval(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 45000, [])) ?? [];
    for (const event of events.slice(printed)) {
      const item = compactEvent(event, evidenceFacts);
      evidence.events.push(item);
      if (['plan.ready', 'report.ready', 'review.ready', 'cycle.snapshot', 'task.completed', 'task.failed'].includes(event.type)) {
        const detail = event.type === 'review.ready'
          ? ` verdict=${JSON.stringify(event.verdict)} needsFix=${String(Boolean(event.needsFix))}`
          : event.type === 'cycle.snapshot'
            ? ` decision=${String(event.decision)} ${String(event.conclusionType)}`
            : event.type === 'report.ready'
              ? ` verified=${String(event.report?.verification?.verified)}`
              : '';
        console.log(`     ${event.type}${detail}`);
      }
    }
    printed = events.length;

    // 只审批，不推动：不 recheckVerification、不 acceptUnverified、不 resumeRepair。
    await approveIfNeeded(task, events, approvedPlans, approvedSteps);

    const planCount = evidence.events.filter(event => event.type === 'plan.ready').length;
    if (planCount >= 2 && !shotSecondPlan) {
      shotSecondPlan = true;
      await shot('01-second-round.png');
    }

    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
      terminal = task;
      break;
    }
  }

  // report_pending 是新的停顿出口；多等一会儿确认没有「过几分钟又自己开一轮」。
  if (!terminal) {
    const pendingAt = Date.now();
    while (Date.now() - pendingAt < 45000 && Date.now() < deadline + 45000) {
      await sleep(2000);
      const task = await tryEval(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
      if (task?.status === 'awaiting_approval') awaitingApprovalSeen = true;
      const events = (await tryEval(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`, 45000, [])) ?? [];
      for (const event of events.slice(printed)) evidence.events.push(compactEvent(event, evidenceFacts));
      printed = events.length;
      if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
        terminal = task;
        break;
      }
    }
  }

  evidence.finishedAtValue = Date.now();
  evidence.finishedAt = new Date().toISOString();
  evidence.terminal = terminal
    ? { status: terminal.status, error: terminal.error ?? null, summary: terminal.summary ?? null }
    : { status: (await tryEval(`window.agentAPI.getTask(${JSON.stringify(taskId)})`))?.status ?? 'timeout', timedOut: true };
  evidence.result = classify();
  evidence.approvalObserved = {
    awaitingApprovalSeen,
    plansClicked: approvedPlans.size,
    stepsClicked: approvedSteps.size,
    needsAnalysisWarnings: evidence.events.filter(event =>
      event.type === 'log' && /NEEDS_ANALYSIS|TDL 缺可独立验收的 L2/.test(event.message ?? '')
    ).map(event => event.message)
  };
  note(
    'full-access-no-plan-approval',
    !awaitingApprovalSeen && approvedPlans.size === 0,
    `awaiting=${String(awaitingApprovalSeen)} plansClicked=${String(approvedPlans.size)} NEEDS_ANALYSIS=${String(evidence.approvalObserved.needsAnalysisWarnings.length)}`
  );
  note('task-terminal', ['completed', 'failed', 'cancelled'].includes(evidence.terminal.status), JSON.stringify(evidence.terminal));

  await shot('02-final.png');

  if (!process.env.KEEP_RUNNING) await stopDev();
  await sleep(500);
  const storeAfter = sha256(REAL_STORE);
  evidence.storeAfter = storeAfter;
  note('real-store-untouched', storeBefore === storeAfter, `${String(storeBefore).slice(0, 12)} → ${String(storeAfter).slice(0, 12)}`);

  fs.writeFileSync(path.join(OUT_DIR, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  const result = evidence.result;
  fs.writeFileSync(
    path.join(OUT_DIR, 'EVIDENCE.md'),
    [
      '# 真机复验：还会不会出现长流程',
      '',
      `- 时间：${evidence.startedAt} → ${evidence.finishedAt}`,
      `- 任务：\`${taskId}\`，隔离 userData \`${ISO_USER_DATA}\`，工作区 \`${WORKSPACE}\``,
      `- 模型：${JSON.stringify(evidence.executionDefaults?.selectedCloudModels ?? [])}，权限 \`danger-full-access\`（/tmp 一次性工作区）`,
      `- 真实 store：\`${String(storeBefore).slice(0, 12)}\` 前后${storeBefore === storeAfter ? '一致' : '**变了**'}`,
      '',
      '## 判定',
      '',
      `- 结论：**${result.verdict}**`,
      `- 轮次 ${String(result.rounds)} / 其中出计划 ${String(result.plans)} / 报告 ${String(result.reports)} 份 / 评审 ${String(result.reviews)} 次`,
      `- 耗时 ${String(Math.round(result.elapsedMs / 1000))} 秒，终态 \`${String(result.terminal)}\``,
      `- 报告证据重复：${String(result.repeatedEvidence)}；评审问题重复：${String(result.repeatedReview)}`,
      `- cycle.snapshot：${JSON.stringify(result.snapshots)}`,
      `- 闸门拦截：${JSON.stringify(result.guards)}`,
      `- 完全权限审批：等待审批=${String(evidence.approvalObserved.awaitingApprovalSeen)}，人工点计划=${String(evidence.approvalObserved.plansClicked)}，NEEDS_ANALYSIS 警告=${String(evidence.approvalObserved.needsAnalysisWarnings.length)} 条`,
      '',
      '## 事件',
      '',
      '| 时间 | 事件 | 详情 |',
      '| --- | --- | --- |',
      ...evidence.events.map(event =>
        `| ${String(event.at ?? '')} | ${event.type} | ${JSON.stringify(
          Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'at', 'facts'].includes(key)))
        ).slice(0, 300)} |`
      ),
      '',
      '## 截图',
      '',
      ...evidence.shots.map(file => `- \`${path.relative(OUT_DIR, path.join(ROOT, file))}\``),
      '',
      '> 全程只读观察：没有点接受未验证、没有手动重判验证、没有取消任务。'
    ].join('\n')
  );
  console.log(`\n判定：${result.verdict}（${String(result.rounds)} 轮 / ${String(Math.round(result.elapsedMs / 1000))} 秒）`);
  console.log(`证据：${path.relative(ROOT, OUT_DIR)}/EVIDENCE.md`);
}

try {
  await main();
} catch (error) {
  console.error('复验中断：', error?.message ?? error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'failure.json'), `${JSON.stringify({ error: String(error?.stack ?? error), evidence }, null, 2)}\n`);
  await stopDev();
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (!process.env.KEEP_RUNNING) await stopDev();
}
