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
  planDebateBrief,
  planDebateTopics,
  planReviewBudget,
  planReviewQuestion,
  planReviewRounds,
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

test('门禁：改文件且没有任何能观察结果的动作，点名「不会标已验证」', () => {
  const gate = checkPlanCapabilities(plan([
    { id: 's1', tool: 'fs.edit', args: { path: 'src/a.ts', oldString: 'a', newString: 'b' } }
  ]));
  assert.equal(gate.family, 'code.change');
  assert.equal(gate.missing.length, 1);
  assert.match(gate.missing[0], /不会标已验证/);
  assert.doesNotMatch(gate.missing[0], /test\.run/, '不该把某一种工具写成唯一验证手段');
});

test('门禁：改文件且用 shell.run 真编译 + 断言，不拦', () => {
  const gate = checkPlanCapabilities(plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'src/App.java', content: 'x' } },
    { id: 's2', tool: 'shell.run', args: { command: 'javac -d out src/App.java && out=$(java -cp out App) && [ "$out" = "hello" ]' } }
  ]));
  assert.equal(gate.family, 'code.change');
  assert.deepEqual(gate.missing, []);
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

test('评审 brief 必须写出表态对象、表态目标，以及每条议题的决策目标', () => {
  const brief = planDebateBrief(plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'main.go', content: 'package main' } },
    { id: 's2', tool: 'shell.run', args: { command: 'go run main.go' } },
    { id: 's3', tool: 'fs.readFile', args: { path: 'main.go' } },
    { id: 's4', tool: 'code.run', args: { language: 'go', code: 'package main' } }
  ]));
  assert.match(brief.expressTarget, /工程计划|步骤|系统动作|完成条件/);
  assert.match(brief.expressGoal, /可审批|步骤编号|保留|合并|砍掉/);
  assert.ok(brief.topics.length >= 1);
  for (const topic of brief.topics) {
    assert.ok(topic.text.trim().length > 0, '议题原文不能空');
    assert.ok(topic.goal.trim().length > 0, '每条议题必须有决策目标');
  }
  assert.deepEqual(
    planDebateTopics(plan([
      { id: 's1', tool: 'fs.writeFile', args: { path: 'main.go', content: 'x' } },
      { id: 's2', tool: 'shell.run', args: { command: 'go run main.go' } },
      { id: 's3', tool: 'fs.readFile', args: { path: 'main.go' } },
      { id: 's4', tool: 'code.run', args: { language: 'go', code: 'x' } }
    ])),
    brief.topics.map(item => item.text),
    'planDebateTopics 必须与 brief 议题原文同源'
  );
});

test('有写入、没有任何观察手段时，辩题要求「按任务设计验证方式」，不点名工具', () => {
  const topics = planDebateTopics(plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'src/a.ts', content: 'x' } }
  ]));
  assert.ok(topics.some(topic => topic.includes('设计验证方式')), topics.join(' / '));
  assert.ok(topics.every(topic => !topic.includes('test.run')), '不该把 test.run 当成唯一答案');
});

test('已经写了 javac + 断言，就不再追着问验证方式', () => {
  const topics = planDebateTopics(plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'App.java', content: 'x' } },
    { id: 's2', tool: 'shell.run', args: { command: 'javac -d out App.java && [ "$(java -cp out App)" = "hello" ]' } }
  ]));
  assert.ok(topics.every(topic => !topic.includes('怎么证明没改坏')), topics.join(' / '));
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

// 轮次不再是全局写死 2：2 轮只有「表态 + 质疑」，被质疑方没机会回应。
// 这里锁住「按计划规模定轮次」，以及预算必须跟着轮次走。
test('轮次由分歧收敛决定：只给最多 3 轮的上限', () => {
  const verdict = planReviewRounds(writePlan, 1);
  assert.equal(verdict.rounds, 3);
  assert.match(verdict.reason, /最多 3 轮/);
  assert.match(verdict.reason, /按分歧收敛/);
});

test('设计文档给 3 轮：观点编号评审，质疑需要回应才算收口', () => {
  const design = {
    ...plan([{ id: 's1', tool: 'fs.readFile', args: { path: 'a.md' } }]),
    kind: 'design',
    design: { document: '设计正文', viewpoints: ['观点一', '观点二'] }
  };
  const verdict = planReviewRounds(design, 2);
  assert.equal(verdict.rounds, 3);
  assert.match(verdict.reason, /设计文档/);
});

test('简单计划和复杂计划都只给上限，不写死实际轮次', () => {
  assert.equal(planReviewRounds(writePlan, 2).rounds, 3);
  const twoSteps = plan([
    { id: 's1', tool: 'fs.readFile', args: { path: 'a.ts' } },
    { id: 's2', tool: 'fs.edit', args: { path: 'a.ts', oldString: 'a', newString: 'b' } }
  ]);
  const verdict = planReviewRounds(twoSteps, 2);
  assert.equal(verdict.rounds, 3);
  assert.match(verdict.reason, /最多 3 轮|按分歧收敛/);
});

test('3 位以上评审给 3 轮：多方分歧要有人接着回应', () => {
  const twoSteps = plan([
    { id: 's1', tool: 'fs.readFile', args: { path: 'a.ts' } },
    { id: 's2', tool: 'fs.readFile', args: { path: 'b.ts' } }
  ]);
  const verdict = planReviewRounds(twoSteps, 3);
  assert.equal(verdict.rounds, 3);
  assert.match(verdict.reason, /3 位评审/);
});

test('预算跟着轮次走：3 轮不能还停在 180 秒，否则第三轮被直接砍掉', () => {
  const two = planReviewBudget(2);
  const three = planReviewBudget(3);
  assert.equal(two.totalMs, 180_000);
  assert.equal(three.totalMs, 300_000);
  // 等待必须长于预算：引擎到点会收尾，卡在同一秒会被误判成超时。
  assert.ok(two.waitMs > two.totalMs);
  assert.ok(three.waitMs > three.totalMs);
  assert.equal(three.stageTimeoutMs, 120_000);
});

test('只有质疑轮时，结论如实标注「没有回应轮」，不把质疑当收敛意见', () => {
  const summary = summarizePlanDebate({
    topics: ['改完怎么验证'],
    rounds: [
      { index: 0, phase: 'analysis', messages: [{ author: 'a', kind: 'statement', text: '这个计划可行' }] },
      { index: 1, phase: 'challenge', messages: [{ author: 'b', kind: 'rebuttal', text: '没有验证步骤，不能算完成' }] }
    ]
  });
  assert.match(summary, /没有回应轮/);
  assert.match(summary, /被评审方尚未答复/);
  assert.match(summary, /没有验证步骤/);
  assert.doesNotMatch(summary, /这个计划可行/, '不该把第一轮表态当结论');
});

test('有回应轮时取回应轮，而不是把中间的质疑当结论', () => {
  const summary = summarizePlanDebate({
    topics: ['改完怎么验证'],
    rounds: [
      { index: 0, phase: 'analysis', messages: [{ author: 'a', kind: 'statement', text: '第一轮表态' }] },
      { index: 1, phase: 'challenge', messages: [{ author: 'b', kind: 'rebuttal', text: '中间质疑' }] },
      { index: 2, phase: 'response', messages: [{ author: 'a', kind: 'concession', text: '补上运行断言后接受' }] }
    ]
  });
  assert.match(summary, /补上运行断言后接受/);
  assert.doesNotMatch(summary, /中间质疑/, '质疑不是结论');
  assert.doesNotMatch(summary, /没有回应轮/);
});

test('老记录没有 phase 字段：按 index 兜底仍能认出回应轮', () => {
  const summary = summarizePlanDebate({
    topics: [],
    rounds: [
      { index: 0, messages: [{ author: 'a', kind: 'statement', text: '表态' }] },
      { index: 1, messages: [{ author: 'b', kind: 'rebuttal', text: '质疑' }] },
      { index: 2, messages: [{ author: 'a', kind: 'concession', text: '老记录的回应' }] }
    ]
  });
  assert.match(summary, /老记录的回应/);
});
