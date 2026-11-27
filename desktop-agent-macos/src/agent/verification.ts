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

  const wroteAnything = completedWrites.length > 0 || externalChanged.length > 0;
  const changesCode = changedPaths.some(path => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs)$/i.test(path));

  // 非代码改动（txt/md/json 这类）没有编译/测试可跑。写完再用 fs.readFile
  // 回读同一路径，就是「改动效果看得见」的证据；否则改一行文本也会被判
  // 未验证、反复开修复轮（2026-11-27 真机：改一个 note.txt 跑了 5 轮）。
  // 代码改动不适用：回读源码不等于它能编译或运行。
  const writeIndexByPath = new Map<string, number>();
  results.forEach((item, index) => {
    if (!WRITE_TOOLS.has(item.tool) || item.status !== 'completed') return;
    const written = (item.result as { path?: unknown } | null)?.path;
    if (typeof written === 'string') writeIndexByPath.set(written, index);
  });
  const readbackPassed = !changesCode && results.some((item, index) => {
    if (item.tool !== 'fs.readFile' || item.status !== 'completed') return false;
    const read = item.result as { path?: unknown; content?: unknown; sha256?: unknown } | null;
    const readPath = typeof read?.path === 'string' ? read.path : undefined;
    const writeIndex = readPath ? writeIndexByPath.get(readPath) : undefined;
    if (writeIndex === undefined || index <= writeIndex) return false;
    return (typeof read?.content === 'string' && read.content.length > 0)
      || typeof read?.sha256 === 'string';
  });

  const anyCheckPassed =
    checks.compile.status === 'passed' ||
    checks.run.status === 'passed' ||
    checks.tests.status === 'passed' ||
    checks.diagnostics.status === 'passed' ||
    readbackPassed;
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
 * 工程任务有没有「确认过交付」——与单轮 `verified` 不同，这是跨轮历史判断。
 *
 * 口径（2026-11-24）：怎么检查交付由模型在计划/步骤里设计，系统只确认那些检查
 * 是否已经落到执行报告的验证结论上。不在这里规定「必须写入」或「何种工具才算证据」。
 *
 * 仍要挡住真机假完成事故：第 1 轮写失败后，第 2 轮只有空验证（无成功步骤、
 * 也无任何通过的检查），模型一句「完成」不能过关。没有报告的历史（纯问答/旧数据）
 * 兼容返回 true。
 */
export function hasGenuineDelivery(reports: readonly ExecutionReport[]): boolean {
  if (reports.length === 0) return true;

  const hadFailedWrite = reports.some(report =>
    (report.results ?? []).some(step => WRITE_TOOLS.has(step.tool) && step.status === 'failed')
  );
  const hadSuccessfulWrite = reports.some(report =>
    (report.results ?? []).some(step => WRITE_TOOLS.has(step.tool) && step.status === 'completed') ||
    (report.verification?.changedFiles ?? 0) > 0
  );

  return reports.some(report => {
    const verification = report.verification;
    if (!verification?.verified) return false;

    const checks = verification.checks;
    const checkPassed = Boolean(
      checks && (
        checks.compile?.status === 'passed' ||
        checks.run?.status === 'passed' ||
        checks.tests?.status === 'passed' ||
        checks.diagnostics?.status === 'passed'
      )
    );
    const completedSteps = (report.results ?? []).filter(step => step.status === 'completed');
    // 写失败过的链：必须后续有成功写入，或有一次通过的检查，不能靠空验证收尾。
    if (hadFailedWrite && !hadSuccessfulWrite && !checkPassed) return false;
    // 模型设计的检查已反映在验证结论里：要么检查项通过，要么本轮有成功步骤且验证成立。
    if (checkPassed) return true;
    if (completedSteps.length > 0) return true;
    // 老报告可能没有 results，只认检查项通过；全 skipped 的空验证不算。
    return false;
  });
}
