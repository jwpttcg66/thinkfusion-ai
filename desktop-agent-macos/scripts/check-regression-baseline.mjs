/**
 * P0 基线工具的测试：重试策略 + 逐题统计。
 *
 * 钉住的是「报告不能骗人」的几条：
 * - 403 Endpoint 不可用不重试，也不换模型；
 * - 429/5xx/超时按上限重试，次数和等待时间可追踪；
 * - 达到上限后错误里带策略类别与实际尝试次数；
 * - PARTIAL 题的 V1 通过单独计入，不被说成完整运行；
 * - 同一份快照的多个结果按 commit 收敛后仍能正确统计。
 *
 * Run with: npm run test:regression-baseline
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  RETRY_POLICY_VERSION,
  classifyProviderError,
  retryDelayMs,
  withRetryPolicy,
  retryPolicySnapshot
} = require('./regression/retry-policy.cjs');
const { buildBaselineStats } = require('./regression/baseline-stats.cjs');

function fakeError(code, message, retryAfterMs) {
  const error = new Error(message);
  error.code = code;
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

test('403 Endpoint is unavailable：分类为 endpoint-unavailable，不重试', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    () => withRetryPolicy({
      run: async () => {
        calls += 1;
        throw fakeError('auth', 'API Key 被拒绝（403）：Endpoint is unavailable');
      },
      sleep: async ms => sleeps.push(ms)
    }),
    error => {
      assert.equal(error.policyClass, 'endpoint-unavailable');
      assert.equal(error.attempts, 1);
      assert.match(error.message, /retry:endpoint-unavailable/);
      return true;
    }
  );
  assert.equal(calls, 1, '403 不能重试');
  assert.deepEqual(sleeps, []);
});

test('429：按 Retry-After 等待，最多额外 3 次', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    () => withRetryPolicy({
      run: async () => {
        calls += 1;
        throw fakeError('busy', '云端限流（429）', 1500);
      },
      sleep: async ms => waits.push(ms)
    }),
    error => error.policyClass === 'rate-limit' && error.attempts === 4
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1500, 1500, 1500]);
});

test('5xx：最多额外 2 次，退避 1s/2s', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    () => withRetryPolicy({
      run: async () => {
        calls += 1;
        throw fakeError('unavailable', '云端服务错误 503：busy');
      },
      sleep: async ms => waits.push(ms)
    }),
    error => error.policyClass === 'server-error' && error.attempts === 3
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('超时：最多额外 2 次；不会把 tries 算成 1', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetryPolicy({
      run: async () => {
        calls += 1;
        throw fakeError('timeout', '请求超时');
      },
      sleep: async () => undefined
    }),
    error => error.policyClass === 'timeout' && error.attempts === 3
  );
  assert.equal(calls, 3);
});

test('重试不换模型：同一 agent/model 贯穿所有尝试', async () => {
  const attempts = [];
  let calls = 0;
  const value = await withRetryPolicy({
    run: async attempt => {
      calls += 1;
      attempts.push({ attempt, agentId: 'a', modelId: 'm' });
      if (attempt < 2) throw fakeError('unavailable', '云端服务错误 502');
      return 'ok';
    },
    sleep: async () => undefined
  });
  assert.equal(value.value, 'ok');
  assert.equal(value.attempts, 3);
  assert.deepEqual(attempts.map(item => item.agentId), ['a', 'a', 'a']);
  assert.deepEqual(attempts.map(item => item.modelId), ['m', 'm', 'm']);
  assert.equal(calls, 3);
});

test('400 请求错误不重试；未知错误也不猜成可重试', async () => {
  for (const [code, message, expected] of [
    ['bad-request', '云端说请求有问题（400）', 'request-error'],
    ['unknown', 'something odd', 'unknown']
  ]) {
    let calls = 0;
    await assert.rejects(
      () => withRetryPolicy({
        run: async () => {
          calls += 1;
          throw fakeError(code, message);
        },
        sleep: async () => undefined
      }),
      error => error.policyClass === expected && error.attempts === 1
    );
    assert.equal(calls, 1);
  }
});

test('策略快照明确写死不换模型与各错误上限', () => {
  const snapshot = retryPolicySnapshot();
  assert.equal(snapshot.version, RETRY_POLICY_VERSION);
  assert.equal(snapshot.modelSwitch, false);
  assert.equal(snapshot.classes['endpoint-unavailable'].retry, false);
  assert.equal(snapshot.classes['rate-limit'].maxExtra, 3);
  assert.equal(snapshot.classes['server-error'].maxExtra, 2);
  assert.equal(snapshot.classes.timeout.maxExtra, 2);
});

test('逐题统计：PARTIAL 的 V1 通过单独计入，波动与稳定分开', () => {
  const questions = [
    { id: 'q1', strategy: 'truth', category: 'truth' },
    { id: 'q2', strategy: 'truth', category: 'truth' },
    { id: 'q3', strategy: 'truth', category: 'truth' }
  ];
  const result = (id, { outcome = 'COMPLETED', pass = false, unavailable = false, failure } = {}) => ({
    id,
    debate: { outcome, failures: failure ? [{ agentId: 'a', detail: failure }] : [] },
    judge: { backend: 'model', sharedWith: null },
    quality: { status: 'passed' },
    standard: unavailable ? { backend: 'unavailable' } : { passed: pass }
  });
  const runs = [
    { runId: 'run-1', startedAt: 't1', endedAt: 't2', summary: { structuralOk: false }, results: [
      result('q1', { pass: true }),
      result('q2', { outcome: 'PARTIAL', pass: true, failure: 'API Key 被拒绝（403）：Endpoint is unavailable' }),
      result('q3', { pass: false })
    ] },
    { runId: 'run-2', startedAt: 't3', endedAt: 't4', summary: { structuralOk: false }, results: [
      result('q1', { pass: true }),
      result('q2', { outcome: 'PARTIAL', pass: false, failure: 'API Key 被拒绝（403）：Endpoint is unavailable' }),
      result('q3', { pass: false })
    ] }
  ];
  const stats = buildBaselineStats(runs, questions);
  assert.equal(stats.sampleCount, 2);
  assert.equal(stats.aggregate.v1Pass, 3);
  assert.equal(stats.aggregate.v1PassRate, 50);
  assert.equal(stats.aggregate.stablePass, 1, 'q1 两次都过');
  assert.equal(stats.aggregate.stableCompletePass, 1);
  assert.equal(stats.aggregate.stableFail, 1, 'q3 两次都没过');
  assert.equal(stats.aggregate.fluctuating, 0, 'q2 有 PARTIAL，不能算「完整执行里的波动」');
  assert.equal(stats.aggregate.incomplete, 1, 'q2 两次都 403，归到不完整');
  assert.equal(stats.aggregate.providerUnavailable, 2);
  const q2 = stats.perQuestion.find(row => row.id === 'q2');
  assert.equal(q2.partial, 2);
  assert.equal(q2.v1Pass, 1);
  assert.equal(q2.category, 'incomplete');
});

test('逐题统计：executionCompleteRate 不把 PARTIAL 算成完整运行', () => {
  const questions = [{ id: 'q1', strategy: 'truth', category: 'truth' }];
  const runs = [{
    runId: 'run-1',
    startedAt: 't1',
    endedAt: 't2',
    summary: {},
    results: [{
      id: 'q1',
      debate: { outcome: 'PARTIAL', failures: [] },
      judge: { backend: 'model' },
      quality: { status: 'passed' },
      standard: { passed: true }
    }]
  }];
  const stats = buildBaselineStats(runs, questions);
  assert.equal(stats.aggregate.completed, 0);
  assert.equal(stats.aggregate.partial, 1);
  assert.equal(stats.aggregate.executionCompleteRate, 0);
  assert.equal(stats.aggregate.v1Pass, 1);
});

test('统计分类：评分稳定与端到端稳定分开，PARTIAL 不混进波动', () => {
  const questions = [
    { id: 'all-pass', strategy: 'truth', category: 'truth' },
    { id: 'all-fail', strategy: 'truth', category: 'truth' },
    { id: 'mixed', strategy: 'truth', category: 'truth' },
    { id: 'partial-pass', strategy: 'truth', category: 'truth' }
  ];
  const result = (id, { outcome = 'COMPLETED', pass = false } = {}) => ({
    id,
    debate: { outcome, failures: [] },
    judge: { backend: 'model' },
    quality: { status: 'passed' },
    standard: { passed: pass }
  });
  const runs = [
    { runId: 'run-1', startedAt: 't1', endedAt: 't2', summary: {}, results: [
      result('all-pass', { pass: true }),
      result('all-fail'),
      result('mixed', { pass: true }),
      result('partial-pass', { outcome: 'PARTIAL', pass: true })
    ] },
    { runId: 'run-2', startedAt: 't3', endedAt: 't4', summary: {}, results: [
      result('all-pass', { pass: true }),
      result('all-fail'),
      result('mixed', { pass: false }),
      result('partial-pass', { outcome: 'PARTIAL', pass: true })
    ] }
  ];
  const stats = buildBaselineStats(runs, questions);
  assert.equal(stats.aggregate.stablePass, 2, 'all-pass 和 partial-pass 的评分都稳定');
  assert.equal(stats.aggregate.stableCompletePass, 1, '只有 all-pass 端到端稳定');
  assert.equal(stats.aggregate.stableFail, 1);
  assert.equal(stats.aggregate.fluctuating, 1, 'mixed 是完整执行里的波动');
  assert.equal(stats.aggregate.incomplete, 1, 'partial-pass 归不完整');
});
