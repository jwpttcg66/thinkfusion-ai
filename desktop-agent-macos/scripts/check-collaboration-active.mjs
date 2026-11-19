/** P1.1 active 管线：Planner→审核→Scheduler→Runner→Deliver。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCollaboration } from '../out-test/main/collaboration/engine.js';

const goal = { goalId: 'g1', workspace: 'general', statement: '什么是递归', constraints: [], acceptance: ['结论'], createdAt: 1 };
const participants = [{ participantId: 'm1', label: 'm1', kind: 'cloud', capabilities: ['reasoning', 'knowledge'], available: true }];

test('active 管线跑通：计划/分配/状态/交付/审核', async () => {
  const manager = { ask: async () => [{ participantId: 'm1', status: 'done', text: '递归是函数调用自身' }] };
  const result = await runCollaboration({ goal, participants, manager });
  assert.equal(result.plan.goalId, 'g1');
  assert.equal(result.assignments.length, result.plan.tasks.length);
  assert.equal(result.state.taskStates.every(t => t.status === 'done'), true);
  assert.match(result.deliverable.content, /递归/);
  assert.equal(result.review.ok, true);
  assert.equal(result.replan.needed, false);
  assert.deepEqual(result.debates, []);
});

test('可选模型审核：不合法回退规则；合法采用', async () => {
  const manager = { ask: async () => [{ participantId: 'm1', status: 'done', text: 'ok' }] };
  const good = await runCollaboration({
    goal, participants, manager,
    reviewer: async () => ({ ok: true, source: 'model', notes: [] })
  });
  assert.equal(good.review.source, 'model');
  const bad = await runCollaboration({
    goal, participants, manager,
    reviewer: async () => ({ ok: false, source: 'model', notes: ['bad'] })
  }).catch(error => error);
  assert.match(String(bad), /审核未通过/);
});

test('审核失败时不调度/不执行', async () => {
  const manager = { ask: async () => { throw new Error('不应调用'); } };
  await assert.rejects(
    () => runCollaboration({ goal, participants: [], manager }),
    /没有满足范围|审核未通过/
  );
});
