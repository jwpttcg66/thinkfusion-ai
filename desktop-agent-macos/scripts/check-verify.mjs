/**
 * 「本轮验没验过」：只按执行报告里的事实判，不按模型自称。
 *
 * Run with: npm run test:verify
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyExecution } from '../out-test/agent/verification.js';

const step = (tool, status, result = null) => ({ stepId: tool, tool, status, result, startedAt: 0, endedAt: 1 });

test('改了文件 + 成功的测试：算已验证', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('test.run', 'completed', { exitCode: 0, stdout: '' })
  ]);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.changedFiles, 1);
});

test('改了文件 + 诊断 0 error：算已验证', () => {
  const outcome = verifyExecution([
    step('fs.applyPatch', 'completed', { path: 'a.ts' }),
    step('code.diagnostics', 'completed', { counts: { errors: 0, warnings: 2 } })
  ]);
  assert.equal(outcome.verified, true);
});

test('改了文件但只跑了失败测试：不算', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('test.run', 'completed', { exitCode: 1 })
  ]);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reasons.join('；'), /没有成功的测试或诊断/);
});

test('诊断里还有 error：不算', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'completed', { path: 'a.ts' }),
    step('code.diagnostics', 'completed', { counts: { errors: 1, warnings: 0 } })
  ]);
  assert.equal(outcome.verified, false);
});

test('写操作自己失败：不算，且理由直说', () => {
  const outcome = verifyExecution([
    step('fs.edit', 'failed', null),
    step('test.run', 'completed', { exitCode: 0 })
  ]);
  assert.equal(outcome.verified, false);
  assert.match(outcome.reasons.join('；'), /写操作失败/);
});

test('没有写操作：trivially verified，但理由写明无需验证', () => {
  const outcome = verifyExecution([step('fs.readFile', 'completed', { content: 'x' })]);
  assert.equal(outcome.verified, true);
  assert.match(outcome.reasons.join('；'), /无需验证/);
});
