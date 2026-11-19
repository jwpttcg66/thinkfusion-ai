/** P2-06：首次研究、二次复用、过期、被推翻、多主题、无来源。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeStore } from '../out-test/main/knowledge/store.js';
import { KnowledgeIndex } from '../out-test/main/knowledge/index.js';
import { canReuse } from '../out-test/main/knowledge/freshness.js';

function open() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-k-scenario-'));
  return { dir: d, store: new KnowledgeStore(path.join(d, 'k.json')) };
}
const card = (id, topicId, statement, extra = {}) => ({
  cardId: id, topicId, statement, claimIds: [`c-${id}`], evidenceRefs: [`e-${id}`],
  conditions: [], status: 'active',
  freshness: { asOf: Date.now(), state: 'fresh', reasons: [] }, ...extra
});

test('6 个知识场景', () => {
  const { dir, store } = open();
  store.upsertTopic({ topicId: 't1', title: 'Redis', aliases: [] });
  store.addCard(card('k1', 't1', 'SETNX 可以做锁'));

  // 首次研究：可召回
  let index = new KnowledgeIndex(store.listCards());
  assert.equal(index.recall('SETNX').length, 1);

  // 二次复用：新鲜
  assert.equal(canReuse(store.getCard('k1')).reusable, true);

  // 过期
  const old = { ...store.getCard('k1'), freshness: { asOf: Date.now() - 40 * 24 * 3600 * 1000, state: 'fresh', reasons: [] } };
  assert.equal(canReuse(old).state, 'stale');

  // 被推翻
  store.setStatus('k1', 'refuted');
  assert.equal(canReuse(store.getCard('k1')).reusable, false);

  // 多主题：不串
  store.upsertTopic({ topicId: 't2', title: 'Nginx', aliases: [] });
  store.addCard(card('k2', 't2', 'Nginx 做入口'));
  index = new KnowledgeIndex(store.listCards());
  assert.deepEqual(index.recall('Nginx', { topicId: 't1' }), []);

  // 无来源：拒绝
  assert.throws(() => store.addCard(card('k3', 't1', '无来源', { evidenceRefs: [] })), /至少有一个/);
  fs.rmSync(dir, { recursive: true, force: true });
});
