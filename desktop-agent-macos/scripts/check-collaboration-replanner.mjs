/** P1-11：缺口驱动重规划、版本、护栏。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollaborationState, transitionTask } from '../out-test/main/collaboration/domain/state.js';
import { applyReplan, needsReplan } from '../out-test/main/collaboration/adapt/replanner.js';

const goal = { goalId: 'g1', workspace: 'general', statement: 'q', constraints: [], acceptance: ['a'], createdAt: 1 };
const task = id => ({ taskId: id, goalId: 'g1', kind: 'analyze', envelope: { question: 'q', acceptance: ['a'], evidenceRequired: false }, dependsOn: [], requiredCapabilities: [] });
const plan = {
  planId: 'p1', goalId: 'g1', version: 1,
  policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 4, maxMs: 1000, usedCalls: 0, startedAt: 1 } },
  tasks: [task('t1')], participants: [{ participantId: 'm1', reason: 'x' }], skipped: [], stopWhen: [], reason: 'x', createdAt: 1
};
const budget = plan.policy.budget;

test('失败任务触发 acceptance_gap；stop 后不再重规划', () => {
  let state = createCollaborationState(goal, plan, budget);
  assert.equal(needsReplan(state).needed, false);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  state = transitionTask(state, 't1', 'failed');
  assert.deepEqual(needsReplan(state), { needed: true, reason: 'acceptance_gap' });
  state = { ...state, stop: { reason: 'user_cancelled', at: 1 } };
  assert.equal(needsReplan(state).needed, false);
});

test('新 Plan 版本 +1，旧 Plan 进 history，新任务 pending', () => {
  let state = createCollaborationState(goal, plan, budget);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  state = transitionTask(state, 't1', 'failed');
  const next = applyReplan(state, [task('t2')], 'acceptance_gap');
  assert.equal(next.activePlan.version, 2);
  assert.equal(next.activePlan.supersedes, 'p1');
  assert.equal(next.planHistory.length, 1);
  assert.equal(next.taskStates.find(t => t.taskId === 't2').status, 'pending');
  assert.equal(next.replans.length, 1);
});

test('最多 2 次；重复 taskId 拒绝', () => {
  let state = createCollaborationState(goal, plan, budget);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  state = transitionTask(state, 't1', 'failed');
  state = applyReplan(state, [task('t2')], 'acceptance_gap');
  assert.throws(() => applyReplan(state, [task('t2')], 'acceptance_gap'), /重复任务/);
  state = applyReplan(state, [task('t3')], 'acceptance_gap');
  assert.equal(state.replans.length, 2);
  assert.throws(() => applyReplan(state, [task('t4')], 'acceptance_gap'), /上限/);
});
