/**
 * GCE：GoalContract 与现有 GDC 读模型的单向映射。
 * Run: npm run test:goal-compat
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalContract, createGoalCriterion } from '../out-test/shared/goal-contract.js';
import {
  engineeringGoalViewFromContract,
  legacyGoalFit,
  legacyGoalFitEvent,
  legacyGoalStatus
} from '../out-test/shared/goal-compat.js';

const contract = createGoalContract({
  goalId: 'goal:w1',
  workId: 'w1',
  originalRequest: '优化代码理解能力',
  dimensions: [
    { kind: 'USER_INTENT', text: '更准确理解工程', source: 'USER_EXPLICIT', confidence: 0.9 },
    { kind: 'DESIRED_OUTCOME', text: '能定位符号', source: 'MODEL_INFERRED', confidence: 0.6 }
  ],
  criteria: [
    createGoalCriterion({
      goalId: 'goal:w1',
      goalVersion: 1,
      criterionId: 'c1',
      description: '能定位符号',
      source: 'USER_EXPLICIT',
      verificationMethod: 'test',
      acceptanceThreshold: '通过',
      status: 'MET',
      evidenceRefs: ['ev-1']
    })
  ],
  createdAt: 1
});

test('GoalContract 状态映射到旧 GDC 状态', () => {
  assert.equal(legacyGoalStatus('ACTIVE'), 'active');
  assert.equal(legacyGoalStatus('ACHIEVED'), 'achieved');
  assert.equal(legacyGoalStatus('READY_FOR_CONFIRMATION'), 'confirmed');
  assert.equal(legacyGoalStatus('ACHIEVED_WITH_RISKS'), 'achieved');
  assert.equal(legacyGoalStatus('PARTIAL_ACHIEVEMENT'), 'at_risk');
});

test('新 Fit 不把 WITH_RISKS/PARTIAL 伪装成旧 met', () => {
  assert.equal(legacyGoalFit('MET', true), 'met');
  assert.equal(legacyGoalFit('GAP', true), 'gap');
  assert.equal(legacyGoalFit('PARTIAL', true), 'pending');
  assert.equal(legacyGoalFit('WITH_RISKS', true), 'pending');
  assert.equal(legacyGoalFit('WITH_RISKS', false), 'unknown');
});

test('EngineeringGoalView 从契约单向派生', () => {
  const view = engineeringGoalViewFromContract(contract, {
    workId: 'w1',
    originalRequest: '优化代码理解能力',
    source: 'task'
  });
  assert.equal(view.goalId, 'goal:w1');
  assert.equal(view.originalRequest, '优化代码理解能力');
  assert.equal(view.intent, '更准确理解工程');
  assert.deepEqual(view.successCriteria, ['能定位符号']);
  assert.equal(view.goalVersion, 1);
  assert.equal(view.fit, 'met');
  assert.equal(view.source, 'task');
});

test('goal.fit 扩展不新增第二套事件', () => {
  const event = legacyGoalFitEvent(contract);
  assert.equal(event.fit, 'met');
  assert.equal(event.goalVersion, 1);
  assert.equal(event.met, 1);
  assert.deepEqual(event.criteria, [{
    criterionId: 'c1',
    status: 'MET',
    description: '能定位符号',
    priority: 'MUST',
    evidenceRefs: ['ev-1']
  }]);
  assert.equal(event.gceFit, 'MET');
  assert.equal(event.evidenceCompleteness, 1);
});
