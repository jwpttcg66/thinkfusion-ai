/**
 * 改动量统计（阶段 B3）：只在这里跑 `git diff --numstat`，别在投影层现算。
 *
 * 为什么单独一个文件：这条命令有副作用（起子进程）、会失败（不是 git 仓库、
 * HEAD 还没有提交、路径含特殊字符），失败方式是「拿不到数字」而不是「0 行」。
 * 把「跑命令」注入进来，纯逻辑（解析 numstat、合并多段、二进制跳过）就能单测。
 */

import { execFileSync } from 'node:child_process';

export interface NumstatTotal {
  insertions: number;
  deletions: number;
  /** 二进制文件在 numstat 里是 `-  -`，不计行数但要记下来，避免被当成「0 改动」。 */
  binaryFiles: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string
) => { status: number; stdout: string };

export interface DiffStatsResult extends NumstatTotal {
  /** `true` 只代表「数字来自真实 numstat」，不代表有多有少。 */
  available: boolean;
  detail: string;
}

/** 解析 `git diff --numstat`：三列分别是增、删、路径（路径可能含空格）。 */
export function parseNumstat(stdout: string): NumstatTotal {
  let insertions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [added, removed] = line.split('\t');
    if (added === '-' || removed === '-') {
      binaryFiles += 1;
      continue;
    }
    const plus = Number.parseInt(added, 10);
    const minus = Number.parseInt(removed, 10);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    insertions += plus;
    deletions += minus;
  }
  return { insertions, deletions, binaryFiles };
}

const defaultRunner: CommandRunner = (command, args, cwd) => {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: 0, stdout };
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 1;
    return { status, stdout: '' };
  }
};

/**
 * 收集改动量。
 *
 * 顺序：`git diff --numstat HEAD`（含已 add 的改动）→ 没有 HEAD 时退回
 * `git diff --numstat`（还没有任何提交的仓库）。两次都失败就如实返回
 * `available:false`，绝不写 `+0 / -0`。
 */
export function collectDiffStats(input: {
  workspaceRoot?: string | null;
  paths?: readonly string[];
  run?: CommandRunner;
}): DiffStatsResult {
  const root = input.workspaceRoot?.trim();
  if (!root) {
    return { insertions: 0, deletions: 0, binaryFiles: 0, available: false, detail: '没有工作区' };
  }
  const run = input.run ?? defaultRunner;
  const paths = (input.paths ?? []).filter(Boolean).slice(0, 200);
  const pathArgs = paths.length > 0 ? ['--', ...paths] : [];

  const head = run('git', ['diff', '--numstat', 'HEAD', ...pathArgs], root);
  if (head.status === 0) {
    const total = parseNumstat(head.stdout);
    return { ...total, available: true, detail: `git diff --numstat HEAD（${String(total.binaryFiles)} 个二进制）` };
  }
  const worktree = run('git', ['diff', '--numstat', ...pathArgs], root);
  if (worktree.status === 0) {
    const total = parseNumstat(worktree.stdout);
    return { ...total, available: true, detail: `git diff --numstat（无 HEAD，比较暂存区）` };
  }
  return {
    insertions: 0,
    deletions: 0,
    binaryFiles: 0,
    available: false,
    detail: `git diff 失败：HEAD=${String(head.status)} worktree=${String(worktree.status)}`
  };
}

/** 把统计写回报告块；拿不到就只标 `diffAvailable:false`，不填 0。 */
export function withDiffStats<T extends { changedFiles: number }>(
  verification: T,
  stats: DiffStatsResult
): T & { insertions?: number; deletions?: number; diffAvailable: boolean } {
  if (verification.changedFiles <= 0) return { ...verification, diffAvailable: stats.available };
  if (!stats.available) return { ...verification, diffAvailable: false };
  return { ...verification, insertions: stats.insertions, deletions: stats.deletions, diffAvailable: true };
}
