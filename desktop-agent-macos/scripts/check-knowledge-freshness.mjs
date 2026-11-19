/** P2-03：fresh/stale/refuted 三态与复用判定。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { canReuse, evaluateFreshness } from '../out-test/main/knowledge/freshness.js';

const card = (extra = {}) => ({
  cardId: 'k', topicId: 't', statement: 's', claimIds: [], evidenceRefs: ['e'], conditions: [],
  status: 'active', freshness: { asOf: 1000, state: 'fresh', reasons: [] }, createdAt: 1, updatedAt: 1, ...extra
});

test('新鲜 / 过期 / 版本变化', () => {
  assert.equal(evaluateFreshness(card(), 2000).state, 'fresh');
  assert.equal(evaluateFreshness(card(), 1000 + 31 * 24 * 3600 * 1000).state, 'stale');
  assert.equal(evaluateFreshness(card({ freshness: { asOf: 1000, version: 'v1', state: 'fresh', reasons: [] } }), 2000, { version: 'v2' }).state, 'stale');
});

test('refuted / superseded 不可复用', () => {
  assert.equal(canReuse(card({ status: 'refuted' }), 2000).reusable, false);
  assert.equal(canReuse(card({ status: 'superseded' }), 2000).reusable, false);
});
