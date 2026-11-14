/**
 * 24 题回归集的静态校验。
 *
 * 这里不调用模型，只钉住：
 * - 题目数量、ID/问题唯一；
 * - 六种策略各 4 题；
 * - 数据集 SHA-256 与内容一致；
 * - anchor 是人工列出的规则可查词，不是模型生成的答案。
 *
 * Run with: npm run test:debate-regression-dataset
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, 'regression', 'debate-dataset.json');

function load() {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('24 题、ID 与问题唯一、字段齐全', () => {
  const dataset = load();
  assert.equal(dataset.questions.length, 24);
  const ids = dataset.questions.map(item => item.id);
  const questions = dataset.questions.map(item => item.question);
  assert.equal(new Set(ids).size, ids.length, 'ID 不能重复');
  assert.equal(new Set(questions).size, questions.length, '问题不能重复');
  for (const item of dataset.questions) {
    assert.ok(item.id.length > 0);
    assert.ok(item.category.length > 0);
    assert.ok(item.question.trim().length >= 12, `${item.id} 问题太短`);
  }
});

test('六种策略各 4 题', () => {
  const dataset = load();
  const counts = {};
  for (const item of dataset.questions) counts[item.strategy] = (counts[item.strategy] ?? 0) + 1;
  assert.deepEqual(counts, {
    truth: 4,
    adversarial: 4,
    expert: 4,
    assumption: 4,
    solution: 4,
    discovery: 4
  });
});

test('数据集 SHA-256 与内容一致', () => {
  const dataset = load();
  const actual = createHash('sha256').update(JSON.stringify(dataset.questions)).digest('hex');
  assert.equal(actual, dataset.sha256);
  assert.match(dataset.sha256, /^[a-f0-9]{64}$/);
});

test('anchor 只含人工规则词，且不是模型生成的参考答案', () => {
  const dataset = load();
  const anchored = dataset.questions.filter(item => item.anchor);
  assert.ok(anchored.length >= 6, '至少要有 6 道可规则烟测的题');
  for (const item of anchored) {
    assert.ok(Array.isArray(item.anchor.terms) && item.anchor.terms.length > 0, `${item.id} anchor 为空`);
    assert.ok(item.anchor.note.length > 0, `${item.id} anchor 缺少说明`);
    assert.equal(item.anchor.answer, undefined, `${item.id} 不应保存模型生成的参考答案`);
  }
});
