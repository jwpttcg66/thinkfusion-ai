import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';

test('并发任务事件/序号互不串，取消一个不影响另一个，重启后可恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-conc-'));
  const file = path.join(dir, 'agent-store.json');
  const store = new AgentStore(file);
  const tasks = new TaskManager(store, () => {});
  const a = tasks.create({ prompt: 'a', permissionPreset: 'workspace-write', workspaceRoot: dir });
  const b = tasks.create({ prompt: 'b', permissionPreset: 'workspace-write', workspaceRoot: dir });

  store.appendEvent({ type: 'task.updated', at: 1, task: a, eventId: 'a1', sequence: store.nextSequence(a.taskId), runId: a.taskId, phase: 'understanding' });
  store.appendEvent({ type: 'task.updated', at: 2, task: b, eventId: 'b1', sequence: store.nextSequence(b.taskId), runId: b.taskId, phase: 'understanding' });
  assert.deepEqual(store.listEvents(a.taskId).map(e => e.eventId), ['a1']);
  assert.deepEqual(store.listEvents(b.taskId).map(e => e.eventId), ['b1']);
  assert.equal(store.nextSequence(a.taskId), 2);
  assert.equal(store.nextSequence(b.taskId), 2);

  tasks.transition(a.taskId, 'planning');
  tasks.transition(a.taskId, 'plan_ready');
  tasks.transition(a.taskId, 'awaiting_approval');
  tasks.transition(a.taskId, 'executing');
  tasks.transition(a.taskId, 'cancelled');
  assert.equal(tasks.get(a.taskId).status, 'cancelled');
  assert.equal(tasks.get(b.taskId).status, 'created');

  const reloaded = new AgentStore(file);
  assert.equal(reloaded.getTask(a.taskId)?.status, 'cancelled');
  assert.equal(reloaded.getTask(b.taskId)?.status, 'created');
  assert.equal(reloaded.listEvents(a.taskId).length, 1);
  assert.equal(reloaded.listEvents(b.taskId).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
