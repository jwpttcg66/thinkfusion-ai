/** P1-00：保存/恢复/中断不重复执行。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentStore } from '../out-test/main/store.js';
import { loadState, needsResume, recoverState, saveState } from '../out-test/main/collaboration/persistence.js';
import { createCollaborationState, transitionTask } from '../out-test/main/collaboration/domain/state.js';

const goal = { goalId: 'g1', workspace: 'general', statement: 'q', constraints: [], acceptance: [], createdAt: 1 };
const task = { taskId: 't1', goalId: 'g1', kind: 'analyze', envelope: { question: 'q', acceptance: [], evidenceRequired: false }, dependsOn: [], requiredCapabilities: [] };
const plan = { planId: 'p1', goalId: 'g1', version: 1, policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 1, maxMs: 1, usedCalls: 0, startedAt: 1 } }, tasks: [task], participants: [], skipped: [], stopWhen: [], reason: '', createdAt: 1 };

test('保存/重载：同一 AgentStore', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-persist-'));
  const file = path.join(d, 'store.json');
  const store = new AgentStore(file);
  const state = createCollaborationState(goal, plan, plan.policy.budget);
  saveState(store, 'g1', state);
  const reloaded = new AgentStore(file);
  const loaded = loadState(reloaded, 'g1');
  assert.equal(loaded.goal.goalId, 'g1');
  assert.equal(loaded.taskStates[0].status, 'pending');
  fs.rmSync(d, { recursive: true, force: true });
});

test('running 重启后标 blocked；不自动重跑', () => {
  let state = createCollaborationState(goal, plan, plan.policy.budget);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  const recovered = recoverState(state);
  assert.equal(recovered.taskStates[0].status, 'blocked');
  assert.equal(recovered.taskStates[0].reason, 'restart_interrupted');
});

test('完成/停止后不需要恢复', () => {
  let state = createCollaborationState(goal, plan, plan.policy.budget);
  state = transitionTask(state, 't1', 'assigned');
  state = transitionTask(state, 't1', 'running');
  state = transitionTask(state, 't1', 'done');
  assert.equal(needsResume(state), false);
});
