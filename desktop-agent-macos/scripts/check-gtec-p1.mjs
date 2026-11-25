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
