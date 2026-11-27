/**
 * GCE-P4：目标分解覆盖与正式参与资格纯函数。
 *
 * 复用 P2 的 Criterion 覆盖结果和现有 ECO 角色充分度，不新建调度器/上下文引擎。
 */

import { canAssumeRole, type EcoRole } from './eco';
import type { ContextSufficiency } from './eco';
import type { GoalContract } from './goal-contract';
import type { WorkTask } from './task-decomposition';
import { coverageGaps, criterionCoverage, type CriterionCoverage } from './goal-evidence';
import type { GceCycleStage } from './cycle-decision';

export interface GoalDecompositionAssessment {
  ok: boolean;
  blocking: CriterionCoverage[];
  advisory: CriterionCoverage[];
  reasons: string[];
}

function hasAcceptance(task: Pick<WorkTask, 'acceptanceCriteria'>): boolean {
  return task.acceptanceCriteria.some(item => item.trim().length > 0);
}

/** 分解门禁：MUST 未覆盖或任务不可验收会阻断；SHOULD/NICE 只提示。 */
export function assessGoalDecomposition(
  contract: GoalContract,
  tasks: readonly Pick<WorkTask, 'workTaskId' | 'criterionIds' | 'acceptanceCriteria'>[]
): GoalDecompositionAssessment {
  const coverage = criterionCoverage(contract, tasks);
  const gaps = coverageGaps(coverage);
  const reasons: string[] = [];
  for (const item of gaps.blocking) {
    reasons.push(`MUST Criterion ${item.criterionId} 没有任务承接`);
  }
  for (const task of tasks) {
    if (!hasAcceptance(task)) reasons.push(`任务 ${task.workTaskId} 缺少验收条件`);
  }
  return {
    ok: reasons.length === 0,
    blocking: gaps.blocking,
    advisory: gaps.advisory,
    reasons
  };
}

const STAGE_ROLE: Partial<Record<GceCycleStage, EcoRole>> = {
  GOAL_REASONING: 'analyst',
  ANALYSIS: 'analyst',
  DESIGN: 'architect',
  DESIGN_DEBATE: 'challenger',
  PLANNING: 'planner',
  IMPLEMENTATION: 'implementer',
  REVIEW: 'reviewer',
  REVIEW_DEBATE: 'challenger',
  CONCLUSION: 'adjudicator'
};

/**
 * 正式参与资格：ECO 不足/过期的模型只能给有限意见，不能承担正式阶段角色。
 * 没有映射的阶段默认拒绝正式角色，避免“参与即裁决”。
 */
export function canParticipateFormally(
  sufficiency: ContextSufficiency,
  stage: GceCycleStage
): { ok: boolean; role: EcoRole | null; reason: string } {
  const role = STAGE_ROLE[stage] ?? null;
  if (!role) return { ok: false, role: null, reason: `${stage} 未定义正式参与角色` };
  const gate = canAssumeRole(sufficiency, role);
  return { ok: gate.ok, role, reason: gate.reason };
}
