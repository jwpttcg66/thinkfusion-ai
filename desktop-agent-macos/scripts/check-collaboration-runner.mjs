/** P1-04/P1-05：Runner 写 Attempt/Observation；Deliver 组装交付物。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planGoal } from '../out-test/main/collaboration/planner/planner.js';
import { schedule } from '../out-test/main/collaboration/scheduler/scheduler.js';
import { runPlan } from '../out-test/main/collaboration/runner/runner.js';
import { deliver } from '../out-test/main/collaboration/deliver/deliver.js';

const goal = { goalId: 'g1', workspace: 'general', statement: '什么是递归', constraints: [], acceptance: ['结论'], createdAt: 1 };
const participants = [{ participantId: 'm1', label: 'm1', kind: 'cloud', capabilities: ['reasoning'], available: true }];

test('成功路径：任务 done、Observation 与 Attempt 落状态、交付有内容', async () => {
  const plan = planGoal(goal, participants);
  const assignments = schedule(plan, participants);
  const manager = { ask: async () => [{ participantId: 'm1', status: 'done', text: '递归是函数调用自身' }] };
  const state = await runPlan({ goal, plan, assignments, manager });
  assert.equal(state.taskStates.every(t => t.status === 'done'), true);
  assert.equal(state.observations.length, plan.tasks.length);
  assert.equal(state.taskStates[0].attempts.length, 1);
  const out = deliver(state);
  assert.match(out.content, /递归/);
  assert.equal(out.stopReason, 'acceptance_satisfied');
});

test('失败路径：任务 failed、Observation 不产生、交付列未完成', async () => {
  const plan = planGoal(goal, participants);
  const assignments = schedule(plan, participants);
  const manager = { ask: async () => [{ participantId: 'm1', status: 'failed', error: { code: 'X', message: 'boom' } }] };
  const state = await runPlan({ goal, plan, assignments, manager });
  assert.equal(state.taskStates[0].status, 'failed');
  assert.equal(state.observations.length, 0);
  const out = deliver(state);
  assert.equal(out.stopReason, 'failed');
  assert.equal(out.openQuestions.length, 2);
});
