/**
 * GCE-P4：目标分解覆盖与正式参与资格。
 * Run: npm run test:goal-decomposition
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalContract, createGoalCriterion } from '../out-test/shared/goal-contract.js';
import { assessGoalDecomposition, canParticipateFormally } from '../out-test/shared/goal-decomposition.js';

function contract(criteria) {
  return createGoalContract({
    goalId: 'goal:w1',
    workId: 'w1',
    originalRequest: '优化代码理解能力',
    criteria,
    createdAt: 1
  });
}

function criterion(id, priority = 'MUST') {
  return createGoalCriterion({
    goalId: 'goal:w1',
    goalVersion: 1,
    criterionId: id,
    description: id,
    source: 'USER_EXPLICIT',
    priority,
    verificationMethod: 'test',
    acceptanceThreshold: '通过',
    updatedAt: 1
  });
}

function task(id, criterionIds, acceptance = ['通过测试']) {
  return { workTaskId: id, criterionIds, acceptanceCriteria: acceptance };
}

test('MUST 无任务承接阻断；SHOULD 只提示', () => {
  const c = contract([
    criterion('must-1'),
    criterion('must-2'),
    criterion('should-1', 'SHOULD')
  ]);
  const result = assessGoalDecomposition(c, [task('t1', ['must-1'])]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking.map(item => item.criterionId), ['must-2']);
  assert.deepEqual(result.advisory.map(item => item.criterionId), ['should-1']);
  assert.ok(result.reasons.some(item => item.includes('must-2')));
});

test('任务缺少验收条件阻断', () => {
  const c = contract([criterion('c1')]);
  const result = assessGoalDecomposition(c, [task('t1', ['c1'], [])]);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(item => item.includes('缺少验收条件')));
});

test('旧任务没有 criterionIds 不假装覆盖', () => {
  const c = contract([criterion('c1')]);
  const result = assessGoalDecomposition(c, [{ workTaskId: 'legacy', acceptanceCriteria: ['x'] }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocking.map(item => item.criterionId), ['c1']);
});

test('正式参与资格复用 ECO 角色充分度', () => {
  assert.equal(canParticipateFormally('sufficient', 'DESIGN').ok, true);
  assert.equal(canParticipateFormally('partial', 'DESIGN').ok, false);
  assert.equal(canParticipateFormally('partial', 'ANALYSIS').ok, true);
  assert.equal(canParticipateFormally('insufficient', 'IMPLEMENTATION').ok, false);
  assert.equal(canParticipateFormally('stale', 'REVIEW').ok, false);
  assert.equal(canParticipateFormally('sufficient', 'NEXT_DECISION').ok, false);
});
