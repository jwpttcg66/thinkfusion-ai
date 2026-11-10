/**
 * 语言诊断（`code.diagnostics`）：把本机已有的检查器输出归一成结构化问题。
 *
 * 为什么不是 LSP：语言服务器要常驻进程与文件监听，和本工程的「一次性执行」
 * 模型不搭。这里只用工程里已经装好的 `tsc` / `eslint`，拿它们的输出做结构化，
 * 不引新依赖、不猜结果；没有可用检查器时明确说「没有」，不改 schema。
 *
 * 退出码非 0 不是工具失败——有诊断问题才应该非 0。失败只指「检查器没跑起来」。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DiagnosticIssue {
  path: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
  source: 'tsc' | 'eslint' | 'ruff';
  code?: string;
}

export interface DiagnosticsResult {
  root: string;
  tools: string[];
  issues: DiagnosticIssue[];
  counts: { errors: number; warnings: number };
  /** 没跑起来的检查器与原因；不是失败，但要让人看得见。 */
  skipped: Array<{ tool: string; reason: string }>;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException & { code?: number | null })?.code;
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode: typeof code === 'number' ? code : error ? null : 0,
        timedOut: Boolean((error as { killed?: boolean } | null)?.killed)
      });
    });
  });
}

/** tsc 的 `--pretty false` 输出：`src/a.ts(12,3): error TS2322: 类型不匹配`。 */
export function parseTscOutput(output: string, root: string): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+)?:?\s*(.*)$/;
  for (const line of output.split('\n')) {
    const match = line.trim().match(pattern);
    if (!match) continue;
    const [, file, lineNo, column, severity, code, message] = match;
    issues.push({
      path: path.isAbsolute(file) ? file : path.resolve(root, file),
      line: Number(lineNo),
      column: Number(column),
      severity: severity === 'warning' ? 'warning' : 'error',
      message: message.trim(),
      source: 'tsc',
      ...(code ? { code } : {})
    });
  }
  return issues;
}

/** eslint `-f json`：数组里每项带 filePath / messages。 */
export function parseEslintOutput(output: string): DiagnosticIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const issues: DiagnosticIssue[] = [];
  for (const file of parsed) {
    if (!file || typeof file !== 'object') continue;
    const record = file as { filePath?: unknown; messages?: unknown };
    if (typeof record.filePath !== 'string' || !Array.isArray(record.messages)) continue;
    for (const message of record.messages) {
      if (!message || typeof message !== 'object') continue;
      const item = message as {
        line?: unknown;
        column?: unknown;
        severity?: unknown;
        message?: unknown;
        ruleId?: unknown;
      };
      if (typeof item.message !== 'string') continue;
      issues.push({
        path: record.filePath,
        line: typeof item.line === 'number' ? item.line : 1,
        ...(typeof item.column === 'number' ? { column: item.column } : {}),
        severity: item.severity === 1 ? 'warning' : 'error',
        message: item.message,
        source: 'eslint',
        ...(typeof item.ruleId === 'string' ? { code: item.ruleId } : {})
      });
    }
  }
  return issues;
}

function localBin(root: string, name: string): string | null {
  const bin = path.join(root, 'node_modules', '.bin', name);
  return fs.existsSync(bin) ? bin : null;
}

function limit(issues: DiagnosticIssue[], max: number): DiagnosticIssue[] {
  return issues.length > max ? issues.slice(0, max) : issues;
}

/**
 * 在授权目录里跑可用的检查器，合并结果。
 *
 * 只认工程里已安装的二进制（`node_modules/.bin`），**不用 npx**：npx 在缺包时
 * 会去下载，一次「看诊断」就变成一次联网安装。
 */
export async function runDiagnostics(
  root: string,
  args: { path?: string; maxItems?: number; timeoutMs?: number } = {}
): Promise<DiagnosticsResult> {
  const cwd = args.path ? path.resolve(root, args.path) : root;
  const maxItems = Math.max(1, Math.min(args.maxItems ?? 50, 200));
  const timeoutMs = Math.max(1000, Math.min(args.timeoutMs ?? 120_000, 300_000));
  const tools: string[] = [];
  const skipped: DiagnosticsResult['skipped'] = [];
  const issues: DiagnosticIssue[] = [];

  const tsc = localBin(root, 'tsc');
  if (tsc && fs.existsSync(path.join(root, 'tsconfig.json'))) {
    const result = await run(tsc, ['--noEmit', '--pretty', 'false'], cwd, timeoutMs);
    if (result.exitCode === 0 || result.stdout.trim().length > 0) {
      tools.push('tsc');
      issues.push(...parseTscOutput(result.stdout, root));
    } else {
      skipped.push({ tool: 'tsc', reason: result.timedOut ? '超时' : result.stderr.trim().slice(0, 300) || '没有输出' });
    }
  } else {
    skipped.push({ tool: 'tsc', reason: tsc ? '没有 tsconfig.json' : '没有安装 typescript' });
  }

  const eslint = localBin(root, 'eslint');
  const hasEslintConfig = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs']
    .some(file => fs.existsSync(path.join(root, file)));
  if (eslint && hasEslintConfig) {
    const result = await run(eslint, ['-f', 'json', '.'], cwd, timeoutMs);
    if (result.stdout.trim().startsWith('[')) {
      tools.push('eslint');
      issues.push(...parseEslintOutput(result.stdout));
    } else {
      skipped.push({ tool: 'eslint', reason: result.timedOut ? '超时' : '没有可解析的 JSON 输出' });
    }
  } else {
    skipped.push({ tool: 'eslint', reason: eslint ? '没有 eslint 配置' : '没有安装 eslint' });
  }

  const kept = limit(issues, maxItems);
  return {
    root,
    tools,
    issues: kept,
    counts: {
      errors: kept.filter(item => item.severity === 'error').length,
      warnings: kept.filter(item => item.severity === 'warning').length
    },
    skipped
  };
}
