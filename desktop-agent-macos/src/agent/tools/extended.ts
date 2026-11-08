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
import { resolveGrantedPath } from '../policy';
import { runGit } from './git-run';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_HUNKS = 64;
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

interface Hunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  body: string[];
}

/** 解析单文件 unified diff。文件头（--- / +++）只作形状校验，路径不参与定位。 */
function parsePatch(patch: string): Hunk[] {
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw new Error('补丁过大');
  // 末尾换行是补丁文本自身的结束符，不是一条没有前缀的空行。
  const lines = patch.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        body: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.trim() === '') continue;
      throw new Error('补丁缺少 @@ hunk 头，或存在无法识别的行');
    }
    if (line === '\\ No newline at end of file') continue;
    if (!/^[ +\-]/.test(line)) throw new Error('补丁里有既不是上下文也不是增删的行');
    current.body.push(line);
  }

  if (hunks.length === 0) throw new Error('补丁里没有任何 hunk');
  if (hunks.length > MAX_HUNKS) throw new Error(`hunk 数量超过上限 ${MAX_HUNKS}`);
  return hunks;
}

function applyHunks(content: string, hunks: Hunk[]): string {
  const trailingNewline = content.endsWith('\n');
  const original = content.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) original.pop();

  const out: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = hunk.oldStart - 1;
    if (start < cursor || start > original.length) {
      throw new Error(`hunk 起点 ${hunk.oldStart} 越界或与前一个 hunk 重叠`);
    }
    out.push(...original.slice(cursor, start));
    let at = start;
    let added = 0;

    for (const body of hunk.body) {
      const marker = body[0];
      const text = body.slice(1);
      if (marker === '+') {
        out.push(text);
        added += 1;
        continue;
      }
      if (at >= original.length || original[at] !== text) {
        throw new Error(`hunk 上下文不匹配（原文件第 ${at + 1} 行）：补丁可能基于旧版本`);
      }
      if (marker === ' ') out.push(text);
      // '-' 行校验通过后只推进游标，不输出。
      at += 1;
    }

    const consumed = at - start;
    const produced = consumed - hunk.body.filter(line => line[0] === '-').length + added;
    if (consumed !== hunk.oldCount || produced !== hunk.newCount) {
      throw new Error('hunk 的行数声明与实际内容不一致，拒绝应用');
    }
    cursor = at;
  }

  out.push(...original.slice(cursor));
  return out.join('\n') + (trailingNewline ? '\n' : '');
}

export interface ApplyPatchResult {
  path: string;
  hunks: number;
  previousSha256: string;
  sha256: string;
  bytes: number;
}

async function applyPatch(
  grant: TaskGrant,
  args: { path: string; patch: string; expectedHash?: string }
): Promise<ApplyPatchResult> {
  assertMutable(grant, '应用补丁');
  const target = await resolveGrantedPath(grant, args.path, false);
  const content = await readText(target);
  const previous = sha256(content);
  if (args.expectedHash && args.expectedHash !== previous) {
    throw new Error('文件在读取之后已经变化，拒绝应用补丁（重新读取再生成计划）');
  }
  const hunks = parsePatch(args.patch);
  const next = applyHunks(content, hunks);
  await replaceAtomic(target, next);
  return {
    path: target,
    hunks: hunks.length,
    previousSha256: previous,
    sha256: sha256(next),
    bytes: Buffer.byteLength(next, 'utf8')
  };
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
