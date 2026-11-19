/** P3-01：S1/S2、测试、构建、评审齐全才能完成。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canComplete, createEngineeringTaskState, recordBuild, recordEnd, recordReview, recordStart, recordTest
} from '../out-test/main/engineering/task-state.js';

const base = () => createEngineeringTaskState({
  taskId: 't1', implementerId: 'dev',
  context: { repoRoot: '/repo', branch: 'task/x' }
});

test('缺 S1/S2/测试/构建/评审时不能完成', () => {
  assert.equal(canComplete(base()).ok, false);
});

test('齐全且测试/构建/评审通过才能完成', () => {
  let state = base();
  state = recordStart(state, { commit: 'a', dirty: false, dirtyFiles: [], snapshot: 'S1' });
  state = recordEnd(state, { commit: 'b', dirty: false, dirtyFiles: [], snapshot: 'S2', diffHash: 'h' });
  state = recordTest(state, { command: 'npm test', exitCode: 0, status: 'passed', attestationId: 'x' });
  state = recordBuild(state, { command: 'npm run build', exitCode: 0, status: 'passed' });
  state = recordReview(state, { verdict: 'pass', reviewer: 'reviewer', issues: [] });
  assert.equal(canComplete(state).ok, true);
});

test('评审者不能是实现者；测试失败不能完成', () => {
  let state = base();
  assert.throws(() => recordReview(state, { verdict: 'pass', reviewer: 'dev', issues: [] }), /不能是实现者/);
  state = recordStart(state, { commit: 'a', dirty: false, dirtyFiles: [], snapshot: 'S1' });
  state = recordEnd(state, { commit: 'b', dirty: false, dirtyFiles: [], snapshot: 'S2' });
  state = recordTest(state, { command: 'x', exitCode: 1, status: 'failed' });
  state = recordBuild(state, { command: 'b', exitCode: 0, status: 'passed' });
  state = recordReview(state, { verdict: 'pass', reviewer: 'r', issues: [] });
  assert.equal(canComplete(state).ok, false);
});
