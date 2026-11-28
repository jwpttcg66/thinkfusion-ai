import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentRound, AgentTask, ExecutionReport, StoredPlan } from '../shared/contracts';
import type { Conversation, ConversationMessage } from '../shared/conversation';
import type { TaskEventEnvelope } from '../shared/task-events';
import type { ContextOwner } from '../shared/context';

interface StoreState {
  version: number;
  tasks: AgentTask[];
  rounds: AgentRound[];
  plans: StoredPlan[];
  reports: ExecutionReport[];
  events: AgentEvent[];
  /** General/Knowledge 会话事件映射后的统一 TaskEvent。 */
  runEvents?: TaskEventEnvelope[];
  /**
   * Conversations live in the same journal as tasks.
   *
   * One file, one atomic rename: a conversation and the task it may have
   * spawned can never end up on opposite sides of a crash. The arrays are
   * optional on read so journals written before conversations existed still
   * load instead of being treated as corrupt.
   */
  conversations: Conversation[];
  messages: ConversationMessage[];
  /** P1-00：协作运行状态，和会话同一个 journal。 */
  collaborations?: StoredCollaboration[];
  /** V4 M1-2：目标实体，和任务同一个 journal。可选字段，老 journal 直接读通。 */
  goals?: StoredGoal[];
}

export interface StoredCollaboration {
  goalId: string;
  state: unknown;
  updatedAt: number;
}

/**
 * 目标实体（V4 M1-2）。
 *
 * 一个目标下可以挂多条任务，版本与成功标准就不该由某一条任务单独持有：
 * 否则从 A 改目标只有 A 的版本抬起来，B 还停在旧口径，界面上两条任务
 * 看着像同一个目标、实际跑在两个版本上。
 * 任务上的 `goalContract` 降级为该目标口径的快照，GCE 取证链路照旧读它。
 */
export interface StoredGoal {
  goalId: string;
  /** 目标原文，取建立该目标时那条任务的契约原文；不做摘要。 */
  title: string;
  version: number;
  criteria: string[];
  updatedAt: number;
}

const MAX_EVENTS_PER_TASK = 800;
/** 会话侧（知识空间）事件仍是全局配额：它们属于单条会话，不存在互相挤占。 */
const MAX_RUN_EVENTS = 5000;
/**
 * 任务事件的裁剪按任务算，不按全局条数。
 *
 * 全局 5000 条在多任务并行时会互相挤掉：B 任务跑一轮就能把 A 的计划树挤出
 * 窗口，A 刷新后看到的是「计划未生成」。这里给每个任务一个配额，并且关键
 * 事件（计划、回答、报告、评审、终态）永不裁剪——它们是恢复所需的最小集。
 */
const KEEP_FOREVER: ReadonlySet<string> = new Set([
  'plan.ready',
  'plan.debated',
  'clarification.required',
  'round.answer',
  'report.ready',
  'review.ready',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'work.breakdown.created',
  'work.task.upserted',
  'work.task.status',
  'work.task.blocked',
  'work.task.accepted',
  'work.breakdown.replanned',
  // M1-3：这是一张压在用户这儿没回答的确认卡。裁掉它等于替用户把问题吞了：
  // 重启之后卡片消失、版本却还是旧的那一版。
  'goal.revision.pending'
]);

function taskIdOfEvent(event: AgentEvent): string | null {
  if ('taskId' in event && typeof event.taskId === 'string') return event.taskId;
  if (event.type === 'task.updated') return event.task.taskId;
  return null;
}

/**
 * Atomic JSON journal for task state.
 *
 * v0.6.0 keeps the JSON journal instead of SQLite on purpose: better-sqlite3
 * would drag node-gyp into the install on Apple Silicon, and this store has to
 * be readable by both the main process and the runtime. Every mutation writes
 * a temp file, fsyncs, then renames — so a crash leaves either the old or the
 * new file, never a half-written one. See git history for the tradeoff.
 */
export class AgentStore {
  private state: StoreState = {
    version: 1,
    tasks: [],
    rounds: [],
    plans: [],
    reports: [],
    events: [],
    runEvents: [],
    conversations: [],
    messages: [],
    collaborations: [],
    goals: []
  };

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      this.state = {
        version: parsed.version ?? 1,
        tasks: parsed.tasks ?? [],
        rounds: parsed.rounds ?? [],
        plans: parsed.plans ?? [],
        reports: parsed.reports ?? [],
        events: parsed.events ?? [],
        runEvents: parsed.runEvents ?? [],
        conversations: parsed.conversations ?? [],
        messages: parsed.messages ?? [],
        collaborations: parsed.collaborations ?? [],
        goals: parsed.goals ?? []
      };    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt journal: keep it for forensics, start clean rather than crash on boot.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, backup);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** delta 的落盘节流：10k 次 token 各写一次 journal 会把事件循环拖死。 */
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleDeltaFlush() {
    if (this.deltaTimer) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      this.persist();
    }, 2000);
    // 不让一个待写盘把进程钉住：进程退出时 journal 仍由下一次持久事件补齐。
    this.deltaTimer.unref?.();
  }

  private persist() {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const handle = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(this.state));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.file);
    // 目录项也要落盘；只 fsync 文件在断电时可能丢掉 rename。
    try {
      const dir = fs.openSync(path.dirname(this.file), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch {
      // 某些平台不允许 fsync 目录；尽力而为，不影响正常写。
    }
  }

  // --- tasks ---------------------------------------------------------------

  upsertTask(task: AgentTask) {
    const index = this.state.tasks.findIndex(item => item.taskId === task.taskId);
    if (index >= 0) this.state.tasks[index] = task;
    else this.state.tasks.push(task);
    this.persist();
  }

  getTask(taskId: string): AgentTask | null {
    return this.state.tasks.find(item => item.taskId === taskId) ?? null;
  }

  listTasks(): AgentTask[] {
    return [...this.state.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteTask(taskId: string) {
    this.state.tasks = this.state.tasks.filter(item => item.taskId !== taskId);
    this.state.rounds = this.state.rounds.filter(item => item.taskId !== taskId);
    this.state.plans = this.state.plans.filter(item => item.taskId !== taskId);
    this.state.reports = this.state.reports.filter(item => item.taskId !== taskId);
    this.state.events = this.state.events.filter(item => {
      const eventTaskId = 'taskId' in item
        ? item.taskId
        : item.type === 'task.updated'
          ? item.task.taskId
          : null;
      return eventTaskId !== taskId;
    });
    this.persist();
  }

  // --- rounds --------------------------------------------------------------

  insertRound(round: AgentRound) {
    this.state.rounds.push(round);
    this.persist();
  }

  /**
   * Patch a round in place.
   *
   * A missing round is not an error: deleting a task removes its rounds, and a
   * round that was already in flight comes back to write its result afterwards.
   * Throwing here turned that race into a user-visible "round not found" —
   * jargon about an internal id, caused by deleting something the user had
   * every right to delete. There is nothing to update, so nothing is done.
   */
  updateRound(roundId: string, patch: Partial<AgentRound>) {
    const round = this.state.rounds.find(item => item.roundId === roundId);
    if (!round) return;
    Object.assign(round, patch);
    this.persist();
  }

  getRound(roundId: string): AgentRound | null {
    return this.state.rounds.find(item => item.roundId === roundId) ?? null;
  }

  listRounds(taskId: string): AgentRound[] {
    return this.state.rounds.filter(item => item.taskId === taskId).sort((a, b) => a.roundNumber - b.roundNumber);
  }

  // --- plans ---------------------------------------------------------------

  insertPlan(plan: StoredPlan) {
    this.state.plans.push(plan);
    this.persist();
  }

  updatePlan(planId: string, patch: Partial<StoredPlan>) {
    const plan = this.state.plans.find(item => item.planId === planId);
    if (!plan) throw new Error(`plan not found: ${planId}`);
    Object.assign(plan, patch);
    this.persist();
  }

  getPlan(planId: string): StoredPlan | null {
    return this.state.plans.find(item => item.planId === planId) ?? null;
  }

  // --- reports -------------------------------------------------------------

  insertReport(report: ExecutionReport) {
    this.state.reports.push(report);
    this.persist();
  }

  /** 某一轮的执行报告；重新判定验证结论时要拿它当唯一事实来源。 */
  reportFor(taskId: string, planId?: string): ExecutionReport | null {
    const matches = this.state.reports.filter(item =>
      item.taskId === taskId && (planId === undefined || item.planId === planId)
    );
    return matches[matches.length - 1] ?? null;
  }

  /** 任务全部轮次的执行报告（按落库顺序）；判定「是否真交付过」要看完整历史，不能只看最后一轮。 */
  allReportsFor(taskId: string): ExecutionReport[] {
    return this.state.reports.filter(item => item.taskId === taskId);
  }

  /**
   * 覆盖同一轮的报告。
   *
   * 只用于「执行事实没变、判定口径变了」的场合（例如把 shell.run 里的
   * javac 也算作编译证据后重新判定）。执行结果本身不允许被改写。
   */
  updateReport(report: ExecutionReport): void {
    const index = this.state.reports.findIndex(item =>
      item.taskId === report.taskId && item.roundId === report.roundId && item.planId === report.planId
    );
    if (index === -1) this.state.reports.push(report);
    else this.state.reports[index] = report;
    this.persist();
  }

  // --- unified run events (General/Knowledge) -------------------------------

  nextRunSequence(taskId: string): number {
    let max = 0;
    for (const event of this.state.runEvents ?? []) {
      if (event.taskId === taskId && event.sequence > max) max = event.sequence;
    }
    return max + 1;
  }

  appendRunEvent(event: TaskEventEnvelope): void {
    this.state.runEvents ??= [];
    this.state.runEvents.push(event);
    if (this.state.runEvents.length > MAX_RUN_EVENTS) {
      this.state.runEvents.splice(0, this.state.runEvents.length - MAX_RUN_EVENTS);
    }
    this.persist();
  }

  listRunEvents(taskId: string): TaskEventEnvelope[] {
    return (this.state.runEvents ?? []).filter(event => event.taskId === taskId);
  }

  /** 清掉已不存在任务的 task.updated；老版本删除任务会留下这些孤儿事件。 */
  pruneOrphanEvents(): number {
    const ids = new Set(this.state.tasks.map(task => task.taskId));
    const before = this.state.events.length;
    this.state.events = this.state.events.filter(item => {
      const eventTaskId = 'taskId' in item
        ? item.taskId
        : item.type === 'task.updated'
          ? item.task.taskId
          : null;
      if (!eventTaskId) return true;
      return ids.has(eventTaskId);
    });
    const removed = before - this.state.events.length;
    if (removed > 0) this.persist();
    return removed;
  }

  // --- events --------------------------------------------------------------

  /** 任务内严格递增序号；旧事件没有 sequence 时按已有条数兜底。 */
  nextSequence(taskId: string): number {
    let max = 0;
    for (const event of this.state.events) {
      const eventTaskId = 'taskId' in event
        ? event.taskId
        : event.type === 'task.updated'
          ? event.task.taskId
          : null;
      if (eventTaskId !== taskId) continue;
      if (typeof event.sequence === 'number' && event.sequence > max) max = event.sequence;
    }
    return max + 1;
  }

  appendEvent(event: AgentEvent) {
    // 流式 token 不逐条重写整份 journal：10k 条 delta 会把事件循环拖死，
    // 定时器和 UI 都会停止响应。内存里同一 stream 只保留最新快照，
    // 等 round.answer / 下一个持久事件到来时一起落盘。
    if (event.type === 'round.delta') {
      const index = this.state.events.findIndex(item =>
        item.type === 'round.delta' &&
        item.taskId === event.taskId &&
        item.roundId === event.roundId &&
        item.streamId === event.streamId
      );
      if (index >= 0) this.state.events[index] = event;
      else this.state.events.push(event);
      this.trimEvents();
      // 不每条都落盘：2 秒最多一次。刷新只依赖内存，重启才需要它。
      this.scheduleDeltaFlush();
      return;
    }
    this.state.events.push(event);
    this.trimEvents();
    this.persist();
  }

  /**
   * 每任务一个配额。超出时删该任务最老的非关键事件，关键事件不动。
   * 只删到配额以内，不做全局一刀切——那正是多任务互相踩的原因。
   */
  private trimEvents() {
    const groups = new Map<string, number[]>();
    for (let index = 0; index < this.state.events.length; index += 1) {
      const id = taskIdOfEvent(this.state.events[index]);
      if (!id) continue;
      const list = groups.get(id) ?? [];
      list.push(index);
      groups.set(id, list);
    }
    const drop = new Set<number>();
    for (const indexes of groups.values()) {
      if (indexes.length <= MAX_EVENTS_PER_TASK) continue;
      let excess = indexes.length - MAX_EVENTS_PER_TASK;
      // 从最老的开始删，关键事件跳过（它们是恢复的最小集）。
      for (const index of indexes) {
        if (excess === 0) break;
        if (KEEP_FOREVER.has(this.state.events[index].type)) continue;
        drop.add(index);
        excess -= 1;
      }
    }
    if (drop.size === 0) return;
    this.state.events = this.state.events.filter((_, index) => !drop.has(index));
  }

  listEvents(taskId: string): AgentEvent[] {
    return this.state.events.filter(item =>
      'taskId' in item
        ? item.taskId === taskId
        : item.type === 'task.updated' && item.task.taskId === taskId
    );
  }

  // --- conversations -------------------------------------------------------

  upsertConversation(conversation: Conversation) {
    const index = this.state.conversations.findIndex(item => item.conversationId === conversation.conversationId);
    if (index >= 0) this.state.conversations[index] = conversation;
    else this.state.conversations.push(conversation);
    this.persist();
  }

  getConversation(conversationId: string): Conversation | null {
    return this.state.conversations.find(item => item.conversationId === conversationId) ?? null;
  }

  /**
   * 一次 Journal 持久化完成 owner 活动指针 + committed 事件。
   *
   * 不能由调用方用 upsertTask/upsertConversation + appendEvent 拼事务：
   * 那会产生中间状态（指针已变、事件未落或反过来）。
   */
  commitContextCheckpoint(input: {
    owner: ContextOwner;
    contextId: string;
    checkpointId: string;
    activeRunId: string;
    event?: AgentEvent;
  }): void {
    const now = Date.now();
    const owner = input.owner;
    if (owner.ownerType === 'agent-task') {
      const task = this.state.tasks.find(item => item.taskId === owner.taskId);
      if (!task) throw new Error(`提交上下文检查点失败：任务不存在 ${owner.taskId}`);
      task.contextId = input.contextId;
      task.checkpointId = input.checkpointId;
      task.activeRunId = input.activeRunId;
      task.updatedAt = now;
    } else {
      const conversation = this.state.conversations.find(
        item => item.conversationId === owner.conversationId
      );
      if (!conversation) {
        throw new Error(`提交上下文检查点失败：会话不存在 ${owner.conversationId}`);
      }
      conversation.contextId = input.contextId;
      conversation.checkpointId = input.checkpointId;
      conversation.activeRunId = input.activeRunId;
      conversation.updatedAt = now;
    }
    if (input.event) {
      this.state.events.push(input.event);
      this.trimEvents();
    }
    this.persist();
  }

  listConversations(): Conversation[] {
    return [...this.state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteConversation(conversationId: string) {
    this.state.conversations = this.state.conversations.filter(item => item.conversationId !== conversationId);
    this.state.messages = this.state.messages.filter(item => item.conversationId !== conversationId);
    this.state.collaborations = (this.state.collaborations ?? []).filter(item => item.goalId !== conversationId);
    this.persist();
  }

  /** P1-00：整个 CollaborationState 作为一个 journal 条目。 */
  saveCollaboration(goalId: string, state: unknown) {
    const next = { goalId, state, updatedAt: Date.now() };
    const list = this.state.collaborations ?? [];
    const index = list.findIndex(item => item.goalId === goalId);
    if (index >= 0) list[index] = next;
    else list.push(next);
    this.state.collaborations = list;
    this.persist();
  }

  getCollaboration(goalId: string): unknown | null {
    return (this.state.collaborations ?? []).find(item => item.goalId === goalId)?.state ?? null;
  }

  /** V4 M1-2：目标实体读写。侧栏分组仍由任务驱动，所以这里不需要为「空目标」做过滤。 */
  listGoals(): StoredGoal[] {
    return [...(this.state.goals ?? [])];
  }

  getGoal(goalId: string): StoredGoal | null {
    return (this.state.goals ?? []).find(item => item.goalId === goalId) ?? null;
  }

  upsertGoal(goal: StoredGoal) {
    const list = this.state.goals ?? [];
    const index = list.findIndex(item => item.goalId === goal.goalId);
    if (index >= 0) list[index] = goal;
    else list.push(goal);
    this.state.goals = list;
    this.persist();
  }

  /**
   * 回收目标实体（V4 P1 M2-2 垃圾回收）。
   *
   * 目标唯一的意义是「串起同一目标下的任务」，所以能不能删只有一条判据：还有没有
   * 任务绑在它下面。这条判据由调用方用 `tasksUnderGoal()` 现场算——不在这里按
   * `updatedAt` 猜「很久没人用」：一个用户两周没回来、但只删了其中一条任务的目标，
   * 按时间猜会被连带删掉，剩下几条任务侧栏分组就凭空换标题。
   * 返回是否真删掉一份，没删过就不能报「已回收」。
   */
  deleteGoal(goalId: string): boolean {
    const list = this.state.goals ?? [];
    const index = list.findIndex(item => item.goalId === goalId);
    if (index < 0) return false;
    list.splice(index, 1);
    this.state.goals = list;
    this.persist();
    return true;
  }

  appendMessage(message: ConversationMessage) {
    // A stage that was still running when its conversation was deleted keeps
    // producing turns. The deletion removed the conversation and every message
    // it had; writing this one anyway leaves a record with no conversation above
    // it — invisible in the app and impossible to remove from it. Measured: one
    // orphaned system message survived a delete that happened while the lead
    // stage was still answering.
    if (!this.state.conversations.some(item => item.conversationId === message.conversationId)) return;
    this.state.messages.push(message);
    this.persist();
  }

  listMessages(conversationId: string): ConversationMessage[] {
    return this.state.messages.filter(item => item.conversationId === conversationId).sort((a, b) => a.at - b.at);
  }

  /**
   * 移除一个工作区分组时调用：会话留下，只把归属清掉。
   *
   * 返回被改动的条数。一次写入而不是逐条 persist——侧栏上按一次「移除」不该
   * 产生 N 次磁盘替换，也不该在中途崩溃时留下一半已清、一半还挂着的状态。
   */
  clearConversationWorkspace(workspaceId: string): number {
    let changed = 0;
    for (const conversation of this.state.conversations) {
      if (conversation.workspaceId !== workspaceId) continue;
      delete conversation.workspaceId;
      changed += 1;
    }
    if (changed > 0) this.persist();
    return changed;
  }
}
