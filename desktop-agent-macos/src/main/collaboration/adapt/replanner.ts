/**
 * P1-11 Replanner：缺口驱动，最多 2 次；不改旧 Plan。
 */
import type { CollaborationState, Plan, TaskSpec } from '../domain/types';

export type ReplanReason = 'acceptance_gap' | 'unresolved_dispute' | 'no_new_information';

export interface ReplanDecision {
  needed: boolean;
  reason?: ReplanReason;
}

const MAX_REPLANS = 2;

export function needsReplan(state: CollaborationState): ReplanDecision {
  if (state.stop || state.replans.length >= MAX_REPLANS) return { needed: false };
  const unresolved = state.disputes.some(item => item.status === 'open');
  if (unresolved) return { needed: true, reason: 'unresolved_dispute' };
  const gap = state.taskStates.some(item =>
    item.status === 'failed' || item.status === 'skipped' || item.status === 'blocked'
  );
  if (gap) return { needed: true, reason: 'acceptance_gap' };
  return { needed: false };
}

/**
 * 产生新 Plan；旧 Plan 进 planHistory，不修改。
 * 新任务必须是原计划没有的 taskId；重复直接拒绝。
 */
export function applyReplan(
  state: CollaborationState,
  addedTasks: readonly TaskSpec[],
  reason: ReplanReason
): CollaborationState {
  if (state.replans.length >= MAX_REPLANS) throw new Error('重规划次数已达上限');
  const existing = new Set(state.taskStates.map(item => item.taskId));
  for (const task of addedTasks) {
    if (existing.has(task.taskId)) throw new Error(`重复任务：${task.taskId}`);
  }
  const nextPlan: Plan = {
    ...state.activePlan,
    planId: `${state.activePlan.planId}-r${String(state.replans.length + 1)}`,
    version: state.activePlan.version + 1,
    supersedes: state.activePlan.planId,
    tasks: [...state.activePlan.tasks, ...addedTasks],
    reason: `重规划：${reason}`,
    createdAt: Date.now()
  };
  return {
    ...state,
    activePlan: nextPlan,
    planHistory: [...state.planHistory, state.activePlan],
    taskStates: [
      ...state.taskStates,
      ...addedTasks.map(task => ({ taskId: task.taskId, status: 'pending' as const, attempts: [] }))
    ],
    replans: [
      ...state.replans,
      { at: Date.now(), reason, added: addedTasks.map(task => task.taskId), removed: [] }
    ],
    updatedAt: Date.now()
  };
}
