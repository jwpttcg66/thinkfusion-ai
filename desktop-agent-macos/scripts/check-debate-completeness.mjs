/**
 * 答案完整性复核/修订的单测。
 *
 * 钉住三件事：
 * - 复核员只输出缺口，不宣布通过；
 * - 修订员只补缺口，解析失败不伪造修订；
 * - 没有缺口时不调用修订模型。
 *
 * Run with: npm run test:debate-completeness
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewCompleteness, reviseAnswer } from '../out-test/main/debate/completeness.js';

const answer = text => ({
  agentId: 'reviewer',
  text,
  receivedAt: Date.now(),
  attribution: { requestId: 'test', note: 'test' },
  stage: 'initial'
});

const reviewJson = overrides => JSON.stringify({
  hasGap: true,
  missing: [{ dimension: 'boundary', text: '没有说明适用边界', why: '读者会误以为无条件成立' }],
  reason: '缺少边界',
  ...overrides
});

test('复核：有缺口时返回结构化缺口，不宣布通过', async () => {
  const result = await reviewCompleteness({
    question: '这个方案可靠吗？',
    answer: '可靠。',
    ask: async () => answer(reviewJson()),
    agentId: 'reviewer'
  });
  assert.equal(result.backend, 'model');
  assert.equal(result.hasGap, true);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].dimension, 'boundary');
  assert.equal(result.attempts, 1);
});

test('复核：没有缺口时 hasGap=false 且 missing 为空', async () => {
  const result = await reviewCompleteness({
    question: '这个方案可靠吗？',
    answer: '在条件 A 下可靠，条件 B 下不可靠。',
    ask: async () => answer(reviewJson({ hasGap: false, missing: [], reason: '覆盖充分' })),
    agentId: 'reviewer'
  });
  assert.equal(result.hasGap, false);
  assert.deepEqual(result.missing, []);
});

test('复核：第一次非 JSON，第二次合法则采用', async () => {
  let calls = 0;
  const result = await reviewCompleteness({
    question: '这个方案可靠吗？',
    answer: '可靠。',
    ask: async () => {
      calls += 1;
      return calls === 1 ? answer('我觉得还行。') : answer(reviewJson());
    },
    agentId: 'reviewer'
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.backend, 'model');
});

test('复核：两次都不是 JSON 时 unavailable，不伪造缺口', async () => {
  const result = await reviewCompleteness({
    question: '这个方案可靠吗？',
    answer: '可靠。',
    ask: async () => answer('我觉得还行。'),
    agentId: 'reviewer'
  });
  assert.equal(result.backend, 'unavailable');
  assert.equal(result.hasGap, false);
  assert.deepEqual(result.missing, []);
  assert.match(result.fallbackReason, /不是可解析的 JSON/);
});

test('修订：有缺口时返回修订答案和已补充项', async () => {
  const result = await reviseAnswer({
    question: '这个方案可靠吗？',
    answer: '可靠。',
    missing: [{ dimension: 'boundary', text: '没有说明适用边界', why: '读者会误以为无条件成立' }],
    ask: async () => answer(JSON.stringify({
      revisedAnswer: '在条件 A 下可靠，条件 B 下不可靠。',
      addressed: ['补充适用边界'],
      stillMissing: []
    })),
    agentId: 'reviser'
  });
  assert.equal(result.backend, 'model');
  assert.equal(result.revisedAnswer, '在条件 A 下可靠，条件 B 下不可靠。');
  assert.deepEqual(result.addressed, ['补充适用边界']);
  assert.deepEqual(result.stillMissing, []);
});

test('修订：没有缺口时不调用模型，原样返回', async () => {
  let called = false;
  const result = await reviseAnswer({
    question: '这个方案可靠吗？',
    answer: '可靠。',
    missing: [],
    ask: async () => { called = true; return answer('{}'); },
    agentId: 'reviser'
  });
  assert.equal(called, false);
  assert.equal(result.attempts, 0);
  assert.equal(result.revisedAnswer, '可靠。');
});

test('修订：两次都不是 JSON 时 unavailable，原答案不被覆盖', async () => {
  const result = await reviseAnswer({
    question: '这个方案可靠吗？',
    answer: '可靠。',
    missing: [{ dimension: 'boundary', text: '没有说明适用边界', why: '会误以为无条件成立' }],
    ask: async () => answer('我改好了。'),
    agentId: 'reviser'
  });
  assert.equal(result.backend, 'unavailable');
  assert.equal(result.revisedAnswer, null);
  assert.deepEqual(result.stillMissing, ['没有说明适用边界']);
});
