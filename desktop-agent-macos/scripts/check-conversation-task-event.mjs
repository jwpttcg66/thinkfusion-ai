import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore } from '../out-test/main/store.js';
import { conversationEventToTaskEvent } from '../out-test/shared/task-events.js';
import { projectRunView } from '../out-test/shared/task-view.js';

test('General/Knowledge 会话事件映射到统一 TaskEvent，不创建假 AgentTask', () => {
  const updated = {
    type: 'conversation.updated', at: 10,
    conversation: { conversationId: 'c1', status: 'answered', intent: 'answer' }
  };
  const mapped = conversationEventToTaskEvent(updated, { eventId: 'e1', sequence: 1 });
  assert.equal(mapped.taskId, 'c1');
  assert.equal(mapped.runId, 'c1');
  assert.equal(mapped.sequence, 1);
  assert.equal(mapped.phase, 'delivery');
  assert.equal(mapped.payload.type, 'conversation.updated');

  const deleted = conversationEventToTaskEvent(
    { type: 'conversation.deleted', at: 20, conversationId: 'c1' },
    { eventId: 'e2', sequence: 2 }
  );
  assert.equal(deleted.phase, 'terminal');

  const delta = conversationEventToTaskEvent(
    { type: 'answer.delta', at: 30, conversationId: 'c1', channelId: 'x', text: 'hi' },
    { eventId: 'e3', sequence: 3 }
  );
  assert.equal(delta.phase, 'delivery');
  assert.equal(delta.payload.type, 'answer.delta');
});


test('会话 TaskEvent 落盘后可按 conversationId 恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-run-events-'));
  const file = path.join(dir, 'agent-store.json');
  const store = new AgentStore(file);
  const mapped = conversationEventToTaskEvent(
    { type: 'conversation.updated', at: 1, conversation: { conversationId: 'c1', status: 'answered' } },
    { eventId: 'e1', sequence: store.nextRunSequence('c1') }
  );
  store.appendRunEvent(mapped);
  const reloaded = new AgentStore(file);
  assert.equal(reloaded.listRunEvents('c1').length, 1);
  assert.equal(reloaded.listRunEvents('c1')[0].eventId, 'e1');
  assert.equal(reloaded.nextRunSequence('c1'), 2);
  fs.rmSync(dir, { recursive: true, force: true });
});


test('会话 TaskEvent 可投影为阶段/事件数', () => {
  const events = [
    conversationEventToTaskEvent({ type: 'conversation.updated', at: 1, conversation: { conversationId: 'c1', status: 'answered' } }, { eventId: 'a', sequence: 1 }),
    conversationEventToTaskEvent({ type: 'conversation.deleted', at: 2, conversationId: 'c1' }, { eventId: 'b', sequence: 2 })
  ];
  const view = projectRunView(events);
  assert.equal(view.count, 2);
  assert.equal(view.phase, 'terminal');
  assert.equal(view.lastType, 'conversation.deleted');
});
