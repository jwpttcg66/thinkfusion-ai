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

const GIT_TIMEOUT_MS = 15_000;
const MAX_CHUNK_CHARS = 1_900;

export interface DirtyFileChunk {
  path: string;
  status: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

export interface ResolvedRepository {
  requestedRoot: string;
  root: string;
  commit: string;
  branch: string;
  dirty: boolean;
  chunks: DirtyFileChunk[];
  /** 无法完整冻结的文件/行；有内容时 Pack 只能标 partial。 */
  errors: string[];
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
      throw new Error(`单行超过 ${String(MAX_CHUNK_CHARS)} 字符：${relative}:${String(index + 1)}`);
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
    statusRaw = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z'], {
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
  const errors: string[] = [];
  for (const entry of entries) {
    if (entry.status.includes('D')) {
      errors.push(`删除的文件无法冻结内容：${entry.path}`);
      continue;
    }
    let content: string;
    try {
      const raw = fs.readFileSync(path.join(root, entry.path));
      if (raw.includes(0) || Buffer.from(raw.toString('utf8'), 'utf8').compare(raw) !== 0) {
        errors.push(`二进制/非 UTF-8 文件无法冻结：${entry.path}`);
        continue;
      }
      content = raw.toString('utf8');
    } catch {
      errors.push(`读不到文件：${entry.path}`);
      continue;
    }
    if (content.length === 0) {
      errors.push(`空文件没有可冻结的内容：${entry.path}`);
      continue;
    }
    try {
      chunks.push(...chunksOf(entry.path, entry.status, content));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const fingerprint = createHash('sha256')
    .update(
      chunks
        .map(chunk => `${chunk.path}:${chunk.startLine}-${chunk.endLine}:${chunk.contentHash}`)
        .concat(errors.map(error => `error:${error}`))
        .sort()
        .join('\n'),
      'utf8'
    )
    .digest('hex');

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
