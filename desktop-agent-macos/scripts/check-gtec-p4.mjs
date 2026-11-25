/**
 * GTEC P4：Cycle ↔ WorkTask 绑定。
 * Run: npm run test:gtec-p4
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindWorkTasksToCycle,
  projectCycleTaskBinding,
  tasksForCycle
} from '../out-test/shared/task-decomposition.js';

function task(partial) {
  return {
    workTaskId: 't',
    workId: 'w1',
    dependencies: [],
    acceptanceCriteria: [],
    status: 'ready',
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

test('P4：bindWorkTasksToCycle 只填充空缺 cycleId', () => {
  const bound = bindWorkTasksToCycle([
    task({ workTaskId: 'a' }),
    task({ workTaskId: 'b', cycleId: 'keep' })
  ], 'cycle-1');
  assert.equal(bound.find(t => t.workTaskId === 'a')?.cycleId, 'cycle-1');
  assert.equal(bound.find(t => t.workTaskId === 'b')?.cycleId, 'keep');
});

test('P4：tasksForCycle 过滤', () => {
  const list = [
    task({ workTaskId: 'a', cycleId: 'c1' }),
    task({ workTaskId: 'b', cycleId: 'c2' })
  ];
  assert.deepEqual(tasksForCycle(list, 'c1').map(t => t.workTaskId), ['a']);
});

test('P4：事件投影绑定', () => {
  const events = [
    {
      type: 'work.task.upserted', at: 1, taskId: 'w1', workId: 'w1',
      task: task({ workTaskId: 'a', cycleId: 'cyc-9' })
    },
    {
      type: 'cycle.snapshot', at: 2, taskId: 'w1',
      cycleId: 'cyc-9', cycleNumber: 1, currentStage: 'planning',
      conclusionType: 'unresolved', nextAction: 'continue', debateSkipped: true,
      decision: 'observe',
      budget: { roundCount: 1, maxIterations: 3, nearLimit: false }
    }
  ];
  const binding = projectCycleTaskBinding({ workId: 'w1', events });
  assert.equal(binding.cycleId, 'cyc-9');
  assert.deepEqual(binding.workTaskIds, ['a']);
});
