import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRound,
  AgentTask,
  PermissionPreset,
  TaskStatus
} from '../shared/contracts';
import { AgentStore } from './store';

/** Transitions the spec allows. Anything else is a bug, not a warning. */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  created: ['planning', 'failed', 'cancelled'],
  // planning -> completed covers "planner says the task is already done" before
  // any local step ran; the orchestrator still checks for pending rounds first.
  // planning -> awaiting_clarification covers "the planner needs an answer";
  // nothing moves again until the user supplies one.
  planning: ['plan_ready', 'awaiting_clarification', 'completed', 'failed', 'cancelled'],
  // Answering starts a new round, so it re-enters planning. There is no path
  // from here to anything else: a question that is not answered cannot be
  // executed, approved or skipped.
  awaiting_clarification: ['planning', 'failed', 'cancelled'],
  plan_ready: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'failed', 'cancelled'],
  executing: ['verifying', 'failed', 'cancelled'],
  verifying: ['report_pending', 'failed', 'cancelled'],
  report_pending: ['awaiting_next_round', 'completed', 'failed', 'cancelled'],
  awaiting_next_round: ['planning', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
};

export const TERMINAL: TaskStatus[] = ['completed', 'failed', 'cancelled'];

export class TaskManager {
  constructor(
    private readonly store: AgentStore,
    private readonly emit: (event: AgentEvent) => void
  ) {}

  create(input: {
    prompt: string;
    permissionPreset: PermissionPreset;
    workspaceRoot?: string;
    /** V2.1 D-03：默认 auto——小计划不辩，带写/测的多步计划才辩。 */
    planDebate?: 'auto' | 'on' | 'off';
  }): AgentTask {
    const now = Date.now();
    const firstLine = input.prompt.trim().split('\n')[0] ?? '';
    const task: AgentTask = {
      taskId: randomUUID(),
      title: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || '未命名任务',
      userPrompt: input.prompt,
      status: 'created',
      permissionPreset: input.permissionPreset,
      workspaceRoot: input.workspaceRoot,
      planDebate: input.planDebate ?? 'auto',
      createdAt: now,
      updatedAt: now,
      maxRounds: 20,
      maxSteps: 30,
      timeoutMs: 180_000
    };
    this.store.upsertTask(task);
    this.publish(task);
    return task;
  }

  get(taskId: string): AgentTask {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`任务不存在：${taskId}`);
    return task;
  }

  list(): AgentTask[] {
    return this.store.listTasks();
  }

  transition(taskId: string, to: TaskStatus, patch: Partial<AgentTask> = {}): AgentTask {
    const current = this.get(taskId);
    if (current.status === to) return current;

    const allowed = ALLOWED[current.status];
    if (!allowed.includes(to)) {
      throw new Error(`非法状态转换：${current.status} → ${to}（task ${taskId}）`);
    }

    const next: AgentTask = { ...current, ...patch, status: to, updatedAt: Date.now() };
    this.store.upsertTask(next);
    this.publish(next);
    return next;
  }

  /** Non-transitional update (e.g. recording the current round id). */
  patch(taskId: string, patch: Partial<AgentTask>): AgentTask {
    const current = this.get(taskId);
    const next: AgentTask = { ...current, ...patch, updatedAt: Date.now() };
    this.store.upsertTask(next);
    this.publish(next);
    return next;
  }

  createRound(input: {
    taskId: string;
    inputType: AgentRound['inputType'];
    requestText: string;
  }): AgentRound {
    const rounds = this.store.listRounds(input.taskId);
    const round: AgentRound = {
      roundId: randomUUID(),
      taskId: input.taskId,
      roundNumber: rounds.length + 1,
      requestId: randomUUID(),
      inputType: input.inputType,
      requestText: input.requestText,
      status: 'sending',
      createdAt: Date.now()
    };
    this.store.insertRound(round);
    this.patch(input.taskId, { currentRoundId: round.roundId });
    this.emit({
      type: 'round.started',
      at: Date.now(),
      taskId: input.taskId,
      roundId: round.roundId,
      roundNumber: round.roundNumber,
      inputType: round.inputType
    });
    return round;
  }

  updateRound(roundId: string, patch: Partial<AgentRound>) {
    this.store.updateRound(roundId, patch);
  }

  getRound(roundId: string) {
    return this.store.getRound(roundId);
  }

  listRounds(taskId: string) {
    return this.store.listRounds(taskId);
  }

  log(taskId: string | undefined, level: 'info' | 'warn' | 'error', message: string) {
    this.emit({ type: 'log', at: Date.now(), taskId, level, message });
  }

  private publish(task: AgentTask) {
    this.emit({ type: 'task.updated', at: Date.now(), task });
  }
}
