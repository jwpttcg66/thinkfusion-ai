/**
 * V1 标准答案评分器的单测。
 *
 * 钉住的是封顶规则：缺 must、major 错误、CONTEXTUAL 没边界、分类不一致，
 * 都不能靠模型给高分蒙过去；解析失败必须标 unavailable，不能伪造分数。
 *
 * Run with: npm run test:debate-rubric
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessStandardAnswer } from '../out-test/main/debate/standard-rubric.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const standard = JSON.parse(fs.readFileSync(path.join(here, 'regression', 'debate-standard-answers-v1.json'), 'utf8'));
const byId = new Map(standard.questions.map(item => [item.id, item]));

const answer = text => ({
  agentId: 'rubric-judge',
  text,
  receivedAt: Date.now(),
  attribution: { requestId: 'test', note: 'test' },
  stage: 'initial'
});

const respond = (payload, agentId = 'rubric-judge') => async (id, task) => {
  assert.equal(id, agentId);
  assert.ok(task.system.some(line => line.includes('只输出一个 JSON 对象')));
  assert.match(task.question, /候选回答/);
  return answer(JSON.stringify(payload));
};

function payload(overrides = {}) {
  return {
    questionType: 'FACT',
    matchedClaims: ['c1', 'c2', 'c3', 'c4'],
    missingClaims: [],
    wrongClaims: [],
    boundaryCovered: true,
    score: 92,
    reason: '覆盖标准事实',
    ...overrides
  };
}

test('覆盖全部必答主张：通过', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false，原因是 IEEE 754 浮点精度，实际约 0.30000000000000004。',
    ask: respond(payload()),
    agentId: 'rubric-judge'
  });
  assert.equal(result.backend, 'model');
  assert.equal(result.attempts, 1);
  assert.equal(result.score, 100, '全部 must 覆盖时，门槛分由代码算为 100');
  assert.equal(result.modelScore, 92);
  assert.equal(result.classificationMatch, true);
  assert.deepEqual(result.missingClaims, []);
  assert.equal(result.passed, true);
});

test('模型给 1 分但必须项全覆盖：门槛分仍由代码算，不跟异常低分', async () => {
  const item = byId.get('tcp-udp');
  const result = await assessStandardAnswer({
    item,
    answerText: 'TCP 是可靠有序字节流，不保留消息边界；UDP 是无连接数据报，不保证送达和顺序。',
    ask: respond(payload({
      questionType: 'FACT',
      matchedClaims: ['c1', 'c2', 'c3', 'c4'],
      boundaryCovered: true,
      modelScore: 1,
      score: 1
    })),
    agentId: 'rubric-judge'
  });
  assert.equal(result.modelScore, 1);
  assert.equal(result.score, 100);
  assert.equal(result.passed, true);
});

test('缺 must 主张：最高 69，不通过', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false。',
    ask: respond(payload({ missingClaims: ['c2'], score: 95 })),
    agentId: 'rubric-judge'
  });
  assert.equal(result.score, 69);
  assert.equal(result.modelScore, 95);
  assert.deepEqual(result.missingClaims, ['c2']);
  assert.equal(result.passed, false);
});

test('重大错误主张：最高 39，不通过', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '这是 JavaScript 特有的 bug。',
    ask: respond(payload({ wrongClaims: ['这是 JavaScript 特有的 bug。'], score: 95 })),
    agentId: 'rubric-judge'
  });
  assert.equal(result.score, 39);
  assert.deepEqual(result.wrongClaims, ['这是 JavaScript 特有的 bug。']);
  assert.equal(result.passed, false);
});

test('标准外错误主张默认 minor，不按 major 封顶', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false，原因是浮点精度。',
    ask: respond(payload({ wrongClaims: ['标准里没有的某句话'], score: 95 })),
    agentId: 'rubric-judge'
  });
  assert.equal(result.score, 95);
  assert.deepEqual(result.wrongClaims, ['标准里没有的某句话']);
  assert.equal(result.passed, true);
});

test('CONTEXTUAL 没给边界：最高 65，不通过', async () => {
  const item = byId.get('http-methods');
  const result = await assessStandardAnswer({
    item,
    answerText: 'PUT 幂等，POST 不幂等。',
    ask: respond(payload({
      questionType: 'CONTEXTUAL',
      matchedClaims: ['c1', 'c2', 'c3', 'c4', 'c5'],
      boundaryCovered: false,
      score: 95
    })),
    agentId: 'rubric-judge'
  });
  assert.equal(result.score, 65);
  assert.equal(result.boundaryCovered, false);
  assert.equal(result.passed, false);
});

test('分类不一致：最高 60，不通过', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false。',
    ask: respond(payload({ questionType: 'CONTEXTUAL', score: 95 })),
    agentId: 'rubric-judge'
  });
  assert.equal(result.classificationMatch, false);
  assert.equal(result.score, 60);
  assert.equal(result.passed, false);
});

test('第一次不是 JSON，第二次合法：重试一次后采用', async () => {
  const item = byId.get('float-equality');
  let calls = 0;
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false。',
    ask: async () => {
      calls += 1;
      return calls === 1
        ? answer('我先分析一下，这个回答不错。')
        : answer(JSON.stringify(payload()));
    },
    agentId: 'rubric-judge'
  });
  assert.equal(calls, 2);
  assert.equal(result.backend, 'model');
  assert.equal(result.attempts, 2);
  assert.equal(result.passed, true);
});

test('模型输出不是 JSON：重试后仍失败，unavailable，不伪造分数', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false。',
    ask: async () => answer('我认为这个回答不错。'),
    agentId: 'rubric-judge'
  });
  assert.equal(result.backend, 'unavailable');
  assert.equal(result.score, null);
  assert.equal(result.modelScore, null);
  assert.equal(result.attempts, 2);
  assert.equal(result.passed, false);
  assert.match(result.fallbackReason, /不是可解析的 JSON/);
});

test('评分模型调用失败：unavailable，不伪造分数', async () => {
  const item = byId.get('float-equality');
  const result = await assessStandardAnswer({
    item,
    answerText: '结果是 false。',
    ask: async () => { throw new Error('模型不可用'); },
    agentId: 'rubric-judge'
  });
  assert.equal(result.backend, 'unavailable');
  assert.equal(result.passed, false);
  assert.match(result.fallbackReason, /模型不可用/);
});
