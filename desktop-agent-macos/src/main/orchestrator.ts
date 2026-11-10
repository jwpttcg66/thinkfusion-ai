import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  AgentEvent,
  AgentPlan,
  AgentTask,
  ApprovePlanInput,
  ExecutionReport,
  PermissionPreset,
  PlanDebate,
  PlanPreview,
  StepApprovalMode,
  StoredPlan,
  TaskGrant
} from '../shared/contracts';
import { allowedToolsForPreset, buildClarificationAnswerPrompt, buildInitialPrompt, buildPlanRepairPrompt, buildReportPrompt, parseAnswer } from '../shared/protocol';
import { READ_ONLY_TOOLS } from '../shared/contracts';
import { planDebateTopics, shouldDebatePlan } from './engineering/plan-review';
import { AgentStore } from './store';
import { TaskManager, TERMINAL } from './task-manager';
import { ChatPageDriver, ContextLimitError } from './adapters/browser/page-driver';
import { runPlan, decideStepApproval } from './agent-manager';

const GRANT_TTL_MS = 30 * 60 * 1000;

export interface OrchestratorDeps {
  tasks: TaskManager;
  store: AgentStore;
  /** 每次取用时都重新解析：运行时切换规划源后，执行链路不能还连着旧页面。 */
  adapter: () => ChatPageDriver;
  emit: (event: AgentEvent) => void;
  dbPath: () => string;
  /**
   * 执行报告落库后的旁路。用于把逐步结果接进会话轨迹；不传时行为不变。
   */
  onReport?: (task: AgentTask, report: ExecutionReport) => void;
  /**
   * V2.1：执行后的独立 Review。可选——现有测试与「只跑 Runtime」的场景
   * 不提供它时，整条执行链路和以前一模一样。
   */
  review?: (report: ExecutionReport, plan: AgentPlan) => Promise<{
    reviewer: string;
    backend: 'model' | 'rules';
    verdict: string;
    issues: string[];
    needsFix: boolean;
    at: number;
  }>;
  /**
   * 逐次审批的粒度。不传时按 `mutating`（只问有副作用的步骤）。
   *
   * 为什么默认不是 `every`：一个八步的批量改造会弹八次，用户第三次之后就开始
   * 无脑点批准——那比只问关键几步更不安全。要最严的语义就传 `() => 'every'`。
   */
  stepApproval?: () => StepApprovalMode;
  /**
   * V2.1 D-03：计划生成之后、审批之前，对这份方案开一场辩论。
   *
   * 不传表示没有接入辩论能力——那时计划照旧直接进审批，行为与升级前一致。
   * 返回 `null` 表示没有可用成员，编排器会如实记下「没辩成」而不是假装辩过。
   */
  debatePlan?: (input: {
    taskId: string;
    roundId: string;
    planId: string;
    plan: AgentPlan;
    topics: string[];
  }) => Promise<{
    debateId?: string;
    status: 'completed' | 'stopped';
    participants: string[];
    summary: string;
  } | null>;
}

/**
 * Drives the closed loop: prompt -> chat page -> plan -> approval -> runtime ->
 * report -> chat page -> ... until complete, cancelled, or a limit is hit.
 *
 * Which site that page is belongs to `ChatPageDriver.siteLabel`, not to this
 * class: the loop is the same for every provider, and a message that names one
 * of them is wrong the moment a second one is switched on.
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

  /**
   * 规划页面按需取，不在构造时锁死。
   *
   * 规划源可以在设置里切换；如果这里缓存了构造那一刻的适配器，切换后界面显示
   * 已经换了，真正发问题的却还是旧页面——DeepSeek 掉登录时，整个工程执行会
   * 一直报「DeepSeek 未登录」，而用户看到的规划源是 ChatGPT。
   */
  private get adapter() {
    return this.deps.adapter();
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

  async submit(input: {
    prompt: string;
    permissionPreset: PermissionPreset;
    workspaceRoot?: string;
    /** V2.1 D-03：这份计划要不要先做方案评审辩论（默认 auto）。 */
    planDebate?: 'auto' | 'on' | 'off';
  }): Promise<AgentTask> {
    const site = this.adapter.siteLabel;
    const status = await this.adapter.getStatus();
    if (!status.loggedIn) throw new Error(`${site} 未登录：${status.detail ?? '请先在内嵌页面登录'}`);
    if (!status.pageReady) throw new Error(`${site} 页面不可用：${status.detail ?? '未找到输入框'}`);
    if (status.generating) throw new Error(`${site} 正在生成上一条回答，请等待完成后再提交`);

    const task = this.tasks.create({
      prompt: input.prompt,
      permissionPreset: input.permissionPreset,
      workspaceRoot: input.workspaceRoot,
      planDebate: input.planDebate
    });
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
      throw new Error(`计划已过期，请让 ${this.adapter.siteLabel} 重新生成`);
    }

    const rootDir = await this.resolveWorkspace(task);
    const plan = stored.plan;

    if (task.permissionPreset === 'read-only') {
      // 以前这里写死「只允许 fs.list / fs.readFile」，把 fs.tree / fs.search
      // 也当成写入拒绝了——只读权限下连看结构都做不到。判据必须和 Runtime
      // 用同一份清单，否则界面允许的、执行时又拒绝，用户只会看到一条假报错。
      const writes = plan.steps.filter(step => !(READ_ONLY_TOOLS as readonly string[]).includes(step.tool));
      if (writes.length > 0) throw new Error('计划包含写入或系统操作，但当前权限为「仅可查看」');
    }

    const grant: TaskGrant = {
      taskId: task.taskId,
      permissionPreset: task.permissionPreset,
      approvalPolicy: 'ask',
      rootDir,
      allowedTools: [...new Set(plan.steps.map(step => step.tool))],
      expiresAt: Date.now() + GRANT_TTL_MS,
      maxSteps: Math.min(plan.steps.length, task.maxSteps),
      grantVersion: 1,
      // 审批粒度随授权一起下发：Runtime 只认凭据里的值，界面改不了执行中的计划。
      stepApproval: this.deps.stepApproval?.() ?? 'mutating'
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
    try {
      this.deps.onReport?.(task, report);
    } catch {
      // 轨迹是旁路：记录失败不能让已经完成的执行看起来失败。
    }

    // 独立评审只读执行事实，不改任务状态；失败也不该把已经完成的执行作废。
    // 需要修复时只是给出结论，下一轮计划仍要用户重新批准。
    let review: { reviewer: string; verdict: string; issues: string[]; needsFix: boolean } | null = null;
    if (this.deps.review) {
      try {
        const verdict = await this.deps.review(report, plan);
        review = {
          reviewer: verdict.reviewer,
          verdict: verdict.verdict,
          issues: verdict.issues,
          needsFix: verdict.needsFix
        };
        this.deps.emit({
          type: 'review.ready', at: verdict.at, taskId: task.taskId, roundId: stored.roundId,
          reviewer: verdict.reviewer, backend: verdict.backend, verdict: verdict.verdict,
          issues: verdict.issues, needsFix: verdict.needsFix
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.emit({ type: 'log', at: Date.now(), taskId: task.taskId, level: 'warn', message: `独立评审没有完成：${detail}` });
      }
    }

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

    await this.continueAfterReport(task.taskId, report, review);
  }

  async reject(input: { taskId: string; planId: string; reason?: string }): Promise<void> {
    const task = this.tasks.get(input.taskId);
    if (task.status !== 'awaiting_approval') throw new Error(`任务当前状态为 ${task.status}，无法拒绝计划`);
    this.deps.store.updatePlan(input.planId, { approvalStatus: 'rejected' });
    this.tasks.transition(input.taskId, 'cancelled', { error: input.reason ?? '用户拒绝执行计划' });
    this.deps.emit({ type: 'task.cancelled', at: Date.now(), taskId: input.taskId });
  }

  /**
   * 逐次审批的两个入口。
   *
   * 这里不校验任务状态是刻意的：等待点在 Runtime 里，主进程只知道「某一步在
   * 等答复」。真校验放在 `decideStepApproval`——它认不出这个 (taskId, stepId)
   * 就明确报错，界面因此不会把「批准晚了」显示成「已经放行」。
   */
  async approveStep(input: { taskId: string; stepId: string; remember?: boolean }): Promise<void> {
    decideStepApproval({ ...input, approved: true });
  }

  async rejectStep(input: { taskId: string; stepId: string; reason?: string }): Promise<void> {
    decideStepApproval({ ...input, approved: false, reason: input.reason ?? '用户拒绝执行这一步' });
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (TERMINAL.includes(task.status)) return;

    const round = task.currentRoundId ? this.tasks.getRound(task.currentRoundId) : null;
    if (round) this.adapter.cancelWait(round.requestId);

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
      answer: input.answer,
      permissionPreset: this.tasks.get(input.taskId).permissionPreset,
      allowedTools: allowedToolsForPreset(this.tasks.get(input.taskId).permissionPreset)
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

        return this.askPage(taskId, roundId, prompt);
      });
      this.tasks.updateRound(roundId, { status: 'answer_ready', answerText: answer, completedAt: Date.now() });
      this.deps.emit({ type: 'round.answer', at: Date.now(), taskId, roundId, text: answer });

      await this.handleAnswer(taskId, roundId, answer);
    } finally {
      this.busy.delete(taskId);
    }
  }

  /**
   * 把一问发出去并等回答；会话装不下时换一条会话重问一次。
   *
   * 为什么要在这里恢复：网页通道那条路（PageAdapter.ask）早就做了这件事，
   * 但工程执行走的是编排器，直接调 driver 的 `sendMessage`——于是同一个
   * 「上下文已满」在两条路上有两种下场：问答能自己换会话继续，任务却在
   * 发送的第一步就失败，用户看到的是「ChatGPT 这条会话的上下文已满」，
   * 而他刚刚才开过新会话。
   *
   * 只重试一次：第二次还满就是真的满了（或站点不让开新会话），如实失败，
   * 不要在这里循环重开把页面刷爆。
   */
  private async askPage(taskId: string, roundId: string, prompt: string): Promise<string> {
    const attempt = async (requestId: string) => {
      const { snapshotBefore } = await this.adapter.sendMessage(prompt, requestId);
      this.tasks.updateRound(roundId, { status: 'awaiting_answer' });
      return this.adapter.waitForAnswer(
        requestId,
        snapshotBefore,
        this.tasks.get(taskId).timeoutMs,
        prompt
      );
    };

    const current = this.tasks.getRound(roundId)?.requestId;
    const first = typeof current === 'string' && current ? current : randomUUID();
    try {
      return await attempt(first);
    } catch (error) {
      if (!(error instanceof ContextLimitError)) throw error;

      const reset = await this.adapter.newConversation();
      if (!reset.ok) {
        throw new Error(
          `${this.adapter.siteLabel} 这条会话的上下文已满，自动开新会话也没成功（${reset.detail ?? '原因未知'}）。` +
            '在右侧页面点一次「新对话」，再重新提交。'
        );
      }
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: `${this.adapter.siteLabel} 这条会话的上下文已满，已自动开新会话后重问`
      });
      // 换一条新 requestId：上一问即使没发出去，也可能已经在页面侧留下了
      // 一个等待句柄，复用同一个 id 会让「这一问的回答」和上一问撞在一起。
      const retried = randomUUID();
      this.tasks.updateRound(roundId, { requestId: retried });
      return attempt(retried);
    }
  }

  private async handleAnswer(taskId: string, roundId: string, answer: string) {
    // The captured transcript can contain our own prompt, and the prompt
    // carries example protocol blocks with the real ids. Strip it before
    // parsing, or a clarification sample becomes a live clarification request
    // (and a completion sample would end the task).
    const echo = this.tasks.getRound(roundId)?.requestText;
    const result = parseAnswer(answer, { taskId, roundId }, { ignoreEcho: echo });

    if (result.kind === 'none') {
      this.tasks.updateRound(roundId, { status: 'plan_invalid' });
      const error = '回答中没有找到 desktop-agent/v1 协议块';
      this.deps.emit({ type: 'plan.invalid', at: Date.now(), taskId, roundId, error });
      if (this.repairPlan(taskId, error)) return;
      throw new Error('回答中没有找到可执行计划，已停止自动执行');
    }

    if (result.kind === 'invalid') {
      this.tasks.updateRound(roundId, { status: 'plan_invalid' });
      this.deps.emit({ type: 'plan.invalid', at: Date.now(), taskId, roundId, error: result.error });
      if (this.repairPlan(taskId, result.error)) return;
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
          message: `${this.adapter.siteLabel} 声明完成，但本地仍有未处理的轮次，拒绝标记完成`
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
    // 这一份计划是哪一份：辩论期间也要能回答，所以现在就记，不等审批。
    this.tasks.patch(taskId, { currentPlanId: stored.planId });
    // 计划卡片先给出去：方案评审辩论可能要跑几分钟，让审批的人对着空白等
    // 不是产品行为。此时状态是 plan_ready 而不是 awaiting_approval，审批会
    // 被明确拒绝——「还在评审」和「可以批准了」不能长得一样。
    this.deps.emit({ type: 'plan.ready', at: Date.now(), taskId, roundId, plan: toPreview(stored) });

    const debate = await this.reviewPlanWithDebate(taskId, roundId, stored);
    this.tasks.transition(taskId, 'awaiting_approval', { currentPlanId: stored.planId });
    if (debate) {
      this.deps.emit({
        type: 'plan.debated', at: debate.at, taskId, roundId, planId: stored.planId, debate
      });
    }
  }

  /**
   * 方案评审辩论（V2.1 D-03）。
   *
   * 没辩成也必须留下一条可读的记录：「关闭了辩论」「计划太小」「没有可用成员」
   * 是三种不同的情况，审批的人需要知道自己看到的是一个没有被评审过的计划。
   */
  private async reviewPlanWithDebate(
    taskId: string,
    roundId: string,
    stored: StoredPlan
  ): Promise<PlanDebate | null> {
    const task = this.tasks.get(taskId);
    const decision = shouldDebatePlan(task.planDebate, stored.plan);
    if (!decision.debate) {
      if (!this.deps.debatePlan) return null;
      return { status: 'skipped', topics: [], participants: [], summary: '', skippedReason: decision.reason, at: Date.now() };
    }
    if (!this.deps.debatePlan) {
      return {
        status: 'skipped', topics: [], participants: [], summary: '',
        skippedReason: '这次运行没有接入辩论能力，计划未经评审', at: Date.now()
      };
    }

    const topics = planDebateTopics(stored.plan);
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: `方案评审：就「${topics[0].slice(0, 40)}…」等 ${topics.length} 个议题开辩`
    });
    try {
      const result = await this.deps.debatePlan({ taskId, roundId, planId: stored.planId, plan: stored.plan, topics });
      if (!result) {
        return {
          status: 'skipped', topics, participants: [], summary: '',
          skippedReason: '辩论没有可用成员，计划未经评审', at: Date.now()
        };
      }
      return {
        status: result.status,
        debateId: result.debateId,
        topics,
        participants: result.participants,
        summary: result.summary,
        at: Date.now()
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'warn',
        message: `方案评审辩论没有完成：${detail}；计划仍可审批，但要知道它没被辩过`
      });
      return {
        status: 'skipped', topics, participants: [], summary: '',
        skippedReason: `辩论失败：${detail}`, at: Date.now()
      };
    }
  }

  /**
   * 计划没通过校验时，让模型自己改一轮（最多两次）。
   *
   * 一个占位符不该让整个任务死掉：模型不知道自己错在哪，用户看到的是一串
   * zod 路径。把失败原因原样交回去，它通常一次就能改对（真机验证过）。
   * 两次还不行才失败——无限重试等于把页面当成免费算力。
   */
  private repairPlan(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (TERMINAL.includes(task.status)) return false;
    const attempts = this.tasks.listRounds(taskId).filter(round => round.inputType === 'plan_repair').length;
    if (attempts >= 2) return false;
    if (this.tasks.listRounds(taskId).length >= task.maxRounds) return false;

    this.tasks.transition(taskId, 'planning');
    const round = this.tasks.createRound({ taskId, inputType: 'plan_repair', requestText: '' });
    const prompt = buildPlanRepairPrompt({
      taskId,
      roundId: round.roundId,
      error,
      userPrompt: task.userPrompt,
      permissionPreset: task.permissionPreset,
      allowedTools: allowedToolsForPreset(task.permissionPreset)
    });
    this.tasks.updateRound(round.roundId, { requestText: prompt, status: 'sending' });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'warn',
      message: `计划没通过校验（${error.slice(0, 120)}），已让模型修正后重出（第 ${attempts + 1}/2 次）`
    });
    void this.driveRound(taskId, round.roundId, prompt).catch(next => this.fail(taskId, next));
    return true;
  }

  private async continueAfterReport(
    taskId: string,
    report: ExecutionReport,
    review: { reviewer: string; verdict: string; issues: string[]; needsFix: boolean } | null = null
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    const rounds = this.tasks.listRounds(taskId);

    if (rounds.length >= task.maxRounds) {
      this.tasks.transition(taskId, 'failed', { error: `达到最大轮数 ${task.maxRounds}，任务未完成` });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: `达到最大轮数 ${task.maxRounds}` });
      return;
    }

    this.tasks.transition(taskId, 'awaiting_next_round');
    this.tasks.transition(taskId, 'planning');

    // 修复任务：评审指出的问题必须进到下一轮计划请求里，否则「修复」只是把
    // 同一个计划重新生成一遍。这里显式记一条，界面上能看出这一轮是修什么。
    if (review && review.issues.length > 0) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: review.needsFix ? 'warn' : 'info',
        message: `修复任务：${review.reviewer} 指出 ${review.issues.length} 项问题，已并入下一轮计划请求（仍需你重新批准）`
      });
    }

    const round = this.tasks.createRound({ taskId, inputType: 'execution_report', requestText: '' });
    const prompt = buildReportPrompt({ taskId, roundId: round.roundId, report, review });
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
