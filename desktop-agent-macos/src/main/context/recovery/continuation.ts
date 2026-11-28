/**
 * 「继续」到底该走哪条路（V4 P1 M2-2）。
 *
 * 重启后点「继续」有两种正确下场，代价完全不同：
 * - **直达续跑**：拿已批准的计划，只跑上次没跑完的步骤；
 * - **重新规划**：开新一轮问 Planner，旧步骤只作为现状。
 *
 * 判错的代价不对称——续跑判成重规划只是多花一轮，重规划判成续跑则是拿一份
 * 可能已经对不上的旧计划继续写文件。所以这里只在**每一条依据都能核对**时才放行
 * 续跑，任何一条不满足就退回重规划，并把理由逐条列出来（不是只列第一条）：
 * 界面要能回答「为什么没给我续跑」。
 *
 * 本模块是纯函数：不读盘、不发事件、不碰状态机，判定结果由调用方落库。
 */

import type {
  AgentEvent,
  ExecutionReport,
  StepResult,
  StoredPlan
} from '../../../shared/contracts';
import { verifyExecution } from '../../../agent/verification';
import { sideEffectKey } from './side-effects';
import type { TaskPointerSource, TaskRecoveryResult } from './task-recovery';

/** 一步「已经跑完」的证据。 */
export interface CompletedStep {
  /** 能还原出的步骤结果；纯事件来源带 args 与 result，报告来源就是报告里那一条。 */
  result: StepResult;
  /** 证据来自执行报告还是步骤事件——决定收尾时能不能原样还原这一步。 */
  source: 'report' | 'events';
  /** 上一次真正执行完这一步的时间。 */
  executedAt: number;
}

/** 续跑时下发给 Runtime 的复用清单。 */
export interface ReusedStepInput {
  stepId: string;
  checkpointId?: string;
  executedAt: number;
}

export interface ContinuationPlan {
  mode: 'continue';
  /** 放行的就是这份已批准计划；调用方按 planId/roundId 原样下发，不改步骤内容。 */
  plan: StoredPlan;
  /** 上轮真跑成功、本轮不重做的步骤。 */
  reusedStepIds: string[];
  /** 本轮真正要执行的步骤。 */
  pendingStepIds: string[];
  /** 下发给 Runtime 的复用清单（含上次执行时间）。 */
  reusedSteps: ReusedStepInput[];
  /** 收尾时把「本轮没跑」的步骤还原成真实结果所用的证据表。 */
  completed: Map<string, CompletedStep>;
  checkpointId?: string;
  contextId?: string;
  /** 这次续跑读的指针来自哪里；M2-1 的口径在续跑事件里同样要带上。 */
  pointerSource?: TaskPointerSource;
  reasons: string[];
}

export interface ReplanPlan {
  mode: 'replan';
  reasons: string[];
}

export type ContinuationVerdict = ContinuationPlan | ReplanPlan;

export interface ContinuationInput {
  taskId: string;
  /** 恢复结论；null 表示宿主没注入恢复能力。 */
  recovery: TaskRecoveryResult | null;
  /** 回退开关：关掉就恒定走重规划（旧行为）。 */
  enabled: boolean;
  /** 任务当前挂着的计划（`task.currentPlanId` 对应的那份）。 */
  plan: StoredPlan | null;
  /** 计划原文与落库 contentHash 是否一致，由调用方算（避免与 hashPlan 循环依赖）。 */
  planHashMatches: boolean;
  reports: readonly ExecutionReport[];
  /** 该任务的事件流；报告没落时，步骤完成只能靠 `step.started` + `step.completed` 认定。 */
  events: readonly AgentEvent[];
  /** P0-2 门禁：目标契约过期且用户还没确认，必须重规划。 */
  gateBlocks: boolean;
  /** 版本链判定 requiresReplan。 */
  requiresReplan: boolean;
}

const RECOVERY_BLOCKERS: Record<string, string> = {
  none: '没有可核对的检查点指针，无法确定上次跑到哪一步',
  needs_context_refresh: '检查点可读但工程上下文已过期，必须先重新采集',
  needs_replan: '目标版本已变化，旧步骤不能再当作当前分解',
  stale: '检查点校验不通过（归档缺失或 hash 不匹配），不猜执行进度',
  blocked: '恢复被挡'
};

function roundKey(roundId: string, stepId: string): string {
  return `${roundId}:${stepId}`;
}

/**
 * 这一步「结局已知且成功」的证据。
 *
 * 两个来源，可信度不同但都足以决定「本轮不重做」：
 * - 执行报告里 `status === 'completed'`（只认同一个 planId 的最后一份报告）；
 * - 事件流里同一 `roundId` 下 `step.started` 之后跟着 `step.completed`——
 *   SIGKILL 打断整份计划时报告根本不会落库，只看报告就等于「一步都没做」，
 *   续跑会把已经写过的 `fs.edit` 再 edit 一次然后报「找不到原文」，
 *   把一个本该省一轮的操作变成一条假失败。
 *
 * 只有 `step.started`、没有 `completed`/报告的步骤不算完成（结局未知）。
 * `roundId` 缺失的运行时事件不参与认定：跨轮的 stepId 都从 step-1 开始，
 * 认不出归属就宁可重跑，也不能把上一轮的同名步骤当成本轮已完成。
 */
export function collectCompletedSteps(input: {
  plan: StoredPlan;
  reports: readonly ExecutionReport[];
  events: readonly AgentEvent[];
}): Map<string, CompletedStep> {
  const { plan } = input;
  const completed = new Map<string, CompletedStep>();
  const stepIds = new Set(plan.plan.steps.map(step => step.id));

  const prior = input.reports.filter(report => report.planId === plan.planId).at(-1);
  for (const result of prior?.results ?? []) {
    if (result.status !== 'completed') continue;
    if (!stepIds.has(result.stepId)) continue;
    completed.set(roundKey(plan.roundId, result.stepId), {
      result,
      source: 'report',
      executedAt: prior?.createdAt ?? 0
    });
  }

  const started = new Map<string, { tool: string; args?: Record<string, unknown> }>();
  const finished = new Map<string, { tool: string; result: unknown; durationMs: number; at: number }>();
  const failed = new Set<string>();
  for (const event of input.events) {
    if (event.type !== 'step.started' && event.type !== 'step.completed' && event.type !== 'step.failed') continue;
    if (event.roundId !== plan.roundId) continue;
    const stepId = event.stepId;
    if (!stepId || !stepIds.has(stepId)) continue;
    if (event.type === 'step.started') {
      started.set(stepId, { tool: event.tool, ...(event.args ? { args: event.args } : {}) });
    } else if (event.type === 'step.completed') {
      finished.set(stepId, {
        tool: event.tool,
        result: event.result,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : 0,
        at: event.at
      });
    } else if (event.type === 'step.failed') {
      failed.add(stepId);
    }
  }

  for (const [stepId, done] of finished) {
    const key = roundKey(plan.roundId, stepId);
    if (failed.has(stepId) || completed.has(key)) continue;
    const begin = started.get(stepId);
    completed.set(key, {
      result: {
        stepId,
        tool: (begin?.tool ?? done.tool) as StepResult['tool'],
        status: 'completed',
        // 事件只记了「这一步成功返回并带结果」，没记这一步自报的验证断言；
        // 补一个 true 就是把没记录的东西当记录过。
        verified: false,
        result: done.result,
        durationMs: done.durationMs,
        ...(begin?.args ? { args: begin.args } : {})
      },
      source: 'events',
      executedAt: done.at
    });
  }
  return completed;
}

/**
 * 该计划的步骤按「结局已知的成功」拆成复用/待执行。
 *
 * failed / skipped / 结局未知的步骤照旧要跑；判定只看 `completed` 证据表，
 * 表里只有同一个 planId 的报告 completed 与同一 roundId 的 completed 事件。
 */
export function splitPlanSteps(
  plan: StoredPlan,
  completed: ReadonlyMap<string, CompletedStep>
): { reusedStepIds: string[]; pendingStepIds: string[] } {
  const reusedStepIds: string[] = [];
  const pendingStepIds: string[] = [];
  for (const step of plan.plan.steps) {
    if (completed.has(roundKey(plan.roundId, step.id))) reusedStepIds.push(step.id);
    else pendingStepIds.push(step.id);
  }
  return { reusedStepIds, pendingStepIds };
}

/**
 * 账本缺口是否挡住续跑。
 *
 * `needs_reconciliation` 的原口径是「没有报告可核对内容的写操作」，按它一刀切判
 * 门槛等于：任何含 `shell.run` / `test.run` 的计划永远不能续跑（这些工具本就没有
 * 路径可核对），直达续跑会变成死代码。所以这里只挡**结局未知**的条目：
 * - 结局已知（报告 completed 或事件 step.completed）→ 本轮不重跑，无需再核对；
 * - 结局未知且路径核对为 applied → 允许（这一步会被重跑，路径还在说明没写坏）；
 * - 结局未知又无路径可核对 → 挡住，交回重规划让模型看现状。
 * 路径消失（missing）永远挡住，由调用方另有一条判定。
 */
export function unknownSideEffects(
  entries: readonly { roundId?: string; stepId: string; status: string }[],
  completed: ReadonlyMap<string, CompletedStep>
): string[] {
  return entries
    .filter(entry => entry.status !== 'applied' && !completed.has(sideEffectKey(entry)))
    .map(entry => `${entry.stepId}（${entry.status}）`);
}

export function decideContinuation(input: ContinuationInput): ContinuationVerdict {
  const reasons: string[] = [];
  const recovery = input.recovery;

  if (!input.enabled) reasons.push('续跑开关已关闭：按重新规划继续');
  if (!recovery) reasons.push('宿主未注入上下文恢复能力');
  else if (recovery.status !== 'recovered') {
    reasons.push(RECOVERY_BLOCKERS[recovery.status] ?? `恢复结论为 ${recovery.status}`);
  }

  const ledger = recovery?.ledger;
  if (ledger && ledger.missing > 0) {
    reasons.push(`${String(ledger.missing)} 个记录过的改动文件已不存在，需要重规划补做`);
  }

  const plan = input.plan;
  if (!plan) reasons.push('任务没有当前计划可续跑');
  else {
    if (plan.taskId !== input.taskId) reasons.push('计划归属任务与当前任务不一致');
    if (plan.approvalStatus !== 'approved') {
      reasons.push(`计划审批状态为 ${plan.approvalStatus}，未批准的计划不能直接执行`);
    }
    if (!input.planHashMatches) reasons.push('计划内容与落库 hash 不一致，需重新审阅');
  }

  // 账本缺口要在拿到 completed 证据表之后判：同一份「无路径可核对」的条目，
  // 结局已知就不是缺口，未知才是。
  const completed = plan ? collectCompletedSteps({ plan, reports: input.reports, events: input.events }) : null;
  if (plan && completed && ledger) {
    const blocked = unknownSideEffects(ledger.entries, completed);
    if (blocked.length > 0) {
      reasons.push(`${String(blocked.length)} 个写操作结局未知且无路径可核对：${blocked.slice(0, 3).join('、')}`);
    }
  }

  if (input.gateBlocks) reasons.push('目标契约门禁未确认：旧步骤不得进入执行');
  if (input.requiresReplan) reasons.push('版本链判定需要重规划');

  if (reasons.length > 0 || !plan || !completed) return { mode: 'replan', reasons };

  const { reusedStepIds, pendingStepIds } = splitPlanSteps(plan, completed);
  if (pendingStepIds.length === 0) {
    return {
      mode: 'replan',
      reasons: ['已批准计划的步骤都已执行完，本轮要做的是校验与收尾而不是再跑步骤']
    };
  }

  return {
    mode: 'continue',
    plan,
    reusedStepIds,
    pendingStepIds,
    reusedSteps: reusedStepIds.map(stepId => ({
      stepId,
      ...(recovery?.checkpointId ? { checkpointId: recovery.checkpointId } : {}),
      executedAt: completed.get(roundKey(plan.roundId, stepId))?.executedAt ?? 0
    })),
    completed,
    ...(recovery?.checkpointId ? { checkpointId: recovery.checkpointId } : {}),
    ...(recovery?.contextId ? { contextId: recovery.contextId } : {}),
    ...(recovery?.pointerSource ? { pointerSource: recovery.pointerSource } : {}),
    reasons
  };
}

/**
 * 把续跑报告里的「复用」条目还原成真实结果。
 *
 * Runtime 只负责「这一步不重跑」，它给不出上一步的 stdout、耗时与改动路径——那些在
 * 报告或步骤事件里。不还原的话有两个后果：`verifyExecution` 只看本轮跑过的步骤，
 * 上轮已经做过的构建/测试会被判成「没验」，任务白停在 VERIFYING；交付文件也会
 * 因为本轮没写文件而少掉（违反「最终结论必须带交付文件」）。
 *
 * 找不到证据时保留原来的 skipped 条目：宁可让缺口可见，也不把它当成已完成。
 */
export function mergeReusedResults(
  report: ExecutionReport,
  completed: ReadonlyMap<string, CompletedStep> | null
): ExecutionReport {
  if (!report.results.some(item => item.reusedFrom) || !completed) return report;
  const results = report.results.map(item => {
    if (!item.reusedFrom) return item;
    const evidence = completed.get(roundKey(report.roundId, item.stepId));
    return evidence ? { ...evidence.result, reusedFrom: item.reusedFrom } : item;
  });
  return { ...report, results, verification: verifyExecution(results) };
}
