/**
 * P1-00：CollaborationState 持久化/恢复。复用 AgentStore，不建第二套 Journal。
 */
import type { CollaborationState, TaskStatus } from './domain/types';

export interface CollaborationJournal {
  saveCollaboration(goalId: string, state: unknown): void;
  getCollaboration(goalId: string): unknown | null;
}

function isState(value: unknown): value is CollaborationState {
  return !!value && typeof value === 'object' && (value as CollaborationState).version === 1
    && Array.isArray((value as CollaborationState).taskStates);
}

export function saveState(store: CollaborationJournal, goalId: string, state: CollaborationState): void {
  store.saveCollaboration(goalId, state);
}

export function loadState(store: CollaborationJournal, goalId: string): CollaborationState | null {
  const raw = store.getCollaboration(goalId);
  return isState(raw) ? raw : null;
}

const INTERRUPTED: readonly TaskStatus[] = ['assigned', 'running', 'retrying'];

/**
 * 重启恢复：未完成的任务不能假设成功。
 * - running/assigned/retrying → blocked，原因 restart_interrupted（不自动重跑）；
 * - 已完成/失败/跳过保持；
 * - returned 状态不再有 running。
 */
export function recoverState(state: CollaborationState): CollaborationState {
  const taskStates = state.taskStates.map(task => {
    if (!INTERRUPTED.includes(task.status)) return task;
    return {
      ...task,
      status: 'blocked' as const,
      reason: 'restart_interrupted',
      currentAttemptId: undefined
    };
  });
  return { ...state, taskStates, updatedAt: Date.now() };
}

/** 没有 stop 且仍有非终态任务时，才需要继续。 */
export function needsResume(state: CollaborationState): boolean {
  if (state.stop) return false;
  return state.taskStates.some(task =>
    task.status === 'pending' || task.status === 'assigned' || task.status === 'running' || task.status === 'retrying'
  );
}
