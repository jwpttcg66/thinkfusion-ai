import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_TASK_STREAM, isLive, reduceTaskStream } from '../out-test/shared/task-stream.js';

test('流按 roundId 隔离，旧轮次迟到 delta 被丢弃', () => {
  let s = reduceTaskStream(EMPTY_TASK_STREAM, { type: 'round.started', roundId: 'r1', at: 1 });
  s = reduceTaskStream(s, { type: 'round.delta', roundId: 'r1', text: 'hello', at: 2 });
  assert.equal(s.text, 'hello');
  assert.equal(isLive(s), true);
  s = reduceTaskStream(s, { type: 'round.answer', roundId: 'r1', text: 'hello', at: 3 });
  assert.equal(isLive(s), false, 'answer 后应结算');
  s = reduceTaskStream(s, { type: 'round.delta', roundId: 'r1', text: 'late', at: 4 });
  assert.equal(s.text, '', '已结算轮次的迟到 delta 必须忽略');
});

test('新一轮开始清空上一轮临时输出，终态清空全部', () => {
  let s = reduceTaskStream(EMPTY_TASK_STREAM, { type: 'round.started', roundId: 'r1', at: 1 });
  s = reduceTaskStream(s, { type: 'round.delta', roundId: 'r1', text: 'old', reasoning: 'internal', at: 2 });
  s = reduceTaskStream(s, { type: 'round.delta', roundId: 'r2', text: 'other', at: 3 });
  assert.equal(s.text, 'old', '不同轮次的 delta 必须被丢弃');
  s = reduceTaskStream(s, { type: 'round.started', roundId: 'r2', at: 4 });
  assert.equal(s.text, '');
  assert.equal(s.reasoning, '');
  s = reduceTaskStream(s, { type: 'round.delta', roundId: 'r2', text: 'new', at: 5 });
  assert.equal(s.text, 'new');
  s = reduceTaskStream(s, { type: 'task.failed', at: 6 });
  assert.deepEqual(s, EMPTY_TASK_STREAM);
});
