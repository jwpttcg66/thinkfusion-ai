/**
 * 工程上下文解析：把「用户选中的目录」变成可冻结的 Git 基准。
 *
 * 只做三件事：找到真正的仓库根、读出 HEAD/分支/dirty 清单、把 dirty 文件
 * 切成可放进 Evidence Pack 的片段。不做任务 Worktree 的创建，也不复制整个
 * 仓库——干净仓库只记 commit；dirty 仓库只冻结实际改动/未跟踪文件。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { snapshotFingerprintOf } from './snapshot';
import type { EvidencePackSnapshot, EvidencePackSnapshotFile, EvidencePackSnapshotIssue } from './types';

const GIT_TIMEOUT_MS = 15_000;
const MAX_CHUNK_CHARS = 1_900;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface DirtyFileChunk {
  path: string;
  status: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

export type RepositoryIssueCode =
  | 'deleted'
  | 'empty'
  | 'unreadable'
  | 'symlink'
  | 'binary'
  | 'too-large'
  | 'path-escape'
  | 'line-too-long'
  | 'non-file';

export interface RepositoryIssue {
  code: RepositoryIssueCode;
  path?: string;
  message: string;
}

export interface ResolvedRepository {
  requestedRoot: string;
  root: string;
  commit: string;
  branch: string;
  dirty: boolean;
  chunks: DirtyFileChunk[];
  /** 无法完整冻结的文件/行；有内容时 Pack 只能标 partial。 */
  errors: RepositoryIssue[];
  dirtyFingerprint?: string;
  resolvedAt: number;
}

export interface RepositoryResolution {
  context?: ResolvedRepository;
  /** 整个仓库不可用（不是某个文件失败）。 */
  error?: string;
}

interface StatusEntry {
  status: string;
  path: string;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function parseStatus(raw: string): StatusEntry[] {
  const tokens = raw.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const status = token.slice(0, 2);
    const file = token.slice(3);
    if (!file) continue;
    entries.push({ status, path: file });
    // rename/copy 在 -z 下多带一个原路径 token，跳过它，别当成新文件。
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return entries;
}

function chunksOf(relative: string, status: string, content: string): DirtyFileChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: DirtyFileChunk[] = [];
  let start = 1;
  let buffer: string[] = [];
  let chars = 0;

  const flush = (endLine: number) => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n');
    chunks.push({
      path: relative,
      status,
      startLine: start,
      endLine,
      content: text,
      contentHash: createHash('sha256').update(text, 'utf8').digest('hex')
    });
    start = endLine + 1;
    buffer = [];
    chars = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > MAX_CHUNK_CHARS) {
      const error = new Error(`单行超过 ${String(MAX_CHUNK_CHARS)} 字符：${relative}:${String(index + 1)}`);
      error.name = 'TOO_LONG_LINE';
      throw error;
    }
    if (buffer.length > 0 && chars + line.length + 1 > MAX_CHUNK_CHARS) {
      flush(index);
    }
    buffer.push(line);
    chars += line.length + 1;
  }
  flush(lines.length);
  return chunks;
}

/**
 * 解析工程目录。`rootDir` 必须是用户/会话明确绑定的目录，不允许调用方拿
 * 全局默认目录来兜底——历史辩论不能因为今天切了工作区就指向另一份代码。
 */
export function resolveRepositoryContext(rootDir: string): RepositoryResolution {
  const requestedRoot = path.resolve(rootDir);
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
    return { error: `工程目录不存在：${requestedRoot}` };
  }

  let root: string;
  let commit: string;
  try {
    root = path.resolve(git(requestedRoot, ['rev-parse', '--show-toplevel']));
    commit = git(root, ['rev-parse', 'HEAD']);
  } catch (error) {
    return { error: `不是可用的 Git 仓库：${error instanceof Error ? error.message : String(error)}` };
  }

  let branch = 'HEAD';
  try {
    branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'HEAD';
  } catch {
    // 分离 HEAD 或异常时保留 HEAD，不编一个分支名。
  }

  let statusRaw = '';
  try {
    statusRaw = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    return { error: `读取工作区状态失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const entries = parseStatus(statusRaw);
  const chunks: DirtyFileChunk[] = [];
  const errors: RepositoryIssue[] = [];
  for (const entry of entries) {
    if (entry.status.includes('D')) {
      errors.push({ code: 'deleted', path: entry.path, message: `删除的文件无法冻结内容：${entry.path}` });
      continue;
    }
    const absolute = path.resolve(root, entry.path);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      errors.push({ code: 'path-escape', path: entry.path, message: `路径越出仓库：${entry.path}` });
      continue;
    }
    let content: string;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        // 只冻结链接目标字符串会泄露仓库外路径；冻结链接指向的内容则会把
        // 仓库外文件带进证据。这里直接标 partial，让人明确看见缺口。
        errors.push({ code: 'symlink', path: entry.path, message: `符号链接不冻结目标内容：${entry.path}` });
        continue;
      }
      if (!stat.isFile()) {
        errors.push({ code: 'non-file', path: entry.path, message: `不是普通文件：${entry.path}` });
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        errors.push({ code: 'too-large', path: entry.path, message: `文件超过 ${String(MAX_FILE_BYTES)} 字节：${entry.path}` });
        continue;
      }
      const raw = fs.readFileSync(absolute);
      if (raw.includes(0) || Buffer.from(raw.toString('utf8'), 'utf8').compare(raw) !== 0) {
        errors.push({ code: 'binary', path: entry.path, message: `二进制/非 UTF-8 文件无法冻结：${entry.path}` });
        continue;
      }
      content = raw.toString('utf8');
    } catch {
      errors.push({ code: 'unreadable', path: entry.path, message: `读不到文件：${entry.path}` });
      continue;
    }
    if (content.length === 0) {
      errors.push({ code: 'empty', path: entry.path, message: `空文件没有可冻结的内容：${entry.path}` });
      continue;
    }
    try {
      chunks.push(...chunksOf(entry.path, entry.status, content));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof Error && error.name === 'TOO_LONG_LINE' ? 'line-too-long' : 'unreadable';
      errors.push({ code, path: entry.path, message });
    }
  }

  const snapshot = snapshotOfRepository(chunks, errors);
  const fingerprint = snapshotFingerprintOf(snapshot.files, snapshot.errors);

  return {
    context: {
      requestedRoot,
      root,
      commit,
      branch,
      dirty: entries.length > 0,
      chunks,
      errors,
      ...(entries.length > 0 ? { dirtyFingerprint: fingerprint } : {}),
      resolvedAt: Date.now()
    }
  };
}

/** 把 chunks + issues 转成结构化的 snapshot 元数据，供 manifest 校验。 */
export function snapshotOfRepository(
  chunks: readonly DirtyFileChunk[],
  errors: readonly RepositoryIssue[]
): EvidencePackSnapshot {
  const byPath = new Map<string, EvidencePackSnapshotFile>();
  const globalErrors: EvidencePackSnapshotIssue[] = [];
  const fileOf = (relative: string): EvidencePackSnapshotFile => {
    let file = byPath.get(relative);
    if (!file) {
      file = { path: relative, ranges: [], issues: [] };
      byPath.set(relative, file);
    }
    return file;
  };
  for (const chunk of chunks) {
    fileOf(chunk.path).ranges.push({
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      contentHash: chunk.contentHash
    });
  }
  for (const error of errors) {
    const issue: EvidencePackSnapshotIssue = {
      code: error.code,
      ...(error.path ? { path: error.path } : {}),
      message: error.message
    };
    if (error.path) fileOf(error.path).issues.push(issue);
    else globalErrors.push(issue);
  }
  return {
    version: 1,
    dirty: chunks.length > 0 || errors.length > 0,
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    errors: globalErrors
  };
}

/** 给 baseline 用：把解析结果转成可写入 manifest 的快照。 */
export function snapshotOfResolvedRepository(context: ResolvedRepository): EvidencePackSnapshot {
  const snapshot = snapshotOfRepository(context.chunks, context.errors);
  return {
    ...snapshot,
    dirty: context.dirty,
    ...(context.dirtyFingerprint ? { dirtyFingerprint: context.dirtyFingerprint } : {})
  };
}
