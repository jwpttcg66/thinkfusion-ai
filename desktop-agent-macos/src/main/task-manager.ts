import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRound,
  AgentTask,
  PermissionPreset,
  TaskStatus
} from '../shared/contracts';
import { AgentStore } from './store';
import { codingStateFor } from '../shared/coding-workflow';
import { DEFAULT_TASK_BUDGET, budgetStateOf, canOpenRound, extendTaskBudget, normalizeTaskBudget } from '../shared/task-budget';
import { autoContinueOf } from '../shared/task-continue';
import type { BudgetState, TaskBudget } from '../shared/task-budget';

/** Transitions the spec allows. Anything else is a bug, not a warning. */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  created: ['planning', 'paused', 'interrupted', 'budget_exhausted', 'blocked', 'failed', 'cancelled'],
  // planning -> completed covers "planner says the task is already done" before
  // any local step ran; the orchestrator still checks for pending rounds first.
  // planning -> awaiting_clarification covers "the planner needs an answer";
  // nothing moves again until the user supplies one.
  planning: ['plan_ready', 'awaiting_clarification', 'paused', 'interrupted', 'budget_exhausted', 'blocked', 'completed', 'failed', 'cancelled'],
  // Answering starts a new round, so it re-enters planning. There is no path
  // from here to anything else: a question that is not answered cannot be
  // executed, approved or skipped.
  awaiting_clarification: ['planning', 'paused', 'interrupted', 'blocked', 'failed', 'cancelled'],
  plan_ready: ['awaiting_approval', 'paused', 'interrupted', 'blocked', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'paused', 'interrupted', 'blocked', 'failed', 'cancelled'],
  executing: ['verifying', 'paused', 'interrupted', 'budget_exhausted', 'blocked', 'failed', 'cancelled'],
  verifying: ['report_pending', 'paused', 'interrupted', 'budget_exhausted', 'blocked', 'failed', 'cancelled'],
  report_pending: ['awaiting_next_round', 'paused', 'interrupted', 'budget_exhausted', 'blocked', 'completed', 'failed', 'cancelled'],
  // completed 这条是 M3-4 的用户出口：判定要开下一轮、但用户关了无人值守时，任务停在这里
  // 且手里已经有一份报告。缺这条边的话，「不再做一轮」只剩两条路——要么白烧一整轮模型
  // 去够 report_pending 的收口按钮，要么点取消把已交付的东西记成没交付。
  awaiting_next_round: ['planning', 'paused', 'interrupted', 'budget_exhausted', 'blocked', 'completed', 'failed', 'cancelled'],
  pause_requested: ['pausing', 'paused', 'interrupted', 'cancel_requested', 'cancelled', 'failed'],
  pausing: ['paused', 'interrupted', 'cancel_requested', 'cancelled', 'failed'],
  cancel_requested: ['cancelling', 'cancelled', 'interrupted', 'paused', 'failed'],
  cancelling: ['cancelled', 'interrupted', 'failed'],
  // paused/interrupted/blocked → budget_exhausted：恢复（resume）时才发现轮数已见底，
  // 这条落点必须可达，否则又只能退回 `failed` 那个接不回去的终态。
  paused: ['planning', 'plan_ready', 'awaiting_clarification', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'awaiting_next_round', 'budget_exhausted', 'blocked', 'failed', 'cancelled'],
  interrupted: ['planning', 'plan_ready', 'awaiting_clarification', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'awaiting_next_round', 'budget_exhausted', 'blocked', 'failed', 'cancelled'],
  // 这两个落点也吃 `interrupted`：停在「等预算」或「等你处理」的任务上，在途那一轮的
  // promise 还活着，通道断了照样会走 fail() 的分类落点。缺这条边时 transition 抛错，
  // fail() 的兜底就把一条还能接回去的通道故障写成了终态——正是 M3-4d 要堵的口。
  // 预算/阻塞信息不会因此丢掉：resume() 会重读门禁与前置条件，再把它送回原落点
  // （`interrupted -> budget_exhausted` / `blocked` 本来就是允许的）。
  budget_exhausted: ['planning', 'plan_ready', 'awaiting_clarification', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'awaiting_next_round', 'interrupted', 'blocked', 'failed', 'cancelled'],
  blocked: ['planning', 'plan_ready', 'awaiting_clarification', 'awaiting_approval', 'executing', 'verifying', 'report_pending', 'awaiting_next_round', 'interrupted', 'budget_exhausted', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
};

// 任何未结束状态都可以提出暂停/取消；请求态再由 Runtime 回执推进到实际态。
for (const from of [
  'planning', 'awaiting_clarification', 'plan_ready', 'awaiting_approval', 'executing',
  'verifying', 'report_pending', 'awaiting_next_round', 'paused', 'interrupted',
  'budget_exhausted', 'blocked', 'pause_requested', 'pausing', 'cancel_requested'
] as const) {
  ALLOWED[from].push('cancel_requested');
  if (from !== 'cancel_requested') ALLOWED[from].push('pause_requested');
}

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
    debateAgentIds?: string[];
    /** 目标与版本；缺省按「一个任务一个目标 v1」建立，后续修订会递增。 */
    goalId?: string;
    goalVersion?: number;
    goalCriteria?: string[];
  }): AgentTask {
    const now = Date.now();
    const firstLine = input.prompt.trim().split('\n')[0] ?? '';
    const taskId = randomUUID();
    const task: AgentTask = {
      taskId,
      title: firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine || '未命名任务',
      userPrompt: input.prompt,
      status: 'created',
      permissionPreset: input.permissionPreset,
      workspaceRoot: input.workspaceRoot,
      goalId: input.goalId ?? `goal:${taskId}`,
      goalVersion: input.goalVersion ?? 1,
      ...(input.goalCriteria && input.goalCriteria.length > 0
        ? { goalCriteria: [...input.goalCriteria] }
        : {}),
      planDebate: input.planDebate ?? 'auto',
      ...(input.debateAgentIds && input.debateAgentIds.length > 0 ? { debateAgentIds: input.debateAgentIds } : {}),
      createdAt: now,
      updatedAt: now,
      // 预算从建立那天就落盘：`maxRounds` 只作显示别名，判定读的是 `budget`（M3-3 单点）。
      maxRounds: DEFAULT_TASK_BUDGET.maxRounds,
      budget: normalizeTaskBudget(),
      maxSteps: 30,
      timeoutMs: 600_000
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

  /**
   * 应用启动时收敛上一次进程留下的在途任务。
   *
   * planning/executing/verifying 依赖内存里的 Runner；应用退出后这些 Runner
   * 已经不存在，任务却会永远显示“正在规划/执行”。只能明确标失败，不能
   * 假装还在跑，也不能自动重跑有副作用的执行。
   */
  reconcileInterrupted(): number {
    const interrupted = new Set<TaskStatus>([
      'planning', 'executing', 'verifying', 'pause_requested', 'pausing'
    ]);
    const cancelled = new Set<TaskStatus>(['cancel_requested', 'cancelling']);
    let count = 0;
    for (const task of this.store.listTasks()) {
      if (interrupted.has(task.status)) {
        this.transition(task.taskId, 'interrupted', {
          error: '应用退出前任务未结束，已标记为中断；暂停未完成，恢复时先核对上次检查点与副作用。'
        });
        count += 1;
        continue;
      }
      if (cancelled.has(task.status)) {
        this.transition(task.taskId, 'cancelled', {
          error: '应用退出前取消未完成，工具已随进程退出；副作用需人工核对。'
        });
        count += 1;
      }
    }
    return count;
  }

  transition(taskId: string, to: TaskStatus, patch: Partial<AgentTask> = {}): AgentTask {
    const current = this.get(taskId);
    if (current.status === to) return current;

    const allowed = ALLOWED[current.status];
    if (!allowed.includes(to)) {
      throw new Error(`非法状态转换：${current.status} → ${to}（task ${taskId}）`);
    }

    const next: AgentTask = {
      ...current,
      ...patch,
      status: to,
      codingState: patch.codingState ?? codingStateFor(to),
      updatedAt: Date.now()
    };
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

  /**
   * 预算的唯一写路径（M3-3）：追加 → 落盘 → 发事件 → 当场重算门禁。
   *
   * 原来错在哪：界面上有「追加预算或结束」的文案，却没有任何地方能把预算写回任务，
   * 所以超限只能停在 `failed`。这里同时保证「只增不减」（`extendTaskBudget` 的约定）
   * 和 `maxRounds` 这个显示别名跟着走，避免两份数对不上。
   *
   * 返回的 `gate` 是给调用方与事件用的：加完预算到底放行没有，必须当场可核对。
   */
  extendBudget(
    taskId: string,
    raw: TaskBudget | null | undefined,
    source: 'user' | 'model' | 'resume' = 'user'
  ): { task: AgentTask; budget: TaskBudget; gate: ReturnType<typeof canOpenRound> } {
    const current = this.get(taskId);
    const previous = current.budget ?? null;
    const budget = extendTaskBudget(previous, raw);
    const task = this.patch(taskId, { budget, maxRounds: budget.maxRounds ?? DEFAULT_TASK_BUDGET.maxRounds });
    const gate = canOpenRound({
      budget,
      // 模型调用与 token 现网没有任务级账本（主进程不回填每轮 usage），如实记 null：
      // 设了这两条上限也不会误判超限，界面会显示「未记账」而不是「没用完」。
      usage: { rounds: this.store.listRounds(taskId).length, modelCalls: null, tokens: null }
    });
    this.emit({
      type: 'task.budget.updated',
      at: Date.now(),
      taskId,
      budget,
      previous,
      source,
      gate
    });
    return { task, budget, gate };
  }

  /**
   * 无人值守续轮开关的唯一写路径（M3-4c）：落盘 → 发事件 → 回执生效值。
   *
   * 与预算同类：只改一个字段但必须留痕，否则「这一轮为什么没自己开」事后无从核对。
   * `previous` 记的是**生效值**而不是字段原值——老任务没写过这个字段，缺省按「自动续轮」算，
   * 直接回 `undefined` 会让界面显示成「原来是关的」。
   */
  setAutoContinue(taskId: string, autoContinue: boolean): { task: AgentTask; previous: boolean } {
    const current = this.get(taskId);
    const previous = autoContinueOf(current);
    const task = this.patch(taskId, { autoContinue });
    this.emit({
      type: 'task.auto_continue.updated',
      at: Date.now(),
      taskId,
      autoContinue,
      previous,
      source: 'user'
    });
    return { task, previous };
  }

  /** 预算核算读数（详情面板与门禁共用）：轮数从轮次表现算，token 拿不到就记未知。 */
  budgetView(taskId: string): { budget: TaskBudget; state: BudgetState; gate: ReturnType<typeof canOpenRound> } {
    const task = this.get(taskId);
    const budget = task.budget ?? normalizeTaskBudget({ maxRounds: task.maxRounds });
    const usage = { rounds: this.store.listRounds(taskId).length, modelCalls: null, tokens: null };
    return {
      budget,
      state: budgetStateOf({ budget, usage }),
      gate: canOpenRound({ budget, usage })
    };
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
