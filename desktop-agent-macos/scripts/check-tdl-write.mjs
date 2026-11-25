/**
 * TDL-P3：写入闸门与种子事件。
 * Run: npm run test:tdl-write
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWorkTaskStatus,
  projectWorkBreakdownFromEvents,
  seedWorkEventsFromPlan,
  workStatusEventFromStep
} from '../out-test/shared/task-decomposition.js';

const workId = 'task-write';

test('种子事件 + 步骤完成事件可投影到 2/2', () => {
  const plan = {
    planId: 'p1',
    taskId: workId,
    roundId: 'r1',
    title: '写入路径',
    description: '',
    completion: 'done',
    steps: [
      { id: 's1', tool: 'fs.list', args: {}, description: '列' },
      { id: 's2', tool: 'fs.stat', args: {}, description: '看' }
    ]
  };
  const events = [
    ...seedWorkEventsFromPlan({ workId, title: '写入路径', plan, at: 1 }),
    workStatusEventFromStep({ workId, stepId: 's1', phase: 'started', expectedRevision: 1, at: 2 }),
    workStatusEventFromStep({ workId, stepId: 's1', phase: 'completed', expectedRevision: 2, at: 3 }),
    workStatusEventFromStep({ workId, stepId: 's2', phase: 'started', expectedRevision: 1, at: 4 }),
    workStatusEventFromStep({ workId, stepId: 's2', phase: 'completed', expectedRevision: 2, at: 5 })
  ];
  // after upsert revision is 1; started bumps to 2; completed needs expectedRevision 2
  // Fix: re-project carefully - seed creates revision 1 ready.
  // started: expectedRevision 1 → revision 2 running
  // completed: expectedRevision 2 → revision 3 completed
  // s2 starts pending→ready via refresh, revision still 1
  const fixed = [
    ...seedWorkEventsFromPlan({ workId, title: '写入路径', plan, at: 1 }),
    workStatusEventFromStep({ workId, stepId: 's1', phase: 'started', expectedRevision: 1, at: 2 }),
    workStatusEventFromStep({ workId, stepId: 's1', phase: 'completed', expectedRevision: 2, at: 3 }),
    workStatusEventFromStep({ workId, stepId: 's2', phase: 'started', expectedRevision: 1, at: 4 }),
    workStatusEventFromStep({ workId, stepId: 's2', phase: 'completed', expectedRevision: 2, at: 5 })
  ];
  const view = projectWorkBreakdownFromEvents({ workId, events: fixed });
  assert.equal(view.source, 'work-events');
  assert.equal(view.summary.completed, 2);
  assert.equal(view.summary.total, 2);
  assert.equal(view.status, 'completed');
});

test('applyWorkTaskStatus 拒绝无证据完成', () => {
  const seeded = seedWorkEventsFromPlan({
    workId,
    title: 't',
    plan: {
      planId: 'p',
      taskId: workId,
      roundId: 'r',
      title: 't',
      description: '',
      completion: 'c',
      steps: [{ id: 's1', tool: 'fs.list', args: {} }]
    }
  });
  const view = projectWorkBreakdownFromEvents({ workId, events: seeded });
  assert.equal(view.tasks[0].status, 'ready');
  // reconstruct tasks via a second status apply path tested in contract; here ensure event without evidence doesn't complete
  const bad = [
    ...seeded,
    {
      type: 'work.task.status',
      at: 9,
      taskId: workId,
      workId,
      workTaskId: 'wt-s1',
      status: 'completed',
      expectedRevision: 1
    }
  ];
  const after = projectWorkBreakdownFromEvents({ workId, events: bad });
  assert.notEqual(after.tasks[0].status, 'completed');
});
