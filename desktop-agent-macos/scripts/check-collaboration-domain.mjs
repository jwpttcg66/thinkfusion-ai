/** P1-00：TaskSpec / TaskRuntimeState / Attempt 的初始状态与转移。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRetry,
  createCollaborationState,
  recordAttempt,
  stopCollaboration,
  transitionTask
} from '../out-test/main/collaboration/domain/state.js';

const goal = {
  goalId: 'g1', workspace: 'general', statement: 'q', constraints: [], acceptance: ['a'], createdAt: 1
};
const task = (id, kind = 'analyze') => ({
  taskId: id,
  goalId: 'g1',
  kind,
  envelope: { question: 'q', acceptance: ['a'], evidenceRequired: false },
  dependsOn: [],
  requiredCapabilities: ['reasoning']
});
const plan = {
  planId: 'p1', goalId: 'g1', version: 1,
  policy: {
    modelScope: 'remote', includeWeb: false, minParticipants: 1,
    allowWebQuestioner: false, budget: { maxCalls: 2, maxMs: 1000, usedCalls: 0, startedAt: 1 }
  },
  tasks: [task('t1'), task('t2', 'execute')],
  participants: [{ participantId: 'm1', reason: 'test' }],
  skipped: [], stopWhen: ['done'], reason: 'test', createdAt: 1
};
const budget = { maxCalls: 2, maxMs: 1000, usedCalls: 0, startedAt: 1 };

test('初始状态：每个 TaskSpec 一条 pending', () => {
  const state = createCollaborationState(goal, plan, budget);
  assert.deepEqual(state.taskStates.map(t => [t.taskId, t.status]), [['t1', 'pending'], ['t2', 'pending']]);
  assert.equal(state.activePlan.planId, 'p1');
  assert.equal(state.version, 1);
});

test('合法转移：pending → assigned → running → done', () => {
  let state = createCollaborationState(goal, plan, budget);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  state = transitionTask(state, 't1', 'done');
  assert.equal(state.taskStates[0].status, 'done');
});

test('非法转移被拒绝；终态不再前进', () => {
  const state = createCollaborationState(goal, plan, budget);
  assert.throws(() => transitionTask(state, 't1', 'done'), /非法任务状态转移/);
  assert.throws(() => transitionTask(state, 't1', 'nope'), /非法任务状态转移/);
});

test('重试：只读 running → retrying → running；写任务不可重试', () => {
  let state = createCollaborationState(goal, plan, budget);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  state = transitionTask(state, 't1', 'retrying');
  state = transitionTask(state, 't1', 'running');
  assert.equal(state.taskStates[0].status, 'running');
  const t1 = plan.tasks[0];
  const t2 = plan.tasks[1];
  assert.equal(canRetry(t1, state.taskStates[0]), true);
  assert.equal(canRetry(t2, state.taskStates[1]), false);
});

test('Attempt 只追加，编号连续；重复拒绝', () => {
  let state = createCollaborationState(goal, plan, budget);
  state = transitionTask(state, 't1', 'assigned');
  const first = { attemptId: 'a1', taskId: 't1', participantId: 'm1', number: 1, status: 'running', startedAt: 1 };
  state = recordAttempt(state, first);
  assert.equal(state.taskStates[0].status, 'running');
  assert.equal(state.taskStates[0].attempts.length, 1);
  assert.throws(() => recordAttempt(state, { ...first, attemptId: 'a3', number: 3 }), /编号不连续/);
  assert.throws(() => recordAttempt(state, first), /重复 Attempt/);
});

test('stop 写入原因；序列化可往返', () => {
  const state = stopCollaboration(createCollaborationState(goal, plan, budget), 'budget_exhausted');
  assert.equal(state.stop.reason, 'budget_exhausted');
  const round = JSON.parse(JSON.stringify(state));
  assert.equal(round.stop.reason, 'budget_exhausted');
});
