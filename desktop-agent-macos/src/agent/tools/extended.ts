/**
 * 第一批补齐的本地能力：多 hunk 补丁、git worktree、依赖概览、源码骨架。
 *
 * 这几个不是把已有工具换个名字：
 * - `fs.edit` 一次只能改一处字面量；`applyPatch` 按 unified diff 的 hunk
 *   顺序校验上下文，一次改多处，且每一处都对不上就整份拒绝。
 * - `shell.run` 的 workspace-write 白名单只放行只读 git 子命令；worktree 是
 *   会创建/删除目录的写操作，必须走自己的参数白名单，不能交给 shell 拼串。
 * - 依赖概览与源码骨架是「工程证据」的补充，只读、有上限，不调模型。
 *
 * 所有路径都走 `resolveGrantedPath`；写操作一律先算指纹再原子替换。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TaskGrant } from '../../shared/contracts';
import { applyUnifiedHunks, parseUnifiedDiff } from '../../shared/unified-diff';
import { resolveGrantedPath } from '../policy';
import { withFileLock } from './file-lock';
import { runGit } from './git-run';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'out', 'out-test', 'dist', 'build', '.next', 'coverage']);

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function assertMutable(grant: TaskGrant, action: string): void {
  if (grant.permissionPreset === 'read-only') {
    throw new Error(`当前权限为“仅可查看”，禁止${action}`);
  }
}

async function readText(target: string): Promise<string> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('目标必须是普通文件');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过上限 ${MAX_FILE_BYTES} bytes`);
  return fs.readFile(target, 'utf8');
}

/** 同目录临时文件 + rename，读者只会看到旧内容或完整的新内容。 */
async function replaceAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export interface ApplyPatchResult {
  path: string;
  hunks: number;
  previousSha256: string;
  sha256: string;
  bytes: number;
  /** 原始补丁（截断），给界面画 diff 卡。 */
  patch: string;
}

async function applyPatch(
  grant: TaskGrant,
  args: { path: string; patch: string; expectedHash?: string }
): Promise<ApplyPatchResult> {
  assertMutable(grant, '应用补丁');
  const target = await resolveGrantedPath(grant, args.path, false);
  if (!args.expectedHash || !/^[a-f0-9]{64}$/.test(args.expectedHash)) {
    throw new Error(
      'OBSERVATION_REQUIRED：应用补丁前先 fs.readFile / fs.stat 拿到 sha256，并在 expectedHash 里回填'
    );
  }
  return withFileLock(target, async () => {
    const content = await readText(target);
    const previous = sha256(content);
    if (args.expectedHash !== previous) {
      throw new Error('文件在读取之后已经变化，拒绝应用补丁（重新读取再生成计划）');
    }
    const hunks = parseUnifiedDiff(args.patch);
    const next = applyUnifiedHunks(content, hunks);
    await replaceAtomic(target, next);
    // 回读：rename 成功不等于磁盘上是这份内容。
    const written = await readText(target);
    if (sha256(written) !== sha256(next)) {
      throw new Error('写入后回读与预期内容不一致，拒绝把这一步算作成功');
    }
    return {
      path: target,
      hunks: hunks.length,
      previousSha256: previous,
      sha256: sha256(written),
      bytes: Buffer.byteLength(written, 'utf8'),
      patch: args.patch.slice(0, 8000)
    };
  });
}

// ---------------------------------------------------------------------------
// git worktree：参数逐个构造，绝不拼 shell
// ---------------------------------------------------------------------------

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;

function parseWorktrees(porcelain: string): Array<{ path: string; head: string; branch: string }> {
  const out: Array<{ path: string; head: string; branch: string }> = [];
  let current: { path: string; head: string; branch: string } | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), head: '', branch: '' };
      out.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7);
  }
  return out;
}

export interface WorktreeResult {
  action: string;
  exitCode: number;
  output: string;
  worktrees?: Array<{ path: string; head: string; branch: string }>;
}

async function gitWorktree(
  grant: TaskGrant,
  args: { action: 'list' | 'add' | 'remove'; path?: string; branch?: string }
): Promise<WorktreeResult> {
  // list 也要 workspace-write：它是一次真实命令执行，只读档位下不额外开口子。
  assertMutable(grant, '执行 git worktree');
  const cwd = await resolveGrantedPath(grant, '.', false);

  let argv: string[];
  if (args.action === 'list') {
    argv = ['worktree', 'list', '--porcelain'];
  } else {
    if (!args.path) throw new Error(`${args.action} 需要 path`);
    const target = await resolveGrantedPath(grant, args.path, args.action === 'add');
    if (args.action === 'add') {
      if (!args.branch || !BRANCH_NAME.test(args.branch)) throw new Error('branch 不合法');
      argv = ['worktree', 'add', target, args.branch];
    } else {
      argv = ['worktree', 'remove', target];
    }
  }

  const run = await runGit(cwd, argv);
  if (run.exitCode !== 0) {
    throw new Error(`git worktree ${args.action} 失败（退出码 ${run.exitCode}）：${run.stderr.trim() || run.stdout.trim()}`);
  }
  const result: WorktreeResult = {
    action: args.action,
    exitCode: run.exitCode,
    output: run.stdout.trim() || run.stderr.trim()
  };
  if (args.action === 'list') result.worktrees = parseWorktrees(run.stdout);
  return result;
}

// ---------------------------------------------------------------------------
// 只读的工程概览
// ---------------------------------------------------------------------------

export interface DependencyOverview {
  path: string;
  name?: string;
  version?: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  lockfile?: string;
  scripts: string[];
  counts: { dependencies: number; devDependencies: number; peerDependencies: number; optionalDependencies: number };
  dependencies: Array<{ name: string; version: string }>;
}

async function projectDependencies(grant: TaskGrant, args: { path?: string; maxEntries?: number }): Promise<DependencyOverview> {
  const dir = await resolveGrantedPath(grant, args.path ?? '.', false);
  const manifest = path.join(dir, 'package.json');
  const raw = await readText(manifest);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('package.json 不是合法 JSON');
  }

  const deps = (parsed.dependencies ?? {}) as Record<string, string>;
  const dev = (parsed.devDependencies ?? {}) as Record<string, string>;
  const peer = (parsed.peerDependencies ?? {}) as Record<string, string>;
  const optional = (parsed.optionalDependencies ?? {}) as Record<string, string>;
  const limit = Math.min(Math.max(args.maxEntries ?? 40, 1), 200);

  let packageManager: DependencyOverview['packageManager'] = 'unknown';
  let lockfile: string | undefined;
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn']
  ] as const) {
    try {
      await fs.lstat(path.join(dir, file));
      packageManager = manager;
      lockfile = file;
      break;
    } catch {
      // 继续找下一种
    }
  }

  return {
    path: dir,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    version: typeof parsed.version === 'string' ? parsed.version : undefined,
    packageManager,
    lockfile,
    scripts: Object.keys((parsed.scripts ?? {}) as Record<string, string>).slice(0, limit),
    counts: {
      dependencies: Object.keys(deps).length,
      devDependencies: Object.keys(dev).length,
      peerDependencies: Object.keys(peer).length,
      optionalDependencies: Object.keys(optional).length
    },
    dependencies: Object.entries({ ...deps, ...dev, ...peer, ...optional })
      .slice(0, limit)
      .map(([name, version]) => ({ name, version: String(version) }))
  };
}

const SYMBOL_LINE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/;
const PY_SYMBOL_LINE = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/;
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

export interface OutlineResult {
  files: number;
  truncated: boolean;
  symbols: Array<{ file: string; line: number; name: string }>;
}

async function projectOutline(
  grant: TaskGrant,
  args: { path?: string; maxFiles?: number; maxSymbols?: number }
): Promise<OutlineResult> {
  const root = await resolveGrantedPath(grant, args.path ?? '.', false);
  const maxFiles = Math.min(Math.max(args.maxFiles ?? 120, 1), 500);
  const maxSymbols = Math.min(Math.max(args.maxSymbols ?? 200, 1), 1000);
  const symbols: OutlineResult['symbols'] = [];
  const queue: Array<{ dir: string; relative: string }> = [{ dir: root, relative: '' }];
  let files = 0;
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (files >= maxFiles || symbols.length >= maxSymbols) { truncated = true; break; }
    const entries = await fs.readdir(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push({ dir: path.join(current.dir, entry.name), relative: path.join(current.relative, entry.name) });
        }
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXT.has(path.extname(entry.name))) continue;
      if (files >= maxFiles) { truncated = true; break; }
      files += 1;
      const relative = path.join(current.relative, entry.name);
      let text: string;
      try {
        text = await readText(path.join(current.dir, entry.name));
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && symbols.length < maxSymbols; i += 1) {
        const match = (entry.name.endsWith('.py') ? PY_SYMBOL_LINE : SYMBOL_LINE).exec(lines[i]);
        if (match) symbols.push({ file: relative, line: i + 1, name: match[1] });
      }
    }
  }

  return { files, truncated, symbols };
}

export const extendedTools = {
  applyPatch,
  gitWorktree,
  projectDependencies,
  projectOutline
};
