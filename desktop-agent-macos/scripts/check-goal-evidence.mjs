/**
 * GCE-P2：Criterion ↔ Evidence ↔ WorkTask 纯函数。
 * Run: npm run test:goal-evidence
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessCriterionFromEvidence,
  applyEvidenceToGoalContract,
  coverageGaps,
  criterionCoverage
} from '../out-test/shared/goal-evidence.js';
import { createGoalContract, createGoalCriterion } from '../out-test/shared/goal-contract.js';

function criterion(id, overrides = {}) {
  return createGoalCriterion({
    goalId: 'goal:w1',
    goalVersion: 1,
    criterionId: id,
    description: id,
    source: 'USER_EXPLICIT',
    priority: 'MUST',
    verificationMethod: '真实执行',
    acceptanceThreshold: '通过',
    ...overrides
  });
}

function link(criterionId, type, status, id = `${criterionId}-${type}`) {
  return {
    evidenceId: id,
    workId: 'w1',
    cycleId: 'c1',
    criterionId,
    goalVersion: 1,
    evidenceType: type,
    source: 'test',
    verificationStatus: status,
    linkedAt: 1
  };
}

const contract = createGoalContract({
  goalId: 'goal:w1',
  workId: 'w1',
  originalRequest: '优化代码理解能力',
  criteria: [
    criterion('c1'),
    criterion('c2'),
    criterion('c3')
  ],
  createdAt: 1
});

test('只有 MODEL_CLAIM 不能把 Criterion 标为 MET', () => {
  assert.equal(
    assessCriterionFromEvidence(criterion('c1'), [link('c1', 'MODEL_CLAIM', 'PASSED')]),
    'UNVERIFIED'
  );
});

test('适用证据 PASSED → MET；FAILED → UNMET；无证据 → PENDING', () => {
  assert.equal(
    assessCriterionFromEvidence(criterion('c1'), [link('c1', 'TEST_RESULT', 'PASSED')]),
    'MET'
  );
  assert.equal(
    assessCriterionFromEvidence(criterion('c1'), [link('c1', 'TEST_RESULT', 'FAILED')]),
    'UNMET'
  );
  assert.equal(assessCriterionFromEvidence(criterion('c1'), []), 'PENDING');
});

test('acceptedEvidenceTypes 排除不适用证据', () => {
  const c = criterion('c1', { acceptedEvidenceTypes: ['BUILD_RESULT'] });
  assert.equal(
    assessCriterionFromEvidence(c, [link('c1', 'TEST_RESULT', 'PASSED')]),
    'UNVERIFIED'
  );
  assert.equal(
    assessCriterionFromEvidence(c, [link('c1', 'BUILD_RESULT', 'PASSED')]),
    'MET'
  );
});

test('证据写回 Criterion 并汇总 Goal Fit', () => {
  const result = applyEvidenceToGoalContract(contract, [
    link('c1', 'TEST_RESULT', 'PASSED', 'e1'),
    link('c2', 'TEST_RESULT', 'FAILED', 'e2')
  ], 2);
  assert.equal(result.contract.criteria[0].status, 'MET');
  assert.deepEqual(result.contract.criteria[0].evidenceRefs, ['e1']);
  assert.equal(result.contract.criteria[1].status, 'UNMET');
  assert.equal(result.fit.fit, 'GAP');
  assert.equal(result.fit.met, 1);
  assert.equal(result.fit.unmet, 1);
  assert.equal(result.fit.unverified, 0);
});

test('WAIVED 保留授权；不能被证据覆盖', () => {
  const waived = criterion('c1', {
    status: 'WAIVED',
    waiver: { authorizedBy: 'user', reason: '暂不接受', at: 1 }
  });
  assert.equal(
    assessCriterionFromEvidence(waived, [link('c1', 'TEST_RESULT', 'PASSED')]),
    'WAIVED'
  );
});

test('WorkTask 必须承接 MUST Criterion；无映射不算覆盖', () => {
  const tasks = [
    { workTaskId: 't1', criterionIds: ['c1'] },
    { workTaskId: 't2', criterionIds: [] }
  ];
  const coverage = criterionCoverage(contract, tasks);
  assert.equal(coverage.find(item => item.criterionId === 'c1').covered, true);
  assert.equal(coverage.find(item => item.criterionId === 'c2').covered, false);
  const gaps = coverageGaps(coverage);
  assert.deepEqual(gaps.blocking.map(item => item.criterionId).sort(), ['c2', 'c3']);
  assert.deepEqual(gaps.advisory, []);
});

test('旧 WorkTask 没有 criterionIds 时不假装覆盖', () => {
  const coverage = criterionCoverage(contract, [{ workTaskId: 'legacy' }]);
  assert.ok(coverage.every(item => !item.covered));
  assert.equal(coverageGaps(coverage).blocking.length, 3);
});

test('同一 Criterion 上失败证据优先于通过证据', async () => {
  const { createGoalCriterion: make } = await import('../out-test/shared/goal-contract.js');
  const { assessCriterionFromEvidence: assess } = await import('../out-test/shared/goal-evidence.js');
  const criterion = make({
    goalId: 'g', goalVersion: 1, criterionId: 'c', description: '测试通过',
    source: 'USER_EXPLICIT', verificationMethod: 'test', acceptanceThreshold: '通过', updatedAt: 1
  });
  const links = [
    { evidenceId: 'e1', workId: 'w', cycleId: 'c', criterionId: 'c', goalVersion: 1, evidenceType: 'BUILD_RESULT', source: 's', verificationStatus: 'PASSED', linkedAt: 1 },
    { evidenceId: 'e2', workId: 'w', cycleId: 'c', criterionId: 'c', goalVersion: 1, evidenceType: 'TEST_RESULT', source: 's', verificationStatus: 'FAILED', linkedAt: 1 }
  ];
  assert.equal(assess(criterion, links), 'UNMET');
});
