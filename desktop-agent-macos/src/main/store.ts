import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentRound, AgentTask, ExecutionReport, StoredPlan } from '../shared/contracts';
import type { Conversation, ConversationMessage } from '../shared/conversation';

interface StoreState {
  version: number;
  tasks: AgentTask[];
  rounds: AgentRound[];
  plans: StoredPlan[];
  reports: ExecutionReport[];
  events: AgentEvent[];
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
}

const MAX_EVENTS = 5000;

/**
 * Atomic JSON journal for task state.
 *
 * v0.6.0 keeps the JSON journal instead of SQLite on purpose: better-sqlite3
 * would drag node-gyp into the install on Apple Silicon, and this store has to
 * be readable by both the main process and the runtime. Every mutation writes
 * a temp file, fsyncs, then renames — so a crash leaves either the old or the
 * new file, never a half-written one. See DELIVERY_STATUS.md for the tradeoff.
 */
export class AgentStore {
  private state: StoreState = {
    version: 1,
    tasks: [],
    rounds: [],
    plans: [],
    reports: [],
    events: [],
    conversations: [],
    messages: []
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
        conversations: parsed.conversations ?? [],
        messages: parsed.messages ?? []
      };
    } catch (error) {
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

  private persist() {
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
    this.state.events = this.state.events.filter(item => !('taskId' in item) || item.taskId !== taskId);
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

  // --- events --------------------------------------------------------------

  appendEvent(event: AgentEvent) {
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    this.persist();
  }

  listEvents(taskId: string): AgentEvent[] {
    return this.state.events.filter(item => 'taskId' in item && item.taskId === taskId);
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

  listConversations(): Conversation[] {
    return [...this.state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteConversation(conversationId: string) {
    this.state.conversations = this.state.conversations.filter(item => item.conversationId !== conversationId);
    this.state.messages = this.state.messages.filter(item => item.conversationId !== conversationId);
    this.persist();
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
}
