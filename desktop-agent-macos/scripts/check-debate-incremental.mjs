/**
 * 增量回归复用规则的单元测试。
 *
 * 这里钉住的是“不能证明配置一致就不许复用”：
 * 旧结果没有 fingerprint、prompt/模型池/标准变了、V1 没过，都必须重跑。
 *
 * Run with: npm run test:debate-incremental
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { fingerprintFor, canReuseResult } = require('./regression/incremental.cjs');

const item = { id: 'q1', question: '问题一？', strategy: 'truth', anchor: { terms: ['a'] } };
const standardItem = { id: 'q1', classification: 'FACT', standardFacts: ['事实'] };
const base = {
  runnerVersion: '2.0.0',
  promptVersion: '1.1.0',
  item,
  standardItem,
  models: ['deepseek-v4.1-flash', 'gpt-6-luna'],
  completeness: false
};

const old = (overrides = {}) => ({
  fingerprint: fingerprintFor(base),
  debate: { outcome: 'COMPLETED' },
  standard: { passed: true },
  ...overrides
});

test('没有 fingerprint 的旧结果不能复用', () => {
  const result = old();
  delete result.fingerprint;
  assert.equal(canReuseResult(result, fingerprintFor(base)), false);
});

test('fingerprint 为空字符串不能复用', () => {
  assert.equal(canReuseResult(old({ fingerprint: '' }), fingerprintFor(base)), false);
});

test('prompt 版本变化必须重跑', () => {
  const next = fingerprintFor({ ...base, promptVersion: '1.1.1' });
  assert.notEqual(next, old().fingerprint);
  assert.equal(canReuseResult(old(), next), false);
});

test('模型池变化必须重跑', () => {
  const next = fingerprintFor({ ...base, models: [...base.models, 'claude-haiku-5-5'] });
  assert.notEqual(next, old().fingerprint);
  assert.equal(canReuseResult(old(), next), false);
});

test('题目标准变化只让对应题失效', () => {
  const otherItem = { id: 'q2', question: '问题二？', strategy: 'truth', anchor: null };
  const otherStandard = { id: 'q2', classification: 'FACT', standardFacts: ['另一条事实'] };
  const beforeOther = fingerprintFor({ ...base, item: otherItem, standardItem: otherStandard });
  const changed = fingerprintFor({ ...base, standardItem: { ...standardItem, standardFacts: ['改过的事实'] } });
  const afterOther = fingerprintFor({ ...base, item: otherItem, standardItem: otherStandard });
  assert.notEqual(changed, old().fingerprint);
  assert.equal(afterOther, beforeOther);
});

test('完成但 V1 失败必须重跑', () => {
  assert.equal(canReuseResult(old({ standard: { passed: false } }), old().fingerprint), false);
});

test('未完成必须重跑', () => {
  assert.equal(canReuseResult(old({ debate: { outcome: 'PARTIAL' } }), old().fingerprint), false);
});

test('完成、V1 通过、fingerprint 一致才复用', () => {
  assert.equal(canReuseResult(old(), old().fingerprint), true);
});

test('完整性复核开关变化必须重跑', () => {
  const next = fingerprintFor({ ...base, completeness: true });
  assert.notEqual(next, old().fingerprint);
  assert.equal(canReuseResult(old(), next), false);
});

test('旧 fingerprint 与当前不一致不能复用', () => {
  assert.equal(canReuseResult(old({ fingerprint: 'old' }), old().fingerprint), false);
});
