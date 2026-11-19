/** P2-02：召回可解释；跨主题不串。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { KnowledgeIndex } from '../out-test/main/knowledge/index.js';

const card = (id, topicId, statement, claimIds = [], evidenceRefs = []) => ({
  cardId: id, topicId, statement, claimIds, evidenceRefs, conditions: [], status: 'active',
  freshness: { asOf: 1, state: 'fresh', reasons: [] }, createdAt: 1, updatedAt: 1
});
const cards = [
  card('k1', 't1', 'Redis 分布式锁用 SETNX', ['c1'], ['e1']),
  card('k2', 't2', 'Nginx 负载均衡策略', ['c2'], ['e2'])
];

test('按陈述/Claim/证据召回，带 matchedBy', () => {
  const index = new KnowledgeIndex(cards);
  assert.equal(index.recall('SETNX')[0].card.cardId, 'k1');
  assert.equal(index.recall('c1')[0].matchedBy[0], 'claim');
  assert.equal(index.recall('e2')[0].card.cardId, 'k2');
});

test('topicId 过滤不跨主题；无匹配为空', () => {
  const index = new KnowledgeIndex(cards);
  assert.deepEqual(index.recall('Redis', { topicId: 't2' }), []);
  assert.equal(index.recall('不存在的词').length, 0);
});
