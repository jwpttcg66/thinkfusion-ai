/** P1-12：只对 matters && open 的 Dispute 触发辩论；无基线、无提示词。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDispute, runDebates, selectDebates } from '../out-test/main/collaboration/behaviors/debate.js';

const state = (conflict, dispute) => ({
  version: 1, goal: { goalId: 'g', workspace: 'general', statement: 'q', constraints: [], acceptance: [], createdAt: 1 },
  activePlan: { planId: 'p', goalId: 'g', version: 1, policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 1, maxMs: 1, usedCalls: 0, startedAt: 1 } }, tasks: [], participants: [], skipped: [], stopWhen: [], reason: '', createdAt: 1 },
  planHistory: [], taskStates: [], assignments: [], observations: [], evidence: [], claims: [],
  conflicts: [conflict], disputes: [dispute], budget: { maxCalls: 1, maxMs: 1, usedCalls: 0, startedAt: 1 }, replans: [], updatedAt: 1
});
const conflict = matters => ({ conflictId: 'c1', goalId: 'g', claimA: 'A', claimB: 'B', type: 'factual', matters, status: 'confirmed', detectedBy: 'rule', evidenceRefs: ['e1'], createdAt: 1 });
const dispute = status => ({ disputeId: 'd1', conflictId: 'c1', goalId: 'g', status, openedAt: 1 });

test('matters + open 才触发', () => {
  assert.equal(selectDebates(state(conflict(true), dispute('open'))).length, 1);
  assert.equal(selectDebates(state(conflict(false), dispute('open'))).length, 0);
  assert.equal(selectDebates(state(conflict(true), dispute('resolved'))).length, 0);
});

test('争议可解析；unverified 保持 unresolved', () => {
  const base = state(conflict(true), dispute('open'));
  const resolved = resolveDispute(base, 'd1', { claimId: 'a', relation: 'supports', confidence: 'high', limitations: [], evidenceRefs: ['e1'] });
  assert.equal(resolved.disputes[0].status, 'resolved');
  const unresolved = resolveDispute(base, 'd1', { claimId: 'a', relation: 'unverified', confidence: 'low', limitations: [], evidenceRefs: [] });
  assert.equal(unresolved.disputes[0].status, 'unresolved');
});


test('runDebates 只把选中争议交给外部 Debate，并回写状态', async () => {
  const base = state(conflict(true), dispute('open'));
  const seen = [];
  const next = await runDebates(base, async requests => {
    seen.push(...requests);
    return [{ disputeId: 'd1', verdict: { claimId: 'a', relation: 'supports', confidence: 'high', limitations: [], evidenceRefs: ['e1'] } }];
  });
  assert.equal(seen.length, 1);
  assert.equal(next.disputes[0].status, 'resolved');
  const none = await runDebates(state(conflict(true), dispute('resolved')), async () => { throw new Error('不应调用'); });
  assert.equal(none.disputes[0].status, 'resolved');
});
