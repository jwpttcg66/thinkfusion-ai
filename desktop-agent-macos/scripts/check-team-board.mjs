/**
 * 会话任务板：DAG、CAS、完成证据、工作区串行。
 *
 * Run with: npm run test:team-board
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTeamTask,
  mergeTeamRoster,
  taskRevision,
  teamProgress,
  teamWait,
  updateTeamTask
} from '../out-test/main/team-board.js';

const now = 1_700_000_000_000;
const task = (id, extra = {}) => createTeamTask([], {
  id,
  title: id,
  ...extra
}, now);

test('依赖没完成：任务在 blocked，不进入 ready', () => {
  const a = task('a');
  const b = createTeamTask([a], { id: 'b', title: 'b', dependsOn: ['a'] }, now);
  const progress = teamProgress([a, b]);
  assert.deepEqual(progress.ready.map(item => item.id), ['a']);
  assert.deepEqual(progress.blocked.map(item => [item.task.id, item.missing]), [['b', ['a']]]);

  const wait = teamWait([a, b]);
  assert.equal(wait.done, false);
  assert.deepEqual(wait.ready.map(item => item.id), ['a']);
  assert.deepEqual(wait.blocked, [{ id: 'b', title: 'b', missing: ['a'] }]);
});

test('依赖未完成时不能 doing / done；完成后才能开工', () => {
  const a = task('a');
  const b = createTeamTask([a], { id: 'b', title: 'b', dependsOn: ['a'] }, now);
  assert.throws(
    () => updateTeamTask([a, b], { id: 'b', status: 'doing', expectedRevision: 1 }, { now }),
    error => error.code === 'DEPENDENCY_BLOCKED' && /还依赖未完成/.test(error.message)
  );

  const aDone = updateTeamTask([a, b], {
    id: 'a',
    status: 'done',
    expectedRevision: 1,
    evidence: [{ kind: 'test', detail: 'npm test 退出码 0' }]
  }, { now });
  const bDoing = updateTeamTask(aDone, { id: 'b', status: 'doing', expectedRevision: 1 }, { now });
  assert.equal(bDoing.find(item => item.id === 'b').status, 'doing');
  // 已经在 doing 的任务不再算「可开工」，但仍在 remaining 里。
  const progress = teamProgress(bDoing);
  assert.equal(progress.ready.length, 0);
  assert.deepEqual(progress.remaining.map(item => item.id), ['b']);
});

test('CAS：拿旧 revision 覆盖被拒，成功后 revision 递增', () => {
  const a = task('a');
  const first = updateTeamTask([a], { id: 'a', status: 'doing', expectedRevision: 1 }, { now });
  assert.equal(taskRevision(first[0]), 2);
  assert.throws(
    () => updateTeamTask(first, { id: 'a', status: 'done', expectedRevision: 1 }, { now }),
    error => error.code === 'CAS_CONFLICT' && /当前 revision 2/.test(error.message)
  );
  const done = updateTeamTask(first, {
    id: 'a',
    status: 'done',
    expectedRevision: 2,
    evidence: [{ kind: 'diagnostic', detail: '0 error' }]
  }, { now });
  assert.equal(taskRevision(done[0]), 3);
  assert.equal(done[0].finishedAt, now);
});

test('done 必须带证据；证据追加而不是覆盖', () => {
  const a = task('a');
  assert.throws(
    () => updateTeamTask([a], { id: 'a', status: 'done', expectedRevision: 1 }, { now }),
    error => error.code === 'EVIDENCE_REQUIRED'
  );
  const one = updateTeamTask([a], {
    id: 'a',
    status: 'done',
    expectedRevision: 1,
    evidence: [{ kind: 'commit', ref: 'abc123', detail: '改了 2 个文件' }]
  }, { now });
  const again = updateTeamTask(one, {
    id: 'a',
    status: 'done',
    expectedRevision: 2,
    evidence: [{ kind: 'note', detail: '补充说明' }]
  }, { now });
  assert.deepEqual(again[0].evidence.map(item => item.kind), ['commit', 'note']);
});

test('write 任务同一工作区只能有一个 doing；read 可以共享；换 worktree 可以并行', () => {
  const a = createTeamTask([], { id: 'a', title: 'a', mode: 'write', workspace: '/repo' }, now);
  const b = createTeamTask([], { id: 'b', title: 'b', mode: 'write', workspace: '/repo' }, now);
  const read = createTeamTask([], { id: 'r', title: 'r', mode: 'read', workspace: '/repo' }, now);

  const withA = updateTeamTask([a, b, read], { id: 'a', status: 'doing', expectedRevision: 1 }, { now });
  assert.throws(
    () => updateTeamTask(withA, { id: 'b', status: 'doing', expectedRevision: 1 }, { now, workspaceRoot: '/repo' }),
    error => error.code === 'WORKSPACE_BUSY' && /\/repo/.test(error.message)
  );
  const withRead = updateTeamTask(withA, { id: 'r', status: 'doing', expectedRevision: 1 }, { now, workspaceRoot: '/repo' });
  assert.equal(withRead.find(item => item.id === 'r').status, 'doing');

  const bOther = createTeamTask([], { id: 'b2', title: 'b2', mode: 'write', workspace: '/repo-wt-2' }, now);
  const parallel = updateTeamTask([...withRead, bOther], { id: 'b2', status: 'doing', expectedRevision: 1 }, { now });
  assert.equal(parallel.find(item => item.id === 'b2').status, 'doing');
});

test('未知依赖、重复依赖、自依赖在创建时就被拒', () => {
  const a = task('a');
  assert.throws(
    () => createTeamTask([a], { id: 'b', title: 'b', dependsOn: ['a', 'a'] }, now),
    error => error.code === 'DUPLICATE_DEPENDENCY'
  );
  assert.throws(
    () => createTeamTask([a], { id: 'b', title: 'b', dependsOn: ['nope'] }, now),
    error => error.code === 'UNKNOWN_DEPENDENCY'
  );
  assert.throws(
    () => createTeamTask([a], { id: 'b', title: 'b', dependsOn: ['b'] }, now),
    error => error.code === 'UNKNOWN_DEPENDENCY'
  );
});


test('成员树：parent 必须在协作里，不能自指或成环', () => {
  const root = mergeTeamRoster([], {}, ['root']);
  assert.deepEqual(root.parents, {});
  const first = mergeTeamRoster(root.members, root.parents, ['a', 'b'], 'root');
  assert.deepEqual(first.members, ['root', 'a', 'b']);
  assert.deepEqual(first.parents, { a: 'root', b: 'root' });
  // 已经存在的成员不重挂父级，自指也不会写进树。
  const noSelf = mergeTeamRoster(first.members, first.parents, ['a'], 'a');
  assert.equal(noSelf.parents.a, 'root');
  assert.throws(() => mergeTeamRoster(first.members, first.parents, ['c'], 'outside'), error => error.code === 'UNKNOWN_PARENT');

  const tree = mergeTeamRoster(first.members, first.parents, ['c'], 'a');
  assert.equal(tree.parents.c, 'a');
  // 库里已经有环时，写入前仍会拒绝。
  assert.throws(
    () => mergeTeamRoster(['a', 'b'], { a: 'b', b: 'a' }, []),
    error => error.code === 'MEMBER_CYCLE'
  );
});
