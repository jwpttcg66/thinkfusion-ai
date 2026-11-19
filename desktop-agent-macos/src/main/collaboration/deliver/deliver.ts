/** P1-05：把 Observation 组装成 Deliverable。 */
import { randomUUID } from 'node:crypto';
import type { CollaborationState, Deliverable } from '../domain/types';

export function deliver(state: CollaborationState): Deliverable {
  const done = state.observations.filter(item => item.status === 'done');
  const failed = state.observations.filter(item => item.status !== 'done');
  const failedTasks = state.taskStates.filter(item =>
    item.status === 'failed' || item.status === 'skipped' || item.status === 'cancelled'
  );
  const content = done.map(item => item.text?.trim()).filter(Boolean).join('\n\n');
  const stopReason = state.stop?.reason ?? (failed.length > 0 || failedTasks.length > 0 ? 'failed' : 'acceptance_satisfied');
  return {
    deliverableId: randomUUID(),
    goalId: state.goal.goalId,
    kind: 'answer',
    content,
    claims: [],
    verifications: [],
    openQuestions: [...failed.map(item => `任务 ${item.taskId} 未完成`), ...failedTasks.map(item => `任务 ${item.taskId}：${item.reason ?? item.status}`)],
    stopReason,
    evidenceCoverage: 0,
    createdAt: Date.now()
  };
}
