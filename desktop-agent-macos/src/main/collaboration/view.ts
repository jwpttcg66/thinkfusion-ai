/**
 * UI-01 数据层：把 CollaborationState 变成计划/任务/参与者视图。
 * 组件还没接；这里只保证界面需要的字段齐全、可测试。
 */
import type { CollaborationState, TaskStatus } from './domain/types';

export interface TaskView {
  taskId: string;
  kind: string;
  status: TaskStatus;
  participantId?: string;
  attempts: number;
  reason?: string;
}

export interface PlanView {
  goalId: string;
  planId: string;
  version: number;
  tasks: TaskView[];
  participants: Array<{ participantId: string; reason: string }>;
  skipped: Array<{ participantId: string; reason: string }>;
  stopReason?: string;
}

export function buildPlanView(state: CollaborationState): PlanView {
  const assignmentByTask = new Map(state.assignments.map(item => [item.taskId, item.participantId]));
  return {
    goalId: state.goal.goalId,
    planId: state.activePlan.planId,
    version: state.activePlan.version,
    tasks: state.taskStates.map(task => ({
      taskId: task.taskId,
      kind: state.activePlan.tasks.find(item => item.taskId === task.taskId)?.kind ?? 'unknown',
      status: task.status,
      ...(assignmentByTask.has(task.taskId) ? { participantId: assignmentByTask.get(task.taskId) } : {}),
      attempts: task.attempts.length,
      ...(task.reason ? { reason: task.reason } : {})
    })),
    participants: state.activePlan.participants,
    skipped: state.activePlan.skipped,
    ...(state.stop ? { stopReason: state.stop.reason } : {})
  };
}
