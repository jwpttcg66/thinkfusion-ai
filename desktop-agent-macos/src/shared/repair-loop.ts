/**
 * 修复轮闸门：没有新证据，就不许再开一轮。
 *
 * 真机 2026-11-26：一个本该 134 秒结束的任务跑了 421 秒。多出来的两轮里，
 * 模型把同一个失败命令又跑了一遍、输出一模一样，评审把同样的问题又说了一遍，
 * 系统照旧开下一轮。同一件事做三遍不叫修复，叫空转。
 *
 * 判据只有两条，都从报告里读，不看模型怎么说：
 * 1. 这一轮有没有产生上一轮没有的事实（命令、退出码、输出、参数、验证结论）；
 * 2. 评审有没有提出上一轮没提过的问题。
 * 两条都没有，就停在这里交回用户，而不是再花一轮预算重复同样的事。
 */

import type { ExecutionReport } from './contracts';
import type { DeliveryState, GoalContractFit } from './goal-contract';
import { verificationIsComplete } from './task-view';

export interface RepairLoopState {
  /** 报告里能核对的事实指纹（见 `evidenceFacts`）。 */
  facts: readonly string[];
  /** 评审给出的待修问题。 */
  issues: readonly string[];
}

/**
 * 报告 → 交付三态。
 *
 * 决策函数要的是「做完了吗 / 验过了吗」的可核对口径，不是报告自述的 `nextAction`：
 * `partial` 说明活没干完，execution 记 `PENDING`；改了代码但四项检查没齐，verification
 * 记 `PARTIAL` 而不是 `PASSED`。这里不推断，只翻译报告里已有的字段。
 */
export function deliveryFromReport(
  report: ExecutionReport,
  goal: GoalContractFit = 'UNKNOWN'
): DeliveryState {
  const execution = report.status === 'completed'
    ? 'COMPLETED'
    : report.status === 'cancelled'
      ? 'CANCELLED'
      : report.status === 'failed'
        ? 'FAILED'
        : 'PENDING';
  const checks = report.verification?.checks;
  const anyFailed = Boolean(
    checks && (
      checks.compile.status === 'failed' ||
      checks.tests.status === 'failed' ||
      checks.run?.status === 'failed' ||
      checks.diagnostics?.status === 'failed'
    )
  );
  const verification = anyFailed
    ? 'FAILED'
    : !report.verification
      ? 'UNVERIFIED'
      : verificationIsComplete(report.verification)
        ? 'PASSED'
        : report.verification.verified || checks
          ? 'PARTIAL'
          : 'UNVERIFIED';
  return { execution, verification, goal };
}

function hashText(text: string): string {
  // FNV-1a：只用来判断「输出变没变」，不需要抗碰撞。
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 把一份执行报告压成可比对的事实列表。
 *
 * 每一项都是「这一轮真实发生过什么」，同一个字符串重复出现就是没变化。
 * 故意包含参数与输出哈希：改了文件但命令、输出、退出码都相同仍算没变化，
 * 因为那说明改动没有到达任何能观察结果的地方。
 */
export function evidenceFacts(report: ExecutionReport): string[] {
  const facts: string[] = [];
  for (const item of report.results) {
    const result = asRecord(item.result);
    const exitCode = result?.exitCode;
    facts.push(
      [
        'step',
        item.stepId,
        item.tool,
        item.status,
        exitCode === undefined || exitCode === null ? '' : String(exitCode),
        textOf(item.error)
      ].join(':')
    );
    facts.push(`args:${item.stepId}:${hashText(JSON.stringify(item.args ?? null))}`);
    const stdout = textOf(result?.stdout);
    const stderr = textOf(result?.stderr);
    if (stdout || stderr) facts.push(`out:${item.stepId}:${hashText(`${stdout}\u0000${stderr}`)}`);
  }

  for (const ref of report.evidence?.refs ?? []) {
    const record = asRecord(ref) ?? {};
    facts.push(
      [
        'evidence',
        String(record.kind ?? ''),
        textOf(record.command) || textOf(record.path) || textOf(record.url),
        record.exitCode === undefined || record.exitCode === null ? '' : String(record.exitCode)
      ].join(':')
    );
  }

  const verification = report.verification;
  if (verification) {
    facts.push(`verified:${verification.verified ? 'yes' : 'no'}`);
    const checks = verification.checks;
    if (checks) {
      const rows: Array<[string, unknown]> = [
        ['compile', checks.compile],
        ['run', checks.run],
        ['tests', checks.tests]
      ];
      for (const [label, raw] of rows) {
        const check = asRecord(raw);
        if (!check) continue;
        facts.push(
          `check:${label}:${textOf(check.status)}:${check.exitCode === undefined ? '' : String(check.exitCode)}:${hashText(
            `${textOf(check.command)}\u0000${textOf(check.output)}`
          )}`
        );
      }
      const diagnostics = asRecord(checks.diagnostics);
      if (diagnostics) {
        facts.push(`diagnostics:${textOf(diagnostics.status)}:${String(diagnostics.errors ?? '')}:${String(diagnostics.warnings ?? '')}`);
      }
    }
    for (const path of (verification as { changedPaths?: string[] }).changedPaths ?? []) {
      facts.push(`changed:${path}`);
    }
    for (const reason of verification.reasons) facts.push(`reason:${reason}`);
  }
  return facts;
}

function normalizeIssues(issues: readonly string[]): string[] {
  return issues
    .map(issue => issue.replace(/\s+/g, '').trim())
    .filter(Boolean);
}

/**
 * 一轮里真正跑过的命令及其退出码，形如 `<command>#<exitCode>`。
 *
 * 写文件、抓网页这些没有「退出码」概念的动作不进这个集合：空转分类要回答的是
 * 「同一件事是不是又做了一遍」，而重复的命令 + 相同的退出码是最硬的那条证据。
 */
export function commandOutcomes(report: ExecutionReport): string[] {
  const outcomes = new Set<string>();
  for (const item of report.results) {
    const command = textOf(asRecord(item.args)?.command);
    if (!command) continue;
    const exitCode = asRecord(item.result)?.exitCode;
    outcomes.add(`${command}#${exitCode === undefined || exitCode === null ? '' : String(exitCode)}`);
  }
  for (const ref of report.evidence?.refs ?? []) {
    const record = asRecord(ref);
    if (record?.kind !== 'command') continue;
    const command = textOf(record.command);
    if (!command) continue;
    const exitCode = record.exitCode;
    outcomes.add(`${command}#${exitCode === undefined || exitCode === null ? '' : String(exitCode)}`);
  }
  return [...outcomes];
}

/**
 * 与上一轮「同命令同退出码」的那几条命令。
 *
 * 空列表表示这一轮确实换了做法（或换了结果）。条数用来分类空转原因，列表本身要交给
 * 下一轮的计划请求：只说「不要重复」而不点名是哪几条，模型下一轮大概率还是原样再交一遍。
 */
export function repeatedCommands(
  previous: ExecutionReport | null,
  current: ExecutionReport
): string[] {
  if (!previous) return [];
  const before = new Set(commandOutcomes(previous));
  return commandOutcomes(current).filter(outcome => before.has(outcome));
}

export interface RepairGateResult {
  open: boolean;
  reason: string;
  /** 与上一轮相比新增的事实条数（0 表示这一轮什么都没变）。 */
  newFacts: number;
  /** 评审新提出、上一轮没有的问题条数。 */
  newIssues: string[];
}

/**
 * 要不要再开一轮修复。
 *
 * 没有上一轮可比较时照常开：第一次修复不需要证明什么。
 */
export function shouldOpenRepairRound(input: {
  previous: RepairLoopState | null;
  current: RepairLoopState;
}): RepairGateResult {
  const { previous, current } = input;
  if (!previous) {
    return { open: true, reason: '这是第一次修复，没有上一轮可比较', newFacts: 0, newIssues: [] };
  }

  const before = new Set(previous.facts);
  const newFacts = current.facts.filter(fact => !before.has(fact)).length;
  if (newFacts > 0) {
    return {
      open: true,
      reason: `这一轮有 ${String(newFacts)} 项事实与上一轮不同`,
      newFacts,
      newIssues: []
    };
  }

  const known = new Set(normalizeIssues(previous.issues));
  const newIssues = normalizeIssues(current.issues).filter(issue => !known.has(issue));
  if (newIssues.length > 0) {
    return {
      open: true,
      reason: `评审提出了上一轮没有的 ${String(newIssues.length)} 项问题`,
      newFacts,
      newIssues
    };
  }

  return {
    open: false,
    reason:
      `这一轮没有任何新证据：命令、参数、退出码、输出、验证结论都与上一轮相同，` +
      `评审也没有提出新问题（同样的 ${String(current.issues.length)} 项）`,
    newFacts,
    newIssues: []
  };
}
