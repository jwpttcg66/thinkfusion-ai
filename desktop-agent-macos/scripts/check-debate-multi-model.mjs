/**
 * P1：双模型、三模型、多模型角色与独立 Judge。
 *
 * Run with: npm run test:debate-multi-model
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planLead, roleFor } from '../out-test/main/debate/lead.js';
import { resolveJudge } from '../out-test/main/judge/resolve.js';

const candidate = id => ({ id, label: id, type: 'cloud', available: true });

test('双模型：pair_debate，proposer/critic 分工', () => {
  const plan = planLead({
    mode: 'cloud',
    strategy: 'adversarial',
    candidates: [candidate('a'), candidate('b')],
    selected: ['a', 'b']
  });
  assert.equal(plan.collaboration.shape, 'pair_debate');
  assert.deepEqual(plan.participants, ['a', 'b']);
  assert.equal(roleFor(plan, 'a', 0, 'adversarial'), 'proposer');
  assert.equal(roleFor(plan, 'b', 0, 'adversarial'), 'critic');
});

test('三模型：两位辩论 + 未参辩的第三位独立 Judge', () => {
  const plan = planLead({
    mode: 'cloud',
    strategy: 'truth',
    candidates: [candidate('a'), candidate('b'), candidate('judge')],
    selected: ['a', 'b']
  });
  assert.deepEqual(plan.participants, ['a', 'b']);
  const resolution = resolveJudge({
    candidates: [
      { id: 'a', type: 'cloud', available: true, modelId: 'a' },
      { id: 'b', type: 'cloud', available: true, modelId: 'b' },
      { id: 'judge', type: 'cloud', available: true, modelId: 'judge' }
    ],
    participants: plan.participants,
    participantModelIds: ['a', 'b']
  });
  assert.equal(resolution.judgeAgentId, 'judge');
  assert.equal(resolution.judgeMode, 'independent-judge');
  assert.equal(resolution.judgeIndependent, true);
});

test('四模型：multi_model_panel，角色不全部相同', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const plan = planLead({
    mode: 'cloud',
    strategy: 'truth',
    candidates: ids.map(candidate),
    selected: ids
  });
  assert.equal(plan.collaboration.shape, 'multi_model_panel');
  assert.equal(plan.participants.length, 4);
  const roles = ids.map(id => roleFor(plan, id, 0, 'truth'));
  assert.ok(new Set(roles).size >= 3, `四个参与者应至少有三种角色，实际 ${roles.join('、')}`);
  assert.equal(roles[0], 'proposer');
  assert.equal(roles[1], 'critic');
  assert.equal(roles[2], 'evidence_reviewer');
});
