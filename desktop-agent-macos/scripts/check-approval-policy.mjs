/**
 * 权限档位 → 「还要不要人点」。
 *
 * 守的是一条产品语义：选了「完全权限」就说明这台机器上的操作都允许了，
 * 不该再让人点「确认并执行」和每一步「执行」；而「工作区内修改」不是这个
 * 意思，计划审批必须留着。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { approvalPolicyFor, approvalHintFor, planApprovalGate } from '../out-test/shared/approval.js';
import { needsApproval } from '../out-test/agent/step-approval.js';

test('完全权限：自动批准计划，步骤不再询问', () => {
  const policy = approvalPolicyFor('danger-full-access');
  assert.equal(policy.autoApprovePlan, true);
  assert.equal(policy.stepApproval, 'off');
});

test('完全权限下写操作与命令都不再弹审批', () => {
  const { stepApproval } = approvalPolicyFor('danger-full-access');
  for (const tool of ['fs.writeFile', 'fs.remove', 'shell.run', 'code.run', 'agent.exec']) {
    assert.equal(needsApproval(tool, stepApproval), false, `${tool} 不该再问`);
  }
});

test('工作区内修改：计划仍要人确认，只有写操作才问', () => {
  const policy = approvalPolicyFor('workspace-write');
  assert.equal(policy.autoApprovePlan, false);
  assert.equal(policy.stepApproval, 'mutating');
  assert.equal(needsApproval('fs.readFile', policy.stepApproval), false);
  assert.equal(needsApproval('fs.writeFile', policy.stepApproval), true);
});

test('仅可查看：与工作区内修改同一审批粒度，不因只读就自动开工', () => {
  const policy = approvalPolicyFor('read-only');
  assert.equal(policy.autoApprovePlan, false);
  assert.equal(policy.stepApproval, 'mutating');
});

test('完全权限下缺 L2 不撤销自动批准，只降级为质量警告', () => {
  const gate = planApprovalGate('danger-full-access', true);
  assert.equal(gate.autoApprovePlan, true);
  assert.match(gate.decompositionNote, /不阻塞自动批准/);
  assert.doesNotMatch(gate.decompositionNote, /人工确认/);
});

test('需要人批准的档位，缺 L2 仍只是提醒一起看，不改变门禁', () => {
  const gate = planApprovalGate('workspace-write', true);
  assert.equal(gate.autoApprovePlan, false);
  assert.match(gate.decompositionNote, /人工确认/);
  assert.equal(planApprovalGate('workspace-write', false).decompositionNote, '');
  assert.equal(planApprovalGate('danger-full-access', false).decompositionNote, '');
});

test('编排器不得再拿 NEEDS_ANALYSIS 推翻完全权限', () => {
  const source = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8');
  assert.match(source, /planApprovalGate\(task\.permissionPreset, decomposition\.needsAnalysis\)/);
  assert.doesNotMatch(source, /autoApprovePlan\s*&&\s*!decomposition\.needsAnalysis/);
  assert.doesNotMatch(source, /改为等待人工确认/);
});

test('单实例锁必须落在隔离后的 userData 上', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const setPathAt = source.indexOf("app.setPath(\n  'userData'");
  const lockAt = source.indexOf('requestSingleInstanceLock()');
  assert.ok(setPathAt >= 0 && lockAt > setPathAt, 'setPath(userData) 必须在单实例锁之前');
});

test('完全权限下验证闸门不再停下问人', () => {
  const orchestrator = readFileSync(new URL('../src/main/orchestrator.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8');
  assert.match(orchestrator, /完全权限：不再询问，按接受未验证收尾/);
  assert.match(app, /activeTask\.permissionPreset !== 'danger-full-access'/);
});

test('三档的界面说明各不相同，且完全权限明确说「不再询问」', () => {
  const hints = (['read-only', 'workspace-write', 'danger-full-access']).map(approvalHintFor);
  assert.equal(new Set(hints).size, 3);
  assert.match(hints[2], /自动批准/);
  assert.match(hints[2], /不再逐次询问/);
});
