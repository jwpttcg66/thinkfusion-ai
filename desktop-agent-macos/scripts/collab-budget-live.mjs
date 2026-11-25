/**
 * CB 真机：L0 只读列目录，核对协作克制。
 *
 * 断言：
 *   - 任务终态 completed（或失败也记证据）
 *   - 无 plan.review.progress / 无主导五段等待（L0 auto 应跳过方案评审）
 *   - plan.debated 若有则 status=skipped
 *   - review.ready 的 backend 优先 rules（验证通过时不调模型）
 *   - 面板「核心意见」展示数明显小于「88」量级；争议可为 0
 *
 * 用法：
 *   CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/collab-budget-live.mjs [workspace]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-cb-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 420000);
const REPORT = process.env.CB_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-COLLAB-BUDGET-LIVE.json');

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'cb-live-readme\n');
fs.writeFileSync(path.join(WORKSPACE, 'a.txt'), 'a\n');

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
  checks: {},
  eventTypes: []
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
assert.equal(defaults?.executionMode, 'cloud');
assert.ok(openGoReady.length > 0);

const prompt = '只读列出工作区根目录下的文件名，把文件名写进结论即可，不要改任何文件，不要辩论。';
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
    const extra = event.type === 'plan.debated'
      ? ` status=${event.debate?.status ?? event.status ?? '?'}`
      : event.type === 'review.ready'
        ? ` backend=${event.backend}`
        : event.error
          ? ` (${event.error})`
          : '';
    console.log(`  ${event.type}${extra}`);
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
    } catch { /* ignore */ }
  }

  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    terminal = task;
    break;
  }
}

const finalEvents = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
const reviewProgress = finalEvents.filter(event => event.type === 'plan.review.progress');
const debated = finalEvents.filter(event => event.type === 'plan.debated');
const reviews = finalEvents.filter(event => event.type === 'review.ready');
const leadDeltas = finalEvents.filter(event =>
  event.type === 'round.delta' && String(event.memberId ?? event.participantId ?? '').includes('lead-summary')
);

const dom = await cdp.evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  const panel = document.querySelector('.collab-result');
  const summary = [...(panel?.querySelectorAll('summary') ?? [])]
    .map(el => (el.textContent || '').trim().replace(/\\s+/g, ' '))
    .find(t => t.includes('核心意见'));
  const m = summary?.match(/展示\\s*(\\d+)/);
  const raw = summary?.match(/原始\\s*(\\d+)/);
  const disputes = summary?.match(/争议\\s*(\\d+)/);
  return {
    hasPanel: Boolean(panel),
    opinionSummary: summary ?? null,
    shownOpinions: m ? Number(m[1]) : null,
    rawOpinions: raw ? Number(raw[1]) : null,
    disputes: disputes ? Number(disputes[1]) : null,
    hasFinale: Boolean(panel?.querySelector('.collab-result-finale')),
    sample: (panel?.innerText ?? text).slice(0, 600)
  };
})()`);

note('task-reached-terminal', Boolean(terminal), terminal ? terminal.status : 'timeout');
note(
  'no-plan-review-progress',
  reviewProgress.length === 0,
  `plan.review.progress=${reviewProgress.length}`
);
note(
  'no-lead-summary-stream',
  leadDeltas.length === 0,
  `lead-summary deltas=${leadDeltas.length}`
);
const debateOk = debated.every(event => {
  const status = event.debate?.status ?? event.status;
  return status === 'skipped' || status === undefined;
}) || debated.length === 0;
note('plan-debate-skipped-or-absent', debateOk, `debated=${debated.length}`);
const modelReviews = reviews.filter(event => event.backend === 'model');
note(
  'review-prefer-rules',
  modelReviews.length === 0 || terminal?.status !== 'completed',
  `reviews=${reviews.length}; model=${modelReviews.length}; backends=${reviews.map(r => r.backend).join(',') || 'none'}`
);
note('result-panel-visible', Boolean(dom.hasPanel), dom.hasPanel ? 'found' : 'missing');
note(
  'opinions-not-runaway',
  dom.shownOpinions === null || dom.shownOpinions <= 24,
  `shown=${dom.shownOpinions}; raw=${dom.rawOpinions}; disputes=${dom.disputes}`
);

evidence.terminal = terminal ? { status: terminal.status, error: terminal.error ?? null, summary: terminal.summary ?? null } : null;
evidence.reviewProgressCount = reviewProgress.length;
evidence.debated = debated.map(event => ({
  status: event.debate?.status ?? event.status,
  skippedReason: event.debate?.skippedReason ?? event.skippedReason
}));
evidence.reviews = reviews.map(event => ({ backend: event.backend, needsFix: event.needsFix }));
evidence.dom = dom;
evidence.finishedAt = new Date().toISOString();
evidence.ok = Object.values(evidence.checks).every(item => item.ok);

fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
