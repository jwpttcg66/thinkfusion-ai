/** P3-03：工程计划/审批的最小契约。 */
export type ChangeKind = 'create' | 'modify' | 'delete';

export interface PlannedChange {
  path: string;
  kind: ChangeKind;
  reason: string;
}

export interface EngineeringPlan {
  planId: string;
  goal: string;
  changes: PlannedChange[];
  tests: string[];
  rollback: string;
  risks: string[];
}

export interface PlanCheck {
  ok: boolean;
  reasons: string[];
  approvalRequired: boolean;
}

export function checkEngineeringPlan(plan: EngineeringPlan): PlanCheck {
  const reasons: string[] = [];
  if (!plan.goal.trim()) reasons.push('缺少目标');
  if (plan.changes.length === 0) reasons.push('没有变更');
  if (plan.changes.some(change => !change.reason.trim())) reasons.push('变更缺少理由');
  if (plan.tests.length === 0) reasons.push('没有测试');
  if (!plan.rollback.trim()) reasons.push('没有回退方案');
  if (plan.changes.some(change => change.kind === 'delete') && plan.risks.length === 0) {
    reasons.push('删除变更必须列风险');
  }
  const approvalRequired = plan.changes.some(change => change.kind !== 'create' || true);
  return { ok: reasons.length === 0, reasons, approvalRequired };
}
