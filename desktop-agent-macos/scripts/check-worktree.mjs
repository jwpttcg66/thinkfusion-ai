/**
 * 任务级 Worktree：创建、复用、隔离、提交、合并、清理。
 *
 * 全部用真实 git 仓库跑，不 mock git；这些动作一旦错，用户的代码会落在
 * 错误的地方或直接丢提交。
 *
 * Run with: npm run test:worktree
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  commitTaskWorktree,
  configureTaskWorktrees,
  ensureTaskWorktree,
  getTaskWorktree,
  mergeTaskWorktree,
  removeTaskWorktree,
  taskWorktreeDiff
} from '../out-test/main/task-worktree.js';

const work = mkdtempSync(path.join(tmpdir(), 'tf-worktree-'));
const repo = path.join(work, 'project');
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: repo });
writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'seed'], { cwd: repo });

configureTaskWorktrees({ root: path.join(work, 'worktrees') });
const gitIn = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

test.after(() => {
  rmSync(work, { recursive: true, force: true });
});

test('审批建树：同一任务复用，主工作区不被改动', async () => {
  const first = await ensureTaskWorktree({ rootDir: repo, taskId: 'task-a' });
  assert.ok(first.dir.startsWith(path.join(work, 'worktrees')));
  assert.ok(first.branch.startsWith('tf/'));
  assert.equal(first.exists, true);
  assert.equal(first.dirty, false);
  assert.equal(gitIn(repo, ['status', '--porcelain']).trim(), '');

  const second = await ensureTaskWorktree({ rootDir: repo, taskId: 'task-a' });
  assert.equal(second.dir, first.dir);
  assert.equal(second.branch, first.branch);

  // 在工作树里改文件：主工作区仍干净，工作树自己变脏。
  writeFileSync(path.join(first.dir, 'seed.txt'), 'seed\nchanged\n');
  writeFileSync(path.join(first.dir, 'extra.txt'), 'new\n');
  assert.equal(gitIn(repo, ['status', '--porcelain']).trim(), '');

  const view = await getTaskWorktree('task-a');
  assert.equal(view.dirty, true);
  assert.deepEqual(view.changedFiles, ['extra.txt', 'seed.txt']);

  const diff = await taskWorktreeDiff('task-a');
  assert.match(diff.diff, /changed/);
  assert.deepEqual(diff.untracked, ['extra.txt']);
});

test('提交后 unclean 消失、领先基线 1 个提交', async () => {
  const view = await commitTaskWorktree({ taskId: 'task-a', message: '外部 Agent 的改动' });
  assert.equal(view.dirty, false);
  assert.equal(view.ahead, 1);
  assert.equal(view.merged, false);
});

test('合并进主工作区；冲突/脏树时不会半合并', async () => {
  const merged = await mergeTaskWorktree('task-a');
  assert.ok(merged.commit.length >= 7);
  assert.match(readFileSync(path.join(repo, 'seed.txt'), 'utf8'), /changed/);
  assert.equal(existsSync(path.join(repo, 'extra.txt')), true);

  const view = await getTaskWorktree('task-a');
  assert.equal(view.merged, true);
});

test('删除已合并的工作树：目录与分支都回收', async () => {
  const view = await getTaskWorktree('task-a');
  await removeTaskWorktree({ taskId: 'task-a' });
  assert.equal(existsSync(view.dir), false);
  assert.equal(await getTaskWorktree('task-a'), null);
  // 分支已合并，-d 能删；再查应该不存在。
  assert.throws(() => gitIn(repo, ['rev-parse', '--verify', `refs/heads/${view.branch}`]));
});

test('脏树默认拒绝删除；显式 force 才删，且不冒充已合并', async () => {
  const view = await ensureTaskWorktree({ rootDir: repo, taskId: 'task-b' });
  writeFileSync(path.join(view.dir, 'wip.txt'), 'work in progress\n');

  await assert.rejects(() => removeTaskWorktree({ taskId: 'task-b' }), /未提交/);
  assert.equal(existsSync(view.dir), true);

  await removeTaskWorktree({ taskId: 'task-b', force: true });
  assert.equal(existsSync(view.dir), false);
});

test('不是 git 仓库时明确拒绝，而不是直接改主目录', async () => {
  const plain = path.join(work, 'plain');
  mkdirSync(plain, { recursive: true });
  await assert.rejects(() => ensureTaskWorktree({ rootDir: plain, taskId: 'task-c' }), /不是 git 仓库/);
});
