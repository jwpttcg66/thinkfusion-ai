/**
 * P1 修复验收：N 次基线比较、单轮标准答案检查、重算脚本不覆盖输入。
 *
 * Run with: npm run test:compare-baselines
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { compare: compareBaselines, comparability } = require('./regression/compare-baselines.cjs');
const { compare: compareResults } = require('./regression/compare-results.cjs');
const { recomputeBaseline, outputPaths } = require('./regression/recompute-baseline-stats.cjs');

const sha = char => char.repeat(64);

function question(id, category) {
  return {
    id,
    strategy: 'truth',
    category,
    runs: 2,
    completed: category === 'incomplete' ? 1 : 2,
    partial: category === 'incomplete' ? 1 : 0,
    v1Pass: category === 'stable-pass' ? 2 : category === 'stable-fail' ? 0 : 1,
    v1Fail: category === 'stable-fail' ? 2 : 0,
    outcomes: category === 'incomplete' ? ['COMPLETED', 'PARTIAL'] : ['COMPLETED', 'COMPLETED'],
    providerUnavailable: category === 'incomplete' ? 1 : 0
  };
}

function baselineDoc({ category = 'stable-pass', ...overrides } = {}) {
  const config = {
    createdAt: '2026-11-16T00:00:00.000Z',
    runner: { version: '2.3.0', commit: 'x', backend: 'opencode-go', provider: 'opencode-go', promptVersion: '1.1.0' },
    dataset: { version: '1.0.0', sha256: sha('a') },
    standard: { version: '1.1.0', sha256: sha('b') },
    retryPolicy: { version: '1.0.0' },
    models: [{ model: 'm1' }],
    sampling: { temperature: { value: 0, support: 'accepted' }, seed: { value: 42, support: 'accepted' } },
    runtime: { runs: 2, completeness: true, workers: 3, providerConcurrency: 6 }
  };
  return {
    kind: 'debate-p0-baseline',
    config,
    sampleCount: 2,
    stats: { sampleCount: 2, perQuestion: [question('q1', category)] },
    ...overrides
  };
}

test('同一份基线可比较，分类无变化', () => {
  const doc = baselineDoc();
  const outcome = compareBaselines(doc, doc);
  assert.equal(outcome.comparable, true);
  assert.deepEqual(outcome.problems, []);
  assert.equal(outcome.totals.changed, 0);
  assert.equal(outcome.totals.lostStablePass, 0);
});

test('数据集、标准答案、runner、重试策略、样本数不一致时拒绝比较', () => {
  const base = baselineDoc();
  const cases = [
    ['数据集', { config: { ...base.config, dataset: { version: '1.0.0', sha256: sha('c') } } }, /数据集不同/],
    ['标准答案', { config: { ...base.config, standard: { version: '1.1.0', sha256: sha('d') } } }, /标准答案不同/],
    ['runner', { config: { ...base.config, runner: { ...base.config.runner, version: '2.2.0' } } }, /runner 不同/],
    ['重试策略', { config: { ...base.config, retryPolicy: { version: '0.9.0' } } }, /重试策略不同/],
    ['样本数', { sampleCount: 3, stats: { ...base.stats, sampleCount: 3 } }, /样本数不同/]
  ];
  for (const [label, overrides, pattern] of cases) {
    const problems = comparability(base, baselineDoc(overrides));
    assert.ok(problems.some(problem => pattern.test(problem)), `${label} 应拒绝：${problems.join('；')}`);
  }
});

test('分类变化：稳定通过丢失、新增稳定失败、解除稳定失败', () => {
  const before = baselineDoc({ category: 'stable-pass' });
  const after = baselineDoc({
    category: 'stable-fail',
    stats: {
      sampleCount: 2,
      perQuestion: [question('q1', 'stable-fail'), question('q2', 'stable-pass')]
    }
  });
  before.stats.perQuestion.push(question('q2', 'stable-fail'));
  const outcome = compareBaselines(before, after);
  assert.equal(outcome.comparable, true);
  assert.equal(outcome.totals.lostStablePass, 1, 'q1 从稳定通过掉了');
  assert.equal(outcome.totals.newStableFail, 1);
  assert.equal(outcome.totals.gainedStablePass, 1, 'q2 从稳定失败变成稳定通过');
  assert.equal(outcome.totals.resolvedStableFail, 1);
});

test('PARTIAL 从波动移到不完整会被标成 changed，而不是稳定失败', () => {
  const before = baselineDoc({ category: 'fluctuating' });
  const after = baselineDoc({ category: 'incomplete' });
  const outcome = compareBaselines(before, after);
  assert.equal(outcome.rows[0].delta, 'changed');
  assert.equal(outcome.totals.newStableFail, 0);
});

function singleRun(standard) {
  return {
    dataset: { version: '1.0.0', sha256: sha('a') },
    models: ['m1'],
    completeness: true,
    standard,
    results: [{
      id: 'q1',
      strategy: 'truth',
      standard: { passed: true },
      quality: { status: 'passed' },
      judge: { backend: 'model', sharedWith: null }
    }]
  };
}

test('compare-results：缺少或不同的标准答案 SHA 都拒绝比较', () => {
  const base = singleRun({ version: '1.1.0', sha256: sha('b') });
  assert.equal(compareResults(base, singleRun({ version: '1.1.0', sha256: sha('b') })).comparable, true);

  const missing = compareResults(base, singleRun(undefined));
  assert.equal(missing.comparable, false);
  assert.ok(missing.problems.some(problem => problem.includes('缺少标准答案')));

  const changed = compareResults(base, singleRun({ version: '1.2.0', sha256: sha('c') }));
  assert.equal(changed.comparable, false);
  assert.ok(changed.problems.some(problem => problem.includes('标准答案不同')));
});

test('重算脚本：输出路径永远不等于输入，输入文件内容不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-recompute-'));
  try {
    const input = path.join(dir, 'baseline.json');
    const doc = baselineDoc();
    doc.runs = [{
      runId: 'run-1',
      startedAt: 't1',
      endedAt: 't2',
      summary: {
        execution: { COMPLETED: 1 },
        standard: { total: 1, passed: 1, failed: 0 },
        structuralOk: true
      },
      results: [{
        id: 'q1',
        strategy: 'truth',
        category: 'truth',
        debate: { outcome: 'COMPLETED', failures: [] },
        standard: { passed: true },
        judge: { backend: 'model' },
        quality: { status: 'passed' }
      }]
    }];
    fs.writeFileSync(input, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    const before = createHash('sha256').update(fs.readFileSync(input)).digest('hex');

    const paths = outputPaths(input);
    assert.notEqual(path.resolve(paths.stamped), path.resolve(input));
    assert.notEqual(path.resolve(paths.latest), path.resolve(input));

    const result = recomputeBaseline(input);
    const after = createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    assert.equal(after, before, '输入文件被改写了');
    assert.ok(fs.existsSync(result.stamped));
    assert.ok(fs.existsSync(result.latest));
    assert.notEqual(result.stamped, input);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧统计没有 category 时拒绝比较，提示先重算', () => {
  const doc = baselineDoc();
  delete doc.stats.perQuestion[0].category;
  const problems = comparability(doc, baselineDoc());
  assert.ok(problems.some(problem => problem.includes('缺少逐题 category')));
});
