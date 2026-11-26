/**
 * ECO 按需工程探索（P1-01）。
 *
 * 「上下文不足」以前只会问「给我这些路径」。模型真正想知道的是：这个符号在
 * 哪定义、谁在调用、这块有没有测试、这次改动改了什么。这里把这几种问法落成
 * 真实读取：每条证据仍带 sha256，读不到就如实跳过，不推测、不伪造。
 *
 * 边界：
 * - 只读工作区内的相对路径，越界/绝对路径一律跳过；
 * - 目录/文件遍历有上限，避免把「补一条证据」变成扫全盘；
 * - 不执行测试、不写文件；DIFF_READ 只跑只读的 `git diff`。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { ContextRequest, ContextResourceRef } from '../../shared/eco';
import { normalizeRelativePath } from './eco-evidence';

/** 单次探索最多产出多少条资源；超出部分不读，避免把上下文撑爆。 */
export const MAX_EXPLORE_RESOURCES = 12;

/** 目录发现最多列多少项。 */
export const MAX_DIRECTORY_ENTRIES = 200;

/** 符号/调用搜索最多扫多少文件。 */
export const MAX_SCAN_FILES = 600;

/** 参与内容扫描的单文件上限；超过只按文件名判断，不读正文。 */
export const MAX_SCAN_BYTES = 512 * 1024;

/** diff 正文上限（字符）；只用于证据摘要，不是给模型看的全文。 */
export const MAX_DIFF_CHARS = 64 * 1024;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'out-test',
  'coverage',
  'target',
  '.next',
  '.turbo',
  'vendor',
  '__pycache__'
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.kt', '.py', '.go', '.rs', '.rb', '.php', '.cs', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.scala', '.sh'
]);

export interface ExploreSkip {
  path: string;
  reason: string;
}

export interface ExploreResult {
  resources: ContextResourceRef[];
  skipped: ExploreSkip[];
  /** 这次实际做了什么；进日志，避免「发过请求」被当成「拿到证据」。 */
  detail: string;
}

function digestOf(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function isInside(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveInside(root: string, raw: string): { absolute: string; rel: string } | null {
  const rel = normalizeRelativePath(raw);
  if (!rel) return null;
  const absolute = path.resolve(root, rel);
  if (!isInside(root, absolute) && absolute !== root) return null;
  return { absolute, rel };
}

/** 深度优先遍历工作区文件（有上限、跳过依赖与构建产物）；只返回相对路径。 */
function walkFiles(root: string, startRel: string | undefined, limit: number): string[] {
  const start = startRel ? resolveInside(root, startRel) : { absolute: root, rel: '' };
  if (!start) return [];
  const out: string[] = [];
  const stack: string[] = [start.absolute];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      out.push(rel);
    }
  }
  return out;
}

function readText(absolute: string): string | null {
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

interface Hit {
  rel: string;
  line: number;
  text: string;
}

function findPattern(root: string, files: readonly string[], pattern: RegExp, limit: number): Hit[] {
  const hits: Hit[] = [];
  for (const rel of files) {
    if (hits.length >= limit) break;
    const ext = path.extname(rel).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) continue;
    const text = readText(path.resolve(root, rel));
    if (!text) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.length > 400) continue;
      if (!pattern.test(line)) continue;
      hits.push({ rel, line: index + 1, text: line.trim().slice(0, 200) });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

function symbolResource(hit: Hit, kind: 'symbol', at: number): ContextResourceRef {
  const label = `${hit.rel}#L${String(hit.line)}`;
  return {
    resourceId: `sym:${label}`,
    kind,
    pathOrLabel: label,
    verified: true,
    factClass: 'verified_fact',
    digest: digestOf(`${label}\n${hit.text}`),
    size: Buffer.byteLength(hit.text, 'utf8'),
    verifiedAt: at
  };
}

function discoverDirectory(root: string, dir: string, at: number): ExploreResult {
  const target = resolveInside(root, dir);
  if (!target) return { resources: [], skipped: [{ path: dir, reason: '不是工作区内的相对路径' }], detail: '目录越界' };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target.absolute, { withFileTypes: true });
  } catch {
    return { resources: [], skipped: [{ path: dir, reason: '目录不存在或不可读' }], detail: '目录读取失败' };
  }
  const names = entries
    .filter(entry => !(entry.name.startsWith('.') && entry.isDirectory()))
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map(entry => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
  if (names.length === 0) {
    return { resources: [], skipped: [{ path: dir, reason: '目录为空' }], detail: '目录为空' };
  }
  const listing = names.join('\n');
  return {
    resources: [{
      resourceId: `dir:${target.rel}`,
      kind: 'module',
      pathOrLabel: target.rel.endsWith('/') ? target.rel : `${target.rel}/`,
      verified: true,
      factClass: 'verified_fact',
      digest: digestOf(listing),
      size: Buffer.byteLength(listing, 'utf8'),
      verifiedAt: at
    }],
    skipped: [],
    detail: `列出 ${String(names.length)} 项`
  };
}

function discoverTests(root: string, paths: readonly string[], at: number): ExploreResult {
  const candidates = new Set<string>();
  for (const raw of paths) {
    const rel = normalizeRelativePath(raw);
    if (!rel) continue;
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const stem = base.replace(/\.[^./]+$/, '');
    const ext = path.posix.extname(rel);
    const prefix = dir === '.' ? '' : `${dir}/`;
    for (const name of [
      `${stem}.test${ext}`,
      `${stem}.spec${ext}`,
      `${stem}_test${ext}`,
      `test_${stem}${ext}`,
      `${stem}Test${ext}`
    ]) {
      candidates.add(`${prefix}${name}`);
    }
    candidates.add(`${prefix}__tests__/${stem}.test${ext}`);
  }
  const found: string[] = [];
  const skipped: ExploreSkip[] = [];
  for (const rel of candidates) {
    if (found.length >= MAX_EXPLORE_RESOURCES) break;
    const target = resolveInside(root, rel);
    if (!target) continue;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(target.absolute);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) continue;
    found.push(rel);
  }
  if (found.length === 0) {
    // 没有同名测试：退一步在目标目录里按命名约定找，仍不猜内容。
    const dirs = new Set(paths
      .map(item => normalizeRelativePath(item))
      .filter((item): item is string => item !== null)
      .map(item => path.posix.dirname(item)));
    for (const dir of dirs) {
      const files = walkFiles(root, dir === '.' ? undefined : dir, 200);
      for (const rel of files) {
        if (!/(\.test\.|\.spec\.|_test\.|Test\.|^test_)/.test(path.posix.basename(rel))) continue;
        found.push(rel);
        if (found.length >= 5) break;
      }
      if (found.length >= 5) break;
    }
  }
  if (found.length === 0) {
    return { resources: [], skipped: [{ path: paths.join(', '), reason: '找不到对应的测试文件' }], detail: '未发现测试' };
  }
  const resources: ContextResourceRef[] = [];
  for (const rel of found.slice(0, MAX_EXPLORE_RESOURCES)) {
    const target = resolveInside(root, rel);
    if (!target) continue;
    const bytes = readText(target.absolute);
    if (bytes === null) {
      skipped.push({ path: rel, reason: '测试文件不可读' });
      continue;
    }
    resources.push({
      resourceId: `test:${rel}`,
      kind: 'test',
      pathOrLabel: rel,
      verified: true,
      factClass: 'verified_fact',
      digest: digestOf(bytes),
      size: Buffer.byteLength(bytes, 'utf8'),
      verifiedAt: at
    });
  }
  return { resources, skipped, detail: `找到 ${String(resources.length)} 个测试文件` };
}

function readDiff(root: string, baseRef: string | undefined, at: number): ExploreResult {
  const base = (baseRef ?? 'HEAD').trim() || 'HEAD';
  if (!/^[A-Za-z0-9._/~^-]+$/.test(base)) {
    return { resources: [], skipped: [{ path: base, reason: '基线引用含非法字符' }], detail: '基线非法' };
  }
  let output = '';
  try {
    output = execFileSync('git', ['-C', root, 'diff', '--unified=0', base, '--'], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return { resources: [], skipped: [{ path: base, reason: 'git diff 执行失败（可能不是仓库）' }], detail: 'diff 失败' };
  }
  if (!output.trim()) {
    return { resources: [], skipped: [{ path: base, reason: '工作树相对该基线没有改动' }], detail: '无改动' };
  }
  const bounded = output.slice(0, MAX_DIFF_CHARS);
  return {
    resources: [{
      resourceId: `diff:${base}`,
      kind: 'file',
      pathOrLabel: `diff:${base}`,
      verified: true,
      factClass: 'verified_fact',
      digest: digestOf(bounded),
      size: Buffer.byteLength(bounded, 'utf8'),
      verifiedAt: at
    }],
    skipped: [],
    detail: `diff ${String(bounded.length)} 字符${output.length > bounded.length ? '（已截断）' : ''}`
  };
}

/**
 * 执行一条类型化补充请求。未知类型按 FILE_READ 处理——旧事件里没有 kind，
 * 不能因为缺一个字段就拒绝补上下文。
 */
export function exploreContextRequest(input: {
  workspaceRoot: string;
  request: ContextRequest;
  now?: number;
}): ExploreResult {
  const root = path.resolve(input.workspaceRoot);
  const at = input.now ?? Date.now();
  const kind = input.request.kind ?? 'FILE_READ';

  if (kind === 'FILE_READ') {
    const paths = input.request.requestedPaths ?? [];
    if (paths.length === 0) {
      return { resources: [], skipped: [{ path: '', reason: '请求没有给出路径' }], detail: '无路径' };
    }
    const read = readFilesBounded(root, paths, at);
    return {
      resources: read.resources,
      skipped: read.skipped,
      detail: `读取 ${String(read.resources.length)}/${String(paths.length)} 个文件`
    };
  }

  if (kind === 'DIRECTORY_DISCOVERY') {
    const dir = input.request.directory ?? (input.request.requestedPaths ?? [])[0] ?? '.';
    return discoverDirectory(root, dir === '.' ? '' : dir, at);
  }

  if (kind === 'TEST_DISCOVERY') {
    return discoverTests(root, input.request.requestedPaths ?? [], at);
  }

  if (kind === 'DIFF_READ') {
    return readDiff(root, input.request.baseRef, at);
  }

  const symbol = (input.request.symbol ?? '').trim();
  if (!symbol) {
    return { resources: [], skipped: [{ path: '', reason: '请求没有给出符号名' }], detail: '无符号' };
  }
  if (!/^[A-Za-z_$][\w$.:<>-]*$/.test(symbol)) {
    return { resources: [], skipped: [{ path: symbol, reason: '符号名含非法字符' }], detail: '符号非法' };
  }
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const files = walkFiles(root, undefined, MAX_SCAN_FILES);
  if (kind === 'SYMBOL_LOOKUP') {
    // 声明形态优先：`function x`、`class X`、`def x`、`const x =`、`interface X`。
    const pattern = new RegExp(
      `(?:function|class|interface|type|enum|struct|def|fn|const|let|var)\\s+${escaped}\\b|\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function)`
    );
    const hits = findPattern(root, files, pattern, 5);
    return {
      resources: hits.map(hit => symbolResource(hit, 'symbol', at)),
      skipped: hits.length === 0 ? [{ path: symbol, reason: '没有找到声明位置' }] : [],
      detail: hits.length === 0 ? `扫描 ${String(files.length)} 个文件未命中` : `命中 ${String(hits.length)} 处`
    };
  }

  // CALL_RELATION：只认调用形态 `symbol(`，避免把声明也算成调用者。
  const callPattern = new RegExp(`\\b${escaped}\\s*\\(`);
  const hits = findPattern(root, files, callPattern, 8);
  return {
    resources: hits.map(hit => symbolResource(hit, 'symbol', at)),
    skipped: hits.length === 0 ? [{ path: symbol, reason: '没有找到调用点' }] : [],
    detail: hits.length === 0 ? `扫描 ${String(files.length)} 个文件未命中调用` : `命中 ${String(hits.length)} 处调用`
  };
}

/** FILE_READ 复用 plan 证据读取，放在这里只是为了统一入口。 */
function readFilesBounded(
  root: string,
  paths: readonly string[],
  at: number
): { resources: ContextResourceRef[]; skipped: ExploreSkip[] } {
  const resources: ContextResourceRef[] = [];
  const skipped: ExploreSkip[] = [];
  for (const raw of paths.slice(0, MAX_EXPLORE_RESOURCES)) {
    const target = resolveInside(root, raw);
    if (!target) {
      skipped.push({ path: raw, reason: '不是工作区内的相对路径' });
      continue;
    }
    const text = readText(target.absolute);
    if (text === null) {
      skipped.push({ path: target.rel, reason: '文件不存在、不可读或超过扫描上限' });
      continue;
    }
    resources.push({
      resourceId: `file:${target.rel}`,
      kind: 'file',
      pathOrLabel: target.rel,
      verified: true,
      factClass: 'verified_fact',
      digest: digestOf(text),
      size: Buffer.byteLength(text, 'utf8'),
      verifiedAt: at
    });
  }
  return { resources, skipped };
}
