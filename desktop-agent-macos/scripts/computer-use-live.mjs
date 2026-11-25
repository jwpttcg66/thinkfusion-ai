/**
 * 在已经打开的 ThinkFusion 窗口里提交一次桌面操作任务。
 *
 * 前提：desktop-agent-macos 下
 *   THINKFUSION_USER_DATA=$HOME/Library/Application Support/thinkfusion-ai
 *   npm run dev:local
 * CDP 端口 9333。
 *
 * 问题原样发给会话。脚本只代替窗口里的「批准计划 / 批准这一步」，
 * 不改用户的执行默认，也不往问题里加话术。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.env.LIVE_WORKSPACE ?? path.join(os.tmpdir(), 'tf-computer-use-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 480000);
let MARKER = process.env.LIVE_MARKER ?? `tf-live-window-${Date.now().toString(36)}`;
const REPORT = process.env.LIVE_REPORT ?? path.join(os.tmpdir(), 'tf-computer-use-live.json');
const QUESTION = process.env.LIVE_QUESTION ?? `打开 TextEdit。观察当前窗口，如果文本框是空的，输入 ${MARKER}，核对这段文字出现，然后把文本框清空。`;

fs.mkdirSync(WORKSPACE, { recursive: true });

function ax(payload) {
  const helper = path.join(process.cwd(), 'resources/ax-bridge');
  const run = spawnSync(helper, [], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 8000
  });
  const line = (run.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (!line) return { ok: false, error: run.stderr || 'helper 没有输出' };
  return JSON.parse(line);
}

function walk(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  acc.push(node);
  for (const child of node.children ?? []) walk(child, acc);
  return acc;
}

function textEditHasMarker() {
  const front = ax({ command: 'frontmostApplication' });
  const tree = ax({ command: 'focusedTree', maxDepth: 6 });
  const nodes = walk(tree.result);
  const hit = nodes.some(node => String(node.value ?? '').includes(MARKER) || String(node.title ?? '').includes(MARKER));
  return {
    bundleId: front.result?.bundleId ?? null,
    name: front.result?.name ?? null,
    hit,
    roles: nodes.filter(node => node.role === 'AXTextArea' || node.role === 'AXTextField').map(node => ({
      id: node.id,
      role: node.role,
      len: String(node.value ?? '').length,
      hasMarker: String(node.value ?? '').includes(MARKER)
    }))
  };
}

const targets = await (await fetch(ENDPOINT)).json();
const app = targets.find(target =>
  target.type === 'page' &&
  (target.url.startsWith('file:') || target.url.includes('localhost:5173') || /ThinkFusion/i.test(target.title ?? ''))
);
if (!app) throw new Error(`找不到 ThinkFusion 窗口：${JSON.stringify(targets.map(item => item.url))}`);
const cdp = await connect(app);

const evidence = {
  startedAt: new Date().toISOString(),
  question: QUESTION,
  marker: MARKER,
  workspace: WORKSPACE,
  sawMarker: false,
  computerTools: [],
  terminal: null
};

const defaults = await cdp.evaluate('window.agentAPI.getExecutionDefaults()');
evidence.defaults = {
  executionMode: defaults?.executionMode ?? null,
  stepApproval: defaults?.stepApproval ?? null,
  selectedCloudModels: defaults?.selectedCloudModels ?? null
};
console.log(`defaults mode=${defaults?.executionMode} approval=${defaults?.stepApproval}`);

function fire(expression) {
  return cdp.evaluate(`(() => { ${expression}; return 'sent'; })()`);
}

let taskId = process.env.RESUME_TASK ?? '';
if (!taskId) {
  const conversation = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({
    text: QUESTION,
    permissionPreset: 'workspace-write',
    workspaceRoot: WORKSPACE,
    workspaceMode: 'engineering',
    executionConfig: defaults,
    taskKindOverride: 'execution'
  })})`);
  taskId = conversation.taskId;
  if (!taskId) throw new Error(`没有任务：${JSON.stringify(conversation.routing ?? conversation).slice(0, 800)}`);
  evidence.conversationId = conversation.conversationId;
}
evidence.taskId = taskId;
if (process.env.RESUME_TASK) {
  const existing = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  const found = String(existing?.userPrompt ?? '').match(/tf-live-window-[a-z0-9]+/);
  if (found) MARKER = found[0];
  evidence.conversationId = existing?.conversationId ?? null;
  console.log(`resume status=${existing?.status} marker=${MARKER}`);
}
evidence.marker = MARKER;
evidence.question = process.env.RESUME_TASK ? null : QUESTION;
console.log(`task ${taskId}`);

const deadline = Date.now() + TIMEOUT_MS;
const approvedPlans = new Set();
const approvedSteps = new Set();
let printed = 0;
let terminal = null;
while (Date.now() < deadline) {
  await sleep(2000);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  for (const event of events.slice(printed)) {
    const tool = event.tool ?? event.step?.tool ?? '';
    if (String(tool).startsWith('computer.') || String(event.type).startsWith('computer.')) {
      evidence.computerTools.push({ type: event.type, tool, at: event.at });
    }
    console.log(`  ${event.type}${tool ? ` ${tool}` : ''}${event.error ? ` (${event.error})` : ''}`);
  }
  printed = events.length;
  const task = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  if (!task) continue;

  if (task.status === 'awaiting_approval') {
    const plan = [...events].reverse().find(event => event.type === 'plan.ready' && event.plan?.planId);
    const planId = plan?.plan?.planId;
    if (planId && !approvedPlans.has(planId)) {
      const tools = (plan.plan.steps ?? []).map(step => step.tool);
      evidence.planTools = tools;
      console.log(`  plan ${tools.join(', ')}`);
      await fire(`window.agentAPI.approvePlan(${JSON.stringify({
        taskId,
        roundId: plan.roundId,
        planId,
        approved: true
      })}).catch(error => console.error(error))`);
      approvedPlans.add(planId);
    }
  }

  const pending = [...events].reverse().find(event => {
    if (event.type !== 'step.approval' || !event.stepId) return false;
    const settled = events.some(item =>
      (item.type === 'step.approval-resolved') && item.stepId === event.stepId && (item.at ?? 0) >= (event.at ?? 0)
    );
    return !settled && !approvedSteps.has(`${event.at}:${event.stepId}`);
  });
  if (pending) {
    console.log(`  approve step ${pending.stepId} ${pending.tool ?? pending.step?.tool ?? ''}`);
    await fire(`window.agentAPI.approveStep(${JSON.stringify({ taskId, stepId: pending.stepId })}).catch(error => console.error(error))`);
    approvedSteps.add(`${pending.at}:${pending.stepId}`);
  }

  if (task.status === 'awaiting_clarification') {
    const asked = events.some(event => event.type === 'clarification.answered');
    if (!asked) {
      await fire(`window.agentAPI.answerClarification(${JSON.stringify({
        taskId,
        answer: '文本框是空的就输入，核对后再清空。'
      })}).catch(error => console.error(error))`);
      console.log('  answered clarification');
    }
  }

  const observed = textEditHasMarker();
  if (observed.hit) evidence.sawMarker = true;

  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    terminal = task;
    break;
  }
}

evidence.terminal = terminal ? { status: terminal.status, error: terminal.error ?? null } : { status: 'timeout' };
evidence.finalObserve = textEditHasMarker();
if (evidence.finalObserve.hit) {
  const field = evidence.finalObserve.roles.find(item => item.hasMarker);
  if (field) {
    const cleared = ax({
      command: 'setValue',
      elementId: field.id,
      text: '',
      expectedRole: field.role
    });
    evidence.clearedByChecker = cleared.ok === true;
  }
}
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report ${REPORT}`);
console.log(JSON.stringify({
  status: evidence.terminal.status,
  error: evidence.terminal.error,
  sawMarker: evidence.sawMarker,
  planTools: evidence.planTools ?? [],
  computerEvents: evidence.computerTools.length
}, null, 2));
if (evidence.terminal.status !== 'completed' || !evidence.sawMarker) process.exitCode = 1;
