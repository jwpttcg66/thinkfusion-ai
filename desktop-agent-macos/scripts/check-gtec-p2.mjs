/**
 * GTEC P2：真实加权进度、分母动态、无时间漂移。
 * Run: npm run test:gtec-p2
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeWorkProgress } from '../out-test/shared/task-decomposition.js';

function task(partial) {
  return {
    workTaskId: 't',
    workId: 'w',
    dependencies: [],
    acceptanceCriteria: ['a'],
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

test('P2：等权叶子 1/2 → 0.5', () => {
  const progress = computeWorkProgress([
    task({ workTaskId: 'a', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }], parentTaskId: 'g' }),
    task({ workTaskId: 'b', status: 'ready', parentTaskId: 'g' }),
    task({ workTaskId: 'g', level: 1, status: 'ready' })
  ]);
  assert.equal(progress.total, 2);
  assert.equal(progress.completed, 1);
  assert.equal(progress.ratio, 0.5);
});

test('P2：high_risk 权重更大，只完成 low 时 ratio < 0.5', () => {
  const progress = computeWorkProgress([
    task({ workTaskId: 'easy', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }], complexity: 'low' }),
    task({ workTaskId: 'hard', status: 'ready', complexity: 'high_risk' })
  ]);
  assert.ok(progress.ratio < 0.5, `ratio=${progress.ratio}`);
  assert.ok(progress.ratio > 0);
});

test('P2：新增未完成叶子后分母变大、完成率下降', () => {
  const before = computeWorkProgress([
    task({ workTaskId: 'a', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }] })
  ]);
  const after = computeWorkProgress([
    task({ workTaskId: 'a', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }] }),
    task({ workTaskId: 'b', status: 'pending' })
  ]);
  assert.equal(before.ratio, 1);
  assert.equal(after.total, 2);
  assert.ok(after.ratio < before.ratio);
});

test('P2：blocked 计入 total 但不算 completed；skipped 不占分母', () => {
  const progress = computeWorkProgress([
    task({ workTaskId: 'a', status: 'blocked', blockedReason: '等待' }),
    task({ workTaskId: 'b', status: 'skipped', blockedReason: '取消' }),
    task({ workTaskId: 'c', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }] })
  ]);
  assert.equal(progress.total, 2);
  assert.equal(progress.completed, 1);
  assert.equal(progress.blocked, 1);
  assert.equal(progress.skipped, 1);
  assert.equal(progress.ratio, 0.5);
});

test('P2：相同输入两次调用无时间漂移', () => {
  const tasks = [
    task({ workTaskId: 'a', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }] }),
    task({ workTaskId: 'b', status: 'ready' })
  ];
  const a = computeWorkProgress(tasks);
  const b = computeWorkProgress(tasks);
  assert.deepEqual(a, b);
});

test('P2：byParent 汇总子树叶子', () => {
  const progress = computeWorkProgress([
    task({ workTaskId: 'g', level: 1, status: 'ready' }),
    task({ workTaskId: 'a', parentTaskId: 'g', status: 'completed', evidence: [{ kind: 'note', detail: 'ok' }] }),
    task({ workTaskId: 'b', parentTaskId: 'g', status: 'ready' })
  ]);
  assert.equal(progress.byParent.g.total, 2);
  assert.equal(progress.byParent.g.completed, 1);
  assert.equal(progress.byParent.g.ratio, 0.5);
});
