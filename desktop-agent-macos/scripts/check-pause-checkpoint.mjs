/**
 * P0-4：暂停/取消不是只改一个状态字。
 *
 * 覆盖：请求态 → 停止中 → 实际态、检查点带目标版本/任务树 revision/副作用账本，
 * 以及恢复入口确实读到该检查点而不是沿用旧结论。
 * Run: npm run test:pause-checkpoint
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';
import { AgentOrchestrator } from '../out-test/main/orchestrator.js';
import { ContextArchiveStore } from '../out-test/main/context/checkpoint/archive.js';
import { ContextCheckpointStore } from '../out-test/main/context/checkpoint/store.js';
import { commitPauseCheckpoint } from '../out-test/main/context/checkpoint/pause.js';
import { recoverTaskContext, taskContextOwner } from '../out-test/main/context/recovery/task-recovery.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pause-checkpoint-'));
const workspace = path.join(dir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const events = [];
const tasks = new TaskManager(store, event => events.push(event));
const checkpointBase = path.join(dir, 'checkpoints');
const checkpointStore = new ContextCheckpointStore({ baseDir: checkpointBase });
const archive = new ContextArchiveStore(checkpointBase);

function orchestrator(overrides = {}) {
  return new AgentOrchestrator({
    tasks,
    store,
    adapter: () => ({ cancelWait: () => {} }),
    emit: event => events.push(event),
    dbPath: () => path.join(dir, 'journal.json'),
    pauseCheckpoint: async input => commitPauseCheckpoint(input, {
      store: checkpointStore, archive, journal: store
    }),
    ...overrides
  });
}

function reportFor(taskId, stepId, tool, args) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'execution_report',
    taskId,
    roundId: `round:${stepId}`,
    planId: `plan:${stepId}`,
    status: 'completed',
    errors: [],
    nextAction: 'continue',
    createdAt: Date.now(),
    results: [{
      stepId, tool, status: 'completed', verified: true, durationMs: 1, args
    }]
  };
}

function statusSequence(taskId) {
  const statuses = events
    .filter(event => event.type === 'task.updated' && event.task.taskId === taskId)
    .map(event => event.task.status);
  // 检查点事务会顺带发布一次 task.updated；这里只关心状态迁移序列。
  return statuses.filter((status, index) => index === 0 || status !== statuses[index - 1]);
}

function upsertWorkTask(taskId, revision) {
  store.appendEvent({
    type: 'work.task.upserted',
    at: Date.now(),
    taskId,
    task: { workTaskId: `w-${taskId}`, status: 'pending', goalVersion: 1, revision }
  });
}

test('暂停：先到请求态/停止中，检查点记录目标版本、任务树与副作用缺口', async () => {
  const task = tasks.create({ prompt: '暂停检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  upsertWorkTask(task.taskId, 3);
  fs.writeFileSync(path.join(workspace, 'done.txt'), 'done', 'utf8');
  store.insertReport(reportFor(task.taskId, 's1', 'fs.writeFile', { path: 'done.txt' }));
  store.insertReport(reportFor(task.taskId, 's2', 'shell.run', { command: 'echo hi' }));

  await orchestrator().pause(task.taskId);

  assert.deepEqual(statusSequence(task.taskId), [
    'created', 'planning', 'pause_requested', 'pausing', 'paused'
  ]);
  const current = tasks.get(task.taskId);
  assert.ok(current.checkpointId);
  assert.ok(current.contextId);
  assert.equal(current.resumeStatus, 'planning');

  const pausedEvent = events.filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === task.taskId
  ).at(-1);
  assert.equal(pausedEvent?.reason, 'pause');
  assert.equal(pausedEvent?.goalVersion, 1);
  assert.equal(pausedEvent?.taskRevision, 3);
  assert.equal(pausedEvent?.checkpointId, current.checkpointId);
  assert.ok(pausedEvent?.needsReconciliation >= 1);

  const checkpoint = await checkpointStore.find(taskContextOwner(current), current.checkpointId);
  assert.ok(checkpoint);
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('目标版本 v1')));
  assert.ok(checkpoint.summary.constraints.some(line => line.includes('任务树 revision 3')));
  assert.ok(checkpoint.summary.openIssues.some(line => line.includes('needs_reconciliation')));
  assert.ok(checkpoint.summary.evidence.some(item => item.path === 'done.txt'));
});

test('取消：先到请求态/取消中，再落检查点并结束', async () => {
  const task = tasks.create({ prompt: '取消检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  upsertWorkTask(task.taskId, 2);

  await orchestrator().cancel(task.taskId);

  assert.deepEqual(statusSequence(task.taskId), [
    'created', 'planning', 'plan_ready', 'cancel_requested', 'cancelling', 'cancelled'
  ]);
  const pausedEvent = events.filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === task.taskId
  ).at(-1);
  assert.equal(pausedEvent?.reason, 'cancel');
  assert.equal(pausedEvent?.taskRevision, 2);
  assert.ok(tasks.get(task.taskId).checkpointId);
});

test('未落报告的在途写操作也算副作用缺口，不能因为报告迟到就当没有', async () => {
  const task = tasks.create({ prompt: '在途写入探针', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'executing');
  store.appendEvent({
    type: 'step.started', at: Date.now(), taskId: task.taskId,
    roundId: 'round-inflight', stepId: 's4', tool: 'shell.run',
    args: { command: 'echo hi' }
  });

  await orchestrator().pause(task.taskId);

  const pausedEvent = events.filter(event =>
    event.type === 'context.checkpoint.paused' && event.taskId === task.taskId
  ).at(-1);
  assert.ok(pausedEvent?.needsReconciliation >= 1);
  const current = tasks.get(task.taskId);
  const checkpoint = await checkpointStore.find(taskContextOwner(current), current.checkpointId);
  assert.ok(checkpoint.summary.openIssues.some(line => line.includes('在途')));
});

test('恢复入口读暂停检查点：拿到的是落库摘要与副作用账本，不是旧结论', async () => {
  const task = tasks.create({ prompt: '恢复读暂停检查点', permissionPreset: 'workspace-write', workspaceRoot: workspace });
  tasks.transition(task.taskId, 'planning');
  upsertWorkTask(task.taskId, 4);
  store.insertReport(reportFor(task.taskId, 's3', 'shell.run', { command: 'echo hi' }));
  await orchestrator().pause(task.taskId);
  const paused = tasks.get(task.taskId);

  let captured = null;
  const resumeOrchestrator = orchestrator({
    contextRecovery: async (current, reports) => {
      captured = await recoverTaskContext(current, reports, {
        store: checkpointStore,
        archive,
        eventsForTask: id => store.listEvents(id)
      });
      // 测试里停在恢复前，不让 driveRound 真的发模型请求。
      return { status: 'stale', reason: '测试中止恢复' };
    }
  });

  await assert.rejects(() => resumeOrchestrator.resume(task.taskId), /检查点不可用/);
  assert.equal(captured?.status, 'recovered');
  assert.equal(captured?.checkpointId, paused.checkpointId);
  assert.ok(captured?.summary?.constraints.some(line => line.includes('任务树 revision 4')));
  assert.ok((captured?.ledger?.needsReconciliation ?? 0) >= 1);
});

test('进程重启收敛：暂停中间态转 interrupted，取消中间态转 cancelled', () => {
  const pausing = tasks.create({ prompt: '退出时暂停中', permissionPreset: 'read-only' });
  tasks.transition(pausing.taskId, 'planning');
  tasks.transition(pausing.taskId, 'pause_requested');
  tasks.transition(pausing.taskId, 'pausing');

  const cancelling = tasks.create({ prompt: '退出时取消中', permissionPreset: 'read-only' });
  tasks.transition(cancelling.taskId, 'planning');
  tasks.transition(cancelling.taskId, 'cancel_requested');
  tasks.transition(cancelling.taskId, 'cancelling');

  assert.ok(tasks.reconcileInterrupted() >= 2);
  assert.equal(tasks.get(pausing.taskId).status, 'interrupted');
  assert.equal(tasks.get(cancelling.taskId).status, 'cancelled');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
