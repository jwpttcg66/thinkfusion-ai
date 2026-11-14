/**
 * 24 题技术事实基线 V1 的静态校验。
 *
 * 这里不调用模型，只钉住：
 * - 24 题 id 与回归数据集一致；
 * - 人工复核结论数量：保留 11、补充 10、重做 3；
 * - 分类只能是 FACT / CONTEXTUAL / INSUFFICIENT；
 * - 每题都有标准事实、必答主张、允许表达、错误主张和评分入口；
 * - 数据集 SHA-256 与内容一致。
 *
 * Run with: npm run test:debate-standard-answers
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const standardFile = path.join(here, 'regression', 'debate-standard-answers-v1.json');
const datasetFile = path.join(here, 'regression', 'debate-dataset.json');

const load = () => JSON.parse(fs.readFileSync(standardFile, 'utf8'));

test('24 题、ID 与回归数据集一致、SHA-256 正确', () => {
  const standard = load();
  const dataset = JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
  assert.equal(standard.questions.length, 24);
  assert.deepEqual(
    standard.questions.map(item => item.id),
    dataset.questions.map(item => item.id),
    '标准答案必须与回归数据集同序同 ID'
  );
  const actual = createHash('sha256').update(JSON.stringify(standard.questions)).digest('hex');
  assert.equal(actual, standard.sha256);
  assert.match(standard.sha256, /^[a-f0-9]{64}$/);
});

test('人工复核数量：保留 11、补充 10、重做 3', () => {
  const standard = load();
  const counts = {};
  for (const item of standard.questions) counts[item.review.verdict] = (counts[item.review.verdict] ?? 0) + 1;
  assert.deepEqual(counts, { retain: 11, supplement: 10, redo: 3 });
  const redo = standard.questions.filter(item => item.review.verdict === 'redo').map(item => item.id);
  assert.deepEqual(redo, ['cache-invalidation', 'mq-delivery', 'distributed-lock']);
});

test('分类：FACT 11、CONTEXTUAL 13、INSUFFICIENT 0；不允许未知分类', () => {
  const standard = load();
  const counts = {};
  for (const item of standard.questions) counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  assert.deepEqual(counts, { FACT: 11, CONTEXTUAL: 13 });
  for (const item of standard.questions) {
    assert.ok(['FACT', 'CONTEXTUAL', 'INSUFFICIENT'].includes(item.classification));
    assert.ok(item.review.summary.length > 0);
  }
});

test('每题都有标准事实、必答主张、允许表达和错误主张', () => {
  const standard = load();
  for (const item of standard.questions) {
    assert.ok(item.standardFacts.length >= 2, `${item.id} 标准事实太少`);
    assert.ok(item.requiredClaims.length >= 2, `${item.id} 必答主张太少`);
    assert.ok(item.allowedExpressions.length >= 1, `${item.id} 缺少允许表达`);
    assert.ok(item.wrongClaims.length >= 1, `${item.id} 缺少错误主张`);
    const ids = new Set(item.requiredClaims.map(claim => claim.id));
    assert.equal(ids.size, item.requiredClaims.length, `${item.id} claim id 重复`);
    assert.equal(item.judging.mustPass, undefined, `${item.id} 不应再维护 mustPass`);
    assert.ok(item.requiredClaims.some(claim => claim.severity === 'must'), `${item.id} 至少需要一条 must`);
  }
});

test('must 复核：4 条降为 should；severity 是唯一必答来源', () => {
  const standard = load();
  assert.equal(standard.mustReview.length, 4);
  for (const item of standard.mustReview) {
    const question = standard.questions.find(q => q.id === item.id);
    const claim = question.requiredClaims.find(c => c.id === item.claimId);
    assert.equal(claim.severity, 'should');
    assert.equal(item.from, 'must');
    assert.equal(item.to, 'should');
    assert.ok(item.reason.length > 0);
  }
});

test('compression c3 保持 should，并记录澄清', () => {
  const standard = load();
  const compression = standard.questions.find(q => q.id === 'compression');
  const c3 = compression.requiredClaims.find(c => c.id === 'c3');
  assert.equal(c3.severity, 'should');
  assert.equal(standard.clarifications.length, 1);
  assert.equal(standard.clarifications[0].id, 'compression');
  assert.equal(standard.clarifications[0].claimId, 'c3');
  assert.equal(standard.clarifications[0].decision, 'keep-should');
});

test('评分规则存在，且不保存模型生成的参考答案', () => {
  const standard = load();
  assert.equal(standard.schema, 'thinkfusion.tech-fact-regression/v1');
  assert.equal(standard.scoring.scale, '0-100');
  assert.ok(standard.scoring.rules.length >= 5);
  assert.equal(standard.gate.passScore, 70);
  assert.equal(standard.gate.missingMustCap, 69);
  assert.equal(standard.gate.majorWrongCap, 39);
  assert.equal(standard.gate.contextualNoBoundaryCap, 65);
  assert.equal(standard.gate.classificationMismatchCap, 60);
  for (const item of standard.questions) {
    assert.equal(item.answer, undefined, `${item.id} 不应保存模型生成的参考答案`);
    assert.equal(item.modelAnswer, undefined, `${item.id} 不应保存模型答案`);
  }
});
