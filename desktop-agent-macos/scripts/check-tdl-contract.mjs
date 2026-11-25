/**
 * TDL-P1：契约与状态机。
 * Run: npm run test:tdl-contract
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyWorkTaskStatus,
  canTransition,
  collaborationPolicyFor,
  impactedByReplan,
  upsertWorkTask
} from '../out-test/shared/task-decomposition.js';

function task(partial) {
  return {
    workTaskId: partial.workTaskId,
    workId: 'work-1',
    title: partial.title ?? partial.workTaskId,
    dependencies: partial.dependencies ?? [],
    acceptanceCriteria: ['有证据'],
    status: partial.status ?? 'pending',
    complexity: partial.complexity ?? 'low',
    collaborationPolicy: collaborationPolicyFor(partial.complexity ?? 'low'),
    artifacts: [],
    evidence: partial.evidence ?? [],
    revision: partial.revision ?? 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  };
}

test('状态机：pending 不能直接 completed', () => {
  assert.equal(canTransition('pending', 'ready'), true);
  assert.equal(canTransition('pending', 'completed'), false);
  assert.equal(canTransition('running', 'completed'), true);
});

test('协作策略：low 不强制辩论，high_risk 独立审核', () => {
  assert.deepEqual(collaborationPolicyFor('low'), { debate: 'off', review: 'auto' });
  assert.equal(collaborationPolicyFor('high_risk').debate, 'on');
  assert.equal(collaborationPolicyFor('high_risk').review, 'independent');
});

test('依赖未满足不能开工；CAS 冲突要报错', () => {
  let tasks = [
    task({ workTaskId: 'a', status: 'ready' }),
    task({ workTaskId: 'b', status: 'pending', dependencies: ['a'] })
  ];
  tasks = upsertWorkTask(tasks, tasks[1]);
  assert.throws(
    () => applyWorkTaskStatus(tasks, { workTaskId: 'b', status: 'running', expectedRevision: 1 }),
    /依赖未完成/
  );
  tasks = applyWorkTaskStatus(tasks, {
    workTaskId: 'a',
    status: 'running',
    expectedRevision: 1
  });
  tasks = applyWorkTaskStatus(tasks, {
    workTaskId: 'a',
    status: 'completed',
    expectedRevision: 2,
    evidence: [{ kind: 'note', detail: 'ok' }]
  });
  const b = tasks.find(item => item.workTaskId === 'b');
  assert.equal(b.status, 'ready');
  assert.throws(
    () => applyWorkTaskStatus(tasks, { workTaskId: 'b', status: 'running', expectedRevision: 99 }),
    /CAS_CONFLICT/
  );
});

test('完成必须带证据', () => {
  const tasks = [task({ workTaskId: 'a', status: 'running', revision: 2 })];
  assert.throws(
    () => applyWorkTaskStatus(tasks, { workTaskId: 'a', status: 'completed', expectedRevision: 2 }),
    /验收证据/
  );
});

test('局部重规划只返回变更闭包', () => {
  const tasks = [
    task({ workTaskId: 'a' }),
    task({ workTaskId: 'b', dependencies: ['a'] }),
    task({ workTaskId: 'c', dependencies: ['b'] }),
    task({ workTaskId: 'd' })
  ];
  assert.deepEqual(impactedByReplan(tasks, ['a']).sort(), ['a', 'b', 'c']);
  assert.deepEqual(impactedByReplan(tasks, ['d']), ['d']);
});
