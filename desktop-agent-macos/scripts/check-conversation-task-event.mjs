import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationEventToTaskEvent } from '../out-test/shared/task-events.js';

test('General/Knowledge 会话事件映射到统一 TaskEvent，不创建假 AgentTask', () => {
  const updated = {
    type: 'conversation.updated', at: 10,
    conversation: { conversationId: 'c1', status: 'answered', intent: 'answer' }
  };
  const mapped = conversationEventToTaskEvent(updated, { eventId: 'e1', sequence: 1 });
  assert.equal(mapped.taskId, 'c1');
  assert.equal(mapped.runId, 'c1');
  assert.equal(mapped.sequence, 1);
  assert.equal(mapped.phase, 'understanding');
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
