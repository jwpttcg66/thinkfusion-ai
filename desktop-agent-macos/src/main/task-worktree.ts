/**
 * 任务级 Worktree 的创建、查看、提交、合并与清理。
 *
 * 主进程持有这门能力，Runtime 只在授权里收到一个绝对路径。这样：
 *
 * - 模型不能指定工作树位置，也不能用 `..` 跑出执行目录；
 * - 审批时就能知道「这次改的是哪一棵树」，而不是等执行完才发现改错了地方；
 * - 合并与删除都需要用户显式点，不在执行链路里自动做。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  TaskWorktreeCommitInput,
  TaskWorktreeDiff,
  TaskWorktreeMergeResult,
  TaskWorktreeRemoveInput,
  TaskWorktreeView
} from '../shared/worktree';

interface WorktreeRecord {
  taskId: string;
  rootDir: string;
  dir: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  createdAt: number;
}

interface StoreFile {
  worktrees?: Record<string, WorktreeRecord>;
}

let storeFile: string | null = null;
let storeRoot = '';
let records: Record<string, WorktreeRecord> = {};

export function configureTaskWorktrees(input: { root: string }) {
  storeRoot = input.root;
  storeFile = path.join(input.root, 'worktrees.json');
  records = load();
}

function load(): Record<string, WorktreeRecord> {
  if (!storeFile) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as StoreFile;
    return raw.worktrees ?? {};
  } catch {
    return {};
  }
}

function save(): void {
  if (!storeFile) return;
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, `${JSON.stringify({ worktrees: records }, null, 2)}\n`, 'utf8');
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? Number((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

async function gitOk(cwd: string, args: string[], what: string): Promise<string> {
  const run = await git(cwd, args);
  if (run.code !== 0) {
    const detail = (run.stderr || run.stdout).trim().split('\n').slice(0, 4).join(' ');
    throw new Error(`${what}失败：${detail || `git ${args.join(' ')} 退出码 ${String(run.code)}`}`);
  }
  return run.stdout.trim();
}

function sanitize(value: string, max = 40): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned.slice(0, max) || 'task';
}

function branchFor(taskId: string): string {
  const hash = createHash('sha1').update(taskId).digest('hex').slice(0, 6);
  return `tf/${sanitize(taskId, 32)}-${hash}`;
}

function dirFor(rootDir: string, taskId: string): string {
  const hash = createHash('sha1').update(taskId).digest('hex').slice(0, 6);
  const repo = sanitize(path.basename(rootDir), 30);
  return path.join(storeRoot, `${repo}-${sanitize(taskId, 24)}-${hash}`);
}

function statusEntries(porcelain: string): string[] {
  const parts = porcelain.split('\0').filter(Boolean);
  const files = new Set<string>();
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry.length < 4) continue;
    const state = entry.slice(0, 2);
    files.add(entry.slice(3));
    if (state[0] === 'R' || state[0] === 'C') {
      const from = parts[index + 1];
      if (from) files.add(from);
      index += 1;
    }
  }
  return [...files].sort();
}

async function isWorktree(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  const run = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  return run.code === 0 && run.stdout.trim() === 'true';
}

async function viewOf(record: WorktreeRecord): Promise<TaskWorktreeView> {
  const exists = await isWorktree(record.dir);
  let dirty = false;
  let changedFiles: string[] = [];
  let ahead = 0;
  let merged = false;

  if (exists) {
    const status = await git(record.dir, ['status', '--porcelain=v1', '-z']);
    changedFiles = status.code === 0 ? statusEntries(status.stdout) : [];
    dirty = changedFiles.length > 0;

    const count = await git(record.dir, ['rev-list', '--count', `${record.baseCommit}..HEAD`]);
    ahead = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;

    const ancestor = await git(record.rootDir, ['merge-base', '--is-ancestor', record.branch, 'HEAD']);
    merged = ancestor.code === 0;
  }

  return {
    taskId: record.taskId,
    rootDir: record.rootDir,
    dir: record.dir,
    branch: record.branch,
    baseBranch: record.baseBranch,
    baseCommit: record.baseCommit,
    createdAt: record.createdAt,
    exists,
    dirty,
    changedFiles,
    ahead,
    merged
  };
}

/**
 * 审批时调用：同一任务复用同一棵树；树没了就按原分支重建。
 * 仓库没有提交、或路径已被非工作树占用时明确失败。
 */
export async function ensureTaskWorktree(input: { rootDir: string; taskId: string }): Promise<TaskWorktreeView> {
  if (!storeRoot) throw new Error('工作树存储未初始化');
  const existing = records[input.taskId];
  if (existing) {
    // 同一任务换了工作区：旧树基于另一个仓库，继续用会把改动落到错误的地方。
    if (existing.rootDir !== input.rootDir) {
      throw new Error(`这个任务已有一棵基于 ${existing.rootDir} 的工作树，不能改用 ${input.rootDir}`);
    }
    if (await isWorktree(existing.dir)) return viewOf(existing);
    // 目录被手工删了：清掉陈旧记录，按同一分支重建。
    delete records[input.taskId];
  }

  const top = await git(input.rootDir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    throw new Error('外部 Agent 需要独立工作树，但当前工作区不是 git 仓库；请先在项目里 git init 并提交一次');
  }
  const head = await git(input.rootDir, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    throw new Error('仓库还没有任何提交，无法创建独立工作树；先提交一次再执行外部 Agent');
  }
  const baseCommit = head.stdout.trim();
  const baseBranchRun = await git(input.rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch =
    baseBranchRun.code === 0 && baseBranchRun.stdout.trim() !== 'HEAD'
      ? baseBranchRun.stdout.trim()
      : baseCommit.slice(0, 12);

  const dir = dirFor(input.rootDir, input.taskId);
  const branch = branchFor(input.taskId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !(await isWorktree(dir))) {
    throw new Error(`工作树目录已存在且不是 git 工作树：${dir}`);
  }

  const branchExists = await git(input.rootDir, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  const add =
    branchExists.code === 0
      ? await git(input.rootDir, ['worktree', 'add', dir, branch])
      : await git(input.rootDir, ['worktree', 'add', '-b', branch, dir, baseCommit]);
  if (add.code !== 0) {
    throw new Error(`创建独立工作树失败：${(add.stderr || add.stdout).trim().split('\n')[0] || `退出码 ${String(add.code)}`}`);
  }

  const record: WorktreeRecord = {
    taskId: input.taskId,
    rootDir: input.rootDir,
    dir,
    branch,
    baseBranch,
    baseCommit,
    createdAt: Date.now()
  };
  records[input.taskId] = record;
  save();
  return viewOf(record);
}

export async function getTaskWorktree(taskId: string): Promise<TaskWorktreeView | null> {
  const record = records[taskId];
  if (!record) return null;
  return viewOf(record);
}

export async function taskWorktreeDiff(taskId: string): Promise<TaskWorktreeDiff> {
  const record = records[taskId];
  if (!record) throw new Error('这个任务没有独立工作树');
  if (!(await isWorktree(record.dir))) throw new Error('工作树目录已经不存在');

  const diff = await git(record.dir, ['diff', 'HEAD', '--no-color']);
  const untracked = await git(record.dir, ['ls-files', '--others', '--exclude-standard']);
  const full = diff.code === 0 ? diff.stdout : '';
  const LIMIT = 200_000;
  return {
    dir: record.dir,
    branch: record.branch,
    diff: full.length > LIMIT ? `${full.slice(0, LIMIT)}\n…（已截断，共 ${String(full.length)} 字符）` : full,
    untracked: untracked.code === 0 ? untracked.stdout.split('\n').map(item => item.trim()).filter(Boolean) : [],
    truncated: full.length > LIMIT
  };
}

export async function commitTaskWorktree(input: TaskWorktreeCommitInput): Promise<TaskWorktreeView> {
  const record = records[input.taskId];
  if (!record) throw new Error('这个任务没有独立工作树');
  const message = input.message.trim();
  if (!message) throw new Error('提交信息不能为空');
  if (message.length > 200) throw new Error('提交信息最多 200 字');

  const status = await git(record.dir, ['status', '--porcelain=v1', '-z']);
  if (status.code !== 0) throw new Error('读不到工作树状态');
  if (statusEntries(status.stdout).length === 0) throw new Error('工作树没有改动，不需要提交');

  await gitOk(record.dir, ['add', '-A'], '暂存工作树改动');
  const commit = await git(record.dir, ['commit', '-m', message]);
  if (commit.code !== 0) {
    throw new Error(`提交失败：${(commit.stderr || commit.stdout).trim().split('\n').slice(-2).join(' ')}`);
  }
  return viewOf(record);
}

export async function mergeTaskWorktree(taskId: string): Promise<TaskWorktreeMergeResult> {
  const view = await getTaskWorktree(taskId);
  if (!view) throw new Error('这个任务没有独立工作树');
  if (!view.exists) throw new Error('工作树目录已经不存在');
  if (view.dirty) throw new Error('工作树还有未提交改动：先提交，再合并');

  const record = records[taskId];
  const merged = await git(record.rootDir, ['merge', '--no-ff', '--no-edit', record.branch]);
  if (merged.code !== 0) {
    // 不留半合并状态：冲突时自动 abort，把错误原样交给用户。
    await git(record.rootDir, ['merge', '--abort']);
    throw new Error(`合并失败，已回滚：${(merged.stderr || merged.stdout).trim().split('\n').slice(0, 3).join(' ')}`);
  }
  const head = await gitOk(record.rootDir, ['rev-parse', 'HEAD'], '读取合并结果');
  return {
    taskId,
    branch: record.branch,
    commit: head,
    message: (merged.stdout || '').trim().split('\n')[0] ?? `已合并 ${record.branch}`
  };
}

export async function removeTaskWorktree(input: TaskWorktreeRemoveInput): Promise<void> {
  const record = records[input.taskId];
  if (!record) throw new Error('这个任务没有独立工作树');

  if (await isWorktree(record.dir)) {
    const status = await git(record.dir, ['status', '--porcelain=v1', '-z']);
    const dirty = status.code === 0 && statusEntries(status.stdout).length > 0;
    if (dirty && input.force !== true) {
      throw new Error('工作树有未提交改动：先提交或合并，或显式选择强制删除');
    }
    const removed = await git(record.rootDir, ['worktree', 'remove', '--force', record.dir]);
    if (removed.code !== 0) {
      throw new Error(`删除工作树失败：${(removed.stderr || removed.stdout).trim().split('\n')[0]}`);
    }
  } else {
    await git(record.rootDir, ['worktree', 'prune']);
  }

  const deleteBranch = await git(record.rootDir, [
    'branch',
    input.force === true ? '-D' : '-d',
    record.branch
  ]);
  if (deleteBranch.code !== 0 && input.force !== true) {
    // 分支没合并时保留它：删掉等于把用户的提交弄丢。
    delete records[input.taskId];
    save();
    throw new Error(`工作树已删除，但分支 ${record.branch} 还没有合并，已保留`);
  }

  delete records[input.taskId];
  save();
}
