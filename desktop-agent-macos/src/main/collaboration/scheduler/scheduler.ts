/**
 * P1-03：把 Plan 的每个任务分配给指定参与者。
 *
 * - 不自行增删参与者；
 * - 校验范围、可用性、能力；
 * - 分配理由写进 Assignment。
 */
import { randomUUID } from 'node:crypto';
import type { Assignment, Plan } from '../domain/types';
import type { ParticipantView } from '../participants/manager';

function allowedByScope(participant: ParticipantView, plan: Plan): boolean {
  if (participant.kind === 'web') return plan.policy.includeWeb;
  if (plan.policy.modelScope === 'local') return participant.kind === 'local';
  if (plan.policy.modelScope === 'remote') return participant.kind === 'cloud' || participant.kind === 'cli';
  return true;
}

export function schedule(plan: Plan, participants: readonly ParticipantView[]): Assignment[] {
  const byId = new Map(participants.map(item => [item.participantId, item]));
  return plan.tasks.map(task => {
    const wanted = typeof task.context?.participantId === 'string' ? task.context.participantId : undefined;
    if (!wanted) throw new Error(`任务缺少参与者：${task.taskId}`);
    const participant = byId.get(wanted);
    if (!participant) throw new Error(`未知参与者：${wanted}`);
    if (!participant.available) throw new Error(`参与者不可用：${wanted}`);
    if (!allowedByScope(participant, plan)) throw new Error(`参与者超出范围：${wanted}`);
    for (const capability of task.requiredCapabilities) {
      if (!participant.capabilities.includes(capability)) {
        throw new Error(`参与者缺少能力 ${capability}：${wanted}`);
      }
    }
    return {
      assignmentId: randomUUID(),
      taskId: task.taskId,
      participantId: wanted,
      reason: `计划指定：${task.kind}`,
      contextRefs: [],
      assignedAt: Date.now()
    } satisfies Assignment;
  });
}
