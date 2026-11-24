/**
 * U6 真机：对正在跑的 ThinkFusion（CDP）做主活动区结果面板与 disposition 验收。
 *
 * 前提：
 *   用本机真实 THINKFUSION_USER_DATA 启动（含已有 OpenCode Go Key / 云端默认），
 *   electron-vite --remoteDebuggingPort 9333
 *
 * 约束：
 *   - 走云端主导（submitConversation + 已有 execution defaults），不改用户配置
 *   - 不打开网页源、不调用 submitPrompt（那条会走网页规划器）
 *   - 任务必须 status=completed；结果面板状态完整；failed 不算过
 *   - 用户问题原样发出，不拼完成条件/核对步骤等话术；交付核对由模型侧自行完成
 *
 * 用法：
 *   CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/u6-main-activity-live.mjs [workspace]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-u6-workspace');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 360000);
const REPORT = process.env.U6_REPORT ?? path.join(os.tmpdir(), 'tf-v3-u6-report.json');

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

// ---------------------------------------------------------------------------
// 探测能力：沿用本机已有云端默认；确认 OpenCode Go 可用；不开网页源
// ---------------------------------------------------------------------------
const apiReady = await cdp.evaluate(`typeof window.agentAPI?.submitConversation === 'function'`);
assert.equal(apiReady, true, 'agentAPI 未注入');
const defaults = await cdp.evaluate(`window.agentAPI.getExecutionDefaults()`);
const opts = await cdp.evaluate(`window.agentAPI.getExecutionOptions()`);
const sources = await cdp.evaluate(`window.agentAPI.getSources?.() ?? null`);
const openGo = (opts?.cloudMembers ?? []).filter(item => String(item.id).startsWith('opencode-go:'));
const openGoReady = openGo.filter(item => item.hasKey);
evidence.defaults = defaults;
evidence.opencodeGo = { total: openGo.length, withKey: openGoReady.length, ids: openGoReady.map(item => item.id).slice(0, 12) };
evidence.sources = {
  openOnLaunch: sources?.openOnLaunch ?? null,
  webViewsOpen: sources?.webViewsOpen ?? null,
  planningId: sources?.planningId ?? null
};
note('opencode-go-present', openGoReady.length > 0, `withKey=${openGoReady.length}/${openGo.length}`);
note('execution-defaults-cloud', defaults?.executionMode === 'cloud', `mode=${defaults?.executionMode}`);
note('web-sources-not-forced-open', sources?.openOnLaunch === false, `openOnLaunch=${sources?.openOnLaunch} webViewsOpen=${sources?.webViewsOpen}`);
assert.equal(defaults?.executionMode, 'cloud', '本机 execution defaults 必须是 cloud，脚本不改配置');
assert.ok(openGoReady.length > 0, 'OpenCode Go 模型不可用（hasKey=0）；请用真实 userdata 启动，不要用空临时目录');

// ---------------------------------------------------------------------------
// A. Engineering：云端会话；问题原样发出，脚本只验收终态完整
// ---------------------------------------------------------------------------
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
assert.ok(taskId, `submitConversation 未返回 taskId；routing=${JSON.stringify(conversation.routing ?? null)}`);
evidence.taskA = taskId;
evidence.conversationId = conversation.conversationId;
evidence.modelRoute = conversation.modelRoute ?? null;
console.log(`taskA ${taskId} conversation=${conversation.conversationId} answerers=${(conversation.modelRoute?.answerers ?? []).join(',')}`);

const deadlineA = Date.now() + TIMEOUT_MS;
let printed = 0;
let terminal = null;
const approvedPlanIds = new Set();
while (Date.now() < deadlineA) {
  await sleep(2000);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  for (const event of events.slice(printed)) {
    evidence.events.push({
      taskId,
      type: event.type,
      at: event.at,
      ...(event.error ? { error: event.error } : {}),
      ...(event.message ? { message: event.message } : {})
    });
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
      console.log('  A recheckVerification');
    } catch (error) {
      console.log(`  A recheckVerification failed: ${error}`);
    }
  }

  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    terminal = task;
    break;
  }
}

const domA = await cdp.evaluate(`(() => {
  const panel = document.querySelector('.collab-result');
  const text = panel?.innerText ?? '';
  const deliveryDup = Array.from(document.querySelectorAll('h2,h3,b,.section-title'))
    .map(el => el.textContent?.trim() ?? '')
    .filter(item => item.includes('最终交付'));
  return {
    hasPanel: Boolean(panel),
    panelText: text.slice(0, 800),
    deliveryDupCount: deliveryDup.length,
    showsCompleted: text.includes('completed'),
    showsFailedStatus: /工程\s*[·•]\s*failed/.test(text) || /尚未确认交付|没有真实交付/.test(text),
    bodySnippet: document.body?.innerText?.slice(0, 400) ?? ''
  };
})()`);

note('engineering-task-completed', terminal?.status === 'completed', terminal ? `${terminal.status}${terminal.error ? `: ${terminal.error}` : ''}` : 'timeout');
note('result-panel-visible', Boolean(domA.hasPanel), domA.hasPanel ? 'found .collab-result' : 'missing');
note(
  'result-status-complete',
  terminal?.status === 'completed' && Boolean(domA.hasPanel) && domA.showsCompleted && !domA.showsFailedStatus,
  terminal?.status === 'completed'
    ? `panelCompleted=${domA.showsCompleted} panelFailed=${domA.showsFailedStatus}`
    : `terminal=${terminal?.status ?? 'none'}`
);
note('no-duplicate-final-delivery-stack', domA.deliveryDupCount <= 1, `delivery headings=${domA.deliveryDupCount}`);
evidence.domA = domA;
evidence.terminal = terminal ? { status: terminal.status, error: terminal.error ?? null } : null;

// ---------------------------------------------------------------------------
// B. Disposition 写回：若有 pending 问题则暂缓一条；否则校验未知 issue 守卫
// ---------------------------------------------------------------------------
const eventsA = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
const review = [...eventsA].reverse().find(event => event.type === 'review.ready');
if (review?.issueDetails?.length) {
  const issue = review.issueDetails[0];
  await cdp.evaluate(
    `window.agentAPI.setReviewDisposition(${JSON.stringify({
      taskId,
      issueId: issue.issueId,
      disposition: 'deferred',
      reason: 'U6 真机：暂缓以验证写回',
      roundId: review.roundId
    })})`
  );
  await sleep(1000);
  const after = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  const disp = after.filter(event => event.type === 'review.disposition');
  note('disposition-writeback', disp.some(event => event.issueId === issue.issueId && event.disposition === 'deferred'),
    `disposition events=${disp.length}`);
  evidence.disposition = disp.at(-1) ?? null;
} else {
  let rejected = false;
  try {
    await cdp.evaluate(
      `window.agentAPI.setReviewDisposition(${JSON.stringify({
        taskId,
        issueId: 'missing-issue',
        disposition: 'rejected',
        reason: 'should fail'
      })})`
    );
  } catch {
    rejected = true;
  }
  note('disposition-api-guards-unknown-issue', rejected, review ? 'review without issues' : 'no review.ready');
}

// ---------------------------------------------------------------------------
// C. 轨迹入口按钮
// ---------------------------------------------------------------------------
const evidenceBtn = await cdp.evaluate(`Boolean(document.querySelector('.collab-result-evidence button'))`);
note('open-evidence-button', evidenceBtn || !domA.hasPanel, evidenceBtn ? 'button present' : 'panel absent so N/A');

evidence.finishedAt = Date.now();
evidence.ok = Object.values(evidence.checks).every(item => item.ok);
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
