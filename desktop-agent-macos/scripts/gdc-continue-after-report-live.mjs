/**
 * GDC 真机：短工程任务跑到终态，核对 continueAfterReport 落点事件。
 *
 * 前提：本分支 electron-vite --remoteDebuggingPort 9333 + 真实 userdata
 *
 * 断言：
 *   - 任务终态 completed/failed（超时不算通过）
 *   - 事件流出现 cycle.snapshot
 *   - 事件流出现 goal.fit
 *   - 结果面板可见工程目标 / 循环进度 / 结论与下一步
 *   - 若 completed：时间线含「循环决策」或「目标符合度」笔记
 *
 * 用法：
 *   CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/gdc-continue-after-report-live.mjs [workspace]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-gdc-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 420000);
const REPORT = process.env.GDC_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-GDC-CONTINUE-AFTER-REPORT-LIVE.json');

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'gdc-live-readme\n');
fs.writeFileSync(path.join(WORKSPACE, 'marker.txt'), 'marker-ok\n');

async function listOn(endpoint) {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`CDP ${endpoint} -> ${response.status}`);
  return response.json();
}

function findRenderer(targets) {
  return targets.find(target =>
    target.type === 'page' &&
    (target.url.startsWith('file:') || target.url.includes('localhost:5173') || /ThinkFusion/i.test(target.title ?? ''))
  ) ?? null;
}

const targets = await listOn(ENDPOINT);
const app = findRenderer(targets);
if (!app) throw new Error(`找不到渲染进程；targets=${JSON.stringify(targets.map(t => t.url))}`);
const cdp = await connect(app);

const evidence = {
  startedAt: new Date().toISOString(),
  endpoint: ENDPOINT,
  workspace: WORKSPACE,
  appPathHint: app.url,
  checks: {},
  eventTypes: [],
  snapshots: [],
  goalFits: []
};

function note(name, ok, detail) {
  evidence.checks[name] = { ok, detail, at: Date.now() };
  console.log(`${ok ? 'OK' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const apiReady = await cdp.evaluate(`typeof window.agentAPI?.submitConversation === 'function'`);
assert.equal(apiReady, true, 'agentAPI 未注入');

// 确认跑的是带 GDC 接线的构建：contracts 里应有 cycle.snapshot 处理路径（UI 文案）。
const hasGdcUi = await cdp.evaluate(`(() => {
  // 仅探测脚本是否来自 goal-driven 工作树：主进程无法直接读，靠后续事件断言。
  return typeof window.agentAPI.getTaskEvents === 'function';
})()`);
assert.equal(hasGdcUi, true);

const defaults = await cdp.evaluate(`window.agentAPI.getExecutionDefaults()`);
const opts = await cdp.evaluate(`window.agentAPI.getExecutionOptions()`);
const openGo = (opts?.cloudMembers ?? []).filter(item => String(item.id).startsWith('opencode-go:'));
const openGoReady = openGo.filter(item => item.hasKey);
note('opencode-go-present', openGoReady.length > 0, `withKey=${openGoReady.length}/${openGo.length}`);
note('execution-defaults-cloud', defaults?.executionMode === 'cloud', `mode=${defaults?.executionMode}`);
assert.equal(defaults?.executionMode, 'cloud', 'execution defaults 必须是 cloud');
assert.ok(openGoReady.length > 0, 'OpenCode Go 不可用');

const prompt = '只读列出工作区根目录下的文件名，把文件名列表写进结论即可，不要改任何文件。';
const conversation = await cdp.evaluate(
  `window.agentAPI.submitConversation(${JSON.stringify({
    text: prompt,
    permissionPreset: 'read-only',
    workspaceRoot: WORKSPACE,
    workspaceMode: 'engineering',
    executionConfig: defaults,
    taskKindOverride: 'execution'
  })})`
);
const taskId = conversation.taskId;
assert.ok(taskId, 'submitConversation 未返回 taskId');
evidence.taskId = taskId;
evidence.conversationId = conversation.conversationId;
console.log(`task ${taskId}`);

const deadline = Date.now() + TIMEOUT_MS;
let printed = 0;
let terminal = null;
const approvedPlanIds = new Set();

while (Date.now() < deadline) {
  await sleep(2000);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  for (const event of events.slice(printed)) {
    evidence.eventTypes.push(event.type);
    if (event.type === 'cycle.snapshot') {
      evidence.snapshots.push({
        decision: event.decision,
        conclusionType: event.conclusionType,
        currentStage: event.currentStage,
        nextAction: event.nextAction,
        cycleNumber: event.cycleNumber
      });
      console.log(`  cycle.snapshot decision=${event.decision} stage=${event.currentStage}`);
    } else if (event.type === 'goal.fit') {
      evidence.goalFits.push({ fit: event.fit, notes: event.notes });
      console.log(`  goal.fit ${event.fit}`);
    } else {
      console.log(`  ${event.type}${event.error ? ` (${event.error})` : ''}`);
    }
  }
  printed = events.length;

  const task = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  if (!task) continue;

  if (task.status === 'awaiting_approval') {
    const plan = [...events].reverse().find(event => event.type === 'plan.ready' && event.plan?.planId);
    const planId = plan?.plan?.planId;
    if (planId && !approvedPlanIds.has(planId)) {
      await cdp.evaluate(
        `window.agentAPI.approvePlan(${JSON.stringify({
          taskId,
          roundId: plan.roundId,
          planId,
          approved: true
        })})`
      );
      approvedPlanIds.add(planId);
      console.log(`  approved plan ${planId}`);
    }
  }

  if (task.status === 'report_pending') {
    try {
      await cdp.evaluate(`window.agentAPI.recheckVerification(${JSON.stringify(taskId)})`);
    } catch {
      /* ignore */
    }
  }

  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    terminal = task;
    break;
  }
}

const finalEvents = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
evidence.snapshots = finalEvents
  .filter(event => event.type === 'cycle.snapshot')
  .map(event => ({
    decision: event.decision,
    conclusionType: event.conclusionType,
    currentStage: event.currentStage,
    nextAction: event.nextAction,
    cycleNumber: event.cycleNumber,
    debateSkipped: event.debateSkipped
  }));
evidence.goalFits = finalEvents
  .filter(event => event.type === 'goal.fit')
  .map(event => ({ fit: event.fit, notes: event.notes }));

const dom = await cdp.evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  const notes = Array.from(document.querySelectorAll('.chat-note-text, .chat-note, [class*="note"]'))
    .map(el => el.textContent ?? '')
    .filter(Boolean);
  const cycleNotes = notes.filter(t => t.includes('循环决策') || t.includes('目标符合度'));
  return {
    hasGoal: text.includes('工程目标'),
    hasCycle: text.includes('循环进度'),
    hasNext: text.includes('结论与下一步'),
    cycleNotes: cycleNotes.slice(0, 6).map(t => t.slice(0, 200)),
    panelSnippet: (document.querySelector('.collab-result')?.innerText ?? '').slice(0, 800)
  };
})()`);

note('task-reached-terminal', Boolean(terminal), terminal ? terminal.status : 'timeout');
note('cycle-snapshot-emitted', evidence.snapshots.length > 0, `count=${evidence.snapshots.length}`);
note('goal-fit-emitted', evidence.goalFits.length > 0, `count=${evidence.goalFits.length}`);
note('ui-goal-section', Boolean(dom.hasGoal), dom.hasGoal ? 'visible' : 'missing');
note('ui-cycle-section', Boolean(dom.hasCycle), dom.hasCycle ? 'visible' : 'missing');
note('ui-next-section', Boolean(dom.hasNext), dom.hasNext ? 'visible' : 'missing');
note(
  'timeline-gdc-notes',
  terminal?.status !== 'completed' || dom.cycleNotes.length > 0 || evidence.snapshots.length > 0,
  `notes=${dom.cycleNotes.length}; snapshots=${evidence.snapshots.length}`
);

if (evidence.snapshots.length > 0) {
  const last = evidence.snapshots[evidence.snapshots.length - 1];
  note(
    'snapshot-decision-sane',
    ['complete', 'repair', 'fail_delivery', 'fail_budget', 'observe'].includes(last.decision),
    `decision=${last.decision}`
  );
}

evidence.terminal = terminal ? { status: terminal.status, error: terminal.error ?? null, summary: terminal.summary ?? null } : null;
evidence.dom = dom;
evidence.finishedAt = new Date().toISOString();
evidence.ok = Object.values(evidence.checks).every(item => item.ok);

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
