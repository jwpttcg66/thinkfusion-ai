/**
 * GCE-P2：Criterion ↔ Evidence ↔ WorkTask 映射纯函数。
 *
 * 只做确定性判断：证据类型是否适用、Criterion 状态、Goal Fit、任务覆盖。
 * 不写存储、不调用模型、不改变 Orchestrator 行为。
 */

import type { WorkTask } from './task-decomposition';
import {
  assessGoalContractFit,
  type CriterionStatus,
  type GoalContract,
  type GoalCriterion,
  type GoalEvidenceLink,
  type GoalFitAssessment
} from './goal-contract';

function relevantLinks(
  criterion: GoalCriterion,
  links: readonly GoalEvidenceLink[]
): GoalEvidenceLink[] {
  return links.filter(link =>
    link.criterionId === criterion.criterionId
    && link.goalVersion === criterion.goalVersion
  );
}

function accepted(
  criterion: GoalCriterion,
  link: GoalEvidenceLink
): boolean {
  if (link.evidenceType === 'MODEL_CLAIM') return false;
  if (!criterion.acceptedEvidenceTypes || criterion.acceptedEvidenceTypes.length === 0) return true;
  return criterion.acceptedEvidenceTypes.includes(link.evidenceType);
}

/**
 * 从证据派生 Criterion 状态。
 *
 * - WAIVED 保留授权状态；
 * - 任一适用 PASSED → MET；
 * - 任一适用 FAILED → UNMET；
 * - 只有 MODEL_CLAIM / PENDING / UNKNOWN / 不接受类型 → UNVERIFIED；
 * - 没有任何证据 → PENDING。
 */
export function assessCriterionFromEvidence(
  criterion: GoalCriterion,
  links: readonly GoalEvidenceLink[]
): CriterionStatus {
  if (criterion.status === 'WAIVED') return 'WAIVED';
  const related = relevantLinks(criterion, links);
  if (related.length === 0) return 'PENDING';

  const usable = related.filter(link => accepted(criterion, link));
  if (usable.some(link => link.verificationStatus === 'PASSED')) return 'MET';
  if (usable.some(link => link.verificationStatus === 'FAILED')) return 'UNMET';
  return 'UNVERIFIED';
}

/** 把证据状态写回 Criterion，并把通过的 evidenceId 保留在 evidenceRefs。 */
export function applyCriterionEvidence(
  criterion: GoalCriterion,
  links: readonly GoalEvidenceLink[],
  at = Date.now()
): GoalCriterion {
  const status = assessCriterionFromEvidence(criterion, links);
  const passed = relevantLinks(criterion, links)
    .filter(link => accepted(criterion, link) && link.verificationStatus === 'PASSED')
    .map(link => link.evidenceId);
  const evidenceRefs = [...new Set([...criterion.evidenceRefs, ...passed])];
  return { ...criterion, status, evidenceRefs, updatedAt: at };
}

/** 用证据链接重新计算整个契约的 Goal Fit；不改变未关联证据。 */
export function applyEvidenceToGoalContract(
  contract: GoalContract,
  links: readonly GoalEvidenceLink[],
  at = Date.now()
): { contract: GoalContract; fit: GoalFitAssessment } {
  const criteria = contract.criteria.map(criterion => applyCriterionEvidence(criterion, links, at));
  const next: GoalContract = { ...contract, criteria, updatedAt: at };
  return { contract: next, fit: assessGoalContractFit(next) };
}

export interface CriterionCoverage {
  criterionId: string;
  priority: GoalCriterion['priority'];
  covered: boolean;
  taskIds: string[];
}

/**
 * 检查强制 Criterion 是否至少有一个 WorkTask 承接。
 * 只检查 `criterionIds`；旧任务没有该字段时视为未覆盖，不能假装覆盖。
 */
export function criterionCoverage(
  contract: GoalContract,
  tasks: readonly Pick<WorkTask, 'workTaskId' | 'criterionIds'>[]
): CriterionCoverage[] {
  return contract.criteria.map(criterion => {
    const taskIds = tasks
      .filter(task => (task.criterionIds ?? []).includes(criterion.criterionId))
      .map(task => task.workTaskId);
    return {
      criterionId: criterion.criterionId,
      priority: criterion.priority,
      covered: taskIds.length > 0,
      taskIds
    };
  });
}

/** 未覆盖的 MUST 会阻断完整分解；SHOULD/NICE 只报告。 */
export function coverageGaps(
  coverage: readonly CriterionCoverage[]
): { blocking: CriterionCoverage[]; advisory: CriterionCoverage[] } {
  const uncovered = coverage.filter(item => !item.covered);
  return {
    blocking: uncovered.filter(item => item.priority === 'MUST'),
    advisory: uncovered.filter(item => item.priority !== 'MUST')
  };
}
