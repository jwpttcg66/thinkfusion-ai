/**
 * GTEC P1：Goal 绑定 + TDL 四级树校验 / 依赖环 / skipped。
 * Run: npm run test:gtec-p1
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGoalVersionBump } from '../out-test/shared/goal-driven-cycle.js';
import {
  hasDependencyCycle,
  projectWorkBreakdownFromEvents,
  seedWorkEventsFromPlan,
  validateWorkTaskTree
} from '../out-test/shared/task-decomposition.js';

function baseTask(partial) {
  return {
    workTaskId: 'x',
    workId: 'w1',
    dependencies: [],
    acceptanceCriteria: [],
    status: 'pending',
    complexity: 'low',
    collaborationPolicy: { debate: 'off', review: 'auto' },
    artifacts: [],
    evidence: [],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    level: 3,
    ...partial
  };
}

test('P1：依赖环可被检出', () => {
  const tasks = [
    baseTask({ workTaskId: 'a', dependencies: ['b'], level: 2 }),
    baseTask({ workTaskId: 'b', dependencies: ['a'], level: 2 })
  ];
  assert.equal(hasDependencyCycle(tasks), true);
  assert.equal(hasDependencyCycle([
    baseTask({ workTaskId: 'a', dependencies: [], level: 2 }),
    baseTask({ workTaskId: 'b', dependencies: ['a'], level: 2 })
  ]), false);
});

test('P1：validateWorkTaskTree 拒绝悬空 parent 与环', () => {
  const dangling = validateWorkTaskTree([
    baseTask({ workTaskId: 'child', parentTaskId: 'missing', level: 3 })
  ]);
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some(e => /parent|悬空|不存在/.test(e)));

  const cyclic = validateWorkTaskTree([
    baseTask({ workTaskId: 'a', dependencies: ['b'], level: 2 }),
    baseTask({ workTaskId: 'b', dependencies: ['a'], level: 2 })
  ]);
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.errors.some(e => /环|cycle/i.test(e)));
});

test('P1：种子含 L0/L1/L3 且 goalId/goalVersion 一致', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'work-abc',
    title: 'demo',
    goalId: 'goal:work-abc',
    goalVersion: 2,
    plan: {
      planId: 'p1',
      taskId: 'work-abc',
      roundId: 'r1',
      title: 'demo',
      description: 'd',
      completion: 'c',
      steps: [
        { id: 's1', tool: 'fs.list', args: {}, description: 'list' },
        { id: 's2', tool: 'fs.readFile', args: {}, description: 'read' }
      ]
    },
    at: 10
  });
  const upserts = events.filter(e => e.type === 'work.task.upserted').map(e => e.task);
  const levels = new Set(upserts.map(t => t.level));
  assert.ok(levels.has(0), '缺 L0');
  assert.ok(levels.has(1), '缺 L1');
  assert.ok(levels.has(3), '缺 L3');
  assert.ok(upserts.every(t => t.goalId === 'goal:work-abc'));
  assert.ok(upserts.every(t => t.goalVersion === 2));
  const view = projectWorkBreakdownFromEvents({ workId: 'work-abc', events, title: 'demo' });
  assert.ok(view.summary.total >= 2);
});

test('P1：skipped 不算完成；completed 无验收不算 acceptanceMet', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'w-skip',
    title: 'skip',
    plan: {
      planId: 'p',
      taskId: 'w-skip',
      roundId: 'r',
      title: 'skip',
      description: 'd',
      completion: 'c',
      steps: [{ id: 's1', tool: 'fs.list', args: {} }]
    },
    at: 1
  });
  const leaf = events.find(e => e.type === 'work.task.upserted' && e.task.level === 3);
  assert.ok(leaf);
  events.push({
    type: 'work.task.status',
    at: 2,
    taskId: 'w-skip',
    workId: 'w-skip',
    workTaskId: leaf.task.workTaskId,
    status: 'skipped',
    expectedRevision: 1,
    blockedReason: '用户取消该步'
  });
  const view = projectWorkBreakdownFromEvents({ workId: 'w-skip', events, title: 'skip' });
  const row = view.tasks.find(t => t.workTaskId === leaf.task.workTaskId);
  assert.equal(row?.status, 'skipped');
  assert.equal(row?.acceptanceMet, false);
  assert.equal(view.summary.completed, 0);
});

test('P1：目标实质变更才 bump version', () => {
  assert.equal(applyGoalVersionBump(1, 'clarify'), 1);
  assert.equal(applyGoalVersionBump(1, 'optimize'), 1);
  assert.equal(applyGoalVersionBump(1, 'change'), 2);
});

test('P1：decomposition 生成 L2，L3 挂到 L2，进度只算叶子', async () => {
  const { progressRatioFromRows } = await import('../out-test/shared/task-decomposition.js');
  const events = seedWorkEventsFromPlan({
    workId: 'w2',
    title: '两级子任务',
    plan: {
      planId: 'p2',
      title: '两级子任务',
      steps: [
        { id: 's1', tool: 'fs.readFile', args: { path: 'a.ts' }, description: '读 a' },
        { id: 's2', tool: 'fs.writeFile', args: { path: 'a.ts' }, description: '写 a' },
        { id: 's3', tool: 'code.run', args: {}, description: '验证' }
      ],
      decomposition: [
        { id: 't1', title: '改 a.ts', acceptanceCriteria: ['a.ts 编译通过'], stepIds: ['s1', 's2'] },
        { id: 't2', title: '验证', acceptanceCriteria: ['测试通过'], stepIds: ['s3'] }
      ]
    },
    at: 1
  });
  const view = projectWorkBreakdownFromEvents({ workId: 'w2', events, title: '两级子任务' });
  const byId = new Map(view.tasks.map(item => [item.workTaskId, item]));
  const t1 = byId.get('wt-task-t1');
  assert.equal(t1?.level, 2);
  assert.equal(t1?.parentTaskId?.startsWith('wt-group-'), true);
  assert.equal(byId.get('wt-s1')?.parentTaskId, 'wt-task-t1');
  assert.equal(byId.get('wt-s2')?.parentTaskId, 'wt-task-t1');
  assert.equal(byId.get('wt-s3')?.parentTaskId, 'wt-task-t2');
  // 进度分母只算 3 个叶子，不算 L2/L1/L0
  assert.equal(view.summary.total, 3);
  // DFS：父在前、子紧随
  const order = view.tasks.map(item => item.workTaskId);
  assert.ok(order.indexOf('wt-task-t1') < order.indexOf('wt-s1'));
  assert.ok(order.indexOf('wt-s1') < order.indexOf('wt-s2'));
  // L2 不伪装成「当前执行」
  assert.notEqual(view.currentTaskId, 'wt-task-t1');
  assert.equal(progressRatioFromRows(view.tasks), 0);
});

test('P1：计划重出时旧分解作废，分母只算新树', () => {
  const first = seedWorkEventsFromPlan({
    workId: 'w3',
    title: '旧计划',
    plan: {
      planId: 'p-old',
      title: '旧计划',
      steps: [
        { id: 's1', tool: 'fs.readFile', args: { path: 'a.ts' } },
        { id: 's2', tool: 'fs.writeFile', args: { path: 'a.ts' } }
      ]
    },
    at: 1
  });
  const impacted = first
    .filter(event => event.type === 'work.task.upserted')
    .map(event => event.task.workTaskId);
  const second = seedWorkEventsFromPlan({
    workId: 'w3',
    title: '新计划',
    plan: { planId: 'p-new', title: '新计划', steps: [{ id: 's9', tool: 'code.run', args: {} }] },
    at: 20
  });
  const view = projectWorkBreakdownFromEvents({
    workId: 'w3',
    events: [
      ...first,
      { type: 'work.breakdown.replanned', at: 10, taskId: 'w3', workId: 'w3', impactedIds: impacted },
      ...second
    ],
    title: 'w3'
  });
  const oldTask = view.tasks.find(item => item.workTaskId === 'wt-s1');
  assert.equal(oldTask?.status, 'cancelled');
  // 被作废的旧步骤不占分母，只剩新计划的那一步
  assert.equal(view.summary.total, 1);
});
