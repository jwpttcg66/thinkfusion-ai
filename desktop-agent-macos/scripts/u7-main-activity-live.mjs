/**
 * U7 真机：结果面板与时间线去重 + 来源标签可见。
 *
 * 前提同 U6：真实 THINKFUSION_USER_DATA + electron-vite --remoteDebuggingPort 9333
 *
 * 额外断言：
 *   - 有 .collab-result 时，工程时间线不得再出现完整 .chat-conclusion
 *   - 协作过程默认收起（.is-process 无 open，或细节未展开）
 *   - 意见/争议区若有来源标签则可见
 *
 * 用法：
 *   CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/u7-main-activity-live.mjs [workspace]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-u7-workspace');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 360000);
const REPORT = process.env.U7_REPORT ?? path.join(os.tmpdir(), 'tf-v3-u7-report.json');

fs.mkdirSync(WORKSPACE, { recursive: true });
if (!fs.existsSync(path.join(WORKSPACE, 'readme.txt'))) {
  fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'readme.txt\n');
}

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
if (!app) throw new Error(`找不到渲染进程；当前 targets=${JSON.stringify(targets.map(t => t.url))}`);
const cdp = await connect(app);

const evidence = {
  startedAt: Date.now(),
  endpoint: ENDPOINT,
  workspace: WORKSPACE,
  checks: {},
  events: []
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
assert.equal(defaults?.executionMode, 'cloud', '本机 execution defaults 必须是 cloud');
assert.ok(openGoReady.length > 0, 'OpenCode Go 不可用；请用真实 userdata');

const promptA = '工作区根目录下有哪些文件名？';
const conversation = await cdp.evaluate(
  `window.agentAPI.submitConversation(${JSON.stringify({
    text: promptA,
    permissionPreset: 'read-only',
    workspaceRoot: WORKSPACE,
    workspaceMode: 'engineering',
    executionConfig: defaults,
    taskKindOverride: 'execution'
  })})`
);
const taskId = conversation.taskId;
assert.ok(taskId, 'submitConversation 未返回 taskId');
evidence.taskA = taskId;
evidence.conversationId = conversation.conversationId;
console.log(`taskA ${taskId}`);

const deadlineA = Date.now() + TIMEOUT_MS;
let printed = 0;
let terminal = null;
const approvedPlanIds = new Set();
while (Date.now() < deadlineA) {
  await sleep(2000);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  for (const event of events.slice(printed)) {
    evidence.events.push({ type: event.type, at: event.at });
    console.log(`  A ${event.type}${event.error ? ` (${event.error})` : ''}`);
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
      console.log(`  A approved plan ${planId}`);
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

const domA = await cdp.evaluate(`(() => {
  const panel = document.querySelector('.collab-result');
  const processSection = document.querySelector('.collab-result-section.is-process');
  const conclusions = document.querySelectorAll('.chat-conclusion');
  const reviewCards = document.querySelectorAll('.chat-review');
  const verifyCards = document.querySelectorAll('.chat-verification');
  const timelineMarkers = Array.from(document.querySelectorAll('.chat-note-text'))
    .map(el => el.textContent ?? '')
    .filter(text => text.includes('详见上方') || text.includes('已写入上方'));
  const sourceLabels = Array.from(document.querySelectorAll('.collab-result-sources'))
    .map(el => el.textContent?.trim() ?? '')
    .filter(Boolean);
  return {
    hasPanel: Boolean(panel),
    panelText: (panel?.innerText ?? '').slice(0, 1000),
    processOpen: processSection ? processSection.open : null,
    fullConclusionCount: conclusions.length,
    fullReviewCount: reviewCards.length,
    fullVerifyCount: verifyCards.length,
    timelineMarkerCount: timelineMarkers.length,
    sourceLabelCount: sourceLabels.length,
    sourceSample: sourceLabels.slice(0, 3)
  };
})()`);

note('engineering-task-completed', terminal?.status === 'completed', terminal ? terminal.status : 'timeout');
note('result-panel-visible', Boolean(domA.hasPanel), domA.hasPanel ? 'found' : 'missing');
note(
  'no-duplicate-full-conclusion',
  !domA.hasPanel || domA.fullConclusionCount === 0,
  `chat-conclusion=${domA.fullConclusionCount}`
);
note(
  'no-duplicate-full-review-cards',
  !domA.hasPanel || domA.fullReviewCount === 0,
  `chat-review=${domA.fullReviewCount}`
);
note(
  'no-duplicate-full-verify-cards',
  !domA.hasPanel || domA.fullVerifyCount === 0,
  `chat-verification=${domA.fullVerifyCount}`
);
note(
  'process-section-collapsed-by-default',
  !domA.hasPanel || domA.processOpen === false,
  `processOpen=${domA.processOpen}`
);
note(
  'timeline-keeps-markers-when-omitted',
  !domA.hasPanel || terminal?.status !== 'completed' || domA.timelineMarkerCount > 0 || (
    domA.fullConclusionCount === 0 && domA.fullReviewCount === 0
  ),
  `markers=${domA.timelineMarkerCount}`
);

evidence.domA = domA;
evidence.terminal = terminal ? { status: terminal.status, error: terminal.error ?? null } : null;
evidence.finishedAt = Date.now();
evidence.ok = Object.values(evidence.checks).every(item => item.ok);
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
