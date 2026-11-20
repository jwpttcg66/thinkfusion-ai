/** P1-04：并发、依赖、取消、超时。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlan } from '../out-test/main/collaboration/runner/runner.js';

const goal = { goalId: 'g', workspace: 'general', statement: 'q', constraints: [], acceptance: [], createdAt: 1 };
const task = (id, dependsOn = []) => ({
  taskId: id, goalId: 'g', kind: 'analyze',
  envelope: { question: id, acceptance: [], evidenceRequired: false },
  dependsOn, requiredCapabilities: []
});
const plan = tasks => ({
  planId: 'p', goalId: 'g', version: 1,
  policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 10, maxMs: 10000, usedCalls: 0, startedAt: 1 } },
  tasks, participants: [], skipped: [], stopWhen: [], reason: '', createdAt: 1
});
const assignment = id => ({ assignmentId: `a-${id}`, taskId: id, participantId: 'm', reason: 'x', contextRefs: [], assignedAt: 1 });

test('独立任务并发，最大并发受限', async () => {
  let active = 0;
  let maxActive = 0;
  const manager = {
    ask: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 30));
      active -= 1;
      return [{ participantId: 'm', status: 'done', text: 'ok' }];
    }
  };
  const tasks = [task('t1'), task('t2'), task('t3')];
  const state = await runPlan({ goal, plan: plan(tasks), assignments: tasks.map(t => assignment(t.taskId)), manager, maxConcurrency: 2 });
  assert.equal(state.taskStates.every(t => t.status === 'done'), true);
  assert.ok(maxActive >= 2, `expected concurrency, got ${maxActive}`);
  assert.ok(maxActive <= 2, `max concurrency exceeded: ${maxActive}`);
});

test('依赖任务等前序完成', async () => {
  const order = [];
  const manager = { ask: async ids => { order.push(ids); return [{ participantId: 'm', status: 'done', text: 'ok' }]; } };
  const tasks = [task('t1'), task('t2', ['t1'])];
  const state = await runPlan({ goal, plan: plan(tasks), assignments: tasks.map(t => assignment(t.taskId)), manager });
  assert.deepEqual(order, [['m'], ['m']]);
  assert.equal(state.taskStates.every(t => t.status === 'done'), true);
});

test('取消：后续任务不再调用', async () => {
  const controller = new AbortController();
  let calls = 0;
  const manager = { ask: async () => { calls += 1; controller.abort(); return [{ participantId: 'm', status: 'done', text: 'ok' }]; } };
  const tasks = [task('t1'), task('t2')];
  const state = await runPlan({ goal, plan: plan(tasks), assignments: tasks.map(t => assignment(t.taskId)), manager, signal: controller.signal, maxConcurrency: 1 });
  assert.equal(calls, 1);
  assert.equal(state.taskStates[1].status, 'cancelled');
});

test('超时：任务 failed，原因 timeout', async () => {
  const manager = { ask: () => new Promise(() => {}) };
  const tasks = [task('t1')];
  const state = await runPlan({ goal, plan: plan(tasks), assignments: [assignment('t1')], manager, timeoutMs: 20 });
  assert.equal(state.taskStates[0].status, 'failed');
  assert.equal(state.taskStates[0].reason, 'timeout');
});
