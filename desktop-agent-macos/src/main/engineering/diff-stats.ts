/**
 * 改动量统计（阶段 B3）：只在这里跑 `git diff --numstat`，别在投影层现算。
 *
 * 为什么单独一个文件：这条命令有副作用（起子进程）、会失败（不是 git 仓库、
 * HEAD 还没有提交、路径含特殊字符），失败方式是「拿不到数字」而不是「0 行」。
 * 把「跑命令」注入进来，纯逻辑（解析 numstat、合并多段、二进制跳过）就能单测。
 */

import { execFileSync } from 'node:child_process';
import type { DiffFileStat } from '../../shared/contracts';

export interface NumstatTotal {
  insertions: number;
  deletions: number;
  /** 二进制文件在 numstat 里是 `-  -`，不计行数但要记下来，避免被当成「0 改动」。 */
  binaryFiles: number;
  /**
   * 逐文件明细（阶段 1）：与总数是同一次解析的产物，每行一条。
   * `parseNumstat` 一次遍历同时算出两者，不跑第二遍 diff。
   */
  files: DiffFileStat[];
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string
) => { status: number; stdout: string };

export interface DiffStatsResult extends NumstatTotal {
  /** `true` 只代表「总数来自真实 numstat」，不代表有多有少。 */
  available: boolean;
  /** `true` 只代表逐文件明细完整可信；未跟踪文件等无法采集时为 `false`。 */
  filesAvailable: boolean;
  detail: string;
}

/**
 * 解析 `git diff --numstat`：三列分别是增、删、路径（路径可能含空格）。
 *
 * 一次遍历同时算总数与逐文件明细，两者同源，保证「逐文件之和 = 总数」。
 * 路径里带空格时不能用 `split(' ')`；numstat 用 tab 分隔，取前两列后剩下整段都是路径。
 */
export function parseNumstat(stdout: string): NumstatTotal {
  let insertions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  const files: DiffFileStat[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const first = line.indexOf('\t');
    const second = first >= 0 ? line.indexOf('\t', first + 1) : -1;
    if (first < 0 || second < 0) continue;
    const added = line.slice(0, first);
    const removed = line.slice(first + 1, second);
    // 路径可能含 tab（少见），整段照收，不截断。
    const path = line.slice(second + 1).trim();
    if (!path) continue;
    if (added === '-' || removed === '-') {
      binaryFiles += 1;
      files.push({ path, insertions: 0, deletions: 0, binary: true });
      continue;
    }
    const plus = Number.parseInt(added, 10);
    const minus = Number.parseInt(removed, 10);
    if (!Number.isFinite(plus) || !Number.isFinite(minus)) continue;
    insertions += plus;
    deletions += minus;
    files.push({ path, insertions: plus, deletions: minus });
  }
  return { insertions, deletions, binaryFiles, files };
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
 * 逐文件明细是否完整。
 *
 * `git diff --numstat HEAD` 不覆盖未跟踪文件。报告里的 `changedPaths` 是「本轮改了哪些文件」
 * 的权威清单：只要有一个清单里的路径没出现在 numstat 明细里，就说明明细有遗漏
 * （典型是新建但未 add 的文件），必须标 `filesAvailable:false`，不能让界面画一份假清单。
 * 老报告没有 changedPaths 时无法交叉核对，此时以 numstat 本身为准——它采到的都是真的。
 */
export function filesComplete(files: readonly DiffFileStat[], paths: readonly string[]): boolean {
  if (paths.length === 0) return true;
  const known = new Set(files.map(file => file.path));
  return paths.every(path => {
    const clean = path.trim();
    if (!clean) return true;
    if (known.has(clean)) return true;
    // git 对含空格/非 ASCII 的路径会加引号，做一次去引号再比。
    const unquoted = clean.replace(/^"|"$/g, '');
    return known.has(unquoted);
  });
}

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
    return {
      insertions: 0, deletions: 0, binaryFiles: 0, files: [],
      available: false, filesAvailable: false, detail: '没有工作区'
    };
  }
  const run = input.run ?? defaultRunner;
  const paths = (input.paths ?? []).filter(Boolean).slice(0, 200);
  const pathArgs = paths.length > 0 ? ['--', ...paths] : [];

  const head = run('git', ['diff', '--numstat', 'HEAD', ...pathArgs], root);
  if (head.status === 0) {
    const total = parseNumstat(head.stdout);
    return {
      ...total,
      available: true,
      filesAvailable: filesComplete(total.files, paths),
      detail: `git diff --numstat HEAD（${String(total.binaryFiles)} 个二进制）`
    };
  }
  const worktree = run('git', ['diff', '--numstat', ...pathArgs], root);
  if (worktree.status === 0) {
    const total = parseNumstat(worktree.stdout);
    return {
      ...total,
      available: true,
      filesAvailable: filesComplete(total.files, paths),
      detail: 'git diff --numstat（无 HEAD，比较暂存区）'
    };
  }
  return {
    insertions: 0, deletions: 0, binaryFiles: 0, files: [],
    available: false, filesAvailable: false,
    detail: `git diff 失败：HEAD=${String(head.status)} worktree=${String(worktree.status)}`
  };
}

/** 把统计写回报告块；拿不到就只标不可用，不填 0，也不伪造逐文件清单。 */
export function withDiffStats<T extends { changedFiles: number }>(
  verification: T,
  stats: DiffStatsResult
): T & {
  insertions?: number; deletions?: number; diffAvailable: boolean;
  diffFiles?: DiffFileStat[]; diffFilesAvailable?: boolean;
} {
  if (verification.changedFiles <= 0) {
    return { ...verification, diffAvailable: stats.available, diffFilesAvailable: stats.filesAvailable };
  }
  if (!stats.available) {
    return { ...verification, diffAvailable: false, diffFilesAvailable: false };
  }
  return {
    ...verification,
    insertions: stats.insertions,
    deletions: stats.deletions,
    diffAvailable: true,
    // 明细不完整时宁可不写，让界面没有可画的清单，也不伪造。
    ...(stats.filesAvailable ? { diffFiles: stats.files } : {}),
    diffFilesAvailable: stats.filesAvailable
  };
}
