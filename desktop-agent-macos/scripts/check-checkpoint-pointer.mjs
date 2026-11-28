/**
 * M2-1：检查点指针只有一个写者，恢复走的路径要能被看见。
 *
 * 覆盖三件事：
 * 1. 暂停后任务上的 contextId/checkpointId/activeRunId 与检查点文件一致，
 *    且只有 Journal 事务写它们（旧代码在此之后又 patch 一遍，漏了 activeRunId，
 *    等于用半套指针盖掉权威值）；
 * 2. 事件里带的是完整指针，任务字段丢了也能重建；
 * 3. 恢复时 `context.recovered` 带上 pointerSource，两条路径可区分。
 *
 * Run: npm run test:checkpoint-pointer
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-checkpoint-pointer-'));
const workspace = path.join(dir, 'ws');
fs.mkdirSync(workspace, { recursive: true });
const store = new AgentStore(path.join(dir, 'agent-store.json'));
const checkpointBase = path.join(dir, 'checkpoints');
const checkpointStore = new ContextCheckpointStore({ baseDir: checkpointBase });
const archive = new ContextArchiveStore(checkpointBase);

function harness(overrides = {}) {
  const events = [];
  const emit = event => {
    events.push(event);
    // 主进程的 emit 同时把事件写进 Journal（index.ts:store.appendEvent），
    // 指针重建读的就是这份事件流，测试不能只收不发。
    store.appendEvent(event.taskId
      ? { ...event, eventId: `ev_${String(events.length)}`, runId: event.taskId }
      : event);
  };
  const tasks = new TaskManager(store, emit);
  const orchestrator = new AgentOrchestrator({
    tasks,
    store,
    adapter: () => ({ cancelWait: () => {} }),
    emit,
    dbPath: () => path.join(dir, 'journal.json'),
    pauseCheckpoint: async input => commitPauseCheckpoint(input, {
      store: checkpointStore, archive, journal: store
    }),
    ...overrides
  });
  return { tasks, orchestrator, events };
}

function newTask(prompt) {
  const { tasks, orchestrator, events } = harness();
  const task = tasks.create({
    prompt, permissionPreset: 'workspace-write', workspaceRoot: workspace
  });
  tasks.transition(task.taskId, 'planning');
  return { tasks, orchestrator, events, taskId: task.taskId };
}

test('暂停后指针三字段落库，且与检查点文件逐项一致', async () => {
  const { tasks, orchestrator, taskId } = newTask('指针一致性');
  await orchestrator.pause(taskId);

  const task = tasks.get(taskId);
  assert.ok(task.checkpointId, 'checkpointId 没落库');
  assert.ok(task.contextId, 'contextId 没落库');
  assert.ok(task.activeRunId, 'activeRunId 没落库：Journal 事务之外还有第二个写者');

  const checkpoint = await checkpointStore.find(taskContextOwner(task), task.checkpointId);
  assert.ok(checkpoint, '任务指针指向的检查点文件不存在');
  assert.equal(task.contextId, checkpoint.contextId);
  assert.equal(task.activeRunId, checkpoint.runId);
});

test('暂停事件带完整指针：任务字段丢了也能重建', async () => {
  const { tasks, orchestrator, events, taskId } = newTask('事件带指针');
  await orchestrator.pause(taskId);

  const paused = events.filter(event => event.type === 'context.checkpoint.paused').at(-1);
  assert.ok(paused);
  const task = tasks.get(taskId);
  assert.equal(paused.contextId, task.contextId);
  assert.equal(paused.checkpointId, task.checkpointId);
  assert.equal(paused.activeRunId, task.activeRunId);
});

test('恢复读落库指针：context.recovered 标出 pointerSource=task-fields', async () => {
  const first = newTask('正常恢复');
  await first.orchestrator.pause(first.taskId);
  const paused = first.tasks.get(first.taskId);

  let captured = null;
  const resume = harness({
    contextRecovery: async (current, reports) => {
      captured = await recoverTaskContext(current, reports, {
        store: checkpointStore,
        archive,
        eventsForTask: id => store.listEvents(id)
      });
      return { status: 'stale', reason: '测试中止恢复', pointerSource: captured.pointerSource };
    }
  });
  await assert.rejects(() => resume.orchestrator.resume(first.taskId), /检查点不可用/);
  assert.equal(captured.pointerSource, 'task-fields');
  assert.equal(captured.checkpointId, paused.checkpointId);
});

test('任务字段被清成半套：恢复退到事件流重建，并在事件里标出 pointerSource', async () => {
  const { tasks, orchestrator, taskId } = newTask('半套指针');
  await orchestrator.pause(taskId);
  const paused = tasks.get(taskId);

  let captured = null;
  const resume = harness({
    contextRecovery: async (current, reports) => {
      const probe = { ...current, contextId: undefined, checkpointId: undefined, activeRunId: undefined };
      captured = await recoverTaskContext(probe, reports, {
        store: checkpointStore,
        archive,
        eventsForTask: id => store.listEvents(id)
      });
      return { status: 'recovered', pointerSource: captured.pointerSource };
    }
  });
  await resume.orchestrator.resume(taskId).catch(() => {
    /* 测试适配器不会真跑完这一轮，只要能拿到恢复事件。 */
  });

  assert.equal(captured.status, 'recovered');
  assert.equal(captured.pointerSource, 'events-replay');
  assert.equal(captured.checkpointId, paused.checkpointId);
  assert.equal(captured.contextId, paused.contextId);
  const recoveredEvent = resume.events.filter(event =>
    event.type === 'context.event' && event.taskId === taskId &&
    event.event === 'context.recovered'
  ).at(-1);
  assert.equal(recoveredEvent?.context?.pointerSource, 'events-replay');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
