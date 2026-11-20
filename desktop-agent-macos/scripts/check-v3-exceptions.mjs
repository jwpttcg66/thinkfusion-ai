/** E-02：11 个异常场景。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ParticipantManager } from '../out-test/main/collaboration/participants/manager.js';
import { runPlan } from '../out-test/main/collaboration/runner/runner.js';
import { recoverState, needsResume } from '../out-test/main/collaboration/persistence.js';
import { createCollaborationState } from '../out-test/main/collaboration/domain/state.js';
import { verifyClaim } from '../out-test/main/collaboration/verifier.js';
import { planCliExecution } from '../out-test/main/execution/cli-executor.js';
import { canComplete, createEngineeringTaskState, recordReview, recordStart, recordEnd, recordTest, recordBuild } from '../out-test/main/engineering/task-state.js';

const goal = { goalId: 'g', workspace: 'general', statement: 'q', constraints: [], acceptance: [], createdAt: 1 };
const task = (id, participantId) => ({
  taskId: id, goalId: 'g', kind: 'analyze',
  envelope: { question: id, acceptance: [], evidenceRequired: false },
  dependsOn: [], requiredCapabilities: [], context: { participantId }
});
const plan = tasks => ({
  planId: 'p', goalId: 'g', version: 1,
  policy: { modelScope: 'remote', includeWeb: true, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 10, maxMs: 10000, usedCalls: 0, startedAt: 1 } },
  tasks, participants: [], skipped: [], stopWhen: [], reason: '', createdAt: 1
});
const assignment = (taskId, participantId) => ({ assignmentId: `a-${taskId}`, taskId, participantId, reason: 'x', contextRefs: [], assignedAt: 1 });

function pool(agents) {
  return {
    all: async () => agents,
    available: async () => agents.filter(a => a.health.available),
    ask: async (id, input) => agents.find(a => a.id === id).ask(input),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
}
const agent = (id, kind, health, ask) => ({ id, label: id, sourceType: kind, health: async () => health, ask });

test('1 本地不可用：跳过，不偷偷切远端', async () => {
  const manager = new ParticipantManager(pool([
    agent('local', 'local', { available: false, detail: '未启动' }, async () => ({ text: 'x' })),
    agent('cloud', 'cloud', { available: true }, async () => ({ text: 'x' }))
  ]));
  const out = await manager.ask(['local'], 'q');
  assert.equal(out[0].status, 'skipped');
});

test('2 远端不可用：失败明确', async () => {
  const manager = new ParticipantManager(pool([
    agent('cloud', 'cloud', { available: false, detail: '401' }, async () => ({ text: 'x' }))
  ]));
  const out = await manager.ask(['cloud'], 'q');
  assert.equal(out[0].status, 'skipped');
  assert.match(out[0].error.message, /401/);
});

test('3 Web 请求失败：failed，不影响其他参与者', async () => {
  const manager = new ParticipantManager(pool([
    agent('web', 'web', { available: true }, async () => { throw new Error('page'); }),
    agent('cloud', 'cloud', { available: true }, async () => ({ text: 'ok' }))
  ]));
  const out = await manager.ask(['web', 'cloud'], 'q');
  assert.equal(out[0].status, 'failed');
  assert.equal(out[1].status, 'done');
});

test('4 参与者失败：任务 failed', async () => {
  const manager = { ask: async () => [{ participantId: 'm', status: 'failed', error: { code: 'X', message: 'boom' } }] };
  const state = await runPlan({ goal, plan: plan([task('t1', 'm')]), assignments: [assignment('t1', 'm')], manager });
  assert.equal(state.taskStates[0].status, 'failed');
});

test('5 部分失败：其余完成，交付列未完成', async () => {
  const manager = { ask: async ids => ids[0] === 'a'
    ? [{ participantId: 'a', status: 'failed', error: { code: 'X', message: 'boom' } }]
    : [{ participantId: 'b', status: 'done', text: 'ok' }] };
  const state = await runPlan({
    goal, plan: plan([task('t1', 'a'), task('t2', 'b')]),
    assignments: [assignment('t1', 'a'), assignment('t2', 'b')], manager
  });
  assert.equal(state.taskStates[0].status, 'failed');
  assert.equal(state.taskStates[1].status, 'done');
});

test('6 并发超时：failed=timeout', async () => {
  const manager = { ask: () => new Promise(() => {}) };
  const state = await runPlan({ goal, plan: plan([task('t1', 'm')]), assignments: [assignment('t1', 'm')], manager, timeoutMs: 10 });
  assert.equal(state.taskStates[0].reason, 'timeout');
});

test('7 用户取消：后续不再提交', async () => {
  const controller = new AbortController();
  let calls = 0;
  const manager = { ask: async () => { calls += 1; controller.abort(); return [{ participantId: 'm', status: 'done', text: 'ok' }]; } };
  const state = await runPlan({
    goal, plan: plan([task('t1', 'm'), task('t2', 'm')]),
    assignments: [assignment('t1', 'm'), assignment('t2', 'm')], manager,
    signal: controller.signal, maxConcurrency: 1
  });
  assert.equal(calls, 1);
  assert.equal(state.taskStates[1].status, 'cancelled');
});

test('8 重启恢复：running 标 blocked，不自动重跑', () => {
  const state = createCollaborationState(goal, plan([task('t1', 'm')]), plan([task('t1', 'm')]).policy.budget);
  const running = { ...state, taskStates: [{ taskId: 't1', status: 'running', attempts: [] }] };
  const recovered = recoverState(running);
  assert.equal(recovered.taskStates[0].status, 'blocked');
  assert.equal(needsResume({ ...recovered, taskStates: [{ ...recovered.taskStates[0], status: 'pending' }] }), true);
});

test('9 权限不足：CLI 执行被拒', () => {
  assert.equal(planCliExecution({ intent: 'execute', approved: false, hasWorktree: true }).ok, false);
  assert.equal(planCliExecution({ intent: 'execute', approved: true, hasWorktree: false }).ok, false);
});

test('10 证据缺失：unverified，不标已验证', () => {
  const claim = { claimId: 'c', goalId: 'g', text: 'x', kind: 'fact', source: {}, createdAt: 1 };
  assert.equal(verifyClaim({ claim, evidence: [] }).relation, 'unverified');
});

test('11 Reviewer 不通过：不能完成', () => {
  let state = createEngineeringTaskState({ taskId: 't', implementerId: 'dev', context: { repoRoot: '/r', branch: 'b' } });
  state = recordStart(state, { commit: 'a', dirty: false, dirtyFiles: [], snapshot: 'S1' });
  state = recordEnd(state, { commit: 'b', dirty: false, dirtyFiles: [], snapshot: 'S2' });
  state = recordTest(state, { command: 't', exitCode: 0, status: 'passed' });
  state = recordBuild(state, { command: 'b', exitCode: 0, status: 'passed' });
  state = recordReview(state, { verdict: 'fail', reviewer: 'r', issues: ['x'] });
  assert.equal(canComplete(state).ok, false);
});
