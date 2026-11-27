/**
 * GCE 生产接线：计划 → 契约 → 报告证据 → Goal Fit。
 * Run: npm run test:goal-runtime
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessReportAgainstGoal,
  assessReportsAgainstGoal,
  evidenceFromReport,
  goalContractFromPlan,
  statusForFit
} from '../out-test/main/engineering/goal-contract-runtime.js';

function report(overrides = {}) {
  return {
    protocol: 'v1',
    type: 'execution_report',
    taskId: 't1',
    roundId: 'r1',
    planId: 'p1',
    status: 'completed',
    results: [],
    errors: [],
    nextAction: 'complete',
    createdAt: 1,
    ...overrides
  };
}

function withChecks(checks, overrides = {}) {
  return report({
    verification: {
      verified: true,
      fullyVerified: true,
      reasons: [],
      changedFiles: 1,
      changedPaths: ['src/a.ts'],
      checks: {
        compile: { status: 'passed' },
        tests: { status: 'passed' },
        run: { status: 'passed' },
        diagnostics: { status: 'passed', errors: 0, warnings: 0 },
        changedFiles: ['src/a.ts'],
        ...checks
      }
    },
    ...overrides
  });
}

const contract = () => goalContractFromPlan({
  taskId: 't1',
  userPrompt: '增加登录校验',
  goalCriteria: ['缺少 token 时返回 401'],
  planTitle: '实现登录校验',
  completionCondition: '测试通过且返回 401',
  at: 1
});

test('计划只产生明确标准：用户标准 + 计划完成条件', () => {
  const goal = contract();
  assert.equal(goal.status, 'ACTIVE');
  assert.equal(goal.criteria.length, 2);
  assert.equal(goal.criteria[0].source, 'USER_EXPLICIT');
  assert.equal(goal.criteria[1].source, 'MODEL_INFERRED');
  assert.equal(goal.criteria[1].description, '测试通过且返回 401');
});

test('没有用户标准和完成条件时不伪造 Criterion', () => {
  const goal = goalContractFromPlan({
    taskId: 't2',
    userPrompt: '看看这个项目',
    planTitle: '只读分析',
    at: 1
  });
  assert.deepEqual(goal.criteria, []);
  assert.equal(goal.openQuestions.length, 1);
});

test('测试/编译/运行通过的证据可把 Criterion 推到 MET', () => {
  const result = assessReportAgainstGoal({ contract: contract(), report: withChecks({}), at: 2 });
  assert.equal(result.fit.fit, 'MET');
  assert.equal(result.contract.status, 'ACHIEVED');
  assert.ok(result.criteria.every(item => item.status === 'MET'));
  assert.ok(result.links.some(item => item.evidenceType === 'TEST_RESULT' && item.verificationStatus === 'PASSED'));
});

test('改了代码只做文本回读不能冒充目标达成', () => {
  const readbackOnly = report({
    verification: {
      verified: true,
      fullyVerified: false,
      reasons: [],
      changedFiles: 1,
      changedPaths: ['src/a.ts']
    }
  });
  const result = assessReportAgainstGoal({ contract: contract(), report: readbackOnly, at: 2 });
  assert.ok(result.criteria.every(item => item.status === 'UNVERIFIED'));
  assert.equal(result.fit.fit, 'PARTIAL');
  assert.notEqual(result.contract.status, 'ACHIEVED');
});

test('非代码改动的成功回读可以作为 FILE_READBACK 证据', () => {
  const doc = report({
    verification: {
      verified: true,
      fullyVerified: true,
      reasons: [],
      changedFiles: 1,
      changedPaths: ['docs/a.md']
    }
  });
  const result = assessReportAgainstGoal({ contract: contract(), report: doc, at: 2 });
  assert.ok(result.links.some(item => item.evidenceType === 'FILE_READBACK' && item.verificationStatus === 'PASSED'));
  assert.equal(result.fit.fit, 'MET');
});

test('报告失败产生 FAILED 证据，Goal Fit 为 GAP', () => {
  const result = assessReportAgainstGoal({
    contract: contract(),
    report: report({ status: 'failed' }),
    at: 2
  });
  assert.equal(result.fit.fit, 'GAP');
  assert.ok(result.links.every(item => item.verificationStatus === 'FAILED'));
});

test('执行完成但没有可核对验证时保持未验证，不写 achieved', () => {
  const completed = report({
    verification: {
      verified: false,
      fullyVerified: false,
      reasons: ['没有测试'],
      changedFiles: 0
    }
  });
  const result = assessReportAgainstGoal({ contract: contract(), report: completed, at: 2 });
  assert.equal(result.fit.fit, 'PARTIAL');
  assert.equal(result.contract.status, 'AT_RISK');
});

test('每条 Criterion 都建立自己的证据链接', () => {
  const result = assessReportAgainstGoal({ contract: contract(), report: withChecks({}), at: 2 });
  const ids = new Set(result.links.map(item => item.criterionId));
  assert.equal(ids.size, 2);
  assert.ok(evidenceFromReport({ contract: contract(), report: withChecks({}), at: 2 }).length >= 4);
});

test('状态跟随 Fit，但不把 UNKNOWN 写成 ACHIEVED', () => {
  assert.equal(statusForFit('ACTIVE', 'MET'), 'ACHIEVED');
  assert.equal(statusForFit('ACTIVE', 'WITH_RISKS'), 'ACHIEVED_WITH_RISKS');
  assert.equal(statusForFit('ACTIVE', 'GAP'), 'AT_RISK');
  assert.equal(statusForFit('ACTIVE', 'UNKNOWN'), 'ACTIVE');
  assert.equal(statusForFit('ABANDONED', 'MET'), 'ABANDONED');
});

test('全轮证据并集：修复轮没有新改动不会把已满足标准冲回未验证', () => {
  const first = withChecks({}, { roundId: 'r1' });
  const repairOnly = report({
    roundId: 'r2',
    verification: {
      verified: true,
      fullyVerified: true,
      reasons: [],
      changedFiles: 0,
      changedPaths: []
    }
  });
  const result = assessReportsAgainstGoal({
    contract: contract(),
    reports: [first, repairOnly],
    at: 3
  });
  assert.equal(result.fit.fit, 'MET');
  assert.ok(result.links.some(item => item.source === 'execution_report:r1'));
});

test('失败的测试/编译证据产生 UNMET，Goal Fit 为 GAP', () => {
  const failed = report({
    verification: {
      verified: false,
      fullyVerified: false,
      reasons: ['测试失败'],
      changedFiles: 1,
      changedPaths: ['src/a.ts'],
      checks: {
        compile: { status: 'passed' },
        tests: { status: 'failed', exitCode: 1 },
        run: { status: 'skipped' },
        diagnostics: { status: 'passed', errors: 0, warnings: 0 },
        changedFiles: ['src/a.ts']
      }
    }
  });
  const result = assessReportAgainstGoal({ contract: contract(), report: failed, at: 2 });
  assert.equal(result.fit.fit, 'GAP');
  assert.ok(result.criteria.every(item => item.status === 'UNMET'));
});
