import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTaskView } from '../out-test/shared/task-view.js';

const event = (value) => ({ at: 1, eventId: Math.random().toString(36), sequence: 1, ...value });

test('TaskView 按轮次投影：新一轮清空旧计划和旧回答', () => {
  const plan = { planId: 'p1', taskId: 't', roundId: 'r1', title: '计划', steps: [], completion: { condition: '完成' } };
  const events = [
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'plan.ready', taskId: 't', roundId: 'r1', plan }),
    event({ type: 'round.answer', taskId: 't', roundId: 'r1', text: '旧回答' }),
    event({ type: 'round.delta', taskId: 't', roundId: 'r1', text: '迟到', reasoning: '内部' }),
    event({ type: 'round.started', taskId: 't', roundId: 'r2', roundNumber: 2, inputType: 'user_prompt' })
  ];
  const view = projectTaskView(events);
  assert.equal(view.plan, null, '新一轮不能显示旧计划');
  assert.equal(view.answer, '', '新一轮不能显示旧回答');
  assert.equal(view.live.text, '');
  assert.equal(view.live.roundId, 'r2');
});

test('回答到达后流状态结算，迟到 delta 不复活', () => {
  const events = [
    event({ type: 'round.started', taskId: 't', roundId: 'r1', roundNumber: 1, inputType: 'user_prompt' }),
    event({ type: 'round.delta', taskId: 't', roundId: 'r1', text: 'hello', reasoning: '想一想' }),
    event({ type: 'round.answer', taskId: 't', roundId: 'r1', text: 'hello' }),
    event({ type: 'round.delta', taskId: 't', roundId: 'r1', text: 'late' })
  ];
  const view = projectTaskView(events);
  assert.equal(view.answer, 'hello');
  assert.equal(view.live.text, '');
  assert.equal(view.modelTrace.length, 1);
  assert.equal(view.modelTrace[0].text, 'hello');
});
