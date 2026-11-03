import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  AgentEvent,
  AgentPlan,
  AgentTask,
  ApprovePlanInput,
  ExecutionReport,
  PermissionPreset,
  PlanPreview,
  StoredPlan,
  TaskGrant
} from '../shared/contracts';
import { allowedToolsForPreset, buildClarificationAnswerPrompt, buildInitialPrompt, buildReportPrompt, parseAnswer } from '../shared/protocol';
import { AgentStore } from './store';
import { TaskManager, TERMINAL } from './task-manager';
import { ChatPageDriver } from './adapters/browser/page-driver';
import { runPlan } from './agent-manager';

const GRANT_TTL_MS = 30 * 60 * 1000;

export interface OrchestratorDeps {
  tasks: TaskManager;
  store: AgentStore;
  adapter: ChatPageDriver;
  emit: (event: AgentEvent) => void;
  dbPath: () => string;
}

/**
 * Drives the closed loop: prompt -> DeepSeek -> plan -> approval -> runtime ->
 * report -> DeepSeek -> ... until complete, cancelled, or a limit is hit.
 *
 * Every step re-checks state instead of trusting the previous step's outcome,
 * because the previous step may have been a web page we do not control.
 */
export class AgentOrchestrator {
  /** taskIds with an active wait or execution, to prevent double-driving. */
  private busy = new Set<string>();

  /**
   * Serialises use of the one page there is.
   *
   * `busy` is per task, which is not enough: two tasks driving the same chat at
   * once overwrite each other's messages and then read each other's answers.
   * That is not theoretical — a real run captured a completion whose taskId
   * belonged to a different task that happened to be waiting on the same page.
   * A page has one writer, so rounds queue up instead.
   */
  private pageQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OrchestratorDeps) {}

  private get tasks() {
    return this.deps.tasks;
  }

  private async withPage<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.pageQueue;
    let release = () => {};
    this.pageQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  async submit(input: { prompt: string; permissionPreset: PermissionPreset; workspaceRoot?: string }): Promise<AgentTask> {
    const status = await this.deps.adapter.getStatus();
    if (!status.loggedIn) throw new Error(`DeepSeek 未登录：${status.detail ?? '请先在内嵌页面登录'}`);
    if (!status.pageReady) throw new Error(`DeepSeek 页面不可用：${status.detail ?? '未找到输入框'}`);
    if (status.generating) throw new Error('DeepSeek 正在生成上一条回答，请等待完成后再提交');

    const task = this.tasks.create(input);
    this.tasks.transition(task.taskId, 'planning');

    // The round id is part of the prompt, so create the round first and then
    // persist the text it was actually driven with.
    const round = this.tasks.createRound({ taskId: task.taskId, inputType: 'user_prompt', requestText: '' });
    const prompt = buildInitialPrompt({
      prompt: input.prompt,
      taskId: task.taskId,
      roundId: round.roundId,
      permissionPreset: input.permissionPreset,
      workspaceRoot: input.workspaceRoot ?? '(未指定工作区)',
      allowedTools: allowedToolsForPreset(input.permissionPreset),
      maxSteps: task.maxSteps
    });
    this.tasks.updateRound(round.roundId, { requestText: prompt });

    void this.driveRound(task.taskId, round.roundId, prompt).catch(error => this.fail(task.taskId, error));
    return this.tasks.get(task.taskId);
  }

  async approve(input: ApprovePlanInput): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (task.status !== 'awaiting_approval') throw new Error(`任务当前状态为 ${task.status}，不接受审批`);
    if (task.currentRoundId !== input.roundId) throw new Error('审批的轮次不是当前轮次');
    if (task.currentPlanId !== input.planId) throw new Error('审批的计划不是当前计划');

    const stored = this.deps.store.getPlan(input.planId);
    if (!stored) throw new Error('计划不存在');
    if (stored.taskId !== input.taskId || stored.roundId !== input.roundId) throw new Error('计划归属与任务/轮次不匹配');
    if (stored.approvalStatus !== 'pending') throw new Error(`计划状态为 ${stored.approvalStatus}，无法重复审批`);
    if (hashPlan(stored.plan) !== stored.contentHash) throw new Error('计划内容已变化，请重新审阅');
    if (Date.now() > stored.createdAt + 10 * 60 * 1000) {
      this.deps.store.updatePlan(stored.planId, { approvalStatus: 'expired' });
      throw new Error('计划已过期，请让 DeepSeek 重新生成');
    }

    const rootDir = await this.resolveWorkspace(task);
    const plan = stored.plan;

    if (task.permissionPreset === 'read-only') {
      const writes = plan.steps.filter(step => step.tool !== 'fs.list' && step.tool !== 'fs.readFile');
      if (writes.length > 0) throw new Error('计划包含写入操作，但当前权限为「仅可查看」');
    }

    const grant: TaskGrant = {
      taskId: task.taskId,
      permissionPreset: task.permissionPreset,
      approvalPolicy: 'ask',
      rootDir,
      allowedTools: [...new Set(plan.steps.map(step => step.tool))],
      expiresAt: Date.now() + GRANT_TTL_MS,
      maxSteps: Math.min(plan.steps.length, task.maxSteps),
      grantVersion: 1
    };

    this.deps.store.updatePlan(stored.planId, { approvalStatus: 'approved' });
    this.tasks.transition(task.taskId, 'executing', { workspaceRoot: rootDir });
    this.busy.add(task.taskId);

    let report: ExecutionReport;
    try {
      report = await runPlan(plan, grant, this.deps.dbPath(), task.timeoutMs, {
        roundId: stored.roundId,
        planId: stored.planId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.tasks.transition(task.taskId, 'failed', { error: message });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId: task.taskId, error: message });
      throw error;
    } finally {
      this.busy.delete(task.taskId);
    }

    this.deps.store.insertReport(report);
    this.deps.emit({ type: 'report.ready', at: Date.now(), taskId: task.taskId, roundId: stored.roundId, report });

    this.tasks.transition(task.taskId, 'verifying');
    this.tasks.transition(task.taskId, 'report_pending');

    if (report.status === 'cancelled') {
      this.tasks.transition(task.taskId, 'cancelled', { error: '执行过程中被取消' });
      this.deps.emit({ type: 'task.cancelled', at: Date.now(), taskId: task.taskId });
      return;
    }

    if (report.status === 'failed' && report.nextAction === 'stop') {
      // A failed plan is reported back so the planner can react, unless nothing
      // ran at all — then there is nothing useful to say.
      if (report.results.length === 0) {
        this.tasks.transition(task.taskId, 'failed', { error: report.errors[0]?.message ?? '执行失败' });
        this.deps.emit({ type: 'task.failed', at: Date.now(), taskId: task.taskId, error: report.errors[0]?.message ?? '执行失败' });
        return;
      }
    }

    await this.continueAfterReport(task.taskId, report);
  }

  async reject(input: { taskId: string; planId: string; reason?: string }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (task.status !== 'awaiting_approval') throw new Error(`任务当前状态为 ${task.status}，无法拒绝计划`);
    this.deps.store.updatePlan(input.planId, { approvalStatus: 'rejected' });
    this.tasks.transition(input.taskId, 'cancelled', { error: input.reason ?? '用户拒绝执行计划' });
    this.deps.emit({ type: 'task.cancelled', at: Date.now(), taskId: input.taskId });
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (TERMINAL.includes(task.status)) return;

    const round = task.currentRoundId ? this.tasks.getRound(task.currentRoundId) : null;
    if (round) this.deps.adapter.cancelWait(round.requestId);

    this.tasks.transition(taskId, 'cancelled', { error: '用户取消任务' });
    this.deps.emit({ type: 'task.cancelled', at: Date.now(), taskId });
  }

  async answerClarification(input: { taskId: string; answer: string }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (TERMINAL.includes(task.status)) throw new Error('任务已结束');
    if (this.busy.has(input.taskId)) throw new Error('任务正在执行，无法回答澄清问题');
    // Only a pending question can be answered. Without this guard a second
    // click on 提交回答 started a second round against the same question, and
    // the two rounds then raced for the page.
    if (task.status !== 'awaiting_clarification') {
      throw new Error(`任务当前状态为 ${task.status}，没有待回答的澄清问题`);
    }

    const rounds = this.tasks.listRounds(input.taskId);
    const last = rounds[rounds.length - 1];
    const questions = last?.pendingQuestions ?? [];

    this.tasks.transition(input.taskId, 'planning');
    const round = this.tasks.createRound({ taskId: input.taskId, inputType: 'clarification_answer', requestText: '' });
    const prompt = buildClarificationAnswerPrompt({
      taskId: input.taskId,
      roundId: round.roundId,
      questions: questions.length ? questions : ['（上一轮提出的澄清问题）'],
      answer: input.answer
    });
    this.tasks.updateRound(round.roundId, { requestText: prompt });
    void this.driveRound(input.taskId, round.roundId, prompt).catch(error => this.fail(input.taskId, error));
  }

  async deleteTask(taskId: string) {
    const task = this.deps.store.getTask(taskId);
    if (task && !TERMINAL.includes(task.status)) throw new Error('只能删除已结束的任务');
    this.deps.store.deleteTask(taskId);
  }

  // -------------------------------------------------------------------------
  // Round driving
  // -------------------------------------------------------------------------

  private async driveRound(taskId: string, roundId: string, prompt: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task.status === 'cancelled' || task.status === 'failed') return;
    this.busy.add(taskId);

    try {
      const round = this.tasks.getRound(roundId);
      if (!round) throw new Error('轮次不存在');

      const answer = await this.withPage(async () => {
        // The wait for the page can be long; a task cancelled while queued must
        // not send anything when its turn comes.
        const queued = this.tasks.get(taskId);
        if (queued.status === 'cancelled' || queued.status === 'failed') throw new Error('WAIT_CANCELLED');

        const { snapshotBefore } = await this.deps.adapter.sendMessage(prompt, round.requestId);
        this.tasks.updateRound(roundId, { status: 'awaiting_answer' });
        return this.deps.adapter.waitForAnswer(
          round.requestId,
          snapshotBefore,
          this.tasks.get(taskId).timeoutMs,
          prompt
        );
      });
      this.tasks.updateRound(roundId, { status: 'answer_ready', answerText: answer, completedAt: Date.now() });
      this.deps.emit({ type: 'round.answer', at: Date.now(), taskId, roundId, text: answer });

      this.handleAnswer(taskId, roundId, answer);
    } finally {
      this.busy.delete(taskId);
    }
  }

  private handleAnswer(taskId: string, roundId: string, answer: string) {
    // The captured transcript can contain our own prompt, and the prompt
    // carries example protocol blocks with the real ids. Strip it before
    // parsing, or a clarification sample becomes a live clarification request
    // (and a completion sample would end the task).
    const echo = this.tasks.getRound(roundId)?.requestText;
    const result = parseAnswer(answer, { taskId, roundId }, { ignoreEcho: echo });

    if (result.kind === 'none') {
      this.tasks.updateRound(roundId, { status: 'plan_invalid' });
      this.deps.emit({ type: 'plan.invalid', at: Date.now(), taskId, roundId, error: '回答中没有找到 desktop-agent/v1 协议块' });
      throw new Error('回答中没有找到可执行计划，已停止自动执行');
    }

    if (result.kind === 'invalid') {
      this.tasks.updateRound(roundId, { status: 'plan_invalid' });
      this.deps.emit({ type: 'plan.invalid', at: Date.now(), taskId, roundId, error: result.error });
      throw new Error(`计划校验失败：${result.error}`);
    }

    if (result.kind === 'conflict') {
      this.tasks.updateRound(roundId, { status: 'plan_invalid' });
      const error = `回答中包含 ${result.blocks} 个互相冲突的协议消息，已拒绝执行`;
      this.deps.emit({ type: 'plan.invalid', at: Date.now(), taskId, roundId, error });
      throw new Error(error);
    }

    if (result.kind === 'clarification') {
      this.tasks.updateRound(roundId, { status: 'answer_ready', pendingQuestions: result.questions });
      // The task is now waiting on a person, not working. Saying so is what
      // keeps "需要澄清" and the status pill from contradicting each other.
      this.tasks.transition(taskId, 'awaiting_clarification');
      this.deps.emit({ type: 'clarification.required', at: Date.now(), taskId, roundId, questions: result.questions });
      return;
    }

    if (result.kind === 'complete') {
      const task = this.tasks.get(taskId);
      const pending = this.tasks
        .listRounds(taskId)
        .some(round => round.status === 'report_sent' || round.status === 'awaiting_answer');
      if (pending) {
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId,
          level: 'warn',
          message: 'DeepSeek 声明完成，但本地仍有未处理的轮次，拒绝标记完成'
        });
        throw new Error('本地状态与完成声明不一致，已停止并等待人工处理');
      }
      this.tasks.transition(taskId, 'completed', { summary: result.summary });
      this.deps.emit({ type: 'task.completed', at: Date.now(), taskId, summary: result.summary });
      return;
    }

    // result.kind === 'plan'
    const task = this.tasks.get(taskId);
    const plan = result.plan;

    if (task.status === 'planning') this.tasks.transition(taskId, 'plan_ready');
    const stored: StoredPlan = {
      planId: randomUUID(),
      taskId,
      roundId,
      plan,
      contentHash: hashPlan(plan),
      approvalStatus: 'pending',
      createdAt: Date.now()
    };
    this.deps.store.insertPlan(stored);
    this.tasks.updateRound(roundId, { status: 'plan_ready' });
    this.tasks.transition(taskId, 'awaiting_approval', { currentPlanId: stored.planId });
    this.deps.emit({ type: 'plan.ready', at: Date.now(), taskId, roundId, plan: toPreview(stored) });
  }

  private async continueAfterReport(taskId: string, report: ExecutionReport): Promise<void> {
    const task = this.tasks.get(taskId);
    const rounds = this.tasks.listRounds(taskId);

    if (rounds.length >= task.maxRounds) {
      this.tasks.transition(taskId, 'failed', { error: `达到最大轮数 ${task.maxRounds}，任务未完成` });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: `达到最大轮数 ${task.maxRounds}` });
      return;
    }

    this.tasks.transition(taskId, 'awaiting_next_round');
    this.tasks.transition(taskId, 'planning');

    const round = this.tasks.createRound({ taskId, inputType: 'execution_report', requestText: '' });
    const prompt = buildReportPrompt({ taskId, roundId: round.roundId, report });
    this.tasks.updateRound(round.roundId, { requestText: prompt, status: 'sending' });

    void this.driveRound(taskId, round.roundId, prompt).catch(error => this.fail(taskId, error));
  }

  // -------------------------------------------------------------------------

  private async resolveWorkspace(task: AgentTask): Promise<string> {
    if (!task.workspaceRoot) throw new Error('任务没有工作区，无法授权执行');
    const real = await fs.realpath(task.workspaceRoot);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error('工作区必须是目录');
    return real;
  }

  private fail(taskId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      const task = this.tasks.get(taskId);
      if (TERMINAL.includes(task.status)) return;
      this.tasks.transition(taskId, 'failed', { error: message });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: message });
    } catch {
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: message });
    }
  }
}

export function hashPlan(plan: AgentPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function toPreview(stored: StoredPlan): PlanPreview {
  return {
    planId: stored.planId,
    taskId: stored.taskId,
    roundId: stored.roundId,
    title: stored.plan.title,
    description: stored.plan.description,
    completion: stored.plan.completion.condition,
    steps: stored.plan.steps.map(step => ({
      id: step.id,
      tool: step.tool,
      description: step.description,
      args: step.args as Record<string, unknown>
    }))
  };
}
