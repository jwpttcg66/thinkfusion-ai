/**
 * 以开场 Evidence Pack 为唯一依据的源码定位。
 *
 * 关键约束（不能放松）：
 * - 干净文件只从开场 commit 读，不读当前工作区；
 * - dirty 文件只从开场 Pack 的 dirty overlay 重组，不读当前工作区；
 * - Pack/ manifest / blob / 快照指纹任一校验失败，都不产生 baseline-verified；
 * - 引用存在只证明「基准里确实有这段代码」，不证明它支持某条 Claim。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sha256Hex } from './hash';
import { snapshotFingerprint } from './snapshot';
import type { EvidencePackStore } from './store';
import type {
  EvidencePackItem,
  EvidencePackManifest,
  EvidencePackSnapshotFile,
  EvidencePackSnapshotRange
} from './types';
import type { CodeReferenceCandidate } from './code-references';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINE_COUNT = 20_000;
const MAX_EXCERPT_CHARS = 2_000;

export type BaselineVerificationStatus = 'baseline-verified' | 'partial' | 'unavailable' | 'rejected';

export type BaselineResolveErrorCode =
  | 'NO_REPOSITORY'
  | 'NO_BASELINE'
  | 'PACK_MISMATCH'
  | 'PACK_UNAVAILABLE'
  | 'PACK_CORRUPT'
  | 'SNAPSHOT_MISSING'
  | 'SNAPSHOT_CORRUPT'
  | 'PATH_INVALID'
  | 'FILE_UNFROZEN'
  | 'FILE_NOT_IN_BASELINE'
  | 'RANGE_INVALID'
  | 'FILE_TOO_LARGE'
  | 'RANGE_TOO_LARGE'
  | 'BINARY'
  | 'SYMLINK'
  | 'GIT_READ_FAILED'
  | 'CHUNK_GAP'
  | 'CHUNK_OVERLAP'
  | 'CHUNK_MISSING'
  | 'FINGERPRINT_MISMATCH';

export interface BaselineDebateState {
  debateId: string;
  repository?: {
    root: string;
    commit: string;
    branch: string;
    dirty: boolean;
    dirtyFingerprint?: string;
  };
  evidencePack?: {
    status: 'complete' | 'partial' | 'failed' | 'unavailable';
    baselinePackId?: string;
  };
}

export interface BaselineResolvedReference {
  status: Exclude<BaselineVerificationStatus, 'rejected' | 'unavailable'>;
  snapshotVerification: 'verified' | 'partial';
  baselinePackId: string;
  commit: string;
  source: 'git-commit' | 'dirty-overlay';
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  /** 片段原始 UTF-8 内容的 sha256；不是 Pack blob hash。 */
  excerptHash: string;
  /** 文件总行数（不含末尾换行产生的空行）。 */
  lineCount: number;
}

export interface BaselineResolveResult {
  status: BaselineVerificationStatus;
  resolved?: BaselineResolvedReference;
  error?: { code: BaselineResolveErrorCode; message: string };
}

export interface BaselineResolveInput {
  state: BaselineDebateState;
  baselinePackId: string;
  store: EvidencePackStore;
  candidate: CodeReferenceCandidate;
}

function fail(code: BaselineResolveErrorCode, message: string): BaselineResolveResult {
  return { status: code === 'PACK_UNAVAILABLE' ? 'unavailable' : 'rejected', error: { code, message } };
}

function normalizePath(value: string): string | null {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':')) return null;
  if (path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('..')) return null;
  return normalized;
}

/** 统一换行与行号：CRLF 规范成 LF；末尾换行不产生可引用的空行。 */
function normalizeContent(raw: string): { content: string; lines: string[] } {
  const content = raw.replace(/\r\n/g, '\n');
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return { content, lines };
}

export function reconstructDirtyFile(
  file: EvidencePackSnapshotFile,
  items: readonly EvidencePackItem[]
): { content: string } | { code: BaselineResolveErrorCode; message: string } {
  if (file.issues.length > 0) {
    return {
      code: 'FILE_UNFROZEN',
      message: `开场基准未完整冻结 ${file.path}：${file.issues.map(issue => issue.message).join('；')}`
    };
  }
  const ranges = [...file.ranges].sort((a, b) => a.startLine - b.startLine);
  if (ranges.length === 0) {
    return { code: 'FILE_UNFROZEN', message: `开场基准没有 ${file.path} 的 dirty 内容` };
  }
  const byLocator = new Map(
    items
      .filter(item => item.locator.path === file.path)
      .map(item => [`${String(item.locator.startLine)}\0${String(item.locator.endLine)}`, item])
  );
  let expected = 1;
  let content = '';
  for (const range of ranges) {
    if (range.startLine < expected) {
      return { code: 'CHUNK_OVERLAP', message: `${file.path} 的 chunk 行号重叠：${String(range.startLine)}` };
    }
    if (range.startLine > expected) {
      return { code: 'CHUNK_GAP', message: `${file.path} 缺少行 ${String(expected)}-${String(range.startLine - 1)}` };
    }
    const item = byLocator.get(`${String(range.startLine)}\0${String(range.endLine)}`);
    if (!item) {
      return { code: 'CHUNK_MISSING', message: `${file.path} 缺少 chunk：${String(range.startLine)}-${String(range.endLine)}` };
    }
    if (sha256Hex(item.content) !== range.contentHash) {
      return { code: 'SNAPSHOT_CORRUPT', message: `${file.path} chunk hash 不一致` };
    }
    content += `${content ? '\n' : ''}${item.content}`;
    expected = range.endLine + 1;
  }
  return { content };
}

function gitShow(
  root: string,
  commit: string,
  relative: string
): { buffer?: Buffer; error?: string; code?: BaselineResolveErrorCode } {
  try {
    const tree = execFileSync('git', ['-C', root, 'ls-tree', '-z', commit, '--', relative], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const entry = tree.split('\0').find(Boolean);
    if (!entry) return { code: 'FILE_NOT_IN_BASELINE', error: `开场 commit 中不存在文件：${relative}` };
    const mode = entry.slice(0, 6);
    if (mode === '120000') return { code: 'SYMLINK', error: `开场基准是符号链接，不能作为源码证据：${relative}` };
    if (mode === '040000' || mode === '160000') return { code: 'FILE_NOT_IN_BASELINE', error: `不是普通文件：${relative}` };
    const size = Number.parseInt(
      execFileSync('git', ['-C', root, 'cat-file', '-s', `${commit}:${relative}`], {
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim(),
      10
    );
    if (Number.isFinite(size) && size > MAX_FILE_BYTES) {
      return { code: 'FILE_TOO_LARGE', error: `开场文件超过 ${String(MAX_FILE_BYTES)} 字节：${relative}` };
    }
    const buffer = execFileSync('git', ['-C', root, 'show', `${commit}:${relative}`], {
      timeout: 15_000,
      maxBuffer: MAX_FILE_BYTES + 1,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { buffer };
  } catch (error) {
    return { code: 'GIT_READ_FAILED', error: error instanceof Error ? error.message : String(error) };
  }
}

function extract(
  content: string,
  relative: string,
  startLine: number,
  endLine: number
): { content: string; lineCount: number } | { code: BaselineResolveErrorCode; message: string } {
  const { lines } = normalizeContent(content);
  if (lineCountTooLarge(lines.length)) {
    return { code: 'FILE_TOO_LARGE', message: `文件行数超过 ${String(MAX_LINE_COUNT)}：${relative}` };
  }
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { code: 'RANGE_INVALID', message: `非法行号：${relative}:${String(startLine)}-${String(endLine)}` };
  }
  if (endLine > lines.length) {
    return { code: 'RANGE_INVALID', message: `行号越界：${relative}:${String(startLine)}-${String(endLine)}（文件 ${String(lines.length)} 行）` };
  }
  if (endLine - startLine + 1 > MAX_LINE_COUNT) {
    return { code: 'RANGE_TOO_LARGE', message: `引用行数超过 ${String(MAX_LINE_COUNT)}：${relative}` };
  }
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  if (excerpt.length === 0) {
    return { code: 'RANGE_INVALID', message: `引用片段为空：${relative}:${String(startLine)}-${String(endLine)}` };
  }
  if (excerpt.length > MAX_EXCERPT_CHARS) {
    return {
      code: 'RANGE_TOO_LARGE',
      message: `引用片段 ${String(excerpt.length)} 字符，超过上限 ${String(MAX_EXCERPT_CHARS)}`
    };
  }
  return { content: excerpt, lineCount: lines.length };
}

function lineCountTooLarge(count: number): boolean {
  return count > MAX_LINE_COUNT;
}

export function resolveBaselineCodeReference(input: BaselineResolveInput): BaselineResolveResult {
  const { state, baselinePackId, store, candidate } = input;
  if (!state.repository) return fail('NO_REPOSITORY', '这场辩论没有开场工程基准');
  if (!state.evidencePack?.baselinePackId) return fail('NO_BASELINE', '这场辩论没有基准 Pack');
  if (state.evidencePack.baselinePackId !== baselinePackId) {
    return fail('PACK_MISMATCH', 'baselinePackId 与辩论状态不一致');
  }
  if (state.evidencePack.status === 'failed' || state.evidencePack.status === 'unavailable') {
    return fail('PACK_UNAVAILABLE', `基准 Pack 状态是 ${state.evidencePack.status}`);
  }

  const relative = normalizePath(candidate.path);
  if (!relative) return fail('PATH_INVALID', `非法路径：${candidate.path}`);
  if (candidate.confidence === 'path-only') {
    return fail('RANGE_INVALID', `只有路径没有行号：${candidate.path}`);
  }
  const startLine = candidate.startLine ?? 0;
  const endLine = candidate.endLine ?? startLine;

  let pack: ReturnType<EvidencePackStore['replay']>;
  try {
    pack = store.replay(baselinePackId);
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    return fail(
      code === 'PACK_NOT_FOUND' ? 'NO_BASELINE' : 'PACK_CORRUPT',
      `基准 Pack 读取失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const manifest: EvidencePackManifest = pack.manifest;
  if (manifest.repo.commit !== state.repository.commit) {
    return fail('PACK_MISMATCH', 'Pack 的 commit 与辩论状态不一致');
  }
  if (manifest.repo.dirty !== state.repository.dirty) {
    return fail('PACK_MISMATCH', 'Pack 的 dirty 状态与辩论状态不一致');
  }
  if (manifest.repo.branch && state.repository.branch && manifest.repo.branch !== state.repository.branch) {
    return fail('PACK_MISMATCH', 'Pack 的分支与辩论状态不一致');
  }

  const partial = state.evidencePack.status === 'partial';
  const snapshot = manifest.snapshot;
  if (!snapshot) {
    if (manifest.repo.dirty) {
      return fail('SNAPSHOT_MISSING', '旧 Pack 没有 dirty 快照元数据，不能恢复 dirty 文件');
    }
  } else {
    if (snapshot.dirty && snapshotFingerprint(snapshot) !== snapshot.dirtyFingerprint) {
      return fail('SNAPSHOT_CORRUPT', '快照指纹与元数据不一致');
    }
    if (snapshot.dirty && state.repository.dirtyFingerprint &&
        snapshot.dirtyFingerprint !== state.repository.dirtyFingerprint) {
      return fail('FINGERPRINT_MISMATCH', 'Pack 指纹与辩论状态不一致');
    }
  }

  const dirtyFile = snapshot?.files.find(file => file.path === relative);
  let content: string;
  let source: 'git-commit' | 'dirty-overlay';
  let lineCount: number;

  if (dirtyFile) {
    const reconstructed = reconstructDirtyFile(dirtyFile, pack.items);
    if ('code' in reconstructed) return fail(reconstructed.code, reconstructed.message);
    if (Buffer.byteLength(reconstructed.content, 'utf8') > MAX_FILE_BYTES) {
      return fail('FILE_TOO_LARGE', `重组文件超过 ${String(MAX_FILE_BYTES)} 字节：${relative}`);
    }
    const extracted = extract(reconstructed.content, relative, startLine, endLine);
    if ('code' in extracted) return fail(extracted.code, extracted.message);
    content = extracted.content;
    lineCount = extracted.lineCount;
    source = 'dirty-overlay';
  } else {
    if (manifest.repo.dirty && !snapshot) {
      return fail('SNAPSHOT_MISSING', '旧 Pack 没有快照元数据，不能确认文件在开场时是否干净');
    }
    const shown = gitShow(state.repository.root, state.repository.commit, relative);
    if (shown.error || !shown.buffer) {
      return fail(shown.code ?? 'FILE_NOT_IN_BASELINE', shown.error ?? `开场 commit 中不存在文件：${relative}`);
    }
    if (shown.buffer.includes(0) || Buffer.from(shown.buffer.toString('utf8'), 'utf8').compare(shown.buffer) !== 0) {
      return fail('BINARY', `开场 commit 中的文件不是 UTF-8：${relative}`);
    }
    if (shown.buffer.length > MAX_FILE_BYTES) {
      return fail('FILE_TOO_LARGE', `开场文件超过 ${String(MAX_FILE_BYTES)} 字节：${relative}`);
    }
    const extracted = extract(shown.buffer.toString('utf8'), relative, startLine, endLine);
    if ('code' in extracted) return fail(extracted.code, extracted.message);
    content = extracted.content;
    lineCount = extracted.lineCount;
    source = 'git-commit';
  }

  return {
    status: partial ? 'partial' : 'baseline-verified',
    resolved: {
      status: partial ? 'partial' : 'baseline-verified',
      snapshotVerification: partial ? 'partial' : 'verified',
      baselinePackId,
      commit: manifest.repo.commit,
      source,
      path: relative,
      startLine,
      endLine,
      content,
      excerptHash: createHash('sha256').update(content, 'utf8').digest('hex'),
      lineCount
    }
  };
}
