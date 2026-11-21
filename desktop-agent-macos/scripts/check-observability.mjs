import assert from 'node:assert/strict';
import test from 'node:test';
import { fromAgentEvent, fromConversationEvent, fromTraceEntry, projectActivity } from '../out-test/shared/observability.js';

test('AgentEvent 投影：reasoning 与 tool 分类/阶段/身份正确', () => {
  const reasoning = fromAgentEvent({
    type: 'round.delta', at: 10, taskId: 't', roundId: 'r', streamId: 's',
    text: 'answer', reasoning: 'think', mode: 'snapshot', providerId: 'cloud', modelId: 'm',
    eventId: 'e1', sequence: 1, runId: 't', phase: 'planning'
  });
  assert.equal(reasoning.category, 'reasoning');
  assert.equal(reasoning.phase, 'streaming');
  assert.equal(reasoning.actor.type, 'model');
  assert.equal(reasoning.actor.provider, 'cloud');

  const tool = fromAgentEvent({
    type: 'step.preparing', at: 11, taskId: 't', roundId: 'r', stepId: 's1', callId: 's1',
    tool: 'fs.readFile', args: { path: 'a' }, eventId: 'e2', sequence: 2, runId: 't'
  });
  assert.equal(tool.category, 'tool');
  assert.equal(tool.phase, 'preparing');
  assert.equal(tool.callId, 's1');
});

test('Trace / Conversation 可投影到同一事件，按 sequence 去重排序', () => {
  const trace = fromTraceEntry({
    seq: 3, at: 30, conversationId: 'c', turn: 1, step: 0, kind: 'step', phase: 'end',
    stage: 'answer', status: 'ok', actorId: 'm', reasoning: 'why'
  }, { taskId: 't' });
  assert.equal(trace.category, 'reasoning');
  assert.equal(trace.sequence, 3);

  const conv = fromConversationEvent(
    { type: 'conversation.updated', at: 20, conversation: { conversationId: 'c', status: 'answered' } },
    { eventId: 'c1', sequence: 1 }
  );
  assert.equal(conv.category, 'lifecycle');

  const list = projectActivity([trace, trace, conv]);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(e => e.sequence), [1, 3]);
});
