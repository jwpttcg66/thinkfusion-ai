/**
 * GCE-P5：恢复时 GoalContract 版本核对。
 * Run: npm run test:goal-recovery
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalContract, createGoalCriterion } from '../out-test/shared/goal-contract.js';
import { reconcileGoalContractOnResume } from '../out-test/shared/goal-recovery.js';

function contract(overrides = {}) {
  return createGoalContract({
    goalId: 'goal:w1',
    workId: 'w1',
    originalRequest: '修复登录',
    goalVersion: 2,
    status: 'ACTIVE',
    criteria: [
      createGoalCriterion({
        goalId: 'goal:w1',
        goalVersion: 2,
        criterionId: 'c1',
        description: '缺少 token 返回 401',
        source: 'USER_EXPLICIT',
        verificationMethod: 'test',
        acceptanceThreshold: '通过',
        updatedAt: 1
      })
    ],
    createdAt: 1,
    ...overrides
  });
}

test('无契约时明确返回 no_contract，不伪造可恢复目标', () => {
  const result = reconcileGoalContractOnResume({ goalId: 'goal:w1', goalVersion: 2 });
  assert.equal(result.status, 'no_contract');
});

test('契约与任务目标版本一致时可继续', () => {
  const result = reconcileGoalContractOnResume({
    goalId: 'goal:w1',
    goalVersion: 2,
    goalCriteria: ['缺少 token 返回 401'],
    contract: contract(),
    tasks: [{ goalId: 'goal:w1', goalVersion: 2 }]
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.contract?.criteria.length, 1);
});

test('目标版本变化或任务树仍绑旧版本时要求重规划', () => {
  const version = reconcileGoalContractOnResume({
    goalId: 'goal:w1',
    goalVersion: 3,
    contract: contract(),
    tasks: [{ goalId: 'goal:w1', goalVersion: 3 }]
  });
  assert.equal(version.status, 'needs_replan');
  assert.match(version.reasons.join('\n'), /v2.*v3/);

  const tasks = reconcileGoalContractOnResume({
    goalId: 'goal:w1',
    goalVersion: 2,
    contract: contract(),
    tasks: [{ goalId: 'goal:w1', goalVersion: 1 }]
  });
  assert.equal(tasks.status, 'needs_replan');
  assert.match(tasks.reasons.join('\n'), /v1.*v2/);
});

test('当前目标标准未进入契约时要求重规划', () => {
  const result = reconcileGoalContractOnResume({
    goalId: 'goal:w1',
    goalVersion: 2,
    goalCriteria: ['缺少 token 返回 401', '新增刷新 token'],
    contract: contract()
  });
  assert.equal(result.status, 'needs_replan');
  assert.match(result.reasons.join('\n'), /新增刷新 token/);
});
