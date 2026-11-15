/**
 * 「本轮到底验没验过」：只陈述执行报告里读得到的事实。
 *
 * 规则来自设计文档：改了文件就必须有一次真的检查跑过——成功的编译/测试
 * （退出码 0），或 `code.diagnostics` 报 0 个 error。写操作全失败、或写完
 * 什么都没跑，都不能算「已验证」。
 *
 * V1.2 起结果结构化：compile / tests / diagnostics / changedFiles 各自
 * 带状态与退出码，界面和下一轮模型不用再从一段文字里猜。所有值都来自
 * StepResult，不允许模型自己填写。
 */

import type { StepResult } from '../shared/contracts';

const WRITE_TOOLS = new Set(['fs.writeFile', 'fs.edit', 'fs.applyPatch', 'fs.remove', 'fs.move', 'fs.copy']);
const COMPILE_COMMAND = /typecheck|build/i;

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface CommandCheck {
  status: CheckStatus;
  exitCode?: number;
  command?: string;
  detail?: string;
}

export interface DiagnosticsCheck {
  status: CheckStatus;
  errors: number;
  warnings: number;
  source?: string;
  path?: string;
  detail?: string;
}

export interface VerificationChecks {
  compile: CommandCheck;
  tests: CommandCheck;
  diagnostics: DiagnosticsCheck;
  changedFiles: string[];
}

export interface ExecutionVerification {
  verified: boolean;
  /** 为什么没算过（或为什么算过）；给界面与报告直接用。 */
  reasons: string[];
  changedFiles: number;
  /** 成功改过的文件路径；编排器据此判断「改的是不是代码」。 */
  changedPaths: string[];
  /** V1.2：结构化检查结果。老报告没有这个字段，读取方按缺失处理。 */
  checks: VerificationChecks;
}

function commandResult(step: StepResult): { status: CheckStatus; exitCode?: number; command?: string; detail?: string } {
  const result = step.result as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown } | null;
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : undefined;
  const command = typeof (step.args as { command?: unknown } | undefined)?.command === 'string'
    ? String((step.args as { command: string }).command)
    : undefined;
  if (step.status === 'failed') {
    return {
      status: 'failed',
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(command === undefined ? {} : { command }),
      detail: step.error ?? '执行失败'
    };
  }
  if (step.status !== 'completed') {
    return { status: 'skipped', ...(command === undefined ? {} : { command }), detail: '没有执行' };
  }
  if (exitCode === undefined) {
    return { status: 'passed', ...(command === undefined ? {} : { command }), detail: '命令已跑完，但没有退出码（后台作业）' };
  }
  const timedOut = result?.timedOut === true;
  return {
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    ...(command === undefined ? {} : { command }),
    ...(timedOut ? { detail: '超时' } : {})
  };
}

function lastCommand(results: readonly StepResult[], predicate: (command: string | undefined) => boolean): CommandCheck {
  const steps = results.filter(step => step.tool === 'test.run');
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    const command = (step.args as { command?: unknown } | undefined)?.command;
    if (predicate(typeof command === 'string' ? command : undefined)) return commandResult(step);
  }
  return { status: 'skipped' };
}

function diagnosticsCheck(results: readonly StepResult[]): DiagnosticsCheck {
  const steps = results.filter(step => step.tool === 'code.diagnostics');
  const step = steps[steps.length - 1];
  if (!step) return { status: 'skipped', errors: 0, warnings: 0 };
  const result = step.result as {
    counts?: { errors?: unknown; warnings?: unknown };
    source?: unknown;
    path?: unknown;
  } | null;
  const errors = typeof result?.counts?.errors === 'number' ? result.counts.errors : 0;
  const warnings = typeof result?.counts?.warnings === 'number' ? result.counts.warnings : 0;
  const base = {
    errors,
    warnings,
    ...(typeof result?.source === 'string' ? { source: result.source } : {}),
    ...(typeof result?.path === 'string' ? { path: result.path } : {})
  };
  if (step.status === 'failed') {
    return { ...base, status: 'failed', detail: step.error ?? '诊断执行失败' };
  }
  if (step.status !== 'completed') {
    return { ...base, status: 'skipped', detail: '没有执行' };
  }
  return { ...base, status: errors === 0 ? 'passed' : 'failed' };
}

export function verifyExecution(results: readonly StepResult[]): ExecutionVerification {
  const writes = results.filter(item => WRITE_TOOLS.has(item.tool));
  const completedWrites = writes.filter(item => item.status === 'completed');
  const failedWrites = writes.filter(item => item.status === 'failed');

  // 外部 CLI 的写操作不会以 fs.writeFile 出现：它自己改文件，我们只在运行
  // 前后各取一次 git status，把差集当作「改过」的事实。少了这一段，一个把
  // 代码改完却没跑测试的 CLI 任务会被判成「没有写操作，无需验证」。
  const externalChanged = [
    ...new Set(
      results
        .filter(item => item.tool === 'agent.exec' && item.status === 'completed')
        .flatMap(item => {
          const result = item.result as { changedPaths?: unknown } | null;
          return Array.isArray(result?.changedPaths)
            ? result.changedPaths.filter((value): value is string => typeof value === 'string')
            : [];
        })
    )
  ].sort();

  const checks: VerificationChecks = {
    compile: lastCommand(results, command => command !== undefined && COMPILE_COMMAND.test(command)),
    tests: lastCommand(results, command => command === undefined || !COMPILE_COMMAND.test(command)),
    diagnostics: diagnosticsCheck(results),
    changedFiles: []
  };

  const changedPaths = [...new Set([
    ...completedWrites
      .map(item => (item.args as { path?: unknown } | undefined)?.path)
      .filter((value): value is string => typeof value === 'string'),
    ...externalChanged
  ])].sort();
  checks.changedFiles = changedPaths;

  const anyCheckPassed =
    checks.compile.status === 'passed' ||
    checks.tests.status === 'passed' ||
    checks.diagnostics.status === 'passed';

  const reasons: string[] = [];
  if (failedWrites.length > 0) {
    reasons.push(`${String(failedWrites.length)} 个写操作失败：本轮不能算已验证`);
  }
  if (externalChanged.length > 0 && !anyCheckPassed) {
    reasons.push(
      `外部 Agent 改了 ${String(externalChanged.length)} 个文件，但没有独立的测试或诊断：本轮不能算已验证`
    );
  }
  if (completedWrites.length > 0 && !anyCheckPassed) {
    reasons.push('改了文件但没有成功的测试或诊断：本轮不能算已验证');
  }
  if (completedWrites.length === 0 && failedWrites.length === 0 && externalChanged.length === 0) {
    reasons.push('本轮没有写操作，无需验证');
  }
  if (externalChanged.length > 0) {
    reasons.push(
      `外部 Agent 的改动路径来自运行前后 git status 的差集（${externalChanged.slice(0, 8).join('、')}${externalChanged.length > 8 ? ' 等' : ''}）`
    );
  }
  if (checks.compile.status === 'failed') {
    reasons.push(`编译检查失败（${checks.compile.command ?? 'test.run'}，退出码 ${String(checks.compile.exitCode ?? '未知')}）`);
  }
  if (checks.tests.status === 'failed') {
    reasons.push(`测试失败（${checks.tests.command ?? 'test.run'}，退出码 ${String(checks.tests.exitCode ?? '未知')}）`);
  }
  if (checks.diagnostics.status === 'failed') {
    reasons.push(
      checks.diagnostics.errors > 0
        ? `诊断还有 ${String(checks.diagnostics.errors)} 个 error`
        : `诊断执行失败（${checks.diagnostics.detail ?? '没有给出原因'}）`
    );
  }

  const wroteAnything = completedWrites.length > 0 || externalChanged.length > 0;
  return {
    verified: failedWrites.length === 0 && (!wroteAnything || anyCheckPassed),
    reasons,
    // 兼容旧报告：这是「成功写了几次」；外部 Agent 按改动文件数计。
    changedFiles: completedWrites.length + externalChanged.length,
    changedPaths,
    checks
  };
}
