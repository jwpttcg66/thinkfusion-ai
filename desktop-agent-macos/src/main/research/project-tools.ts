/**
 * 工程分析里让模型**自己读文件**的只读能力。
 *
 * 2026-11-09 用户裁决：「读取文件，模型不是应该调用本地能力，没看到调用本地能力，
 * 输出也是糟糕的。」
 *
 * 真机现场：附一份 md 问「这个文件有多少行」，两个本地模型都答「无法确定」，
 * 依据还是一段无关的 `index.html:8`。原因不难看：第一手回答原来只是一次
 * `generate()`——程序先把证据切成 8 个片段，模型没有读到整份文件的能力，
 * 附件正文又被截到一万多字，于是「多少行」这种只能靠真读文件才能答的问题，
 * 它只能认输。
 *
 * 这里补的就是那条缺失的通道：模型可以请求读一次文件，宿主真去读，把结果
 * 递回去，再由模型给结论。三条边界：
 *
 * - **只读**。没有写、删、跑命令；路径必须落在工程目录或这一问的附件里。
 * - **有预算**。一次回答最多额外 8 轮（`MAX_TOOL_ROUNDS`），请求不出来就按
 *   原来的方式答，不许把提问拖住。
 * - **结果带指纹与总数**。读文件回的是「共 N 行 / M 字节 + 指定区间正文」，
 *   行数这类问题不再需要模型自己数。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 模型可以请求的只读能力。名字与 Runtime 的 `fs.*` 工具保持一致，便于对照。 */
export const READ_TOOL_NAMES = ['fs.stat', 'fs.readFile', 'fs.search', 'fs.list'] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export interface ReadToolRequest {
  tool: ReadToolName;
  args: Record<string, unknown>;
}

export interface ReadToolScope {
  /** 工程目录；相对路径以它为基准。 */
  root: string;
  /** 这一问的附件绝对路径：不在工程目录下也允许读。 */
  extraFiles: readonly string[];
}

export interface ReadToolResult {
  ok: boolean;
  /** 递回模型的正文。失败时是给人看的原因，模型据此改口而不是硬答。 */
  text: string;
  /** 转录里那一行「调用了本机能力 …」。 */
  summary: string;
}

/** 工程探索最多额外 4 轮；超过之后必须给结论。 */
export const MAX_TOOL_ROUNDS = 8;

/** 单次读取的大小上限；再大的文件只报统计，不回正文。 */
const MAX_READ_BYTES = 64 * 1024 * 1024;
/** 回给模型的正文最多这么多字；行数、字节数永远按整份文件算。 */
const EXCERPT_CHARS = 4000;
/** 搜索最多回这么多条命中。 */
const MAX_HITS = 40;
/** 列目录最多回这么多项。 */
const MAX_ENTRIES = 200;

/**
 * 从一段模型输出里认出「读文件」的请求。
 *
 * 收得很紧：必须是**最后一个**能解析成对象、且带 `tool` 字段的 JSON，tool 还得
 * 在白名单里。模型正常回答里偶尔出现的花括号不该被当成请求——认错就会多跑
 * 一次工具、多问一轮，用户白等。
 */
export function parseToolRequest(raw: string): ReadToolRequest | null {
  if (typeof raw !== 'string') return null;
  // 从后往前找每一个 `{`，各切一个「配平的 JSON 片段」出来试。用配平扫描而不是
  // `indexOf('}')`：模型给的 args 本身带花括号，找第一个右括号只会切出半截。
  for (let start = raw.lastIndexOf('{'); start >= 0; ) {
    const slice = balancedJsonAt(raw, start);
    if (slice) {
      try {
        const parsed: unknown = JSON.parse(slice);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const value = parsed as { tool?: unknown; args?: unknown };
          const tool = normalizeTool(value.tool);
          if (tool) {
            const args =
              value.args && typeof value.args === 'object' && !Array.isArray(value.args)
                ? (value.args as Record<string, unknown>)
                : {};
            return { tool, args };
          }
        }
      } catch {
        // 这一截不是合法 JSON，继续往前找。
      }
    }
    // 到头就停。写 `lastIndexOf('{', -1)` 会更糟：负数被钳成 0，原地打转，
    // 一句「共 {3} 行」就能把进程吊死（2026-11-09 真被这条测试抓出来）。
    if (start === 0) break;
    start = raw.lastIndexOf('{', start - 1);
  }
  return null;
}

/** 从 `start` 处的 `{` 开始，按括号深度切出配平的那一段；切不出来返回 null。 */
function balancedJsonAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function normalizeTool(value: unknown): ReadToolName | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return (READ_TOOL_NAMES as readonly string[]).includes(text) ? (text as ReadToolName) : null;
}

/**
 * 把请求的路径落成真实路径，并且确认它在允许范围内。
 *
 * 范围 = 工程目录子树 + 这一问的附件（按 realpath 比，符号链接绕不出去）。
 * 这是「模型能读 ~/.ssh」与「模型只能读用户授权的东西」之间唯一的一道墙。
 */
async function resolveInScope(input: string, scope: ReadToolScope): Promise<string> {
  const target = path.isAbsolute(input) ? input : path.join(scope.root, input);
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new Error(`读不到 ${input}（文件不存在或没有权限）`);
  }
  const roots = await Promise.all([
    fs.realpath(scope.root).catch(() => scope.root),
    ...scope.extraFiles.map(file => fs.realpath(file).catch(() => file))
  ]);
  const allowed = roots.some(item => real === item || real.startsWith(item + path.sep));
  if (!allowed) throw new Error(`${input} 不在工程目录或这一问的附件里，不能读`);
  return real;
}

function fingerprint(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  if (text.charCodeAt(text.length - 1) === 10) lines -= 1;
  return lines;
}

function looksBinary(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(buffer.byteLength, 4096));
  for (const byte of head) {
    if (byte === 0) return true;
  }
  return false;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = Number(args[key]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

async function statTool(args: Record<string, unknown>, scope: ReadToolScope): Promise<ReadToolResult> {
  const target = readString(args, 'path');
  if (!target) throw new Error('fs.stat 需要 path');
  const real = await resolveInScope(target, scope);
  const stat = await fs.stat(real);
  if (stat.isDirectory()) {
    const listed = await fs.readdir(real);
    return {
      ok: true,
      text: `${target} 是一个目录，共 ${String(listed.length)} 项。`,
      summary: `fs.stat ${target}（目录）`
    };
  }
  if (stat.size > MAX_READ_BYTES) {
    return {
      ok: true,
      text: `${target}：${String(stat.size)} 字节，超过 ${String(MAX_READ_BYTES)} 字节，本轮不读正文，也不统计行数。`,
      summary: `fs.stat ${target}`
    };
  }
  const buffer = await fs.readFile(real);
  const binary = looksBinary(buffer);
  const text = binary ? '' : buffer.toString('utf8');
  return {
    ok: true,
    text: [
      `${target}：${String(stat.size)} 字节${binary ? '（二进制，不统计行数）' : `，${String(countLines(text))} 行`}`,
      `sha256 前 12 位 ${fingerprint(buffer)}；修改于 ${new Date(stat.mtimeMs).toISOString()}`
    ].join('\n'),
    summary: `fs.stat ${target}`
  };
}

async function readFileTool(args: Record<string, unknown>, scope: ReadToolScope): Promise<ReadToolResult> {
  const target = readString(args, 'path');
  if (!target) throw new Error('fs.readFile 需要 path');
  const real = await resolveInScope(target, scope);
  const stat = await fs.stat(real);
  if (stat.isDirectory()) throw new Error(`${target} 是目录，用 fs.list`);
  if (stat.size > MAX_READ_BYTES) {
    return {
      ok: true,
      text: `${target} 有 ${String(stat.size)} 字节，超过单次读取上限，只给统计：${String(stat.size)} 字节。`,
      summary: `fs.readFile ${target}（超上限，只给统计）`
    };
  }
  const buffer = await fs.readFile(real);
  if (looksBinary(buffer)) {
    return {
      ok: true,
      text: `${target} 是二进制文件（${String(buffer.byteLength)} 字节），不读正文。`,
      summary: `fs.readFile ${target}（二进制）`
    };
  }
  const text = buffer.toString('utf8');
  const total = countLines(text);
  const offset = Math.min(readNumber(args, 'offset') ?? 1, Math.max(total, 1));
  const limit = Math.min(readNumber(args, 'limit') ?? 200, 2000);
  const lines = text.split('\n');
  const start = offset - 1;
  const picked = lines.slice(start, start + limit);
  let body = picked.map((line, index) => `${String(start + index + 1)}\t${line}`).join('\n');
  if (body.length > EXCERPT_CHARS) body = `${body.slice(0, EXCERPT_CHARS)}\n…（这一段落太长，已截断）`;
  return {
    ok: true,
    text: [
      `${target}：共 ${String(total)} 行 / ${String(buffer.byteLength)} 字节；下面是第 ${String(offset)}-${String(Math.min(start + limit, total))} 行。`,
      body
    ].join('\n'),
    summary: `fs.readFile ${target}（第 ${String(offset)} 行起）`
  };
}

async function searchTool(args: Record<string, unknown>, scope: ReadToolScope): Promise<ReadToolResult> {
  const pattern = readString(args, 'pattern');
  if (!pattern) throw new Error('fs.search 需要 pattern');
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, 'i');
  } catch {
    throw new Error(`pattern 不是合法正则：${pattern}`);
  }
  const from = readString(args, 'path');
  const startDir = from ? await resolveInScope(from, scope) : await fs.realpath(scope.root).catch(() => scope.root);

  const hits: string[] = [];
  let scanned = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= MAX_HITS || depth > 6) return;
    const listed = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of listed) {
      if (hits.length >= MAX_HITS) return;
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || stat.size > 2 * 1024 * 1024) continue;
      scanned += 1;
      const buffer = await fs.readFile(abs).catch(() => null);
      if (!buffer || looksBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!regexp.test(lines[index])) continue;
        hits.push(`${path.relative(scope.root, abs) || abs}:${String(index + 1)}: ${lines[index].trim().slice(0, 200)}`);
        if (hits.length >= MAX_HITS) return;
      }
    }
  };
  await walk(startDir, 0);

  return {
    ok: true,
    text: hits.length > 0
      ? `在 ${String(scanned)} 个文件里找到 ${String(hits.length)} 处（最多列 ${String(MAX_HITS)} 处）：\n${hits.join('\n')}`
      : `在 ${String(scanned)} 个文件里没有找到 ${pattern}。`,
    summary: `fs.search ${pattern}`
  };
}

async function listTool(args: Record<string, unknown>, scope: ReadToolScope): Promise<ReadToolResult> {
  const target = readString(args, 'path') ?? '.';
  const real = await resolveInScope(target, scope);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error(`${target} 不是目录，用 fs.readFile`);
  const listed = await fs.readdir(real, { withFileTypes: true });
  const rows = listed.slice(0, MAX_ENTRIES).map(entry => {
    const kind = entry.isDirectory() ? '目录' : '文件';
    return `${kind} ${entry.name}`;
  });
  return {
    ok: true,
    text: `${target} 共 ${String(listed.length)} 项：\n${rows.join('\n')}${listed.length > MAX_ENTRIES ? `\n…（只列前 ${String(MAX_ENTRIES)} 项）` : ''}`,
    summary: `fs.list ${target}`
  };
}

/**
 * 执行一次读请求。失败**不抛**：把原因当成结果递回模型，让它换个读法或者如实说
 * 「读不到」——抛出去只会让整个成员变成一条失败。
 */
export async function executeReadTool(
  request: ReadToolRequest,
  scope: ReadToolScope
): Promise<ReadToolResult> {
  try {
    switch (request.tool) {
      case 'fs.stat': return await statTool(request.args, scope);
      case 'fs.readFile': return await readFileTool(request.args, scope);
      case 'fs.search': return await searchTool(request.args, scope);
      case 'fs.list': return await listTool(request.args, scope);
      default: throw new Error(`不支持的能力：${String(request.tool)}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, text: `能力调用失败：${detail}`, summary: `${request.tool}（失败：${detail}）` };
  }
}
