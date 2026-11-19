/** P2-01：知识卡存储、原子写、旧数据兼容。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { KnowledgeStore } from '../out-test/main/knowledge/store.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tf-knowledge-'));
const card = (id, extra = {}) => ({
  cardId: id, topicId: 't1', statement: 'Redis SETNX 用于分布式锁', claimIds: ['c1'],
  evidenceRefs: ['e1'], conditions: ['Redis 单实例'], status: 'active',
  freshness: { asOf: Date.now(), state: 'fresh', reasons: [] }, ...extra
});

test('写入/重载；文件 0600', () => {
  const d = dir();
  const file = path.join(d, 'knowledge.json');
  const store = new KnowledgeStore(file);
  store.upsertTopic({ topicId: 't1', title: 'Redis', aliases: ['缓存'] });
  store.addCard(card('k1'));
  const reloaded = new KnowledgeStore(file);
  assert.equal(reloaded.listCards().length, 1);
  assert.equal(reloaded.listTopics()[0].title, 'Redis');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(d, { recursive: true, force: true });
});

test('无证据拒绝；重复 cardId 拒绝；supersedes 标旧卡', () => {
  const d = dir();
  const store = new KnowledgeStore(path.join(d, 'k.json'));
  assert.throws(() => store.addCard(card('k0', { evidenceRefs: [] })), /至少有一个/);
  store.addCard(card('k1'));
  assert.throws(() => store.addCard(card('k1')), /已存在/);
  store.addCard(card('k2', { supersedes: 'k1', statement: '新结论' }));
  assert.equal(store.getCard('k1').status, 'superseded');
  fs.rmSync(d, { recursive: true, force: true });
});

test('旧数据缺字段可读，不崩', () => {
  const d = dir();
  const file = path.join(d, 'k.json');
  fs.writeFileSync(file, JSON.stringify({ cards: [{ cardId: 'old', evidenceRefs: ['e'] }], topics: [] }), 'utf8');
  const store = new KnowledgeStore(file);
  assert.equal(store.listCards().length, 1);
  assert.equal(store.listCards()[0].cardId, 'old');
  fs.rmSync(d, { recursive: true, force: true });
});
