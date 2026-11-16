/**
 * 代码引用候选的发现与定位（P2 工程证据生产者的第一层）。
 *
 * 这层**只做两件事**：
 * 1. 从文本里找出可能的 `path:line` / `path#Lx-Ly` / 反引号路径；
 * 2. 到真实仓库里校验路径、行号、文件类型，并读出冻结内容。
 *
 * 它不判断「这段代码是否支持某条 Claim」。模型/发言给出的引用只是候选，
 * 文件存在且行号有效只证明「这里确实有这段代码」，不证明主张正确。
 * Claim↔Evidence 的关系必须由后续显式判断产生，不能在这一层猜。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface CodeReferenceCandidate {
  /** 原文里匹配到的片段，便于回溯。 */
  raw: string;
  path: string;
  startLine?: number;
  endLine?: number;
  confidence: 'explicit-line' | 'path-only';
}

export interface ResolvedCodeReference {
  candidate: CodeReferenceCandidate;
  /** 规范化后的仓库相对路径。 */
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  lineCount: number;
}

export interface CodeReferenceResolution {
  resolved?: ResolvedCodeReference;
  error?: string;
}

const PATH_WITH_LINE = /(?:^|[^\w/])((?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?(?![\w])/g;
const PATH_WITH_HASH = /(?:^|[^\w/])((?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]+)#L(\d+)(?:-L(\d+))?/gi;
const PATH_IN_BACKTICKS = /`((?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]+)`/g;

function looksLikeUrl(raw: string, index: number, text: string): boolean {
  if (raw.includes('://')) return true;
  // match.index 可能落在 URL 的中间，向后看整段前缀是否以 URL 结尾。
  const prefix = text.slice(0, index + raw.length);
  return /[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(prefix);
}

function normalizeCandidatePath(value: string): string | null {
  if (!value || value.includes('\0') || value.includes('\\')) return null;
  if (path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.startsWith('..')) return null;
  return normalized;
}

function pushCandidate(
  target: CodeReferenceCandidate[],
  candidate: CodeReferenceCandidate
): void {
  if (!normalizeCandidatePath(candidate.path)) return;
  const key = `${candidate.path}\0${String(candidate.startLine ?? '')}\0${String(candidate.endLine ?? '')}`;
  if (target.some(item => `${item.path}\0${String(item.startLine ?? '')}\0${String(item.endLine ?? '')}` === key)) {
    return;
  }
  target.push(candidate);
}

/** 从一段文本里提取候选；不访问文件系统，纯函数。 */
export function extractCodeReferences(text: string): CodeReferenceCandidate[] {
  const found: CodeReferenceCandidate[] = [];
  for (const match of text.matchAll(PATH_WITH_LINE)) {
    if (looksLikeUrl(match[1] ?? '', match.index ?? 0, text)) continue;
    const start = Number.parseInt(match[2] ?? '', 10);
    const end = match[3] ? Number.parseInt(match[3], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) continue;
    pushCandidate(found, {
      raw: match[0].trim(),
      path: match[1] ?? '',
      startLine: start,
      endLine: end,
      confidence: 'explicit-line'
    });
  }
  for (const match of text.matchAll(PATH_WITH_HASH)) {
    if (looksLikeUrl(match[1] ?? '', match.index ?? 0, text)) continue;
    const start = Number.parseInt(match[2] ?? '', 10);
    const end = match[3] ? Number.parseInt(match[3], 10) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) continue;
    pushCandidate(found, {
      raw: match[0].trim(),
      path: match[1] ?? '',
      startLine: start,
      endLine: end,
      confidence: 'explicit-line'
    });
  }
  for (const match of text.matchAll(PATH_IN_BACKTICKS)) {
    const value = match[1] ?? '';
    if (value.includes('://')) continue;
    pushCandidate(found, {
      raw: match[0],
      path: value,
      confidence: 'path-only'
    });
  }
  return found;
}

/**
 * 到仓库里校验候选并读取内容。路径安全、符号链接、二进制/非 UTF-8、
 * 行号范围全部硬校验；任何一项不成立都返回错误，不返回半份证据。
 */
export function resolveCodeReference(
  rootDir: string,
  candidate: CodeReferenceCandidate
): CodeReferenceResolution {
  if (candidate.confidence === 'path-only') {
    return { error: `只有路径、没有行号或符号，不能作为证据：${candidate.path}` };
  }
  const relative = normalizeCandidatePath(candidate.path);
  if (!relative) return { error: `非法路径：${candidate.path}` };

  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return { error: `路径越出仓库：${candidate.path}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return { error: `文件不存在：${candidate.path}` };
  }
  if (stat.isSymbolicLink()) return { error: `符号链接不读取目标内容：${candidate.path}` };
  if (!stat.isFile()) return { error: `不是普通文件：${candidate.path}` };

  let content: string;
  try {
    const raw = fs.readFileSync(absolute);
    if (raw.includes(0) || Buffer.from(raw.toString('utf8'), 'utf8').compare(raw) !== 0) {
      return { error: `二进制/非 UTF-8 文件不能作为代码证据：${candidate.path}` };
    }
    content = raw.toString('utf8');
  } catch {
    return { error: `读不到文件：${candidate.path}` };
  }

  const lines = content.split(/\r?\n/);
  const startLine = candidate.startLine ?? 1;
  const endLine = candidate.endLine ?? startLine;
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    return {
      error: `行号越界：${candidate.path}:${String(startLine)}-${String(endLine)}（文件 ${String(lines.length)} 行）`
    };
  }
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  if (excerpt.length === 0) return { error: `引用片段为空：${candidate.path}:${String(startLine)}-${String(endLine)}` };

  return {
    resolved: {
      candidate,
      path: relative,
      startLine,
      endLine,
      content: excerpt,
      contentHash: createHash('sha256').update(excerpt, 'utf8').digest('hex'),
      lineCount: lines.length
    }
  };
}

export interface CodeReferenceBatch {
  resolved: ResolvedCodeReference[];
  errors: string[];
}

/** 提取 + 逐个定位；错误逐条保留，供 Pack 标 partial 时使用。 */
export function extractAndResolveCodeReferences(
  text: string,
  rootDir: string
): CodeReferenceBatch {
  const resolved: ResolvedCodeReference[] = [];
  const errors: string[] = [];
  for (const candidate of extractCodeReferences(text)) {
    const outcome = resolveCodeReference(rootDir, candidate);
    if (outcome.resolved) resolved.push(outcome.resolved);
    else errors.push(outcome.error ?? `无法解析：${candidate.raw}`);
  }
  return { resolved, errors };
}
