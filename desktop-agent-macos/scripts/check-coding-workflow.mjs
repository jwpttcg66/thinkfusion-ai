/**
 * 编码工作流：状态映射与预算。
 *
 * Run with: npm run test:coding-workflow
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODING_BUDGET, checkCodingBudget, codingStateFor } from '../out-test/shared/coding-workflow.js';

const plan = (steps) => ({ planId: 'p', taskId: 't', roundId: 'r', title: '', description: '', completion: '', steps });

const write = (path) => ({ id: path, tool: 'fs.edit', args: { path, oldString: 'a', newString: 'b' } });

test('任务状态映射到编码工作流状态', () => {
  assert.equal(codingStateFor('planning'), 'ANALYZING');
  assert.equal(codingStateFor('awaiting_approval'), 'WAITING_APPROVAL');
  assert.equal(codingStateFor('executing'), 'EDITING');
  assert.equal(codingStateFor('verifying'), 'VERIFYING');
  assert.equal(codingStateFor('report_pending'), 'REVIEWING');
  assert.equal(codingStateFor('awaiting_next_round'), 'FIXING');
  assert.equal(codingStateFor('completed'), 'COMPLETED');
  assert.equal(codingStateFor('failed'), 'FAILED');
});

test('正常计划不超预算', () => {
  assert.deepEqual(checkCodingBudget(plan([write('a.ts'), write('b.ts')])), []);
});

test('改动文件超过上限：拒绝并说明拆任务', () => {
  const steps = Array.from({ length: CODING_BUDGET.maxChangedFiles + 1 }, (_, index) => write(`src/f${String(index)}.ts`));
  const violations = checkCodingBudget(plan(steps));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /超过上限.*拆成多次/);
});

test('工具调用超过上限：拒绝', () => {
  const steps = Array.from({ length: CODING_BUDGET.maxToolCalls + 1 }, (_, index) => ({
    id: `s${String(index)}`,
    tool: 'fs.readFile',
    args: { path: 'a.ts' }
  }));
  const violations = checkCodingBudget(plan(steps));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /超过单次上限/);
});
