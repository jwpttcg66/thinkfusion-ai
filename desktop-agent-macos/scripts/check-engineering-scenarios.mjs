/** P3-09：六个工程场景。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canComplete, createEngineeringTaskState, recordBuild, recordEnd, recordReview, recordStart, recordTest
} from '../out-test/main/engineering/task-state.js';
import { captureSnapshot } from '../out-test/main/engineering/snapshot.js';
import { checkEngineeringPlan } from '../out-test/main/engineering/plan.js';

const base = () => createEngineeringTaskState({
  taskId: 't1', implementerId: 'dev', context: { repoRoot: '/repo', branch: 'task/x' }
});
const complete = () => {
  let s = base();
  s = recordStart(s, { commit: 'a', dirty: false, dirtyFiles: [], snapshot: 'S1' });
  s = recordEnd(s, { commit: 'b', dirty: false, dirtyFiles: [], snapshot: 'S2' });
  s = recordTest(s, { command: 'npm test', exitCode: 0, status: 'passed' });
  s = recordBuild(s, { command: 'build', exitCode: 0, status: 'passed' });
  s = recordReview(s, { verdict: 'pass', reviewer: 'r', issues: [] });
  return s;
};
const plan = (extra = {}) => ({
  planId: 'p', goal: 'g', changes: [{ path: 'a.ts', kind: 'modify', reason: 'fix' }],
  tests: ['npm test'], rollback: 'revert', risks: [], ...extra
});

test('1 完整任务可完成', () => assert.equal(canComplete(complete()).ok, true));
test('2 缺 S1 不可完成', () => assert.equal(canComplete(base()).ok, false));
test('3 测试失败不可完成', () => {
  let s = base();
  s = recordStart(s, { commit: 'a', dirty: false, dirtyFiles: [], snapshot: 'S1' });
  s = recordEnd(s, { commit: 'b', dirty: false, dirtyFiles: [], snapshot: 'S2' });
  s = recordTest(s, { command: 'x', exitCode: 1, status: 'failed' });
  s = recordBuild(s, { command: 'b', exitCode: 0, status: 'passed' });
  s = recordReview(s, { verdict: 'pass', reviewer: 'r', issues: [] });
  assert.equal(canComplete(s).ok, false);
});
test('4 评审者不能是实现者', () => {
  assert.throws(() => recordReview(base(), { verdict: 'pass', reviewer: 'dev', issues: [] }), /不能是实现者/);
});
test('5 git 快照能识别 dirty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-p3-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'i'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), '2');
  assert.equal(captureSnapshot(dir, 'S2').dirty, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('6 计划缺回退不可通过', () => assert.equal(checkEngineeringPlan(plan({ rollback: '' })).ok, false));
