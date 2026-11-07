/**
 * 工程理解：真实读取用户授权的目录，产出带路径、行号、指纹的证据。
 *
 * 这是 V2.1 Phase E 的地基，也是和「让模型凭印象聊架构」的分界线。
 * 三条不能放宽的边界：
 *
 * - **只读。** 这里一个字都不写，也不执行任何命令、不跟随符号链接。
 * - **有界。** 深度、文件数、单文件大小、总字节数、片段长度都有硬上限；
 *   大仓库宁可截断并在 `warnings` 里说明，也不能把整个工程塞进上下文。
 * - **不碰凭证。** 密钥、证书、`.env`、`node_modules`、`.git` 直接跳过；
 *   目录里的 README 指令只是文本，不构成任何权限提升。
 *
 * 产物是「证据」，不是「结论」。结论由主导人读这些证据后给，
 * 而且第一手网页提问仍然是用户原话——工程证据只在执行阶段（汇总）
 * 作为附加材料出现，绝不塞进发给网页的问题里。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import type { EngineeringEvidence } from '../../shared/conversation';
import { analyzeForQuestion } from './analysis';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.idea', '.vscode', 'vendor', '__pycache__',
  'DerivedData', 'Pods', '.workbuddy', 'ui-preview', 'release'
]);

const IGNORED_FILES =
  /(\.env|\.env\.|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$|\.key$|credentials|secrets?|token|\.sqlite$|\.db$|\.lock$|package-lock|yarn-lock|pnpm-lock)/i;

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.markdown',
  '.py', '.go', '.java', '.kt', '.rs', '.rb', '.php', '.c', '.h', '.cc', '.cpp',
  '.swift', '.sh', '.yml', '.yaml', '.toml', '.css', '.scss', '.html', '.vue',
  '.sql', '.gradle', '.xml', '.txt', '.proto', '.graphql'
]);

export interface ScanOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEvidence?: number;
  now?: () => number;
}

export interface ProjectScan {
  root: string;
  /** 给人和给主导人看的工程概览。 */
  summary: string;
  evidence: EngineeringEvidence[];
  /**
   * 结构关系：符号索引、调用点、模块依赖、变更影响。
   *
   * 和 `evidence` 分开：证据是「读到了哪几段原文」，分析是「这些文件之间是什么
   * 关系」。前者能逐字核对，后者是结构线索，材料里会写明识别方法。
   */
  analysis?: string;
  filesScanned: number;
  truncated: boolean;
  warnings: string[];
}

interface FileEntry {
  rel: string;
  abs: string;
  content: string;
  sha256: string;
  mtime: number;
  score: number;
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 从问题里取可用的检索词：英文按词，中文按 2 字滑窗。 */
export function termsOf(question: string): string[] {
  const terms = new Set<string>();
  const latin = question.toLowerCase().match(/[a-z][a-z0-9_.-]{1,}/g) ?? [];
  for (const word of latin) if (word.length >= 2) terms.add(word);
  const cjk = question.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i++) terms.add(run.slice(i, i + 2));
    if (run.length === 2) terms.add(run);
  }
  return [...terms].slice(0, 40);
}

function scoreOf(rel: string, content: string, terms: readonly string[]): number {
  const lowerRel = rel.toLowerCase();
  const lowerContent = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerRel.includes(term)) score += 6;
    if (lowerContent.includes(term)) score += 1;
  }
  // 项目说明、入口、清单总是值得先看一眼。
  if (/^(readme|package\.json|tsconfig|src\/index|src\/main|app\/|go\.mod|pom\.xml|cargo\.toml|pyproject)/i.test(lowerRel)) score += 3;
  return score;
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function excerptFor(content: string, terms: readonly string[]): { line: number; excerpt: string; why: string } {
  const lines = content.split('\n');
  let bestLine = 0;
  let bestScore = 0;
  for (let index = 0; index < lines.length; index++) {
    const lower = lines[index].toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  }
  const start = Math.max(0, bestLine - 1);
  const picked = lines.slice(start, start + 8).join('\n').slice(0, 700);
  return {
    line: start + 1,
    excerpt: picked,
    why: bestScore > 0 ? '命中问题里的关键词' : '文件开头（入口 / 项目说明）'
  };
}

/** 把证据变成主导人能引用的材料。 */
export function engineeringMaterial(scan: ProjectScan): string {
  if (scan.evidence.length === 0 && !scan.analysis) return '';
  const parts = [
    '【工程证据：以下由本机真实读取授权目录得到，不是模型推测】',
    scan.summary,
    ...(scan.analysis ? ['', scan.analysis] : []),
    '',
    ...scan.evidence.map(
      (item, index) =>
        `[证据${index + 1}] ${item.path}:${item.line}（sha256 ${item.sha256.slice(0, 12)}，读取于 ${new Date(item.readAt).toISOString()}）\n${item.excerpt}`
    ),
    '',
    '分析结论必须写明依据的是哪一条证据（路径:行号）；证据不足以支撑的地方写「无法确定」，不要凭常识补。'
  ];
  if (scan.truncated) parts.push(`注意：扫描被上限截断（${scan.warnings.join('；')}），结论只覆盖已读到的文件。`);
  return parts.join('\n');
}

/**
 * 扫描授权目录。失败要抛，让调用方如实告诉用户「没读到」，
 * 不能悄悄返回一份空证据再让模型自由发挥。
 */
export async function scanProject(
  rootInput: string,
  question: string,
  options: ScanOptions = {}
): Promise<ProjectScan> {
  const maxDepth = options.maxDepth ?? 6;
  const maxFiles = options.maxFiles ?? 500;
  const maxFileBytes = options.maxFileBytes ?? 256 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024;
  const maxEvidence = options.maxEvidence ?? 8;
  const now = options.now ?? Date.now;

  const root = await fs.realpath(rootInput);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error('工程目录不是一个目录');

  const terms = termsOf(question);
  const warnings: string[] = [];
  const entries: FileEntry[] = [];
  const topLevel: string[] = [];
  const byExtension = new Map<string, number>();
  let filesSeen = 0;
  let totalBytes = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || depth > maxDepth) return;
    let listed: Dirent<string>[];
    try {
      listed = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      warnings.push(`${path.relative(root, dir) || '.'} 读不到，已跳过`);
      return;
    }
    for (const entry of listed) {
      if (entries.length >= maxFiles) {
        truncated = true;
        warnings.push(`文件数达到上限 ${maxFiles}`);
        return;
      }
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (depth === 0 && topLevel.length < 40) topLevel.push(`${entry.isDirectory() ? '目录' : '文件'} ${entry.name}`);

      // 符号链接一律不跟：lstat 告诉我们它是什么，不用打开它。
      let stat;
      try {
        stat = await fs.lstat(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (IGNORED_FILES.test(entry.name)) continue;

      filesSeen += 1;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if (stat.size > maxFileBytes) {
        truncated = true;
        warnings.push(`${rel} 超过单文件上限 ${maxFileBytes} 字节`);
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        truncated = true;
        warnings.push(`总读取量达到上限 ${maxTotalBytes} 字节`);
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      totalBytes += buffer.byteLength;
      const content = buffer.toString('utf8');
      byExtension.set(ext || '(无扩展名)', (byExtension.get(ext || '(无扩展名)') ?? 0) + 1);
      entries.push({
        rel,
        abs,
        content,
        sha256: sha256Of(content),
        mtime: stat.mtimeMs,
        score: scoreOf(rel, content, terms)
      });
    }
  }

  await walk(root, 0);

  const ranked = [...entries].sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  const picked = ranked.slice(0, maxEvidence);
  const readAt = now();
  const evidence: EngineeringEvidence[] = picked.map(item => {
    const snippet = excerptFor(item.content, terms);
    return {
      path: item.rel,
      line: snippet.line,
      excerpt: snippet.excerpt,
      sha256: item.sha256,
      mtime: item.mtime,
      readAt,
      why: snippet.why
    };
  });

  const extSummary = [...byExtension.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}×${count}`)
    .join('、');
  const summary = [
    `工程根目录：${path.basename(root)}（绝对路径不进上下文）`,
    `顶层：${topLevel.slice(0, 20).join('、') || '（空）'}`,
    `可读文本文件 ${entries.length} 个 / 扫描到 ${filesSeen} 个；类型分布：${extSummary || '无'}`,
    `本轮取用 ${evidence.length} 个文件片段：${evidence.map(item => `${item.path}:${item.line}`).join('、') || '无'}`
  ].join('\n');

  // 结构关系单独算一份：证据回答「读到了什么」，分析回答「它们怎么连起来」。
  // 失败不影响证据——宁可只有证据，也不让一次正则异常把整个分析打掉。
  let analysis: string | undefined;
  try {
    analysis = analyzeForQuestion(entries.map(item => ({ rel: item.rel, content: item.content })), question) || undefined;
  } catch {
    warnings.push('结构分析没有完成，本轮只有文件证据');
  }

  return { root, summary, evidence, analysis, filesScanned: entries.length, truncated, warnings };
}
