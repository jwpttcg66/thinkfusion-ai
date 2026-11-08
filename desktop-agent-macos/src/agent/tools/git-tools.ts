/**
 * git 读与轻写：status / diff / log / show / stash / branch。
 *
 * 为什么不让模型 `shell.run git ...`：
 * - `shell.run` 的 workspace-write 白名单只放行只读 git 子命令，且拿回来的
 *   是一段文本；这里给的是结构化结果（分支、ahead/behind、逐文件状态、逐条
 *   提交），模型不必再解析人读格式；
 * - stash / branch / switch 会改仓库状态，必须走自己的动作白名单，
 *   参数逐个构造，绝不经 shell；
 * - 输出一律有上限，超大 diff 会被截断并明确标注，而不是悄悄少几万行。
 *
 * 所有路径先过 `resolveGrantedPath`，引用名先过 `assertSafeRef`。
 */

import path from 'node:path';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';
import { assertSafeRef, gitFailure, GIT_MAX_OUTPUT, runGit } from './git-run';

const MAX_DIFF_BYTES = 256 * 1024;

function assertMutable(grant: TaskGrant, action: string): void {
  if (grant.permissionPreset === 'read-only') {
    throw new Error(`当前权限为“仅可查看”，禁止${action}`);
  }
}

/** 工作区里的相对 pathspec：绝对路径 git 不认，越界路径这里就会先被拒。 */
async function pathspec(grant: TaskGrant, root: string, input?: string): Promise<string | undefined> {
  if (!input) return undefined;
  const target = await resolveGrantedPath(grant, input, false);
  const relative = path.relative(root, target);
  if (relative.startsWith('..')) throw new Error('path 不在授权目录内');
  return relative || '.';
}

export interface GitStatusResult {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  changes: Array<{ path: string; index: string; worktree: string; untracked: boolean }>;
  truncated: boolean;
}

/** `git status --porcelain=v1 -z` 逐条读；重命名条目会多一个「来源路径」，跳过它。 */
function parsePorcelain(raw: string): GitStatusResult['changes'] {
  const changes: GitStatusResult['changes'] = [];
  const parts = raw.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    const file = entry.slice(3);
    changes.push({ path: file, index, worktree, untracked: index === '?' });
    // 'R' / 'C' 后面紧跟一条原始路径，它属于这一条记录，不是新文件。
    if (index === 'R' || index === 'C') i += 1;
  }
  return changes;
}

async function gitStatus(grant: TaskGrant, args: { path?: string; maxEntries?: number }): Promise<GitStatusResult> {
  const root = await resolveGrantedPath(grant, args.path ?? '.', false);
  const status = await runGit(root, ['status', '--porcelain=v1', '-z']);
  if (status.exitCode !== 0) throw gitFailure('status', status);

  const branchRun = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRun.exitCode === 0 ? branchRun.stdout.trim() : '(还没有提交)';

  const upstreamRun = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = upstreamRun.exitCode === 0 ? upstreamRun.stdout.trim() : null;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const countRun = await runGit(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    if (countRun.exitCode === 0) {
      const [left, right] = countRun.stdout.trim().split(/\s+/);
      behind = Number(left) || 0;
      ahead = Number(right) || 0;
    }
  }

  const limit = Math.min(Math.max(args.maxEntries ?? 200, 1), 2000);
  const all = parsePorcelain(status.stdout);
  return {
    branch,
    upstream,
    ahead,
    behind,
    clean: all.length === 0,
    changes: all.slice(0, limit),
    truncated: all.length > limit
  };
}

export interface GitDiffResult {
  staged: boolean;
  commit: string | null;
  bytes: number;
  truncated: boolean;
  text: string;
}

async function gitDiff(
  grant: TaskGrant,
  args: { path?: string; staged?: boolean; commit?: string; maxBytes?: number }
): Promise<GitDiffResult> {
  const root = await resolveGrantedPath(grant, '.', false);
  const file = await pathspec(grant, root, args.path);
  const argv = ['diff', '--no-color', '--unified=3'];
  if (args.staged) argv.push('--cached');
  if (args.commit) argv.push(assertSafeRef(args.commit, 'commit'));
  if (file) argv.push('--', file);

  // 大 diff 用 git 自己的截断，避免把几十 MB 读进内存再裁。
  const maxBytes = Math.min(Math.max(args.maxBytes ?? 64 * 1024, 1024), MAX_DIFF_BYTES);
  const run = await runGit(root, argv);
  if (run.exitCode !== 0) throw gitFailure('diff', run);
  const text = run.stdout;
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return {
    staged: Boolean(args.staged),
    commit: args.commit ? assertSafeRef(args.commit, 'commit') : null,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: Buffer.byteLength(text, 'utf8') > maxBytes,
    text: cut
  };
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

/** 用 0x1f 分隔字段：提交标题里可能有 `:`、`|` 甚至制表符，只有控制符够稳。 */
async function gitLog(
  grant: TaskGrant,
  args: { path?: string; limit?: number; maxEntries?: number }
): Promise<{ entries: GitLogEntry[]; truncated: boolean }> {
  const root = await resolveGrantedPath(grant, '.', false);
  const limit = Math.min(Math.max(args.limit ?? args.maxEntries ?? 20, 1), 200);
  const file = await pathspec(grant, root, args.path);
  const argv = ['log', '--no-color', '-n', String(limit + 1), '--pretty=format:%h%x1f%an%x1f%aI%x1f%s'];
  if (file) argv.push('--', file);

  const run = await runGit(root, argv);
  // 空仓库（还没有任何提交）不是错误，返回空列表让模型知道「确实是空的」。
  if (run.exitCode !== 0) {
    if (/does not have any commits yet|bad default revision/i.test(run.stderr)) {
      return { entries: [], truncated: false };
    }
    throw gitFailure('log', run);
  }

  const rows = run.stdout.split('\n').filter(Boolean);
  const entries = rows.slice(0, limit).map(line => {
    const [hash, author, date, subject] = line.split('\x1f');
    return { hash, author, date, subject };
  });
  return { entries, truncated: rows.length > limit };
}

async function gitShow(
  grant: TaskGrant,
  args: { commit: string; stat?: boolean; maxBytes?: number }
): Promise<GitDiffResult & { commit: string }> {
  const root = await resolveGrantedPath(grant, '.', false);
  const commit = assertSafeRef(args.commit, 'commit');
  const maxBytes = Math.min(Math.max(args.maxBytes ?? 64 * 1024, 1024), MAX_DIFF_BYTES);
  const argv = ['show', '--no-color', '--date=iso-strict', '--pretty=format:%h %an %aI%n%s%n'];
  if (args.stat) argv.push('--stat');
  argv.push(commit, '--');

  const run = await runGit(root, argv);
  if (run.exitCode !== 0) throw gitFailure('show', run);
  const total = Buffer.byteLength(run.stdout, 'utf8');
  return {
    commit,
    staged: false,
    bytes: total,
    truncated: total > maxBytes,
    text: Buffer.from(run.stdout, 'utf8').subarray(0, maxBytes).toString('utf8')
  };
}

export interface GitStashResult {
  action: string;
  exitCode: number;
  output: string;
}

async function gitStash(
  grant: TaskGrant,
  args: { action: 'list' | 'push' | 'pop' | 'drop'; message?: string; index?: number }
): Promise<GitStashResult> {
  assertMutable(grant, `执行 git stash ${args.action}`);
  const root = await resolveGrantedPath(grant, '.', false);

  let argv: string[];
  if (args.action === 'list') argv = ['stash', 'list', '--no-color'];
  else if (args.action === 'push') {
    argv = ['stash', 'push'];
    if (args.message) argv.push('-m', args.message.slice(0, 200));
  } else if (args.action === 'pop') {
    argv = ['stash', 'pop'];
    if (args.index !== undefined) argv.push(`stash@{${Math.max(0, Math.trunc(args.index))}}`);
  } else {
    // drop 必须指明是哪一条：不给下标就默认 stash@{0} 也是显式的，但会被误删，
    // 所以这里要求调用方写清楚。
    if (args.index === undefined) throw new Error('drop 需要 index，说明要丢掉第几条 stash');
    argv = ['stash', 'drop', `stash@{${Math.max(0, Math.trunc(args.index))}}`];
  }

  const run = await runGit(root, argv);
  if (run.exitCode !== 0) throw gitFailure(`stash ${args.action}`, run);
  return { action: args.action, exitCode: run.exitCode, output: run.stdout.trim() || run.stderr.trim() };
}

export interface GitBranchResult {
  action: string;
  current: string;
  branches: Array<{ name: string; current: boolean }>;
  output: string;
}

async function gitBranch(
  grant: TaskGrant,
  args: { action: 'list' | 'create' | 'switch'; name?: string }
): Promise<GitBranchResult> {
  const root = await resolveGrantedPath(grant, '.', false);
  if (args.action !== 'list') {
    assertMutable(grant, `执行 git branch ${args.action}`);
    const name = assertSafeRef(args.name ?? '', 'branch');
    const argv = args.action === 'create' ? ['branch', name] : ['switch', name];
    const run = await runGit(root, argv);
    if (run.exitCode !== 0) throw gitFailure(`branch ${args.action}`, run);
  }

  const listRun = await runGit(root, ['branch', '--no-color', '--format=%(HEAD)%09%(refname:short)']);
  if (listRun.exitCode !== 0) throw gitFailure('branch list', listRun);
  const branches = listRun.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [mark, name] = line.split('\t');
      return { name: (name ?? '').trim(), current: mark.trim() === '*' };
    });
  return {
    action: args.action,
    current: branches.find(item => item.current)?.name ?? '',
    branches,
    output: args.action === 'list' ? '' : `${args.action} ${args.name ?? ''}`.trim()
  };
}

export const gitTools = {
  gitStatus,
  gitDiff,
  gitLog,
  gitShow,
  gitStash,
  gitBranch
};

/** 供测试用：确认输出上限没有被悄悄放宽。 */
export const GIT_TOOL_LIMITS = { MAX_DIFF_BYTES, GIT_MAX_OUTPUT };
