/**
 * V2.1 D-03：方案评审辩论的判据。
 *
 * 这一组测的是产品决定，不是模型质量：什么计划值得辩、辩什么、辩完怎么读。
 * 一条底线要能被断言：辩论不改执行语义——辩出「应该写 3 个文件」也不会
 * 让只读授权变成可写。
 *
 * Run with: npm run test:plan-review
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planDebateTopics,
  planReviewQuestion,
  shouldDebatePlan,
  summarizePlanDebate
} from '../out-test/main/engineering/plan-review.js';

function plan(steps, condition = '测试通过') {
  return {
    id: 'p1',
    title: '给 utils 增加一个函数',
    description: '新增 formatBytes 并补测试',
    steps,
    completion: { condition }
  };
}

const readOnlyPlan = plan([
  { id: 's1', tool: 'fs.list', args: { path: '.' } },
  { id: 's2', tool: 'fs.readFile', args: { path: 'src/utils.ts' } }
]);

const writePlan = plan([
  { id: 's1', tool: 'fs.readFile', args: { path: 'src/utils.ts' } },
  { id: 's2', tool: 'fs.writeFile', args: { path: 'src/utils.ts', content: 'x', overwrite: true, expectedHash: 'a'.repeat(64) } },
  { id: 's3', tool: 'test.run', args: { command: 'npm test' } }
]);

test('关闭辩论时不辩，并说得出是设置关的', () => {
  const decision = shouldDebatePlan('off', writePlan);
  assert.equal(decision.debate, false);
  assert.match(decision.reason, /关闭/);
});

test('开启辩论时哪怕两步只读也辩——用户明确要求优先', () => {
  assert.equal(shouldDebatePlan('on', readOnlyPlan).debate, true);
});

test('auto 不辩小的只读计划，但带写入或测试的多步计划要辩', () => {
  assert.equal(shouldDebatePlan('auto', readOnlyPlan).debate, false);
  assert.match(shouldDebatePlan('auto', readOnlyPlan).reason, /只读/);
  assert.equal(shouldDebatePlan(undefined, writePlan).debate, true);
  assert.equal(shouldDebatePlan('auto', plan([
    { id: 's1', tool: 'fs.list', args: { path: '.' } },
    { id: 's2', tool: 'fs.readFile', args: { path: 'a.ts' } },
    { id: 's3', tool: 'fs.readFile', args: { path: 'b.ts' } }
  ])).debate, true);
});

test('辩题指向具体风险：覆盖写、缺验证、步骤过多', () => {
  const topics = planDebateTopics(writePlan);
  assert.ok(topics.some(topic => topic.includes('overwrite')), '覆盖写必须被点名');
  assert.ok(topics.some(topic => topic.includes('验收条件')) === false, '已经有测试时不该拿验收条件凑数');
});

test('有写入没测试时，辩题直接问「怎么证明没改坏」', () => {
  const topics = planDebateTopics(plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'src/a.ts', content: 'x' } }
  ]));
  assert.ok(topics.some(topic => topic.includes('test.run')), topics.join(' / '));
});

test('辩题最多三条，避免把审批拖成一场长会', () => {
  const topics = planDebateTopics(plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'a', content: 'x', overwrite: true, expectedHash: 'b'.repeat(64) } },
    { id: 's2', tool: 'fs.mkdir', args: { path: 'a' } },
    { id: 's3', tool: 'fs.writeFile', args: { path: 'b', content: 'x' } },
    { id: 's4', tool: 'fs.writeFile', args: { path: 'c', content: 'x' } },
    { id: 's5', tool: 'fs.list', args: { path: '.' } }
  ]));
  assert.ok(topics.length <= 3);
});

test('交给辩手的问题里必须能看到每一步和完成条件', () => {
  const question = planReviewQuestion(writePlan);
  assert.match(question, /给 utils 增加一个函数/);
  assert.match(question, /fs\.writeFile/);
  assert.match(question, /测试通过/);
  assert.match(question, /步骤编号/);
});

test('辩论结论取最后一轮立场，失败的成员必须点名', () => {
  const summary = summarizePlanDebate({
    topics: ['覆盖写是否必要'],
    rounds: [
      { index: 1, messages: [{ author: 'a', kind: 'statement', text: '第一轮观点' }] },
      {
        index: 2,
        messages: [{ author: 'a', kind: 'rebuttal', text: '第二轮收敛后的观点' }],
        failures: [{ agentId: 'b', detail: '超时' }]
      }
    ]
  });
  assert.match(summary, /第二轮收敛后的观点/);
  assert.doesNotMatch(summary, /第一轮观点/);
  assert.match(summary, /b（超时）/);
  assert.match(summary, /不代表他们/);
});

test('一场没说话的空辩论不许被当成「评审通过」', () => {
  assert.match(summarizePlanDebate({ rounds: [], topics: [] }), /不能据此判断/);
  assert.match(
    summarizePlanDebate({ rounds: [{ index: 1, messages: [] }], topics: [] }),
    /没有留下发言/
  );
});
