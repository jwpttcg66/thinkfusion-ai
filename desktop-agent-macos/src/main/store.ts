import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentRound, AgentTask, ExecutionReport, StoredPlan } from '../shared/contracts';

interface StoreState {
  version: number;
  tasks: AgentTask[];
  rounds: AgentRound[];
  plans: StoredPlan[];
  reports: ExecutionReport[];
  events: AgentEvent[];
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
  private state: StoreState = { version: 1, tasks: [], rounds: [], plans: [], reports: [], events: [] };

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
        events: parsed.events ?? []
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

  updateRound(roundId: string, patch: Partial<AgentRound>) {
    const round = this.state.rounds.find(item => item.roundId === roundId);
    if (!round) throw new Error(`round not found: ${roundId}`);
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
}
