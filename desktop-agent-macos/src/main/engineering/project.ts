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
import type {
  AttributeStat,
  EngineeringEvidence,
  FileStructureStats,
  TagCount
} from '../../shared/conversation';
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
  /**
   * 用户在问题里点名要读的文件。点名是比关键词匹配强的信号：它排进证据
   * 第一位，且不受单文件 / 总量上限拦截——超过上限就取头部并注明只读了
   * 多少。凭证与二进制的边界不放宽。
   */
  named?: boolean;
  /** 点名文件才统计：整个文件多少行（按 \n 计，含空行）。 */
  totalLines?: number;
  /** 点名文件超过单文件上限时：实际读了前 bytes 字节 / 文件共 totalBytes 字节。 */
  partial?: { bytes: number; totalBytes: number };
  /** 点名文件才有：整份文件读完后的结构统计（标签 / 属性 / 级别各多少）。 */
  structure?: FileStructureStats;
}

/**
 * 从问题里提取「用户点名要读的文件名」。
 *
 * 两种写法都认：绝对路径（取最后一段）和裸文件名（带扩展名，允许
 * `.txt_` 这种下划线结尾的真实文件名）。版本号、纯数字串不算文件。
 * 返回小写文件名，最多 5 个——点名再多也读不完，宁可如实说没读。
 */
export function namedFilesIn(question: string): string[] {
  const names = new Set<string>();
  const add = (candidate: string) => {
    const base = candidate.split('/').pop() ?? '';
    if (base.length >= 5 && /\.[A-Za-z0-9]{1,8}_?$/.test(base) && !/^[\d.]+$/.test(base)) {
      names.add(base.toLowerCase());
    }
  };
  // 绝对路径：到空白或中文标点为止。
  for (const p of question.match(/\/[^\s，。；、！？（()）"'「」『』]{2,}/g) ?? []) add(p);
  // 裸文件名（含下划线 / 中文 / 连字符）。
  for (const token of question.match(/[\w.\-\u4e00-\u9fa5]+\.[A-Za-z0-9]{1,8}_?/g) ?? []) add(token);
  return [...names].slice(0, 5);
}

/** 点名文件按 \n 数行；最后一个不带换行的尾行也算一行。 */
function countLines(buffer: Buffer): number {
  const text = buffer.toString('utf8');
  let lines = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

/** 点名文件允许整读的最大体积；再大的文件逐行数数也不划算了。 */
const NAMED_MAX_BYTES = 32 * 1024 * 1024;
/** 结构统计最多扫这么多字节：32MB 的行正则要几百毫秒，宁可只统计前缀并注明。 */
const STRUCTURE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 扫描到的文件超过这个数，就不再在摘要里逐条列顶层条目。
 *
 * 真机 2026-11-09：工程目录选的是 `~/Downloads`，用户只附了一份 md 问行数，
 * 转录里却列出 20 条顶层文件（DS_Store、dmg、pkg…）。那种目录不是单个工程，
 * 逐条列出来只是噪音。
 */
const TOP_LEVEL_LIST_LIMIT = 200;
/** 材料里最多列这么多种标签；总数与种类数仍是精确值。 */
const STRUCTURE_TAG_LIMIT = 24;
const STRUCTURE_ATTR_LIMIT = 12;
const STRUCTURE_LEVEL_LIMIT = 8;
const STRUCTURE_SAMPLES = 3;

const BRACKET_TAG = /\[([^[\]\n]{1,60})\]/g;
const BRACKET_KV = /^([A-Za-z][A-Za-z0-9_.-]{0,40})=(.*)$/;
const LEVEL_FIELD = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T][\d:.,]+\s+([A-Z]{3,10})\b/;
/**
 * 日志行首：时间戳 + 级别 + logger + `-` + 方括号标签。
 *
 * 认这一层是因为「模块标签」和「正文里的方括号」必须分开数——日志正文里
 * 出现 `[513029306, 113168373]` 这种玩家列表时，把它算成标签会让种类数从 14 变 17。
 */
const LINE_PREFIX =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T][\d:.,]+\s+([A-Z]{3,10})\s+\S+\s+-\s+\[([^[\]\n]{1,60})\]/;

/**
 * 数一份文本的结构：方括号标签、`[key=value]` 属性、行级字段（日志级别）。
 *
 * 只做计数，不做语义判断——`[CarromStream]` 和 `[TODO]` 一视同仁。这样它
 * 对任何日志/清单类文件都成立，不用为某种格式写死规则。
 */
export function structureStatsOf(
  text: string,
  coverage?: { bytes: number; totalBytes: number }
): FileStructureStats {
  const headTags = new Map<string, number>();
  const bracketTags = new Map<string, number>();
  const attrs = new Map<string, { count: number; values: Map<string, number> }>();
  const levels = new Map<string, number>();
  let lines = 0;
  let prefixLines = 0;
  let bracketTotal = 0;
  let attributeTotal = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    lines += 1;

    const prefix = LINE_PREFIX.exec(line);
    if (prefix) {
      prefixLines += 1;
      levels.set(prefix[1], (levels.get(prefix[1]) ?? 0) + 1);
      const tag = prefix[2].trim();
      if (tag) headTags.set(tag, (headTags.get(tag) ?? 0) + 1);
    } else {
      const level = LEVEL_FIELD.exec(line);
      if (level) levels.set(level[1], (levels.get(level[1]) ?? 0) + 1);
    }

    BRACKET_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BRACKET_TAG.exec(line)) !== null) {
      const body = match[1].trim();
      if (!body) continue;
      const kv = BRACKET_KV.exec(body);
      if (kv) {
        attributeTotal += 1;
        const entry = attrs.get(kv[1]) ?? { count: 0, values: new Map<string, number>() };
        entry.count += 1;
        entry.values.set(kv[2], (entry.values.get(kv[2]) ?? 0) + 1);
        attrs.set(kv[1], entry);
      } else {
        bracketTotal += 1;
        bracketTags.set(body, (bracketTags.get(body) ?? 0) + 1);
      }
    }
  }

  const byCount = (map: Map<string, number>): TagCount[] =>
    [...map.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));

  const attributes: AttributeStat[] = [...attrs.entries()]
    .map(([key, entry]) => ({
      key,
      count: entry.count,
      distinct: entry.values.size,
      samples: [...entry.values.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, STRUCTURE_SAMPLES)
        .map(([value]) => value)
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // 一半以上的行都能认出「时间戳 + 级别 + logger - [标签]」，就按行首标签数；
  // 否则退回「全文所有方括号」，至少不会一个标签都没有。
  const useHead = prefixLines > 0 && prefixLines * 2 >= lines;
  const chosen = useHead ? headTags : bracketTags;
  const chosenTotal = useHead ? prefixLines : bracketTotal;

  return {
    lines,
    tagScope: useHead ? 'line-head' : 'bracket',
    tags: byCount(chosen).slice(0, STRUCTURE_TAG_LIMIT),
    tagTotal: chosenTotal,
    tagDistinct: chosen.size,
    attributes: attributes.slice(0, STRUCTURE_ATTR_LIMIT),
    attributeTotal,
    attributeDistinct: attrs.size,
    levels: byCount(levels).slice(0, STRUCTURE_LEVEL_LIMIT),
    ...(coverage ? { truncated: coverage } : {})
  };
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

function excerptFor(
  content: string,
  terms: readonly string[],
  named = false
): { line: number; excerpt: string; why: string } {
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
    why: bestScore > 0 ? '命中问题里的关键词' : named ? '问题里点名的文件（文件开头）' : '文件开头（入口 / 项目说明）'
  };
}

/** 把点名文件的结构统计写成一段材料：数字全部来自本机计数。 */
export function structureSection(item: EngineeringEvidence): string {
  const stats = item.structure;
  if (!stats) return '';
  const join = (rows: TagCount[]): string => rows.map(row => `${row.value}×${row.count}`).join('、');
  const listed = (rows: TagCount[]): number => rows.reduce((sum, row) => sum + row.count, 0);

  const levelSum = listed(stats.levels);
  const levelLine =
    stats.levels.length === 0
      ? '- 行级字段分布：没有识别到（时间戳后面的第一个字段不是全大写词）'
      : `- 行级字段分布（时间戳后第一个全大写词，如日志级别）：${join(stats.levels)}（合计 ${levelSum} 行）` +
        (levelSum < stats.lines ? `，另有 ${stats.lines - levelSum} 行没有这个字段` : '');

  const tagRest = stats.tagTotal - listed(stats.tags);
  const tagLabel =
    stats.tagScope === 'line-head'
      ? '行首方括号标签（时间戳+级别+logger 之后的那个 `[标签]`，正文里的方括号不算）'
      : '方括号标签（文件没有可识别的日志行首，按全文所有 `[..]` 计）';
  const tagLine =
    stats.tags.length === 0
      ? `- ${tagLabel}：0 个`
      : `- ${tagLabel}共 ${stats.tagTotal} 个 / ${stats.tagDistinct} 种：${join(stats.tags)}` +
        (tagRest > 0 ? `；另有 ${stats.tagDistinct - stats.tags.length} 种共 ${tagRest} 个未列出` : '');

  const attrLine =
    stats.attributes.length === 0
      ? '- 方括号属性标签 [key=value]：0 个'
      : `- 方括号属性标签 [key=value] 共 ${stats.attributeTotal} 个 / ${stats.attributeDistinct} 种：` +
        stats.attributes
          .map(attr =>
            `${attr.key}×${attr.count}（${attr.distinct} 种取值${
              attr.distinct <= 3 ? `：${attr.samples.join('、')}` : `，如 ${attr.samples.join('、')}`
            }）`
          )
          .join('；');

  return [
    `【点名文件结构统计】${item.path} —— 以下每个数字都是本机把整份文件读完后数出来的（不是模型估计），聚合类问题直接按这里回答：`,
    `- 统计行数：${stats.lines} 行${item.totalLines != null && item.totalLines !== stats.lines ? `（文件共 ${item.totalLines} 行）` : ''}`,
    stats.truncated
      ? `- 覆盖范围：文件共 ${Math.round(stats.truncated.totalBytes / 1024)} KB，只统计了前 ${Math.round(stats.truncated.bytes / 1024)} KB`
      : '- 覆盖范围：全文，未截断',
    levelLine,
    tagLine,
    attrLine
  ].join('\n');
}

/** 把证据变成主导人能引用的材料。 */
export function engineeringMaterial(scan: ProjectScan): string {
  if (scan.evidence.length === 0 && !scan.analysis) return '';
  const parts = [
    '【工程证据：以下由本机真实读取授权目录得到，不是模型推测】',
    scan.summary,
    ...(scan.analysis ? ['', scan.analysis] : []),
    '',
    ...scan.evidence.map((item, index) => {
      const extra = [
        item.totalLines != null ? `全文共 ${item.totalLines} 行` : null,
        item.partial
          ? `超过单文件上限，只读了前 ${Math.round(item.partial.bytes / 1024)} KB（文件共 ${Math.round(item.partial.totalBytes / 1024)} KB）`
          : null
      ]
        .filter(Boolean)
        .join('，');
      return `[证据${index + 1}] ${item.path}:${item.line}（sha256 ${item.sha256.slice(0, 12)}，读取于 ${new Date(
        item.readAt
      ).toISOString()}${extra ? `；${extra}` : ''}）\n${item.excerpt}`;
    }),
    '',
    // 真机 s21 的教训：664 行的统计埋在证据头部的括号里，14b 的主导人没接住，
    // 对着「片段只是节选」回答了「无法确定」。点名文件的统计单独成段，并写明
    // 它来自完整文件，不随片段截断。
    ...(() => {
      const named = scan.evidence.find(item => item.totalLines != null);
      if (!named) return [];
      return [
        `【点名文件统计】${named.path} 已由本机完整读取统计：全文共 ${named.totalLines} 行（按换行计，含空行）。` +
          (named.partial
            ? '证据片段只是文件头部的节选，行数统计用的是完整文件。'
            : '上面的片段只是节选，行数以这条统计为准。') +
          '用户问「总共多少条 / 多少行 / 有多大」时直接引用这条统计。'
      ];
    })(),
    // 聚合型问题（标签各多少、级别各多少）模型对着片段数不准，这里把本机数好的
    // 结构统计单独成段递过去——数字是计数结果，不随片段截断。
    ...(() => {
      const named = scan.evidence.find(item => item.structure);
      if (!named?.structure) return [];
      return ['', structureSection(named)];
    })(),
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
  /** 问题里点名的文件（小写文件名）。 */
  const namedBase = new Set(namedFilesIn(question));
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
      // 点名是强信号：即使是 .log 这类不在常规文本清单里的扩展名也读（凭证
      // 与二进制边界照旧生效，见下面 IGNORED_FILES 与 isBinary）。
      const isNamed = namedBase.has(entry.name.toLowerCase());
      if (!TEXT_EXTENSIONS.has(ext) && !isNamed) continue;
      if (isNamed && stat.size > NAMED_MAX_BYTES) {
        warnings.push(`${rel} 是问题里点名的文件，但超过 ${Math.round(NAMED_MAX_BYTES / 1024 / 1024)} MB，本轮读不了`);
        continue;
      }
      if (!isNamed && stat.size > maxFileBytes) {
        truncated = true;
        warnings.push(`${rel} 超过单文件上限 ${maxFileBytes} 字节`);
        continue;
      }
      if (!isNamed && totalBytes + stat.size > maxTotalBytes) {
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
      const content =
        isNamed && buffer.byteLength > maxFileBytes
          ? buffer.subarray(0, maxFileBytes).toString('utf8')
          : buffer.toString('utf8');
      byExtension.set(ext || '(无扩展名)', (byExtension.get(ext || '(无扩展名)') ?? 0) + 1);
      const item: FileEntry = {
        rel,
        abs,
        content,
        sha256: sha256Of(buffer.toString('utf8')),
        mtime: stat.mtimeMs,
        score: scoreOf(rel, content, terms)
      };
      if (isNamed) {
        item.named = true;
        item.totalLines = countLines(buffer);
        // 结构统计读的是**整份文件**，不是证据片段：大文件也只喂模型 256KB，
        // 但「标签各出现多少次」必须按全量数，否则答案会系统性偏小。
        const scanBytes = Math.min(buffer.byteLength, STRUCTURE_MAX_BYTES);
        const scanText = buffer.subarray(0, scanBytes).toString('utf8');
        item.structure = structureStatsOf(
          scanText,
          scanBytes < buffer.byteLength
            ? { bytes: scanBytes, totalBytes: buffer.byteLength }
            : undefined
        );
        if (buffer.byteLength > maxFileBytes) {
          item.partial = { bytes: maxFileBytes, totalBytes: buffer.byteLength };
          warnings.push(
            `${rel} 是问题里点名的文件，超过单文件上限，只取前 ${maxFileBytes} 字节（全文 ${buffer.byteLength} 字节 / ${item.totalLines} 行）`
          );
        }
      }
      entries.push(item);
    }
  }

  await walk(root, 0);

  const ranked = [...entries].sort(
    (a, b) => (b.named ? 1 : 0) - (a.named ? 1 : 0) || b.score - a.score || a.rel.localeCompare(b.rel)
  );
  const picked = ranked.slice(0, maxEvidence);
  const readAt = now();
  const evidence: EngineeringEvidence[] = picked.map(item => {
    const snippet = excerptFor(item.content, terms, item.named ?? false);
    return {
      path: item.rel,
      line: snippet.line,
      excerpt: snippet.excerpt,
      sha256: item.sha256,
      mtime: item.mtime,
      readAt,
      why: snippet.why,
      ...(item.totalLines != null ? { totalLines: item.totalLines } : {}),
      ...(item.partial ? { partial: item.partial } : {}),
      ...(item.structure ? { structure: item.structure } : {})
    };
  });

  const extSummary = [...byExtension.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([ext, count]) => `${ext}×${count}`)
    .join('、');
  // 真机 2026-11-09：工程目录选的是 ~/Downloads，用户只附了一份 md 问行数，
  // 转录里却列出 20 条顶层文件（DS_Store、dmg、pkg…）。那种目录不是单个工程，
  // 逐条列出来只是噪音，还会让人以为「读了一堆相关文件」。超过这个数就不列。
  const topLevelText =
    filesSeen > TOP_LEVEL_LIST_LIMIT
      ? `顶层：扫描到 ${String(filesSeen)} 项，未逐条列出（这个目录不像单个工程）`
      : `顶层：${topLevel.slice(0, 20).join('、') || '（空）'}`;
  const summary = [
    `工程根目录：${path.basename(root)}（绝对路径不进上下文）`,
    topLevelText,
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
