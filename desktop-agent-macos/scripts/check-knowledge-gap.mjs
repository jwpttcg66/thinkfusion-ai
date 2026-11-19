/** P2-04：缺口检测、任务化、无新增即停。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { findKnowledgeGaps, gapTasks, replanForGaps, shouldContinueResearch } from '../out-test/main/knowledge/gap.js';

const claim = (id, text, evidenceId) => ({
  claimId: id, goalId: 'g', text, kind: 'fact', source: { evidenceId }, createdAt: 1
});
const card = (id, claimIds, asOf = Date.now(), status = 'active') => ({
  cardId: id, topicId: 't', statement: 's', claimIds, evidenceRefs: ['e1'], conditions: [],
  status, freshness: { asOf, state: 'fresh', reasons: [] }, createdAt: 1, updatedAt: 1
});
const conflict = { conflictId: 'c1', goalId: 'g', claimA: 'a', claimB: 'b', type: 'factual', matters: true, status: 'confirmed', detectedBy: 'rule', evidenceRefs: ['e1'], createdAt: 1 };
const dispute = { disputeId: 'd1', conflictId: 'c1', goalId: 'g', status: 'open', openedAt: 1 };

test('未覆盖 Claim / 过期卡 / 未决争议 都成为缺口', () => {
  const gaps = findKnowledgeGaps({
    question: 'q',
    cards: [card('k1', ['c1']), card('k2', ['c9'], Date.now() - 40 * 24 * 3600 * 1000)],
    claims: [claim('c1', '已覆盖', 'e1'), claim('c2', '未覆盖', 'e2')],
    disputes: [dispute],
    conflicts: [conflict]
  });
  assert.ok(gaps.some(g => g.kind === 'unanswered' && g.claimId === 'c2'));
  assert.ok(gaps.some(g => g.kind === 'stale' && g.cardId === 'k2'));
  assert.ok(gaps.some(g => g.kind === 'disputed' && g.disputeId === 'd1'));
});

test('缺口任务化；无新增任务就停', () => {
  const gaps = [{ kind: 'unanswered', text: 'x', claimId: 'c' }];
  const tasks = gapTasks('g', gaps);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, 'research');
  assert.equal(shouldContinueResearch(gaps, 1), true);
  assert.equal(shouldContinueResearch(gaps, 0), false);
});

test('缺口可通过 Replanner 落到新 Plan', async () => {
  const { createCollaborationState } = await import('../out-test/main/collaboration/domain/state.js');
  const goal = { goalId: 'g', workspace: 'general', statement: 'q', constraints: [], acceptance: [], createdAt: 1 };
  const plan = { planId: 'p', goalId: 'g', version: 1, policy: { modelScope: 'remote', includeWeb: false, minParticipants: 1, allowWebQuestioner: false, budget: { maxCalls: 1, maxMs: 1, usedCalls: 0, startedAt: 1 } }, tasks: [], participants: [], skipped: [], stopWhen: [], reason: '', createdAt: 1 };
  const state = createCollaborationState(goal, plan, plan.policy.budget);
  const next = replanForGaps(state, [{ kind: 'unanswered', text: 'x' }]);
  assert.equal(next.applied, true);
  assert.equal(next.state.activePlan.version, 2);
  assert.equal(next.state.activePlan.tasks.length, 1);
});
