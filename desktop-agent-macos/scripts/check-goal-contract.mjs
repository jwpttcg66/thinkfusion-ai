/**
 * GCE-P1：Goal Contract 纯函数、Criterion 与逐条 Goal Fit。
 * Run: npm run test:goal-contract
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGoalContractFit,
  applyGoalContractChange,
  canTransitionGoalContract,
  createGoalContract,
  createGoalCriterion,
  normalizeGoalDimensions,
  transitionGoalContract,
  validateGoalContract
} from '../out-test/shared/goal-contract.js';

const dims = normalizeGoalDimensions([
  { kind: 'USER_INTENT', text: '希望更准确理解工程', source: 'USER_EXPLICIT', confidence: 0.9 },
  { kind: 'DESIRED_OUTCOME', text: '能定位符号和调用关系', source: 'MODEL_INFERRED', confidence: 0.6 },
  { kind: 'SUCCESS_CRITERIA', text: '能给出类、方法和调用边', source: 'USER_EXPLICIT', confidence: 1 }
], 1);

function contract(criteria = []) {
  return createGoalContract({
    goalId: 'goal:w1',
    workId: 'w1',
    originalRequest: '优化代码理解能力',
    dimensions: dims,
    criteria,
    createdAt: 1
  });
}

function criterion(id, status, priority = 'MUST', evidenceRefs = []) {
  return createGoalCriterion({
    goalId: 'goal:w1',
    goalVersion: 1,
    criterionId: id,
    description: id,
    source: 'USER_EXPLICIT',
    priority,
    verificationMethod: 'test',
    acceptanceThreshold: '通过',
    status,
    evidenceRefs,
    updatedAt: 1
  });
}

test('六维目标：缺失维度保留 UNRESOLVED，不猜内容', () => {
  assert.equal(dims.length, 6);
  const missing = dims.find(item => item.kind === 'GOAL_VALUE');
  assert.equal(missing.source, 'UNRESOLVED');
  assert.equal(missing.text, '');
  assert.equal(dims.find(item => item.kind === 'USER_INTENT').source, 'USER_EXPLICIT');
});

test('模型推断不能伪装成用户确认', () => {
  const bad = contract();
  bad.dimensions = bad.dimensions.map(item =>
    item.kind === 'DESIRED_OUTCOME'
      ? { ...item, source: 'MODEL_INFERRED', confirmedByUser: true }
      : item
  );
  assert.equal(validateGoalContract(bad).ok, false);
  assert.ok(validateGoalContract(bad).reasons.some(item => item.includes('不能标记为用户确认')));
});

test('MET 必须有证据；WAIVED 必须有授权', () => {
  const noEvidence = contract([criterion('c1', 'MET')]);
  assert.equal(validateGoalContract(noEvidence).ok, false);
  assert.ok(validateGoalContract(noEvidence).reasons.some(item => item.includes('没有证据')));

  const noWaiver = contract([criterion('c2', 'WAIVED')]);
  assert.equal(validateGoalContract(noWaiver).ok, false);
  assert.ok(validateGoalContract(noWaiver).reasons.some(item => item.includes('没有授权记录')));
});

test('Goal Fit 逐条汇总：UNKNOWN/GAP/PARTIAL/WITH_RISKS/MET', () => {
  assert.equal(assessGoalContractFit(contract()).fit, 'UNKNOWN');

  const gap = contract([criterion('c1', 'UNMET')]);
  assert.equal(assessGoalContractFit(gap).fit, 'GAP');

  const partial = contract([criterion('c1', 'UNVERIFIED')]);
  assert.equal(assessGoalContractFit(partial).fit, 'PARTIAL');

  const waivedCriterion = criterion('c1', 'WAIVED');
  waivedCriterion.waiver = { authorizedBy: 'user', reason: '暂不接受该标准', at: 2 };
  const withRisks = contract([waivedCriterion]);
  assert.equal(assessGoalContractFit(withRisks).fit, 'WITH_RISKS');

  const met = contract([criterion('c1', 'MET', 'MUST', ['ev-1'])]);
  const fit = assessGoalContractFit(met);
  assert.equal(fit.fit, 'MET');
  assert.equal(fit.met, 1);
  assert.equal(fit.evidenceCompleteness, 1);
});

test('目标状态机：合法转换生效，非法转换拒绝', () => {
  let c = contract();
  c = transitionGoalContract(c, 'UNDERSTANDING', 2);
  c = transitionGoalContract(c, 'READY_FOR_CONFIRMATION', 3);
  c = transitionGoalContract(c, 'CONFIRMED', 4);
  c = transitionGoalContract(c, 'ACTIVE', 5);
  assert.equal(c.status, 'ACTIVE');
  assert.equal(canTransitionGoalContract('ACTIVE', 'ACHIEVED'), true);
  assert.equal(canTransitionGoalContract('ACHIEVED', 'ACTIVE'), false);
  assert.throws(() => transitionGoalContract(c, 'DRAFT'), /非法目标状态转换/);
});

test('删减成功标准必须确认；确认才升版本，拒绝保留旧目标', () => {
  const old = contract([
    criterion('c1', 'MET', 'MUST', ['ev-1']),
    criterion('c2', 'PENDING')
  ]);
  const next = [criterion('c1', 'MET', 'MUST', ['ev-1'])];

  const rejected = applyGoalContractChange(old, next, { userConfirmed: false, at: 10 });
  assert.equal(rejected.kind, 'change');
  assert.equal(rejected.requiresUserConfirmation, true);
  assert.equal(rejected.changed, false);
  assert.equal(rejected.contract.goalVersion, 1);
  assert.equal(rejected.contract.criteria.length, 2);

  const accepted = applyGoalContractChange(old, next, { userConfirmed: true, at: 11 });
  assert.equal(accepted.requiresUserConfirmation, false);
  assert.equal(accepted.contract.goalVersion, 2);
  assert.equal(accepted.contract.criteria.length, 1);
  assert.equal(accepted.contract.criteria[0].goalVersion, 2);
});

test('补充标准是 clarify，不升目标版本', () => {
  const old = contract([criterion('c1', 'PENDING')]);
  const next = [criterion('c1', 'PENDING'), criterion('c2', 'PENDING')];
  const result = applyGoalContractChange(old, next, { at: 12 });
  assert.equal(result.kind, 'clarify');
  assert.equal(result.contract.goalVersion, 1);
  assert.equal(result.contract.criteria.length, 2);
});
