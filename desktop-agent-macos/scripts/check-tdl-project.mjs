/**
 * TDL-P2：事件投影与汇总；无事件不得变 completed。
 * Run: npm run test:tdl-project
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectWorkBreakdownFromEvents,
  seedWorkEventsFromPlan
} from '../out-test/shared/task-decomposition.js';

const workId = 'task-tdl';

test('无计划无 work 事件时是 empty，分数 0/0', () => {
  const view = projectWorkBreakdownFromEvents({ workId, events: [], title: '空' });
  assert.equal(view.source, 'empty');
  assert.equal(view.summary.total, 0);
  assert.equal(view.summary.completed, 0);
});

test('从 plan + step 派生：0/2 → 1/2，当前任务跟随 running', () => {
  const base = [
    {
      type: 'plan.ready',
      at: 1,
      taskId: workId,
      roundId: 'r1',
      plan: {
        planId: 'p1',
        taskId: workId,
        roundId: 'r1',
        title: '两步任务',
        description: '',
        completion: '完成',
        steps: [
          { id: 's1', tool: 'fs.list', args: {}, description: '列目录' },
          { id: 's2', tool: 'fs.stat', args: {}, description: '看文件' }
        ]
      }
    }
  ];
  let view = projectWorkBreakdownFromEvents({ workId, events: base, title: '两步任务' });
  assert.equal(view.source, 'derived-from-plan');
  assert.equal(view.summary.total, 2);
  assert.equal(view.summary.completed, 0);
  assert.equal(view.tasks[0].status, 'ready');
  assert.equal(view.currentTaskId, 'wt-s1');

  view = projectWorkBreakdownFromEvents({
    workId,
    events: [
      ...base,
      { type: 'step.started', at: 2, taskId: workId, stepId: 's1', tool: 'fs.list' }
    ]
  });
  assert.equal(view.tasks[0].status, 'running');
  assert.deepEqual(view.summary.runningIds, ['wt-s1']);

  view = projectWorkBreakdownFromEvents({
    workId,
    events: [
      ...base,
      { type: 'step.started', at: 2, taskId: workId, stepId: 's1', tool: 'fs.list' },
      { type: 'step.completed', at: 3, taskId: workId, stepId: 's1', tool: 'fs.list', result: {} }
    ]
  });
  assert.equal(view.summary.completed, 1);
  assert.equal(view.summary.total, 2);
  assert.equal(view.tasks[0].status, 'completed');
  assert.equal(view.tasks[1].status, 'ready');
  assert.equal(view.currentTaskId, 'wt-s2');
});

test('显式 work.* 优先于 plan 派生', () => {
  const plan = {
    planId: 'p1',
    taskId: workId,
    roundId: 'r1',
    title: '计划标题',
    description: '',
    completion: 'x',
    steps: [{ id: 's1', tool: 'fs.list', args: {} }]
  };
  const seeded = seedWorkEventsFromPlan({ workId, title: '专项分解', plan, at: 10 });
  const view = projectWorkBreakdownFromEvents({
    workId,
    events: [
      { type: 'plan.ready', at: 1, taskId: workId, roundId: 'r1', plan },
      ...seeded
    ]
  });
  assert.equal(view.source, 'work-events');
  assert.equal(view.title, '专项分解');
  assert.equal(view.summary.total, 1);
  assert.equal(view.tasks[0].source, 'work-events');
});

test('模型百分比不会凭空变成 completed：没有完成事件就仍是 0', () => {
  const view = projectWorkBreakdownFromEvents({
    workId,
    events: [
      {
        type: 'plan.ready',
        at: 1,
        taskId: workId,
        roundId: 'r1',
        plan: {
          planId: 'p1',
          taskId: workId,
          roundId: 'r1',
          title: 't',
          description: '',
          completion: 'c',
          steps: [{ id: 's1', tool: 'fs.list', args: {}, description: '一步' }]
        }
      },
      { type: 'log', at: 2, taskId: workId, level: 'info', message: '已完成 100%' }
    ]
  });
  assert.equal(view.summary.completed, 0);
});
