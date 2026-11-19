/** P2-05：三块地图，每条都有出处。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildKnowledgeMap } from '../out-test/main/knowledge/map.js';

const claim = (id, text, evidenceId) => ({ claimId: id, goalId: 'g', text, kind: 'fact', source: { evidenceId }, createdAt: 1 });
const card = (id, claimIds, evidenceRefs, status = 'active', asOf = Date.now()) => ({
  cardId: id, topicId: 't', statement: `card-${id}`, claimIds, evidenceRefs, conditions: [],
  status, freshness: { asOf, state: 'fresh', reasons: [] }, createdAt: 1, updatedAt: 1
});
const conflict = { conflictId: 'c1', goalId: 'g', claimA: 'a', claimB: 'b', type: 'factual', matters: true, status: 'confirmed', detectedBy: 'rule', evidenceRefs: ['e-a'], createdAt: 1 };
const dispute = { disputeId: 'd1', conflictId: 'c1', goalId: 'g', status: 'open', openedAt: 1 };

test('已确认/争议/未回答；无出处条目不进入', () => {
  const map = buildKnowledgeMap({
    cards: [card('k1', ['c1'], ['e1']), card('k2', ['c2'], [], 'active')],
    claims: [claim('c1', '已确认结论', 'e1'), claim('a', 'A 说法', 'e-a'), claim('b', 'B 说法', 'e-b'), claim('c3', '未回答结论', 'e3'), claim('c4', '无出处', undefined)],
    disputes: [dispute],
    conflicts: [conflict]
  });
  assert.equal(map.confirmed.length, 1);
  assert.ok(map.disputed.length >= 2);
  assert.equal(map.unanswered.length, 1);
  assert.ok([...map.confirmed, ...map.disputed, ...map.unanswered].every(item => item.evidenceRefs.length > 0));
});
