/**
 * 「本轮到底验没验过」：只陈述执行报告里读得到的事实。
 *
 * 规则来自设计文档：改了文件就必须有一次真的检查跑过——成功的编译 / 运行
 * （退出码 0，或 `code.diagnostics` 报 0 个 error）。写操作全失败、或写完
 * 什么都没跑，都不能算「已验证」。
 *
 * V1.2 起结果结构化：compile / tests / diagnostics / changedFiles 各自
 * 带状态与退出码，界面和下一轮模型不用再从一段文字里猜。所有值都来自
 * StepResult，不允许模型自己填写。
 */

import type { StepResult, ExecutionReport } from '../shared/contracts';
import { stepEvidenceKinds, type EvidenceKind } from '../shared/verification-evidence';

const WRITE_TOOLS = new Set(['fs.writeFile', 'fs.edit', 'fs.applyPatch', 'fs.remove', 'fs.move', 'fs.copy']);

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface CommandCheck {
  status: CheckStatus;
  exitCode?: number;
  command?: string;
  detail?: string;
  /** 这一步打在控制台上的第一行输出：`hello everybody` 就是验收证据。 */
  output?: string;
}

export interface DiagnosticsCheck {
  status: CheckStatus;
  errors: number;
  warnings: number;
  source?: string;
  path?: string;
  command?: string;
  exitCode?: number;
  detail?: string;
}

export interface VerificationChecks {
  compile: CommandCheck;
  /** 真的把程序跑起来（java Main / python x.py / node x.js / ./bin）。 */
  run: CommandCheck;
  tests: CommandCheck;
  diagnostics: DiagnosticsCheck;
  changedFiles: string[];
}

export interface ExecutionVerification {
  verified: boolean;
  /** 改了代码时，四项检查（编译/运行/测试/诊断）都通过才为 true。 */
  fullyVerified: boolean;
  /** 为什么没算过（或为什么算过）；给界面与报告直接用。 */
  reasons: string[];
  changedFiles: number;
  /** 成功改过的文件路径；编排器据此判断「改的是不是代码」。 */
  changedPaths: string[];
  /** V1.2：结构化检查结果。老报告没有这个字段，读取方按缺失处理。 */
  checks: VerificationChecks;
}

function commandResult(step: StepResult): { status: CheckStatus; exitCode?: number; command?: string; detail?: string; output?: string } {
  const result = step.result as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown } | null;
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : undefined;
  const command = typeof (step.args as { command?: unknown } | undefined)?.command === 'string'
    ? String((step.args as { command: string }).command)
    : undefined;
  // 控制台上第一行非空输出：`hello everybody` 这种就是「跑起来了、而且是对的」
  // 的唯一直接证据，界面与评审都直接用它，不再只说一句「通过」。
  const firstLine = typeof result?.stdout === 'string'
    ? result.stdout.split('\n').map(line => line.trim()).find(line => line.length > 0)
    : undefined;
  const output = firstLine ? firstLine.slice(0, 120) : undefined;
  if (step.status === 'failed') {
    return {
      status: 'failed',
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(command === undefined ? {} : { command }),
      ...(output === undefined ? {} : { output }),
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
    ...(output === undefined ? {} : { output }),
    ...(timedOut ? { detail: '超时' } : {})
  };
}

/**
 * 取最后一处能归到这一类证据的步骤。
 *
 * 候选不只 `test.run`：`shell.run` 里写的 `javac` / `mvn package` / `pytest` /
 * `[ "$out" = "hello jwp" ]` 同样是跑过的检查（判定在
 * `shared/verification-evidence.ts`，与计划门禁、评审辩题共用一份口径）。
 * 「最后一处」优先，是因为同一轮里模型可能先跑失败、再跑成功；以最后的状态
 * 为准，前面失败过的痕迹已经由 reasons 里的事实记录。
 */
function lastCommand(results: readonly StepResult[], kind: EvidenceKind): CommandCheck {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const step = results[index];
    if (!stepEvidenceKinds({ tool: step.tool, args: step.args }).includes(kind)) continue;
    const outcome = commandResult(step);
    // 没执行过的步骤不构成证据，也不要把它写成「跳过但失败」。
    if (outcome.status === 'skipped') continue;
    return outcome;
  }
  return { status: 'skipped' };
}

/**
 * 真机运行这一项。
 *
 * 只有「跑完了、有退出码、退出码 0」才叫跑通。`npm run dev` 这类后台启动的
 * 进程没有退出码，它证明的是服务起来了，不是这次改动能跑对——按跳过记。
 */
function runCheck(results: readonly StepResult[]): CommandCheck {
  const outcome = lastCommand(results, 'run');
  if (outcome.status === 'passed' && outcome.exitCode === undefined) {
    return {
      status: 'skipped',
      ...(outcome.command === undefined ? {} : { command: outcome.command }),
      detail: '程序在后台启动，没有退出码：不算跑完'
    };
  }
  return outcome;
}

function diagnosticsCheck(results: readonly StepResult[]): DiagnosticsCheck {
  const steps = results.filter(step => step.tool === 'code.diagnostics');
  const step = steps[steps.length - 1];
  if (!step) {
    // 没有 code.diagnostics 时，`go vet` / `eslint` / `ruff` 这类静态检查
    // 同样是诊断证据；否则 Go/Java 任务永远凑不齐四项。
    const shell = lastCommand(results, 'diagnostics');
    if (shell.status === 'skipped') return { status: 'skipped', errors: 0, warnings: 0 };
    return {
      status: shell.status,
      errors: shell.status === 'passed' ? 0 : 1,
      warnings: 0,
      source: 'shell',
      ...(shell.command ? { command: shell.command } : {}),
      ...(shell.exitCode !== undefined ? { exitCode: shell.exitCode } : {}),
      detail: shell.detail ?? shell.command
    };
  }
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
    compile: lastCommand(results, 'compile'),
    run: runCheck(results),
    tests: lastCommand(results, 'tests'),
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
    checks.run.status === 'passed' ||
    checks.tests.status === 'passed' ||
    checks.diagnostics.status === 'passed';

  const wroteAnything = completedWrites.length > 0 || externalChanged.length > 0;
  const changesCode = changedPaths.some(path => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs)$/i.test(path));
  const allChecksPassed =
    checks.compile.status === 'passed' &&
    checks.run.status === 'passed' &&
    checks.tests.status === 'passed' &&
    checks.diagnostics.status === 'passed';
  const reasons: string[] = [];
  if (failedWrites.length > 0) {
    reasons.push(`${String(failedWrites.length)} 个写操作失败：本轮不能算已验证`);
  }
  if (externalChanged.length > 0 && !anyCheckPassed) {
    reasons.push(
      `外部 Agent 改了 ${String(externalChanged.length)} 个文件，但没有独立的构建 / 测试 / 运行断言或诊断：本轮不能算已验证`
    );
  }
  if (completedWrites.length > 0 && !anyCheckPassed) {
    reasons.push('改了文件，但没有任何成功的构建 / 运行 / 测试 / 诊断：本轮不能算已验证');
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
  if (checks.run.status === 'failed') {
    reasons.push(`程序运行失败（${checks.run.command ?? '运行命令'}，退出码 ${String(checks.run.exitCode ?? '未知')}）`);
  }
  if (checks.tests.status === 'failed') {
    reasons.push(`测试失败（${checks.tests.command ?? 'test.run'}，退出码 ${String(checks.tests.exitCode ?? '未知')}）`);
  }
  if (changesCode && !allChecksPassed) {
    const labels: Array<[string, CheckStatus]> = [
      ['编译', checks.compile.status],
      ['运行', checks.run.status],
      ['测试', checks.tests.status],
      ['诊断', checks.diagnostics.status]
    ];
    const missing = labels.filter(([, status]) => status !== 'passed').map(([label]) => label);
    if (missing.length > 0) reasons.push(`完成检查未齐全：${missing.join('、')}未通过/未执行`);
  }
  if (checks.diagnostics.status === 'failed') {
    reasons.push(
      checks.diagnostics.errors > 0
        ? `诊断还有 ${String(checks.diagnostics.errors)} 个 error`
        : `诊断执行失败（${checks.diagnostics.detail ?? '没有给出原因'}）`
    );
  }

  // 代码改动必须四项都通过；非代码改动仍按「至少一项检查」的旧口径。
  const fullyVerified = failedWrites.length === 0 && (!wroteAnything || (changesCode ? allChecksPassed : anyCheckPassed));
  return {
    verified: failedWrites.length === 0 && (!wroteAnything || anyCheckPassed),
    fullyVerified,
    reasons,
    // 兼容旧报告：这是「成功写了几次」；外部 Agent 按改动文件数计。
    changedFiles: completedWrites.length + externalChanged.length,
    changedPaths,
    checks
  };
}

/**
 * 工程任务到底有没有「真交付过」——与单轮的 `verified` 不同，这是跨轮的历史判断。
 *
 * 背景（真机事故）：一个任务第 1 轮写文件 EEXIST 失败，第 2 轮只剩 fs.list / fs.tree
 * 这种空轮，verifyExecution 按既有契约把它记成「没有写操作，无需验证 → verified」，
 * 第 3 轮模型回一句「任务完成」，编排器就直接用 `complete` 声明标成 completed。
 * 结果代码从没写成、程序从没跑过，界面却显示完成——用户看到的就是「假完成」。
 *
 * 空轮 trivially verified 是对的规则（纯问答轮不该被判失败），不能改；要挡的是
 * 「把工程任务的空轮/失败轮当成可交付的证据」。判据是整条链里至少有一份报告真的
 * 跑过一次能观察结果的检查（编译/运行/测试/诊断通过）——不要求必须写过文件：目标
 * 代码本来就正确时无需改动，跑通就是交付。没有报告的历史任务（旧数据、纯问答会话）
 * 按兼容处理返回 true，避免翻旧账。
 */
export function hasGenuineDelivery(reports: readonly ExecutionReport[]): boolean {
  if (reports.length === 0) return true; // 没有报告：不是工程执行链，兼容旧行为
  return reports.some(report => {
    const checks = report.verification?.checks;
    if (!checks) return false;
    // 判据是「真的跑过一次能观察结果的检查」，不是「必须写过文件」。
    // 目标代码本来就正确、无需改动的任务，只要 javac / java / 测试 / 诊断
    // 有一次通过就是真交付；反过来只列目录、什么都没跑的空轮一律不算。
    return checks.compile?.status === 'passed' ||
      checks.run?.status === 'passed' ||
      checks.tests?.status === 'passed' ||
      checks.diagnostics?.status === 'passed';
  });
}
