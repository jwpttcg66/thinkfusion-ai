/**
 * TDL L2 真机：计划出来后，任务树里是否真的出现 L2 子任务，L3 是否挂在 L2 下。
 *
 * 只验证「计划 → 分解事件 → 界面」这一段：不等待方案评审辩论，也不批准执行，
 * 拿到 work.* 种子事件就取消任务。真正的执行链另有 live 脚本覆盖。
 *
 * CDP_ENDPOINT=http://127.0.0.1:9345/json node scripts/tdl-l2-live.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep } from './lib/cdp.mjs';

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9345/json';
const WORKSPACE = process.argv[2] ?? path.join(os.tmpdir(), 'tf-tdl-l2-live');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180000);
const REPORT = process.env.TDL_REPORT
  ?? path.resolve('../docs/implementation/evidence/V3-P0-TDL-L2-LIVE.json');

fs.rmSync(WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

const targets = await (await fetch(ENDPOINT)).json();
const app = targets.find(t => t.type === 'page') ?? targets[0];
if (!app) throw new Error('no renderer');
const cdp = await connect(app);

const evidence = { startedAt: new Date().toISOString(), checks: {}, eventTypes: [] };
function note(name, ok, detail) {
  evidence.checks[name] = { ok, detail, at: Date.now() };
  console.log(`${ok ? 'OK' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const defaults = await cdp.evaluate('window.agentAPI.getExecutionDefaults()');
const conversation = await cdp.evaluate(`window.agentAPI.submitConversation(${JSON.stringify({
  text: process.env.TDL_PROMPT ?? '在工作区创建两个文件：a.txt 写入 alpha，b.txt 写入 beta；创建后分别读回，确认内容正确。不要做别的修改。',
  permissionPreset: 'workspace-write',
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
let seeded = false;
while (Date.now() < deadline) {
  await sleep(1500);
  const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
  for (const event of events.slice(printed)) {
    evidence.eventTypes.push(event.type);
    if (event.type === 'work.task.upserted') {
      console.log(`  work.task L${event.task?.level} ${event.task?.workTaskId} parent=${event.task?.parentTaskId ?? '-'}`);
    } else {
      console.log(`  ${event.type}`);
    }
  }
  printed = events.length;
  // 计划一落地，种子事件就发完了；不需要等评审/执行。
  if (events.some(e => e.type === 'plan.ready') && events.some(e => e.type === 'work.task.upserted')) {
    // 再等一拍，让同一批 upsert 全部到达。
    await sleep(1200);
    seeded = true;
    break;
  }
  const task = await cdp.evaluate(`window.agentAPI.getTask(${JSON.stringify(taskId)})`);
  if (task && ['failed', 'cancelled'].includes(task.status)) break;
}

const events = await cdp.evaluate(`window.agentAPI.getTaskEvents(${JSON.stringify(taskId)})`);
const work = events.filter(e => e.type === 'work.task.upserted').map(e => e.task).filter(Boolean);
const l2 = work.filter(t => t.level === 2);
const l1 = work.filter(t => t.level === 1);
const underL2 = work.filter(t => t.level === 3 && l2.some(s => s.workTaskId === t.parentTaskId));
const planReady = events.filter(e => e.type === 'plan.ready').pop();
const warnings = planReady?.plan?.warnings ?? [];
const decompositionWarned = warnings.some(w => String(w).includes('没有 decomposition'));
const dom = await cdp.evaluate(`(() => {
  const text = document.body?.innerText ?? '';
  return {
    hasBreakdown: text.includes('任务分解'),
    rows: document.querySelectorAll('.work-breakdown li').length
  };
})()`);

note('plan-seeded', seeded, seeded ? 'plan.ready + work.task.upserted' : 'timeout');
note('tdl-l2-exists', l2.length > 0, `count=${l2.length}`);
note('l2-under-l1', l2.length === 0 ? false : l2.every(t => l1.some(g => g.workTaskId === t.parentTaskId)), `l1=${l1.length}`);
note('l3-under-l2', underL2.length > 0, `count=${underL2.length}/${work.filter(t => t.level === 3).length}`);
note('ui-tree', dom.rows > 0, `rows=${dom.rows}`);
// 模型可能判断这些改动属于同一件事而不拆；此时必须能在计划警告里看见「未分解」，
// 而不是让一棵只有 L1→L3 的树冒充已经完成 L2 分解。
note('decomposition-visible', l2.length > 0 || decompositionWarned, decompositionWarned ? 'warned' : (l2.length > 0 ? 'L2 present' : 'silent'));

evidence.warnings = warnings;
evidence.work = work.map(t => ({ id: t.workTaskId, level: t.level, parent: t.parentTaskId ?? null, title: t.title }));
evidence.dom = dom;
evidence.finishedAt = new Date().toISOString();
evidence.ok = Object.values(evidence.checks).every(c => c.ok);
fs.mkdirSync(path.dirname(REPORT), { recursive: true });
fs.writeFileSync(REPORT, JSON.stringify(evidence, null, 2));
console.log(`report -> ${REPORT}`);

// 不留一个卡在评审里的任务：拿到证据就取消。
try { await cdp.evaluate(`void window.agentAPI.cancelTask(${JSON.stringify(taskId)})`); } catch { /* 可能已结束 */ }
cdp.close();
process.exit(evidence.ok ? 0 : 1);
