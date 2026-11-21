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

  store.appendEvent({ type: 'task.updated', at: 2, task: tasks.get(interrupted.taskId), eventId: 'i1', runId: interrupted.taskId, sequence: 1, phase: 'terminal' });
  store.deleteTask(task.taskId);
  assert.equal(store.listEvents(task.taskId).length, 0, '删除任务必须清掉 task.updated');
  // 模拟删除后在途 Provider 又写回一条 delta；启动清理必须把它清掉。
  store.appendEvent({ type: 'round.delta', at: 3, taskId: task.taskId, roundId: 'r', eventId: 'late', runId: task.taskId, sequence: 9, phase: 'planning', text: 'late' });
  assert.equal(store.listEvents(task.taskId).length, 1);
  assert.equal(store.pruneOrphanEvents(), 1);
  assert.equal(store.listEvents(task.taskId).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
