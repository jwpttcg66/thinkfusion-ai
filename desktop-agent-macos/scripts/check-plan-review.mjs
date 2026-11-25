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
  planDecompositionWarning,
  planDebateBriefFromSummary,
  planDebateTopics,
  planReviewBudget,
  planReviewQuestion,
  planReviewRounds,
  shouldDebatePlan,
  summarizePlanDebate,
  topicsFromLeadSummary
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

test('off 关闭；on 强制五段；auto 对 L0 只读跳过、对写入才走五段', () => {
  assert.equal(shouldDebatePlan('off', writePlan).debate, false);
  assert.equal(shouldDebatePlan('on', readOnlyPlan).debate, true);
  assert.equal(shouldDebatePlan('auto', readOnlyPlan).debate, false);
  assert.match(shouldDebatePlan('auto', readOnlyPlan).reason ?? '', /L0|跳过/);
  assert.equal(shouldDebatePlan('auto', writePlan).debate, true);
  assert.match(shouldDebatePlan('auto', writePlan).reason ?? '', /L1|方案评审/);
  // 无五段原文时，绝不从计划结构编造议题。
  assert.deepEqual(planDebateTopics(writePlan), []);
});

test('议题只从主导五段【辩题】解析，与知识问答一致', () => {
  const summary = [
    '【结论】计划可以完成 hello 输出。',
    '【一致】需要写文件并运行。',
    '【分歧】是否先跑测试。',
    '【存疑】没有。',
    '【辩题】',
    '1. 覆盖 utils 是否必要？',
    '2. 测试命令是否够验？'
  ].join('\n');
  assert.deepEqual(topicsFromLeadSummary(summary), [
    '覆盖 utils 是否必要？',
    '测试命令是否够验？'
  ]);
  const brief = planDebateBriefFromSummary(writePlan, summary);
  assert.equal(brief.source, 'model');
  assert.equal(brief.leadSummary, summary);
  assert.equal(brief.topics.length, 2);
  assert.match(brief.expressTarget, /五段结论中的议题/);
});

test('五段写「无」辩题：不编造辩论', () => {
  const summary = [
    '【结论】计划足够。',
    '【一致】步骤清楚。',
    '【分歧】没有。',
    '【存疑】没有。',
    '【辩题】无'
  ].join('\n');
  assert.deepEqual(topicsFromLeadSummary(summary), []);
  const brief = planDebateBriefFromSummary(writePlan, summary);
  assert.equal(brief.source, 'none');
  assert.equal(brief.topics.length, 0);
});

test('多步含 shell：不按结构套「步骤拆分/系统动作」模板', () => {
  const big = plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'A.java', content: 'x' } },
    { id: 's2', tool: 'shell.run', args: { command: 'javac A.java' } },
    { id: 's3', tool: 'shell.run', args: { command: 'java A' } },
    { id: 's4', tool: 'fs.readFile', args: { path: 'A.java' } },
    { id: 's5', tool: 'code.run', args: { language: 'java', code: 'class A {}' } }
  ]);
  assert.deepEqual(planDebateTopics(big), []);
});

test('交给辩手的材料只有计划数据，没有评审话术', () => {
  const question = planReviewQuestion(writePlan);
  assert.match(question, /给 utils 增加一个函数/);
  assert.match(question, /fs\.writeFile/);
  assert.match(question, /测试通过/);
  assert.doesNotMatch(question, /请判断/);
  assert.doesNotMatch(question, /步骤编号/);
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
test('轮次按等级收紧：L1 写入默认最多 1 轮', () => {
  const verdict = planReviewRounds(writePlan, 1);
  assert.equal(verdict.rounds, 1);
  assert.equal(verdict.risk, 'L1');
  assert.match(verdict.reason, /最多 1 轮/);
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
  assert.equal(verdict.risk, 'L3');
  assert.match(verdict.reason, /设计文档|L3/);
});

test('简单只读 L0 上限 1；缺判据写入升到 L2 上限 2', () => {
  assert.equal(planReviewRounds(readOnlyPlan, 1).rounds, 1);
  assert.equal(planReviewRounds(readOnlyPlan, 1).risk, 'L0');
  // 写入但无观察动作 → 缺判据 → L2
  const bareWrite = plan([
    { id: 's1', tool: 'fs.writeFile', args: { path: 'a.ts', content: 'x' } }
  ]);
  const verdict = planReviewRounds(bareWrite, 1);
  assert.equal(verdict.risk, 'L2');
  assert.equal(verdict.rounds, 2);
});

test('多方评审可在等级内多一轮，但封顶 3', () => {
  const twoSteps = plan([
    { id: 's1', tool: 'fs.readFile', args: { path: 'a.ts' } },
    { id: 's2', tool: 'fs.readFile', args: { path: 'b.ts' } }
  ]);
  // L0 只读：即使 3 人也不抬轮次（auto 本就会跳过）
  assert.equal(planReviewRounds(twoSteps, 3).rounds, 1);
  const design = {
    ...plan([{ id: 's1', tool: 'fs.readFile', args: { path: 'a.md' } }]),
    kind: 'design',
    design: { document: '设计正文', viewpoints: ['观点一'] }
  };
  assert.equal(planReviewRounds(design, 3).rounds, 3);
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

test('多写入目标但没有 decomposition：可见提示，不是硬失败', () => {
  const base = {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 't1',
    roundId: 'r1',
    title: '两处改动',
    description: '说明',
    kind: 'implementation',
    steps: [
      { id: 's1', tool: 'fs.writeFile', args: { path: 'a.txt', content: 'a' } },
      { id: 's2', tool: 'fs.writeFile', args: { path: 'b.txt', content: 'b' } }
    ],
    completion: { condition: '两个文件都在' }
  };
  assert.match(planDecompositionWarning(base) ?? '', /没有 decomposition/);
  assert.equal(
    planDecompositionWarning({
      ...base,
      decomposition: [{ id: 't1', title: '创建 a', stepIds: ['s1'] }, { id: 't2', title: '创建 b', stepIds: ['s2'] }]
    }),
    null
  );
  assert.equal(
    planDecompositionWarning({ ...base, steps: [{ id: 's1', tool: 'fs.writeFile', args: { path: 'a.txt', content: 'a' } }] }),
    null
  );
});
