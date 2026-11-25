/**
 * DMOCA 真机：L0 只读列目录，核对参与决策事件与面板。
 * CDP_ENDPOINT=http://127.0.0.1:9333/json node scripts/dmoca-live.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-v3-dmoca-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 420000);
const REPORT = process.env.DMOCA_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-DMOCA-LIVE.json');

fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(WORKSPACE, 'readme.txt'), 'dmoca-live\n');

async function listOn(endpoint) {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`CDP ${endpoint} -> ${response.status}`);
  return response.json();
}

const targets = await listOn(ENDPOINT);
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
const opts = await cdp.evaluate(`window.agentAPI.getExecutionOptions()`);
const openGo = (opts?.cloudMembers ?? []).filter(i => String(i.id).startsWith('opencode-go:') && i.hasKey);
assert.ok(openGo.length > 0);

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
    console.log(`  ${event.type}${event.type === 'model.participation.selected' ? ` risk=${event.risk} debate=${event.debate}` : ''}`);
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
const participation = events.filter(e => e.type === 'model.participation.selected');
const debated = events.filter(e => e.type === 'plan.debated');
const reviews = events.filter(e => e.type === 'review.ready');
const dom = await cdp.evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  return {
    hasDmoca: text.includes('模型协作'),
    hasRisk: /L0|L1|L2|L3/.test(text),
    sample: (document.querySelector('.collab-result')?.innerText ?? '').slice(0, 700)
  };
})()`);

note('completed', terminal?.status === 'completed', terminal?.status ?? 'timeout');
note('participation-event', participation.length > 0, `count=${participation.length}`);
note('l0-skip-debate', participation.some(e => e.debate === 'skip') || debated.some(e => (e.debate?.status ?? e.status) === 'skipped'), `participation debate=${participation.map(e => e.debate).join(',')}`);
note('rules-review', reviews.every(e => e.backend === 'rules') || reviews.length === 0, `backends=${reviews.map(e => e.backend).join(',')}`);
note('ui-dmoca', Boolean(dom.hasDmoca), dom.hasDmoca ? 'visible' : 'missing');

evidence.participation = participation;
evidence.dom = dom;
evidence.terminal = terminal ? { status: terminal.status, summary: terminal.summary } : null;
evidence.finishedAt = new Date().toISOString();
evidence.ok = Object.values(evidence.checks).every(c => c.ok);
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);
cdp.close();
process.exit(evidence.ok ? 0 : 1);
