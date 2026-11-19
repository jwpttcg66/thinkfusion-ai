/**
 * P1-04：按 Assignment 执行任务，写 Attempt / Observation / 状态。
 *
 * P1.0 顺序执行；并发与取消在 P1.1 接入。
 */
import { randomUUID } from 'node:crypto';
import type { Assignment, CollaborationState, Goal, Observation, Plan } from '../domain/types';
import { createCollaborationState, recordAttempt, transitionTask } from '../domain/state';
import type { ParticipantManager } from '../participants/manager';

export interface RunnerInput {
  goal: Goal;
  plan: Plan;
  assignments: readonly Assignment[];
  manager: ParticipantManager;
  now?: () => number;
}

export async function runPlan(input: RunnerInput): Promise<CollaborationState> {
  const now = input.now ?? (() => Date.now());
  let state = createCollaborationState(input.goal, input.plan, input.plan.policy.budget);
  const byTask = new Map(input.plan.tasks.map(task => [task.taskId, task]));
  for (const assignment of input.assignments) {
    const task = byTask.get(assignment.taskId);
    if (!task) continue;
    const dependencyFailed = task.dependsOn.some(dep => {
      const depState = state.taskStates.find(item => item.taskId === dep);
      return !depState || depState.status !== 'done';
    });
    if (dependencyFailed) {
      state = transitionTask(state, task.taskId, 'skipped', '依赖任务未完成');
      continue;
    }
    state = transitionTask(state, task.taskId, 'assigned');
    const startedAt = now();
    const attempt = {
      attemptId: randomUUID(),
      taskId: task.taskId,
      participantId: assignment.participantId,
      number: 1,
      status: 'running' as const,
      startedAt
    };
    state = recordAttempt(state, attempt);
    const [result] = await input.manager.ask([assignment.participantId], task.envelope.question, {
      timeoutMs: task.timeoutMs
    });
    const endedAt = now();
    const status = result?.status === 'done' ? 'done' : result?.status === 'skipped' ? 'skipped' : 'failed';
    if (status === 'done') {
      const observation: Observation = {
        observationId: randomUUID(),
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        participantId: assignment.participantId,
        status: 'done',
        text: result?.text ?? '',
        evidenceRefs: [],
        startedAt,
        endedAt
      };
      state = { ...state, observations: [...state.observations, observation] };
      state = transitionTask(state, task.taskId, 'done');
    } else if (status === 'skipped') {
      state = transitionTask(state, task.taskId, 'skipped', result?.error?.message);
    } else {
      state = transitionTask(state, task.taskId, 'failed', result?.error?.message);
    }
  }
  return { ...state, updatedAt: now() };
}
