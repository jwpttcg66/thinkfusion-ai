import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTaskEvent, phaseOfEvent } from '../out-test/shared/task-events.js';

const started = (sequence, id = 'e1') => ({
  type: 'round.started', taskId: 't', roundId: 'r', roundNumber: 1, inputType: 'user_prompt',
  at: 100, eventId: id, sequence, runId: 't', phase: 'planning'
});

test('事件按 sequence 排序，重复 eventId 不重复插入', () => {
  const a = started(2, 'e2');
  const b = started(1, 'e1');
  let list = mergeTaskEvent([a], b);
  assert.deepEqual(list.map(e => e.sequence), [1, 2]);
  list = mergeTaskEvent(list, a);
  assert.equal(list.length, 2);
});

test('phase 映射覆盖关键阶段', () => {
  assert.equal(phaseOfEvent('round.answer'), 'planning');
  assert.equal(phaseOfEvent('plan.ready'), 'approval');
  assert.equal(phaseOfEvent('step.completed'), 'execution');
  assert.equal(phaseOfEvent('report.ready'), 'verification');
  assert.equal(phaseOfEvent('review.ready'), 'review');
  assert.equal(phaseOfEvent('task.failed'), 'terminal');
});
