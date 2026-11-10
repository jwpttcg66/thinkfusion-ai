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
  checkPlanCapabilities,
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

test('门禁：改文件没跑测试，点名「不会标已验证」', () => {
  const gate = checkPlanCapabilities(plan([
    { id: 's1', tool: 'fs.edit', args: { path: 'src/a.ts', oldString: 'a', newString: 'b' } }
  ]));
  assert.equal(gate.family, 'code.change');
  assert.equal(gate.missing.length, 1);
  assert.match(gate.missing[0], /test\.run/);
});

test('门禁：改文件且跑测试就通过', () => {
  const gate = checkPlanCapabilities(writePlan);
  assert.equal(gate.family, 'code.change');
  assert.deepEqual(gate.missing, []);
});

test('门禁：改界面没有截屏或构建检查要提醒', () => {
  const gate = checkPlanCapabilities(plan([
    { id: 's1', tool: 'fs.edit', args: { path: 'src/renderer/src/App.tsx', oldString: 'a', newString: 'b' } }
  ]));
  assert.ok(gate.missing.some(item => item.includes('界面')));
});

test('门禁：SQL 没有 LIMIT 要提醒，带 LIMIT 或聚合查询放行', () => {
  const unbounded = checkPlanCapabilities(plan([
    { id: 's1', tool: 'sqlite.query', args: { path: 'db.sqlite', sql: 'SELECT * FROM users' } }
  ]));
  assert.equal(unbounded.family, 'data');
  assert.ok(unbounded.missing.some(item => item.includes('LIMIT')));

  for (const sql of ['SELECT * FROM users LIMIT 20', 'SELECT count(*) FROM users', 'PRAGMA table_info(users)']) {
    const gate = checkPlanCapabilities(plan([{ id: 's1', tool: 'sqlite.query', args: { path: 'db.sqlite', sql } }]));
    assert.deepEqual(gate.missing, [], sql);
  }
});

test('门禁：只读计划不拦，主族是 code.read', () => {
  const gate = checkPlanCapabilities(readOnlyPlan);
  assert.equal(gate.family, 'code.read');
  assert.deepEqual(gate.missing, []);
});

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
