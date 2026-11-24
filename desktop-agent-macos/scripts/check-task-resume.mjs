/**
 * 暂停/继续与恢复保护（LT-P5-02/05）。
 *
 * - 等待态暂停→继续回到原等待状态，不重开一轮；
 * - 检查点 stale 时继续失败，任务留在 interrupted；
 * - 同一任务同时只允许一个恢复流程。
 *
 * Run with: npm run test:task-resume
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { AgentOrchestrator } from '../out-test/main/orchestrator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-resume-'));
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const events = [];
const tasks = new TaskManager(store, event => events.push(event));

function orchestrator(overrides = {}) {
  return new AgentOrchestrator({
    tasks,
    store,
    adapter: () => ({ cancelWait: () => {} }),
    emit: event => events.push(event),
    dbPath: () => path.join(dir, 'journal.json'),
    ...overrides
  });
}

test('等待态暂停后继续：回到原状态，不重开一轮', async () => {
  const task = tasks.create({ prompt: '等待补充的任务', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'awaiting_clarification');
  const roundsBefore = tasks.listRounds(task.taskId).length;

  const orch = orchestrator();
  await orch.pause(task.taskId);
  assert.equal(tasks.get(task.taskId).status, 'paused');
  assert.equal(tasks.get(task.taskId).resumeStatus, 'awaiting_clarification');

  await orch.resume(task.taskId);
  assert.equal(tasks.get(task.taskId).status, 'awaiting_clarification');
  assert.equal(tasks.listRounds(task.taskId).length, roundsBefore);
});

test('检查点 stale：继续失败，任务保持 interrupted', async () => {
  const task = tasks.create({ prompt: '中断任务', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'interrupted');
  const orch = orchestrator({
    contextRecovery: async () => ({ status: 'stale', reason: '来源归档 hash 不匹配' })
  });

  await assert.rejects(() => orch.resume(task.taskId), /检查点不可用/);
  assert.equal(tasks.get(task.taskId).status, 'interrupted');
  assert.ok(events.some(event =>
    event.type === 'context.event' &&
    event.event === 'context.compaction.stale' &&
    event.taskId === task.taskId
  ));
});

test('并发恢复保护：同一任务第二次继续被拒绝', async () => {
  const task = tasks.create({ prompt: '并发恢复', permissionPreset: 'workspace-write' });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'interrupted');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const orch = orchestrator({
    contextRecovery: async () => {
      await gate;
      return { status: 'stale', reason: '测试用 stale' };
    }
  });

  const first = orch.resume(task.taskId);
  await assert.rejects(() => orch.resume(task.taskId), /正在执行或恢复中/);
  release();
  await assert.rejects(() => first, /检查点不可用/);
  assert.equal(tasks.get(task.taskId).status, 'interrupted');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
