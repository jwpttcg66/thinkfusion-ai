/**
 * 数据文件能力：JSON 取值、CSV 概要、SQLite 只读查询。
 *
 * 模型读一个 200KB 的 JSON 或 CSV 时，真正要的通常只是「第 37 条记录的 status」
 * 或「这一列有多少个空值」。把整个文件塞进上下文既烧窗口又容易读漏；这三个
 * 工具让它一次问准。
 *
 * 边界：
 * - 只读，不写回任何文件；JSON/CSV 都有字节上限与条数上限；
 * - SQLite 用 `-readonly` 打开，且语句只放行 SELECT / WITH / 只读 PRAGMA，
 *   写库在工具层就被拒，不依赖文件权限；
 * - 输出一律带 `truncated`，截断是明确事实，不是静默丢数据。
 */

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_CHARS = 20_000;
const MAX_ROWS = 5000;

async function readText(target: string): Promise<string> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('目标必须是普通文件');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过上限 ${MAX_FILE_BYTES} bytes（先用 fs.search 缩小范围）`);
  return fs.readFile(target, 'utf8');
}

// ---------------------------------------------------------------------------
// json.query
// ---------------------------------------------------------------------------

export interface JsonQueryResult {
  path: string;
  pointer: string;
  found: boolean;
  type: string;
  value?: unknown;
  preview: string;
  truncated: boolean;
}

/** 支持 `a.b[0].c` 与 JSON Pointer 两种写法：前者顺手，后者能表达怪键名。 */
function parsePointer(pointer: string): Array<string | number> {
  const text = pointer.trim();
  if (!text || text === '/') return [];
  if (text.startsWith('/')) {
    return text
      .slice(1)
      .split('/')
      .map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
      .map(token => (/^\d+$/.test(token) ? Number(token) : token));
  }
  const out: Array<string | number> = [];
  for (const chunk of text.split('.')) {
    if (!chunk) continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(chunk);
    if (!match) throw new Error(`无法解析的路径片段：${chunk}`);
    if (match[1]) out.push(match[1]);
    for (const index of match[2].match(/\d+/g) ?? []) out.push(Number(index));
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

async function jsonQuery(
  grant: TaskGrant,
  args: { path: string; pointer?: string; maxChars?: number }
): Promise<JsonQueryResult> {
  const target = await resolveGrantedPath(grant, args.path, false);
  const raw = await readText(target);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`不是合法 JSON：${(error as Error).message}`);
  }

  const pointer = args.pointer ?? '';
  const tokens = parsePointer(pointer);
  let current: unknown = parsed;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') {
      return { path: target, pointer, found: false, type: 'undefined', preview: '', truncated: false };
    }
    if (Array.isArray(current)) {
      // 数组下标两种写法都要收：`a.b[0]` 解析出来是数字，`/a/b/0` 解析出来是字符串。
      const index = typeof token === 'number' ? token : /^\d+$/.test(token) ? Number(token) : NaN;
      if (Number.isNaN(index)) {
        return { path: target, pointer, found: false, type: 'undefined', preview: '', truncated: false };
      }
      current = current[index];
    } else {
      const key = String(token);
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        return { path: target, pointer, found: false, type: 'undefined', preview: '', truncated: false };
      }
      current = (current as Record<string, unknown>)[key];
    }
  }

  const maxChars = Math.min(Math.max(args.maxChars ?? MAX_JSON_CHARS, 200), MAX_JSON_CHARS);
  const preview = JSON.stringify(current, null, 2) ?? String(current);
  return {
    path: target,
    pointer,
    found: true,
    type: describe(current),
    value: preview.length <= maxChars ? current : undefined,
    preview: preview.slice(0, maxChars),
    truncated: preview.length > maxChars
  };
}

// ---------------------------------------------------------------------------
// csv.summary
// ---------------------------------------------------------------------------

export interface CsvColumnSummary {
  name: string;
  filled: number;
  empty: number;
  distinct: number;
  samples: string[];
  numeric?: { min: number; max: number; mean: number };
}

export interface CsvSummaryResult {
  path: string;
  delimiter: string;
  rows: number;
  columns: CsvColumnSummary[];
  truncated: boolean;
}

/** 最小 CSV 读法：支持双引号包裹、`""` 转义、引号内换行。 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function guessDelimiter(sample: string, explicit?: string): string {
  if (explicit) {
    if (explicit.length !== 1) throw new Error('delimiter 必须是单个字符');
    return explicit;
  }
  const line = sample.split('\n')[0] ?? '';
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = line.split(candidate).length - 1;
    if (count > bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

async function csvSummary(
  grant: TaskGrant,
  args: { path: string; delimiter?: string; maxRows?: number; samples?: number }
): Promise<CsvSummaryResult> {
  const target = await resolveGrantedPath(grant, args.path, false);
  const raw = await readText(target);
  const delimiter = guessDelimiter(raw, args.delimiter);
  const rows = parseCsv(raw, delimiter);
  const limit = Math.min(Math.max(args.maxRows ?? MAX_ROWS, 1), MAX_ROWS);
  const sampleCount = Math.min(Math.max(args.samples ?? 3, 0), 10);

  const header = rows.shift() ?? [];
  const body = rows.slice(0, limit);
  const columns: CsvColumnSummary[] = header.map((name, index) => {
    let filled = 0;
    let empty = 0;
    const distinct = new Set<string>();
    const samples: string[] = [];
    const numbers: number[] = [];

    for (const row of body) {
      const value = (row[index] ?? '').trim();
      if (value === '') { empty += 1; continue; }
      filled += 1;
      if (distinct.size < 500) distinct.add(value);
      if (samples.length < sampleCount && !samples.includes(value)) samples.push(value);
      // 纯数字才算进统计：`1,234`、`N/A` 这类别混进均值里骗人。
      if (/^-?\d+(\.\d+)?$/.test(value)) numbers.push(Number(value));
    }

    const summary: CsvColumnSummary = { name: name || `第 ${index + 1} 列`, filled, empty, distinct: distinct.size, samples };
    if (numbers.length > 0 && numbers.length === filled) {
      const sum = numbers.reduce((total, value) => total + value, 0);
      summary.numeric = {
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        mean: Math.round((sum / numbers.length) * 1000) / 1000
      };
    }
    return summary;
  });

  return {
    path: target,
    delimiter,
    rows: body.length,
    columns,
    truncated: rows.length > limit
  };
}

// ---------------------------------------------------------------------------
// sqlite.query
// ---------------------------------------------------------------------------

const READ_ONLY_SQL = /^\s*(?:select|with|pragma|explain)\b/i;
const WRITE_SQL = /\b(?:insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex)\b/i;

function runSqlite(file: string, sql: string, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('sqlite3', ['-readonly', '-json', file, sql], {
        shell: false,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', chunk => { if (stdout.length < 512 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export interface SqliteQueryResult {
  path: string;
  sql: string;
  rows: unknown[];
  truncated: boolean;
}

async function sqliteQuery(
  grant: TaskGrant,
  args: { path: string; sql: string; maxRows?: number }
): Promise<SqliteQueryResult> {
  const target = await resolveGrantedPath(grant, args.path, false);
  const sql = (args.sql ?? '').trim().replace(/;\s*$/, '');
  if (!sql) throw new Error('sql 不能为空');
  if (!READ_ONLY_SQL.test(sql)) throw new Error('只允许 SELECT / WITH / PRAGMA / EXPLAIN 查询');
  if (WRITE_SQL.test(sql)) throw new Error('查询里出现了写操作关键字，拒绝执行');

  const maxRows = Math.min(Math.max(args.maxRows ?? 200, 1), 2000);
  const run = await runSqlite(target, `${sql} LIMIT ${maxRows + 1}`);
  if (run.code !== 0) {
    // `sqlite3` 不在 PATH 时给一句人话，而不是让模型以为是 SQL 写错了。
    if (/ENOENT|not found/i.test(run.stderr)) throw new Error('本机没有 sqlite3 命令，无法查询数据库');
    throw new Error(`查询失败：${run.stderr.trim() || '没有输出'}`);
  }

  const text = run.stdout.trim();
  if (!text) return { path: target, sql, rows: [], truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('sqlite3 没有返回 JSON（可能是旧版本），改用 shell.run 手工查');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return { path: target, sql, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}

export const dataTools = {
  jsonQuery,
  csvSummary,
  sqliteQuery
};
