/**
 * GCE 与现有 GDC 读模型的兼容层。
 *
 * GoalContract 是目标事实源；EngineeringGoalView / GoalStatusGdc / GoalFitStatus
 * 是现有 UI 的读模型。这里只做单向派生，禁止反向用读模型修改契约。
 */

import type { GoalContract, GoalContractFit, GoalContractStatus } from './goal-contract';
import { assessGoalContractFit, type GoalFitAssessment } from './goal-contract';
import type {
  EngineeringGoalView,
  GoalFitStatus,
  GoalStatusGdc
} from './goal-driven-cycle';

const STATUS_TO_LEGACY: Record<GoalContractStatus, GoalStatusGdc> = {
  DRAFT: 'draft',
  UNDERSTANDING: 'clarifying',
  CLARIFYING: 'clarifying',
  READY_FOR_CONFIRMATION: 'confirmed',
  CONFIRMED: 'confirmed',
  ACTIVE: 'active',
  AT_RISK: 'at_risk',
  CHANGE_PROPOSED: 'change_proposed',
  BLOCKED: 'blocked',
  ACHIEVED: 'achieved',
  ACHIEVED_WITH_RISKS: 'achieved',
  PARTIAL_ACHIEVEMENT: 'at_risk',
  ABANDONED: 'abandoned'
};

export function legacyGoalStatus(status: GoalContractStatus): GoalStatusGdc {
  return STATUS_TO_LEGACY[status];
}

/** 旧读模型只有 pending/met/gap/unknown，新风险/部分状态降级为 pending 并保留说明。 */
export function legacyGoalFit(
  fit: GoalContractFit,
  hasCriteria: boolean
): GoalFitStatus {
  switch (fit) {
    case 'MET': return 'met';
    case 'GAP': return 'gap';
    case 'UNKNOWN': return 'unknown';
    case 'PARTIAL': return 'pending';
    case 'WITH_RISKS': return hasCriteria ? 'pending' : 'unknown';
    default: return 'unknown';
  }
}

export interface GoalCompatInput {
  workId: string;
  originalRequest: string;
  fit?: GoalFitAssessment;
  source?: EngineeringGoalView['source'];
}

/**
 * 从 GoalContract 派生现有 UI 读模型。
 * 只映射可表达的字段；新状态/风险不会被伪装成旧 `met`。
 */
export function engineeringGoalViewFromContract(
  contract: GoalContract,
  input: GoalCompatInput
): EngineeringGoalView {
  const fit = input.fit ?? assessGoalContractFit(contract);
  const intent = contract.dimensions.find(item => item.kind === 'USER_INTENT')?.text ?? '';
  const desiredOutcome = contract.dimensions.find(item => item.kind === 'DESIRED_OUTCOME')?.text ?? '';
  const constraints = contract.dimensions
    .filter(item => item.kind === 'IMPLICIT_CONSTRAINT' && item.text.trim())
    .map(item => item.text);
  return {
    goalId: contract.goalId,
    workId: input.workId,
    originalRequest: input.originalRequest,
    intent: intent || contract.originalRequest.slice(0, 400),
    desiredOutcome: desiredOutcome || contract.originalRequest.slice(0, 400),
    successCriteria: contract.criteria.map(item => item.description),
    constraints,
    assumptions: [...contract.assumptions],
    openQuestions: [...contract.openQuestions],
    goalVersion: contract.goalVersion,
    status: legacyGoalStatus(contract.status),
    fit: legacyGoalFit(fit.fit, contract.criteria.length > 0),
    fitNotes: [
      ...fit.notes,
      ...(fit.fit === 'WITH_RISKS' || fit.fit === 'PARTIAL'
        ? ['旧读模型不能完整表达该状态，需 P5 UI 升级']
        : [])
    ],
    gceFit: fit.fit,
    criteria: contract.criteria.map(item => ({
      criterionId: item.criterionId,
      description: item.description,
      priority: item.priority,
      status: item.status,
      evidenceRefs: [...item.evidenceRefs]
    })),
    source: input.source ?? 'derived'
  };
}

export interface LegacyGoalFitEvent {
  fit: GoalFitStatus;
  gceFit: GoalContractFit;
  notes: string[];
  goalVersion: number;
  criteria: Array<{
    criterionId: string;
    status: string;
    description: string;
    priority: 'MUST' | 'SHOULD' | 'NICE';
    evidenceRefs: string[];
  }>;
  met: number;
  partial: number;
  unmet: number;
  unverified: number;
  waived: number;
  evidenceCompleteness: number;
  blockingRisks: string[];
}

/** 扩展现有 goal.fit 事件，不新增第二套 goal.fit.assessed。 */
export function legacyGoalFitEvent(
  contract: GoalContract,
  fit: GoalFitAssessment = assessGoalContractFit(contract)
): LegacyGoalFitEvent {
  return {
    fit: legacyGoalFit(fit.fit, contract.criteria.length > 0),
    gceFit: fit.fit,
    notes: [...fit.notes],
    goalVersion: contract.goalVersion,
    criteria: contract.criteria.map(item => ({
      criterionId: item.criterionId,
      status: item.status,
      description: item.description,
      priority: item.priority,
      evidenceRefs: [...item.evidenceRefs]
    })),
    met: fit.met,
    partial: fit.partial,
    unmet: fit.unmet,
    unverified: fit.unverified,
    waived: fit.waived,
    evidenceCompleteness: fit.evidenceCompleteness,
    blockingRisks: [...fit.blockingRisks]
  };
}
