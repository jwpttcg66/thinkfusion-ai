/**
 * GCE-P3：Cycle Decision 纯函数与旧出口兼容。
 * Run: npm run test:cycle-decision
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cycleFingerprint,
  decideCycleAction,
  detectNoProgress,
  legacyDecisionOf
} from '../out-test/shared/cycle-decision.js';

function fit(fitValue, overrides = {}) {
  return {
    goalId: 'goal:w1',
    goalVersion: 1,
    fit: fitValue,
    met: 0, partial: 0, unmet: 0, unverified: 0, waived: 0,
    blockingRisks: [],
    evidenceCompleteness: 1,
    notes: [],
    ...overrides
  };
}

function input(overrides = {}) {
  return {
    goalStatus: 'ACTIVE',
    goalFit: fit('MET'),
    delivery: { execution: 'COMPLETED', verification: 'PASSED', goal: 'MET' },
    review: { needsFix: false, blockingIssues: 0, unresolved: 0 },
    budget: { atMaxRounds: false },
    task: {},
    progress: { fingerprint: 'f1', repeated: 0, criterionStalled: false },
    diagnosis: 'none',
    ...overrides
  };
}

test('取消/阻塞/目标未就绪优先于完成判断', () => {
  assert.equal(decideCycleAction(input({ task: { cancelled: true } })).decision, 'ABORT');
  assert.equal(decideCycleAction(input({ task: { blockedReason: '网络不可用' } })).decision, 'BLOCKED');
  assert.equal(decideCycleAction(input({ goalStatus: 'DRAFT' })).decision, 'CLARIFY_GOAL');
  assert.equal(
    decideCycleAction(input({ goalStatus: 'CHANGE_PROPOSED' })).decision,
    'CHANGE_PROPOSED'
  );
});

test('无进展按诊断选择重设计/重分析/重规划/等待', () => {
  const progress = { fingerprint: 'f1', repeated: 2, criterionStalled: false };
  assert.equal(decideCycleAction(input({ progress, diagnosis: 'design' })).decision, 'REDESIGN');
  assert.equal(decideCycleAction(input({ progress, diagnosis: 'analysis' })).decision, 'REANALYZE');
  assert.equal(decideCycleAction(input({ progress, diagnosis: 'task_plan' })).decision, 'REPLAN');
  assert.equal(decideCycleAction(input({ progress, diagnosis: 'implementation' })).decision, 'WAIT_USER');
});

test('GAP 按诊断回到实现/设计/分析/规划/目标', () => {
  const gap = fit('GAP', { unmet: 1 });
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'implementation' })).decision, 'REPAIR');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'design' })).decision, 'REDESIGN');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'analysis' })).decision, 'REANALYZE');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'task_plan' })).decision, 'REPLAN');
  assert.equal(decideCycleAction(input({ goalFit: gap, diagnosis: 'goal' })).decision, 'CLARIFY_GOAL');
});

test('预算耗尽、评审问题、验证失败不能被 complete 覆盖', () => {
  assert.equal(
    decideCycleAction(input({ budget: { atMaxRounds: true } })).decision,
    'BLOCKED'
  );
  assert.equal(
    decideCycleAction(input({ review: { needsFix: true, blockingIssues: 1, unresolved: 0 } })).decision,
    'REPAIR'
  );
  assert.equal(
    decideCycleAction(input({
      delivery: { execution: 'COMPLETED', verification: 'FAILED', goal: 'MET' }
    })).decision,
    'REPAIR'
  );
});

test('MET 仍需验证通过；WITH_RISKS 需用户接受', () => {
  assert.equal(
    decideCycleAction(input({
      delivery: { execution: 'COMPLETED', verification: 'UNVERIFIED', goal: 'MET' }
    })).decision,
    'WAIT_USER'
  );
  const risks = fit('WITH_RISKS', { waived: 1 });
  assert.equal(decideCycleAction(input({ goalFit: risks })).decision, 'WAIT_USER');
  assert.equal(
    decideCycleAction(input({ goalFit: risks, userAcceptedRisks: true })).decision,
    'COMPLETE'
  );
});

test('旧四出口兼容：新语义不被压成 complete', () => {
  assert.equal(legacyDecisionOf('COMPLETE'), 'complete');
  assert.equal(legacyDecisionOf('REPAIR'), 'repair');
  assert.equal(legacyDecisionOf('REDESIGN'), 'observe');
  assert.equal(legacyDecisionOf('WAIT_USER'), 'observe');
});

test('指纹键排序稳定，相同输入可去重', () => {
  const a = cycleFingerprint({ b: 2, a: [1, 2] });
  const b = cycleFingerprint({ a: [1, 2], b: 2 });
  assert.equal(a, b);
  const first = detectNoProgress(null, a, 0);
  assert.equal(first.repeated, 0);
  assert.equal(detectNoProgress(a, a, first.repeated).repeated, 1);
  assert.equal(detectNoProgress(a, a, 2).criterionStalled, true);
});
