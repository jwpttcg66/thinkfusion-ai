/** P1-13：规则审核；模型审核不合法回退。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewPlanRules, reviewWithModel } from '../out-test/main/collaboration/reviewer.js';

const task = id => ({ taskId: id, goalId: 'g', kind: 'analyze', envelope: { question: 'q', acceptance: ['a'], evidenceRequired: false }, dependsOn: [], requiredCapabilities: [] });
const plan = {
  planId: 'p', goalId: 'g', version: 1,
  policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 1, maxMs: 1, usedCalls: 0, startedAt: 1 } },
  tasks: [task('t1')], participants: [{ participantId: 'm1', reason: 'x' }], skipped: [], stopWhen: [], reason: '', createdAt: 1
};

test('规则：正常通过；空计划/人数不足/执行无验收失败', () => {
  assert.equal(reviewPlanRules(plan).ok, true);
  assert.equal(reviewPlanRules({ ...plan, tasks: [] }).ok, false);
  assert.equal(reviewPlanRules({ ...plan, participants: [] }).ok, false);
  const exec = { ...task('t2'), kind: 'execute', envelope: { question: 'q', acceptance: [], evidenceRequired: false } };
  assert.equal(reviewPlanRules({ ...plan, tasks: [exec] }).ok, false);
});

test('模型关闭时只走规则', async () => {
  const result = await reviewWithModel(plan, async () => ({ ok: true }), { enabled: false });
  assert.equal(result.source, 'rule');
});

test('模型输出合法采用；非法/抛错回退', async () => {
  const good = await reviewWithModel(plan, async () => ({ ok: true, notes: ['ok'] }), { enabled: true });
  assert.equal(good.source, 'model');
  const bad = await reviewWithModel(plan, async () => ({ nope: 1 }), { enabled: true });
  assert.equal(bad.fallback, true);
  const thrown = await reviewWithModel(plan, async () => { throw new Error('x'); }, { enabled: true });
  assert.equal(thrown.fallback, true);
});
