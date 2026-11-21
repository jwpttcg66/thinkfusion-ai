import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentStore } from '../out-test/main/store.js';
import { TaskManager } from '../out-test/main/task-manager.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-task-'));
  return { dir, file: path.join(dir, 'agent-store.json') };
}

test('任务状态机拒绝终态回退，事件序号持久化后可恢复', () => {
  const { dir, file } = tempStore();
  const store = new AgentStore(file);
  const tasks = new TaskManager(store, () => {});
  const task = tasks.create({ prompt: 'p', permissionPreset: 'workspace-write', workspaceRoot: dir });
  tasks.transition(task.taskId, 'planning');
  tasks.transition(task.taskId, 'plan_ready');
  tasks.transition(task.taskId, 'awaiting_approval');
  tasks.transition(task.taskId, 'executing');
  tasks.transition(task.taskId, 'verifying');
  tasks.transition(task.taskId, 'report_pending');
  tasks.transition(task.taskId, 'completed');
  assert.throws(() => tasks.transition(task.taskId, 'planning'), /非法状态转换/);

  const seq = store.nextSequence(task.taskId);
  store.appendEvent({
    type: 'task.updated', at: 1, task: tasks.get(task.taskId),
    eventId: 'e1', runId: task.taskId, sequence: seq, phase: 'delivery'
  });
  assert.equal(store.nextSequence(task.taskId), seq + 1);

  const interrupted = tasks.create({ prompt: 'i', permissionPreset: 'workspace-write', workspaceRoot: dir });
  tasks.transition(interrupted.taskId, 'planning');
  assert.equal(tasks.reconcileInterrupted(), 1);
  assert.equal(tasks.get(interrupted.taskId).status, 'failed');
  assert.match(tasks.get(interrupted.taskId).error, /中断/);

  const reloaded = new AgentStore(file);
  assert.equal(reloaded.getTask(task.taskId)?.status, 'completed');
  assert.equal(reloaded.listEvents(task.taskId).length, 1);
  assert.equal(reloaded.listEvents(task.taskId)[0].eventId, 'e1');
  fs.rmSync(dir, { recursive: true, force: true });
});
