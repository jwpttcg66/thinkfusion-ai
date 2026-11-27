/**
 * GCE-P3：Cycle 决策纯函数。
 *
 * 只做确定性判断：给定目标符合度、验证状态、评审、预算、进度和诊断，
 * 选择下一步。不写事件、不调度任务。
 *
 * 规范：docs/spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md
 * 设计：docs/architecture/GCE-P3-CYCLE-DECISION-DESIGN.md
 */

import type {
  GoalContractStatus,
  GoalFitAssessment
} from './goal-contract';
import type { DeliveryState } from './goal-contract';

export type GceCycleStage =
  | 'GOAL_REASONING'
  | 'ANALYSIS'
  | 'DESIGN'
  | 'DESIGN_DEBATE'
  | 'PLANNING'
  | 'IMPLEMENTATION'
  | 'REVIEW'
  | 'REVIEW_DEBATE'
  | 'CONCLUSION'
  | 'GOAL_FIT'
  | 'NEXT_DECISION';

export type CycleDecisionType =
  | 'CONTINUE'
  | 'REPAIR'
  | 'REPLAN'
  | 'REDESIGN'
  | 'REANALYZE'
  | 'CLARIFY_GOAL'
  | 'CHANGE_PROPOSED'
  | 'WAIT_USER'
  | 'BLOCKED'
  | 'COMPLETE'
  | 'ABORT';

export type CycleDiagnosis =
  | 'none'
  | 'implementation'
  | 'design'
  | 'analysis'
  | 'task_plan'
  | 'goal'
  | 'environment';

export interface CycleProgress {
  fingerprint: string;
  repeated: number;
  criterionStalled: boolean;
}

export interface CycleDecisionInput {
  goalStatus: GoalContractStatus;
  goalFit: GoalFitAssessment;
  delivery: DeliveryState;
  review: { needsFix: boolean; blockingIssues: number; unresolved: number };
  budget: { atMaxRounds: boolean; tokenExhausted?: boolean };
  task: { cancelled?: boolean; blockedReason?: string };
  progress: CycleProgress;
  diagnosis: CycleDiagnosis;
  userAcceptedRisks?: boolean;
}

export interface CycleDecisionResult {
  decision: CycleDecisionType;
  reason: string;
  targetStage: GceCycleStage;
  requiresUser: boolean;
}

const USER_GATE: readonly GoalContractStatus[] = [
  'DRAFT',
  'UNDERSTANDING',
  'CLARIFYING',
  'READY_FOR_CONFIRMATION',
  'CHANGE_PROPOSED',
  'BLOCKED'
];

function stageFor(decision: CycleDecisionType): GceCycleStage {
  switch (decision) {
    case 'REPAIR': return 'IMPLEMENTATION';
    case 'REPLAN': return 'PLANNING';
    case 'REDESIGN': return 'DESIGN';
    case 'REANALYZE': return 'ANALYSIS';
    case 'CLARIFY_GOAL':
    case 'CHANGE_PROPOSED': return 'GOAL_REASONING';
    case 'COMPLETE':
    case 'ABORT': return 'NEXT_DECISION';
    case 'CONTINUE':
    case 'WAIT_USER':
    case 'BLOCKED':
    default: return 'NEXT_DECISION';
  }
}

function result(decision: CycleDecisionType, reason: string): CycleDecisionResult {
  return {
    decision,
    reason,
    targetStage: stageFor(decision),
    requiresUser: decision === 'WAIT_USER'
      || decision === 'CLARIFY_GOAL'
      || decision === 'CHANGE_PROPOSED'
  };
}

/**
 * 决策优先级：安全/取消 > 目标有效性 > 阻塞 > 证据/评审 > 诊断 > 预算 > 无进展 > 达成。
 * 这是一条“停止继续错下去”的规则，不是让模型自由选择。
 */
export function decideCycleAction(input: CycleDecisionInput): CycleDecisionResult {
  if (input.task.cancelled) return result('ABORT', '用户取消或终止');

  if (input.task.blockedReason) {
    return result('BLOCKED', `外部阻塞：${input.task.blockedReason}`);
  }

  if (USER_GATE.includes(input.goalStatus)) {
    if (input.goalStatus === 'BLOCKED') return result('BLOCKED', '目标契约被阻塞');
    if (input.goalStatus === 'CHANGE_PROPOSED') return result('CHANGE_PROPOSED', '目标变更等待用户确认');
    return result('CLARIFY_GOAL', `目标契约未就绪：${input.goalStatus}`);
  }

  if (input.progress.repeated >= 2 || input.progress.criterionStalled) {
    if (input.diagnosis === 'design') return result('REDESIGN', '连续无进展且问题在方案设计');
    if (input.diagnosis === 'analysis') return result('REANALYZE', '连续无进展且事实/分析不足');
    if (input.diagnosis === 'task_plan') return result('REPLAN', '连续无进展且任务拆分/依赖不合理');
    return result('WAIT_USER', '连续无进展；停止自动循环，等待用户决定');
  }

  if (input.budget.atMaxRounds || input.budget.tokenExhausted) {
    return result('BLOCKED', '预算已用尽且目标尚未达成');
  }

  if (input.goalFit.fit === 'GAP') {
    if (input.diagnosis === 'goal') return result('CLARIFY_GOAL', '目标本身存在歧义或不可行');
    if (input.diagnosis === 'analysis') return result('REANALYZE', '目标缺口来自事实/分析不足');
    if (input.diagnosis === 'design') return result('REDESIGN', '现有设计无法满足成功标准');
    if (input.diagnosis === 'task_plan') return result('REPLAN', '任务拆分/依赖无法覆盖目标');
    if (input.diagnosis === 'implementation') return result('REPAIR', '实现存在明确缺陷');
    return result('WAIT_USER', '目标未达成且无法自动判断下一步');
  }

  if (input.review.needsFix || input.review.blockingIssues > 0 || input.review.unresolved > 0) {
    return result('REPAIR', '存在待修或未解决评审问题');
  }

  if (input.delivery.verification === 'FAILED') {
    if (input.diagnosis === 'design') return result('REDESIGN', '验证失败且设计不成立');
    if (input.diagnosis === 'analysis') return result('REANALYZE', '验证失败且事实依据不足');
    return result('REPAIR', '验证未通过，进入修复');
  }

  if (input.goalFit.fit === 'WITH_RISKS') {
    return input.userAcceptedRisks
      ? result('COMPLETE', '用户明确接受带风险/未验证交付')
      : result('WAIT_USER', '仅带风险达成，需用户确认是否接受');
  }

  if (input.goalFit.fit === 'MET') {
    if (input.delivery.verification !== 'PASSED') {
      return result('WAIT_USER', '目标标准已满足，但验证状态未通过，需人工确认');
    }
    return result('COMPLETE', '执行、验证和目标标准均已满足');
  }

  if (input.goalFit.fit === 'PARTIAL' || input.goalFit.fit === 'UNKNOWN') {
    if (input.diagnosis === 'implementation') return result('REPAIR', '部分标准未满足，继续实现修复');
    return result('WAIT_USER', '目标符合度不足或未知，需补充目标/证据');
  }

  return result('CONTINUE', '继续当前阶段');
}

/** 旧四出口兼容：新决策不应被压成错误的 complete/repair。 */
export function legacyDecisionOf(
  decision: CycleDecisionType
): 'complete' | 'repair' | 'fail_budget' | 'fail_delivery' | 'observe' {
  switch (decision) {
    case 'COMPLETE': return 'complete';
    case 'REPAIR': return 'repair';
    case 'BLOCKED':
    case 'WAIT_USER':
    case 'CLARIFY_GOAL':
    case 'CHANGE_PROPOSED':
    case 'ABORT':
      return 'observe';
    case 'REPLAN':
    case 'REDESIGN':
    case 'REANALYZE':
    case 'CONTINUE':
    default:
      return 'observe';
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

/** 稳定指纹：键排序、数组保序；只用于去重/回归，不作为业务 ID。 */
export function cycleFingerprint(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function detectNoProgress(
  previousFingerprint: string | null,
  nextFingerprint: string,
  previousRepeated = 0
): CycleProgress {
  const repeated = previousFingerprint === nextFingerprint ? previousRepeated + 1 : 0;
  return {
    fingerprint: nextFingerprint,
    repeated,
    criterionStalled: repeated >= 3
  };
}
