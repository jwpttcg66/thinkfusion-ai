/**
 * TDL 真机：短工程任务跑到有计划/步骤，核对 WorkBreakdown 面板 0/N → k/N。
 *
 * 前提：本分支 electron-vite --remoteDebuggingPort 9333
 *
 * 断言：
 *   - plan.ready 后出现 work.breakdown.created / work.task.upserted（或派生视图）
 *   - 面板 .work-breakdown 可见，分数形如 completed / total
 *   - 至少一条步骤完成后 completed 增加，或终态 completed 时分数合理
 *
 * 用法：
 *   CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/tdl-engineering-live.mjs [workspace]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';
import { projectWorkBreakdownFromEvents } from '../out-test/shared/task-decomposition.js';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-tdl-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 420000);
const REPORT = process.env.TDL_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-TDL-ENGINEERING-LIVE.json');

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'tdl-live-readme\n');
fs.writeFileSync(path.join(WORKSPACE, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(WORKSPACE, 'b.txt'), 'beta\n');
fs.mkdirSync(path.dirname(REPORT), { recursive: true });

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
  appTitleHint: app.url,
  checks: {},
  scores: [],
  workEventTypes: []
};

function note(name, ok, detail) {
  evidence.checks[name] = { ok, detail, at: Date.now() };
  console.log(`${ok ? 'OK' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const apiReady = await cdp.evaluate(`typeof window.agentAPI?.submitConversation === 'function'`);
assert.equal(apiReady, true, 'agentAPI 未注入');

const defaults = await cdp.evaluate(`window.agentAPI.getExecutionDefaults()`);
const opts = await cdp.evaluate(`window.agentAPI.getExecutionOptions()`);
const openGo = (opts?.cloudMembers ?? []).filter(item => String(item.id).startsWith('opencode-go:'));
const openGoReady = openGo.filter(item => item.hasKey);
note('opencode-go-present', openGoReady.length > 0, `withKey=${openGoReady.length}/${openGo.length}`);
note('execution-defaults-cloud', defaults?.executionMode === 'cloud', `mode=${defaults?.executionMode}`);
assert.equal(defaults?.executionMode, 'cloud', 'execution defaults 必须是 cloud');
assert.ok(openGoReady.length > 0, 'OpenCode Go 不可用');

const prompt =
  '只读列出工作区根目录下的文件名，把文件名写进结论即可，不要改任何文件。';
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
const approvedPlanIds = new Set();
let sawPlan = false;
let sawWorkSeed = false;
let sawPanel = false;
let maxCompleted = 0;
let maxTotal = 0;
let printed = 0;
let terminal = null;

while (Date.now() < deadline) {
  await sleep(2000);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  const list = Array.isArray(events) ? events : [];
  for (const event of list.slice(printed)) {
    console.log(`  ${event.type}${event.error ? ` (${event.error})` : ''}`);
  }
  printed = list.length;

  if (list.some(item => item.type === 'plan.ready')) sawPlan = true;
  if (list.some(item =>
    item.type === 'work.breakdown.created' || item.type === 'work.task.upserted'
  )) {
    sawWorkSeed = true;
  }
  evidence.workEventTypes = [...new Set(list.map(item => item.type).filter(t => String(t).startsWith('work.')))];

  const view = projectWorkBreakdownFromEvents({
    workId: taskId,
    events: list,
    title: 'tdl-live'
  });
  maxCompleted = Math.max(maxCompleted, view.summary.completed);
  maxTotal = Math.max(maxTotal, view.summary.total);
  if (
    evidence.scores.length === 0 ||
    evidence.scores[evidence.scores.length - 1].completed !== view.summary.completed ||
    evidence.scores[evidence.scores.length - 1].total !== view.summary.total
  ) {
    evidence.scores.push({
      at: Date.now(),
      completed: view.summary.completed,
      total: view.summary.total,
      source: view.source,
      status: view.status
    });
    console.log(`  score ${view.summary.completed}/${view.summary.total} (${view.source})`);
  }

  const panel = await cdp.evaluate(`(() => {
    const root = document.querySelector('.work-breakdown');
    if (!root) return null;
    const score = root.querySelector('.work-breakdown-score')?.textContent?.trim() ?? '';
    const items = [...root.querySelectorAll('.work-breakdown-item')].map(li => ({
      title: li.querySelector('.work-breakdown-title')?.textContent?.trim() ?? '',
      state: li.querySelector('.work-breakdown-state')?.textContent?.trim() ?? '',
      current: li.classList.contains('is-current')
    }));
    return { score, items, text: root.innerText.slice(0, 500) };
  })()`);
  if (panel) {
    sawPanel = true;
    evidence.panel = panel;
  }

  const task = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  if (!task) continue;

  if (task.status === 'awaiting_approval') {
    const plan = [...list].reverse().find(event => event.type === 'plan.ready' && event.plan?.planId);
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
    terminal = task.status;
    evidence.finalSummary = task.summary ?? null;
    break;
  }
}

note('plan-ready', sawPlan, sawPlan ? 'seen' : 'missing');
note('work-seed-events', sawWorkSeed, evidence.workEventTypes.join(',') || 'none');
note('work-breakdown-panel', sawPanel, evidence.panel?.score ?? 'missing');
note('score-progress', maxTotal > 0, `${maxCompleted}/${maxTotal}`);
note(
  'completed-advanced',
  maxCompleted > 0 || terminal === 'completed',
  `completed=${maxCompleted} terminal=${terminal}`
);
note('task-terminal', Boolean(terminal), terminal ?? 'timeout');

assert.equal(sawPlan, true, '未看到 plan.ready');
assert.equal(sawWorkSeed || maxTotal > 0, true, '没有 work.* 种子也没有派生分解');
assert.equal(sawPanel, true, '未看到 .work-breakdown 面板');
assert.ok(maxTotal > 0, '分解 total 必须 > 0');
assert.ok(
  maxCompleted > 0 || terminal === 'completed',
  `进度未推进：completed=${maxCompleted} terminal=${terminal}`
);

evidence.finishedAt = new Date().toISOString();
evidence.ok = Object.values(evidence.checks).every(item => item.ok);
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
