/**
 * 真机证据：用本机 agent-store 里已完成的多轮任务，核对最终结论仍带前轮交付文件。
 *
 * 背景：修复/再验证轮常常不再写文件；只投影最后一份 report 会冲掉目标物。
 *
 * 用法：
 *   node scripts/check-live-conclusion-deliverables.mjs [userDataDir]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildConclusion, buildTaskConversation } from '../out-test/shared/task-conversation.js';

const userData = process.argv[2]
  ?? process.env.THINKFUSION_USER_DATA
  ?? path.join(os.homedir(), 'Library/Application Support/thinkfusion-ai');
const storePath = path.join(userData, 'agent-store.json');

if (!fs.existsSync(storePath)) {
  console.error(`FAIL 找不到 agent-store：${storePath}`);
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const tasks = (store.tasks ?? []).filter(task => task.status === 'completed');
assert.ok(tasks.length > 0, '没有已完成任务可供真机核对');

const events = store.events ?? [];
let checked = 0;
const report = [];

for (const task of tasks.slice(0, 8)) {
  const taskEvents = events.filter(event => event.taskId === task.taskId);
  const reports = taskEvents.filter(event => event.type === 'report.ready');
  if (reports.length < 2) continue;

  const firstWrites = [];
  for (const item of reports.slice(0, -1)) {
    for (const step of item.report?.results ?? []) {
      if (step.tool !== 'fs.writeFile' && step.tool !== 'fs.mkdir') continue;
      const p = step.result?.path ?? step.args?.path;
      if (typeof p === 'string' && p.trim()) firstWrites.push(p.trim());
    }
  }
  if (firstWrites.length === 0) continue;

  const last = reports[reports.length - 1];
  const lastWrites = (last.report?.results ?? []).filter(step =>
    step.tool === 'fs.writeFile' || step.tool === 'fs.mkdir'
  );
  // 只核对「最后一轮不再写文件」的任务——这才是冲掉目标物的场景。
  if (lastWrites.length > 0) continue;

  const conclusion = buildConclusion(taskEvents, {
    summary: task.summary,
    status: task.status
  });
  assert.ok(conclusion, `任务 ${task.taskId} 应有结论`);
  const entries = buildTaskConversation(taskEvents, {
    prompt: task.userPrompt,
    summary: task.summary,
    status: task.status
  });
  const card = entries.find(entry => entry.kind === 'conclusion');
  assert.ok(card, `任务 ${task.taskId} 对话流应有结论卡`);
  assert.ok(Array.isArray(card.deliverables), '结论卡必须带 deliverables 字段');

  const missing = firstWrites.filter(writePath =>
    !(conclusion.deliverables ?? []).some(item =>
      item === writePath || item.endsWith(writePath) || writePath.endsWith(item)
    )
  );
  assert.equal(
    missing.length,
    0,
    `任务 ${task.taskId} 结论丢掉了前轮交付：${missing.join(', ')}；现有=${(conclusion.deliverables ?? []).join(', ')}`
  );

  checked += 1;
  report.push({
    taskId: task.taskId,
    title: (task.title || task.userPrompt || '').slice(0, 60),
    reports: reports.length,
    firstWrites,
    deliverables: conclusion.deliverables
  });
  console.log(`OK  ${task.taskId.slice(0, 8)}  报告 ${String(reports.length)} 轮，结论仍含 ${String(firstWrites.length)} 个前轮交付`);
  for (const p of firstWrites) console.log(`    · ${p}`);
}

if (checked === 0) {
  console.error('FAIL 本机已完成任务里没有「前轮写文件、末轮只验证」的样本');
  process.exit(1);
}

const out = path.join(os.tmpdir(), 'tf-conclusion-deliverables-live.json');
fs.writeFileSync(out, JSON.stringify({ userData, storePath, checked, report }, null, 2));
console.log(`PASS 真机证据 ${String(checked)} 条 → ${out}`);
