/**
 * One real task, driven through the running app, against the real DeepSeek
 * session. This is the only check that exercises the whole chain at once: UI
 * state, main process, the embedded page, the parser and the runtime.
 *
 * Everything else in the suite is a unit test with a scripted page. They catch
 * regressions in the rules; only this catches the page changing under us.
 *
 * Usage:
 *   node scripts/e2e-live.mjs <workspace> ["prompt"]
 *   node scripts/e2e-live.mjs /tmp/demo "列出工作区根目录下的文件，不要修改任何内容"
 *
 * The app must already be running with --remote-debugging-port=9222, and the
 * embedded page must be logged in. The script approves each plan it receives,
 * because the point is to prove the loop closes, not to exercise the button.
 */
import { connect, findAppTarget, findPageTarget, listTargets, sleep } from './lib/cdp.mjs';

const WORKSPACE = process.argv[2];
const PROMPT = process.argv[3] ?? '列出工作区根目录下的文件，不要修改或创建任何内容';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 210000);

if (!WORKSPACE) {
  console.error('用法: node scripts/e2e-live.mjs <workspace> ["prompt"]');
  process.exit(2);
}

const targets = await listTargets();
const app = findAppTarget(targets);
const page = findPageTarget(targets);
if (!app) throw new Error('找不到应用渲染进程；请用 --remote-debugging-port=9222 启动');

const appCdp = await connect(app);
const pageCdp = page ? await connect(page) : null;

// Start from a fresh chat so the model is not answering inside an unrelated
// conversation — otherwise the first plan can reference files from a previous
// task and the run proves nothing.
if (pageCdp) {
  await pageCdp.evaluate("location.href = 'https://chat.deepseek.com/'");
  console.log('reset the embedded page to a fresh chat');
  await sleep(4000);
}

const task = await appCdp.evaluate(
  `window.agentAPI.submitPrompt(${JSON.stringify({ prompt: PROMPT, permissionPreset: 'read-only', workspaceRoot: WORKSPACE })})`
);
console.log(`task ${task.taskId} created`);

const deadline = Date.now() + TIMEOUT_MS;
let printed = 0;
let lastStatus = '';
let approvals = 0;
let terminal = null;

while (Date.now() < deadline) {
  await sleep(2000);

  const events = await appCdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(task.taskId)})`);
  for (const event of events.slice(printed)) {
    console.log(`  ${event.type}${describe(event)}`);
  }
  printed = events.length;

  const status = await appCdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(task.taskId)})`);
  if (status && status.status !== lastStatus) {
    console.log(`  status -> ${status.status}`);
    lastStatus = status.status;
  }
  if (!status) continue;

  if (status.status === 'awaiting_approval') {
    const planEvent = [...events].reverse().find(event => event.type === 'plan.ready');
    if (!planEvent) continue;
    approvals += 1;
    console.log(`  approving plan ${planEvent.plan.planId} (${planEvent.plan.steps.length} step(s))`);
    await appCdp.evaluate(
      `window.agentAPI.approvePlan(${JSON.stringify({
        taskId: task.taskId,
        roundId: planEvent.plan.roundId,
        planId: planEvent.plan.planId,
        approved: true
      })})`
    );
    continue;
  }

  if (['completed', 'failed', 'cancelled'].includes(status.status)) {
    terminal = { status, events };
    break;
  }
}

const finalStatus = await appCdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(task.taskId)})`);
const events = await appCdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(task.taskId)})`);

console.log(`\nfinal: ${finalStatus?.status}  (${approvals} plan(s) approved, ${countRounds(events)} round(s))`);
if (finalStatus?.error) console.log(`error: ${finalStatus.error}`);

const report = [...events].reverse().find(event => event.type === 'report.ready');
if (report) {
  console.log('last report:', JSON.stringify({ status: report.report.status, nextAction: report.report.nextAction, errors: report.report.errors }, null, 2));
}
for (const event of events) {
  if (event.type === 'step.failed') console.log(`failed step: ${event.stepId} ${event.tool} — ${event.error}`);
  if (event.type === 'plan.invalid') console.log(`invalid plan: ${event.error}`);
}

appCdp.close();
pageCdp?.close();

const ok = finalStatus?.status === 'completed';
process.exit(ok ? 0 : 1);

function describe(event) {
  switch (event.type) {
    case 'round.answer':
      return ` (${String(event.text?.length ?? 0)} chars)`;
    case 'plan.ready':
      return ` (${String(event.plan?.steps?.length ?? 0)} steps)`;
    case 'clarification.required':
      return ` (${String(event.questions?.length ?? 0)} questions)`;
    case 'task.failed':
    case 'plan.invalid':
      return ` ${event.error}`;
    default:
      return '';
  }
}

function countRounds(list) {
  return list.filter(event => event.type === 'round.started').length;
}
