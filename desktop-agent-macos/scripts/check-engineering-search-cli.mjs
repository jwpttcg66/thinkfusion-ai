/** P3-02/06/08：搜索计划、CLI 分流、Java 降级。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planSearch } from '../out-test/main/engineering/search-plan.js';
import { planCliExecution } from '../out-test/main/execution/cli-executor.js';
import { isJavaFile, javaSupport } from '../out-test/main/engineering/java.js';

test('搜索计划：文件/符号/引用/目录/git 按需', () => {
  const file = planSearch('看 src/a.ts 里的定义');
  assert.ok(file.some(a => a.tool === 'read'));
  assert.ok(file.some(a => a.tool === 'symbol'));
  const impact = planSearch('这个函数被哪些地方调用');
  assert.ok(impact.some(a => a.tool === 'search'));
  const tree = planSearch('看下目录结构');
  assert.ok(tree.some(a => a.tool === 'tree'));
  const diff = planSearch('这次改了什么');
  assert.ok(diff.some(a => a.tool === 'git'));
});

test('CLI：回答不需要审批；执行需要审批 + worktree', () => {
  assert.equal(planCliExecution({ intent: 'answer', approved: false, hasWorktree: false }).ok, true);
  assert.equal(planCliExecution({ intent: 'execute', approved: false, hasWorktree: false }).ok, false);
  assert.equal(planCliExecution({ intent: 'execute', approved: true, hasWorktree: true }).ok, true);
});

test('Java：不引入 JDT，文本降级', () => {
  assert.equal(isJavaFile('A.java'), true);
  assert.equal(javaSupport().jdt, false);
  assert.equal(javaSupport().fallback, 'text');
});
