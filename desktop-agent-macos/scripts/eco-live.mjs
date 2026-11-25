/**
 * ECO/TDL V2 真机：只读任务，核对 eco.context.prepared、任务树与面板。
 * CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/eco-live.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-eco-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 420000);
const REPORT = process.env.ECO_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-GOAL-TDL-ECO-LIVE.json');

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'eco-live\n');

const targets = await (await fetch(ENDPOINT)).json();
const app = targets.find(t => t.type === 'page') ?? targets[0];
if (!app) throw new Error('no renderer');
const cdp = await connect(app);

const evidence = { startedAt: new Date().toISOString(), checks: {}, eventTypes: [] };
function note(name, ok, detail) {
  evidence.checks[name] = { ok, detail, at: Date.now() };
  console.log(`${ok ? 'OK' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const defaults = await cdp.evaluate(`window.agentAPI.getExecutionDefaults()`);
assert.equal(defaults?.executionMode, 'cloud');
const conversation = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({
  text: '只读列出工作区根目录文件名，结论写出文件名即可，不要改文件。',
  permissionPreset: 'read-only',
  workspaceRoot: WORKSPACE,
  workspaceMode: 'engineering',
  executionConfig: defaults,
  taskKindOverride: 'execution'
})})`);
const taskId = conversation.taskId;
assert.ok(taskId);
evidence.taskId = taskId;
console.log(`task ${taskId}`);

const deadline = Date.now() + TIMEOUT_MS;
let printed = 0;
let terminal = null;
const approved = new Set();
while (Date.now() < deadline) {
  await sleep(2000);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  for (const event of events.slice(printed)) {
    evidence.eventTypes.push(event.type);
    if (event.type === 'eco.context.prepared') {
      console.log(`  eco.context.prepared sufficiency=${event.package?.sufficiency}`);
    } else {
      console.log(`  ${event.type}`);
    }
  }
  printed = events.length;
  const task = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  if (!task) continue;
  if (task.status === 'awaiting_approval') {
    const plan = [...events].reverse().find(e => e.type === 'plan.ready' && e.plan?.planId);
    if (plan?.plan?.planId && !approved.has(plan.plan.planId)) {
      await cdp.evaluate(`window.agentAPI.approvePlan(${JSON.stringify({
        taskId, roundId: plan.roundId, planId: plan.plan.planId, approved: true
      })})`);
      approved.add(plan.plan.planId);
    }
  }
  if (task.status === 'report_pending') {
    try { await cdp.evaluate(`window.agentAPI.recheckVerification(${JSON.stringify(taskId)})`); } catch { /* */ }
  }
  if (['completed', 'failed', 'cancelled'].includes(task.status)) {
    terminal = task;
    break;
  }
}

const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
const eco = events.filter(e => e.type === 'eco.context.prepared');
const work = events.filter(e => e.type === 'work.task.upserted');
const levels = work.map(e => e.task?.level).filter(v => v !== undefined);
const dom = await cdp.evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  return {
    hasEco: text.includes('工程上下文'),
    hasTree: /L[123]/.test(text),
    sample: (document.querySelector('.collab-result')?.innerText ?? '').slice(0, 800)
  };
})()`);

note('completed', terminal?.status === 'completed', terminal?.status ?? 'timeout');
note('eco-prepared', eco.length > 0, `count=${eco.length} sufficiency=${eco[0]?.package?.sufficiency}`);
note('tdl-levels', levels.includes(1) && levels.includes(3), `levels=${[...new Set(levels)].join(',')}`);
note('ui-eco', Boolean(dom.hasEco), dom.hasEco ? 'visible' : 'missing');
note('ui-tree', Boolean(dom.hasTree), dom.hasTree ? 'L labels' : 'no L labels');

evidence.eco = eco.map(e => ({ sufficiency: e.package?.sufficiency, version: e.package?.contextVersion }));
evidence.dom = dom;
evidence.terminal = terminal ? { status: terminal.status } : null;
evidence.finishedAt = new Date().toISOString();
evidence.ok = Object.values(evidence.checks).every(c => c.ok);
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
