/**
 * CollaborationState 的纯转移。
 *
 * 只有 Runner 会调用这些函数；Planner/Scheduler 只返回新对象。
 * P1-00 只实现任务状态机与初始状态，不接 AgentStore、不执行任务。
 */
import type {
  Attempt,
  Budget,
  CollaborationState,
  Goal,
  Plan,
  StopReason,
  TaskRuntimeState,
  TaskSpec,
  TaskStatus
} from './types';

const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['assigned', 'skipped', 'blocked', 'cancelled'],
  assigned: ['running', 'skipped', 'blocked', 'cancelled'],
  running: ['done', 'failed', 'retrying', 'blocked', 'cancelled'],
  retrying: ['running', 'failed', 'cancelled'],
  done: [],
  failed: [],
  blocked: [],
  skipped: [],
  cancelled: []
};

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return ALLOWED[status].length === 0;
}

export function createCollaborationState(goal: Goal, plan: Plan, budget: Budget): CollaborationState {
  const taskStates: TaskRuntimeState[] = plan.tasks.map(task => ({
    taskId: task.taskId,
    status: 'pending',
    attempts: []
  }));
  return {
    version: 1,
    goal,
    activePlan: plan,
    planHistory: [],
    taskStates,
    assignments: [],
    observations: [],
    evidence: [],
    claims: [],
    conflicts: [],
    disputes: [],
    budget,
    replans: [],
    updatedAt: Date.now()
  };
}

export function findTaskState(state: CollaborationState, taskId: string): TaskRuntimeState {
  const task = state.taskStates.find(item => item.taskId === taskId);
  if (!task) throw new Error(`未知任务：${taskId}`);
  return task;
}

export function transitionTask(
  state: CollaborationState,
  taskId: string,
  next: TaskStatus,
  reason?: string
): CollaborationState {
  const current = findTaskState(state, taskId);
  if (current.status === next) return state;
  if (!ALLOWED[current.status].includes(next)) {
    throw new Error(`非法任务状态转移：${current.status} → ${next}（${taskId}）`);
  }
  const taskStates = state.taskStates.map(item => {
    if (item.taskId !== taskId) return item;
    return {
      ...item,
      status: next,
      ...(reason ? { reason } : {}),
      ...(next === 'running' ? { currentAttemptId: item.currentAttemptId } : {})
    };
  });
  return { ...state, taskStates, updatedAt: Date.now() };
}

/** 只追加 Attempt；旧 Attempt 不改。number 必须连续。 */
export function recordAttempt(state: CollaborationState, attempt: Attempt): CollaborationState {
  const current = findTaskState(state, attempt.taskId);
  if (current.attempts.some(item => item.attemptId === attempt.attemptId)) {
    throw new Error(`重复 Attempt：${attempt.attemptId}`);
  }
  if (attempt.number !== current.attempts.length + 1) {
    throw new Error(`Attempt 编号不连续：期望 ${current.attempts.length + 1}，实际 ${attempt.number}`);
  }
  const taskStates = state.taskStates.map(item => {
    if (item.taskId !== attempt.taskId) return item;
    return {
      ...item,
      status: 'running' as const,
      attempts: [...item.attempts, attempt],
      currentAttemptId: attempt.attemptId
    };
  });
  return { ...state, taskStates, updatedAt: Date.now() };
}

/** 只读任务最多 2 次 Attempt；写/执行不自动重试。 */
export function canRetry(task: TaskSpec, runtime: TaskRuntimeState): boolean {
  if (task.kind === 'execute') return false;
  return runtime.attempts.length < 2;
}

export function stopCollaboration(state: CollaborationState, reason: StopReason): CollaborationState {
  return {
    ...state,
    stop: { reason, at: Date.now() },
    updatedAt: Date.now()
  };
}
