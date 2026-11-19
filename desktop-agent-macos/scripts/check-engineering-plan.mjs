/** P3-03/P3-04：计划完整性、审批、执行断言。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEngineeringPlan } from '../out-test/main/engineering/plan.js';
import { requireExecutionEvidence } from '../out-test/main/engineering/attestation.js';

const plan = () => ({
  planId: 'p', goal: '改一个函数', changes: [{ path: 'a.ts', kind: 'modify', reason: '修复' }],
  tests: ['npm test'], rollback: 'git revert', risks: []
});

test('计划完整；写操作需要审批', () => {
  const result = checkEngineeringPlan(plan());
  assert.equal(result.ok, true);
  assert.equal(result.approvalRequired, true);
});

test('缺测试/回退/变更理由都拒绝', () => {
  assert.equal(checkEngineeringPlan({ ...plan(), tests: [] }).ok, false);
  assert.equal(checkEngineeringPlan({ ...plan(), rollback: '' }).ok, false);
  assert.equal(checkEngineeringPlan({ ...plan(), changes: [{ path: 'a', kind: 'delete', reason: '' }] }).ok, false);
});

test('执行断言缺 attestation 或失败都拒绝', () => {
  assert.equal(requireExecutionEvidence([{ command: 'x', exitCode: 0, outputHash: 'h', attestationId: 'a', at: 1 }]).ok, true);
  assert.equal(requireExecutionEvidence([{ command: 'x', exitCode: 0, outputHash: 'h', at: 1 }]).ok, false);
  assert.equal(requireExecutionEvidence([{ command: 'x', exitCode: 1, outputHash: 'h', attestationId: 'a', at: 1 }]).ok, false);
});
