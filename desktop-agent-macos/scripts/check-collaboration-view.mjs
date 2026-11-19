/** UI-01 数据层：计划/任务/参与者视图。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollaborationState, transitionTask } from '../out-test/main/collaboration/domain/state.js';
import { buildPlanView } from '../out-test/main/collaboration/view.js';

const goal = { goalId: 'g', workspace: 'general', statement: 'q', constraints: [], acceptance: ['a'], createdAt: 1 };
const task = id => ({ taskId: id, goalId: 'g', kind: 'analyze', envelope: { question: 'q', acceptance: ['a'], evidenceRequired: false }, dependsOn: [], requiredCapabilities: [] });
const plan = {
  planId: 'p', goalId: 'g', version: 1,
  policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 1, maxMs: 1, usedCalls: 0, startedAt: 1 } },
  tasks: [task('t1')], participants: [{ participantId: 'm1', reason: 'x' }], skipped: [], stopWhen: [], reason: '', createdAt: 1
};

test('视图含任务状态/参与者/跳过/停止原因', () => {
  let state = createCollaborationState(goal, plan, plan.policy.budget);
  state = transitionTask(state, 't1', 'assigned');
  state = { ...state, assignments: [{ assignmentId: 'a', taskId: 't1', participantId: 'm1', reason: 'x', contextRefs: [], assignedAt: 1 }] };
  state = { ...state, stop: { reason: 'acceptance_satisfied', at: 1 } };
  const view = buildPlanView(state);
  assert.equal(view.tasks[0].status, 'assigned');
  assert.equal(view.tasks[0].participantId, 'm1');
  assert.equal(view.participants[0].participantId, 'm1');
  assert.equal(view.stopReason, 'acceptance_satisfied');
});
