/**
 * GCE-P5：恢复时的目标契约版本核对。
 *
 * 只回答「旧契约还能不能继续用」，不写存储、不改任务状态。
 * 不兼容时调用方应丢弃旧契约，让下一次计划重新建立；不能拿过期目标继续跑。
 */

import type { GoalContract } from './goal-contract';
import type { WorkTask } from './task-decomposition';

export interface GoalRecoveryInput {
  goalId?: string;
  goalVersion?: number;
  goalCriteria?: readonly string[];
  contract?: GoalContract;
  tasks?: readonly Pick<WorkTask, 'goalId' | 'goalVersion'>[];
}

export interface GoalRecoveryResult {
  status: 'ok' | 'no_contract' | 'needs_replan';
  contract?: GoalContract;
  reasons: string[];
}

export function reconcileGoalContractOnResume(
  input: GoalRecoveryInput
): GoalRecoveryResult {
  const contract = input.contract;
  if (!contract) return { status: 'no_contract', reasons: [] };

  const goalId = input.goalId ?? contract.goalId;
  const goalVersion = input.goalVersion ?? 1;
  const reasons: string[] = [];

  if (contract.goalId !== goalId) {
    reasons.push(`目标契约 ${contract.goalId} 与当前任务目标 ${goalId} 不一致`);
  }
  if (contract.goalVersion !== goalVersion) {
    reasons.push(`目标契约 v${String(contract.goalVersion)} 与当前目标 v${String(goalVersion)} 不一致`);
  }
  if (contract.criteria.some(item => item.goalVersion !== goalVersion)) {
    reasons.push('存在 Criterion 仍绑定旧目标版本');
  }

  const expected = new Set(
    (input.goalCriteria ?? []).map(item => item.trim()).filter(Boolean)
  );
  if (expected.size > 0) {
    const actual = new Set(contract.criteria.map(item => item.description.trim()));
    const missing = [...expected].filter(item => !actual.has(item));
    if (missing.length > 0) {
      reasons.push(`当前目标标准没有进入契约：${missing.slice(0, 3).join('；')}`);
    }
  }

  for (const task of input.tasks ?? []) {
    if (task.goalId && task.goalId !== contract.goalId) {
      reasons.push(`任务树仍绑定旧目标 ${task.goalId}`);
      break;
    }
    if (typeof task.goalVersion === 'number' && task.goalVersion !== goalVersion) {
      reasons.push(`任务树仍有 v${String(task.goalVersion)} 的任务，当前目标为 v${String(goalVersion)}`);
      break;
    }
  }

  if (reasons.length > 0) {
    return { status: 'needs_replan', reasons };
  }
  return { status: 'ok', contract, reasons: [] };
}
