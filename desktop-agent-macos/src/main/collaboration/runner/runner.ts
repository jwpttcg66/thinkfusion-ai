/**
 * P1-04：依赖感知的并发 Runner。
 *
 * - 无依赖任务并发；有依赖任务等前序 done；
 * - 依赖失败 → 后继 skipped，不执行；
 * - maxConcurrency 限流；signal 取消；单任务超时；
 * - 所有状态转移串行落在一个 CollaborationState 上。
 */
import { randomUUID } from 'node:crypto';
import type { Assignment, CollaborationState, Goal, Observation, Plan, TaskSpec } from '../domain/types';
import { createCollaborationState, recordAttempt, transitionTask } from '../domain/state';
import type { ParticipantManager } from '../participants/manager';

export interface RunnerInput {
  goal: Goal;
  plan: Plan;
  assignments: readonly Assignment[];
  manager: ParticipantManager;
  maxConcurrency?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

interface RunOne {
  assignment: Assignment;
  task: TaskSpec;
  status: 'done' | 'failed' | 'skipped' | 'cancelled';
  text?: string;
  reason?: string;
  startedAt: number;
  endedAt: number;
  attemptId: string;
}

function terminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped' || status === 'cancelled' || status === 'blocked';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

export async function runPlan(input: RunnerInput): Promise<CollaborationState> {
  const now = input.now ?? (() => Date.now());
  let state = createCollaborationState(input.goal, input.plan, input.plan.policy.budget);
  state = { ...state, assignments: [...input.assignments] };
  const byTask = new Map(input.plan.tasks.map(task => [task.taskId, task]));
  const pending = input.assignments.filter(item => byTask.has(item.taskId));
  const max = Math.max(1, input.maxConcurrency ?? 3);

  while (pending.length > 0) {
    if (input.signal?.aborted) {
      for (const assignment of pending) {
        state = transitionTask(state, assignment.taskId, 'cancelled', 'cancelled');
      }
      break;
    }
    const ready = pending.filter(assignment => {
      const task = byTask.get(assignment.taskId)!;
      return task.dependsOn.every(dep => state.taskStates.find(item => item.taskId === dep)?.status === 'done');
    });
    const blocked = pending.filter(assignment => {
      const task = byTask.get(assignment.taskId)!;
      return task.dependsOn.some(dep => {
        const depState = state.taskStates.find(item => item.taskId === dep);
        return depState && terminal(depState.status) && depState.status !== 'done';
      });
    });
    if (blocked.length > 0) {
      for (const assignment of blocked) {
        state = transitionTask(state, assignment.taskId, 'skipped', '依赖任务未完成');
      }
      for (const assignment of blocked) {
        const index = pending.indexOf(assignment);
        if (index >= 0) pending.splice(index, 1);
      }
      continue;
    }
    if (ready.length === 0) {
      for (const assignment of pending) state = transitionTask(state, assignment.taskId, 'blocked', '依赖无法满足');
      break;
    }
    const batch = ready.slice(0, max);
    for (const assignment of batch) {
      const index = pending.indexOf(assignment);
      if (index >= 0) pending.splice(index, 1);
      state = transitionTask(state, assignment.taskId, 'assigned');
    }
    const results = await Promise.all(batch.map(async (assignment): Promise<RunOne> => {
      const task = byTask.get(assignment.taskId)!;
      const startedAt = now();
      const attemptId = randomUUID();
      state = recordAttempt(state, {
        attemptId,
        taskId: task.taskId,
        participantId: assignment.participantId,
        number: 1,
        status: 'running',
        startedAt
      });
      state = transitionTask(state, task.taskId, 'running');
      try {
        const [answer] = await withTimeout(
          input.manager.ask([assignment.participantId], task.envelope.question, { timeoutMs: task.timeoutMs ?? input.timeoutMs }),
          task.timeoutMs ?? input.timeoutMs ?? 0
        );
        const endedAt = now();
        if (answer?.status === 'done') {
          return { assignment, task, status: 'done', text: answer.text, startedAt, endedAt, attemptId };
        }
        if (answer?.status === 'skipped') {
          return { assignment, task, status: 'skipped', reason: answer.error?.message ?? 'skipped', startedAt, endedAt, attemptId };
        }
        return { assignment, task, status: 'failed', reason: answer?.error?.message ?? 'failed', startedAt, endedAt, attemptId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          assignment, task, status: message === 'timeout' ? 'failed' : 'failed',
          reason: message === 'timeout' ? 'timeout' : message,
          startedAt, endedAt: now(), attemptId
        };
      }
    }));
    for (const result of results) {
      if (result.status === 'done') {
        const observation: Observation = {
          observationId: randomUUID(),
          taskId: result.task.taskId,
          attemptId: result.attemptId,
          participantId: result.assignment.participantId,
          status: 'done',
          text: result.text ?? '',
          evidenceRefs: [],
          startedAt: result.startedAt,
          endedAt: result.endedAt
        };
        state = { ...state, observations: [...state.observations, observation] };
        state = transitionTask(state, result.task.taskId, 'done');
      } else if (result.status === 'skipped') {
        state = transitionTask(state, result.task.taskId, 'skipped', result.reason);
      } else {
        state = transitionTask(state, result.task.taskId, 'failed', result.reason);
      }
    }
  }
  return { ...state, updatedAt: now() };
}
