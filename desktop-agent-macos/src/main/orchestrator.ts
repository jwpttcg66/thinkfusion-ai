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
import { approvalPolicyFor } from '../shared/approval';
import { checkPlanCapabilities, planDebateTopics, planReviewRounds, shouldDebatePlan } from './engineering/plan-review';
import { checkCodingBudget } from '../shared/coding-workflow';
import { verifyExecution, hasGenuineDelivery } from '../agent/verification';
import { verificationIsComplete } from '../shared/task-view';
import { AgentStore } from './store';
import { TaskManager, TERMINAL } from './task-manager';
import { ContextLimitError, type PlanningAdapter } from './adapters/browser/page-driver';
import { runPlan, decideStepApproval, answerStepQuestion, cancelPlan } from './agent-manager';
import { ensureTaskWorktree } from './task-worktree';

const GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * 一次提问的参与成员：第 0 个是主导，其余并行旁听。
 *
 * 为什么放在编排器而不是界面：旁听不是「界面多画一列」，它必须真的发出这次
 * 提问。只有编排器知道这一轮用了哪条 prompt、哪个 roundId、以及回答要不要送去
 * 解析计划。界面只读事件，不参与决定问谁。
 */
export interface PlannerMember {
  /** 成员 id，与事件里的 participantId 同源。 */
  id: string;
  label: string;
  adapter: PlanningAdapter;
}

export interface OrchestratorDeps {
  tasks: TaskManager;
  store: AgentStore;
  /** 每次取用时都重新解析：运行时切换规划源后，执行链路不能还连着旧页面。 */
  adapter: (taskId?: string) => PlanningAdapter;
  /**
   * 按成员 id 重建适配器。
   *
   * 进程重启后 `planningAdapters` 是空的，原来会直接退回网页 adapter：一个
   * 由本地/云端/CLI 主导的任务，执行完的报告会发给没登录的网页，然后整任务
   * 被记成失败。任务里存了 `debateAgentIds`，按它重建就不会换来源。
   */
  memberAdapter?: (memberId: string) => PlanningAdapter | null;
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
  review?: (report: ExecutionReport, plan: AgentPlan, task: AgentTask) => Promise<{
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
    debateAgentIds?: readonly string[];
  }) => Promise<{
    debateId?: string;
    status: 'completed' | 'stopped';
    participants: string[];
    summary: string;
    /** 实际跑了几轮、最多允许几轮、为什么结束；老调用方不给也不影响。 */
    rounds?: number;
    maxRounds?: number;
    roundsReason?: string;
  } | null>;
  /**
   * 审批时给外部 Agent 建独立工作树。默认实现是 main/task-worktree。
   * 测试可以注入一个只返回路径的假实现，不必真起 git。
   */
  worktree?: (input: { rootDir: string; taskId: string }) => Promise<{ dir: string; branch: string }>;
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
const PLANNING_TIMEOUT_MS = 120_000;

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

  private readonly planningAdapters = new Map<string, PlanningAdapter>();
  /**
   * 这一轮真正被问到的成员。只有一个成员时走原有单路，行为与升级前一致；
   * 两个以上才并行旁听，旁听的回答不进计划解析。
   */
  private readonly plannerMembers = new Map<string, PlannerMember[]>();
  /** 在途的旁听请求（`taskId:requestId`），取消时按它掐断。 */
  private readonly peerRequests = new Set<string>();
  private readonly debateAgents = new Map<string, readonly string[]>();

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
  private adapterFor(taskId?: string): PlanningAdapter {
    const cached = taskId ? this.planningAdapters.get(taskId) : undefined;
    if (cached) return cached;
    if (taskId) {
      const rebuilt = this.rebuildAdapter(taskId);
      if (rebuilt) {
        this.planningAdapters.set(taskId, rebuilt);
        return rebuilt;
      }
    }
    return this.deps.adapter(taskId);
  }

  /** 重启后按任务记录的成员重建；重建不出来才退回默认（网页）适配器。 */
  private rebuildAdapter(taskId: string): PlanningAdapter | null {
    if (!this.deps.memberAdapter) return null;
    let task: AgentTask;
    try {
      task = this.tasks.get(taskId);
    } catch {
      return null;
    }
    const memberId = task.debateAgentIds?.[0];
    if (!memberId) return null;
    try {
      return this.deps.memberAdapter(memberId);
    } catch {
      return null;
    }
  }

  /** Provider 不占网页队列；网页适配器仍然串行。 */
  private withPlanningSlot<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    return this.adapterFor(taskId).concurrent ? work() : this.withPage(work);
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
    expertise?: readonly string[];
    collaborationPlan?: string;
    /** 只允许这些模型参加方案评审；空表示沿用调用方候选。 */
    debateAgentIds?: readonly string[];
    /** 这次规划显式指定的适配器（云端/本地 Provider）；缺省走网页。 */
    planningAdapter?: PlanningAdapter;
    /**
     * V2.1：并行参与这一轮提问的成员，第 0 个是主导。
     *
     * 不传就退回 `planningAdapter` / 默认适配器的单路行为——所有既有调用方和
     * 测试都不受影响。传了就代表「这些模型真的都被问了一次」：主导的回答用于
     * 生成计划，其余成员的回答作为独立输出落事件，绝不混进计划文本。
     */
    planners?: readonly PlannerMember[];
  }): Promise<AgentTask> {
    const members = (input.planners ?? []).filter(member => member.id);
    const planner = members[0]?.adapter ?? input.planningAdapter ?? this.deps.adapter();
    const site = planner.siteLabel;
    const status = await planner.getStatus();
    if (!status.loggedIn) throw new Error(`${site} 未登录：${status.detail ?? '请先在内嵌页面登录'}`);
    if (!status.pageReady) throw new Error(`${site} 页面不可用：${status.detail ?? '未找到输入框'}`);
    if (status.generating) throw new Error(`${site} 正在生成上一条回答，请等待完成后再提交`);

    const task = this.tasks.create({
      prompt: input.prompt,
      permissionPreset: input.permissionPreset,
      workspaceRoot: input.workspaceRoot,
      planDebate: input.planDebate,
      ...(input.debateAgentIds && input.debateAgentIds.length > 0 ? { debateAgentIds: [...input.debateAgentIds] } : {})
    });
    this.tasks.transition(task.taskId, 'planning');
    this.planningAdapters.set(task.taskId, planner);
    // 单成员也记：成员卡片与「按模型统计」需要一个身份，不然主导这一路
    // 在界面上没有名字、统计里也没有它。
    const leadMember = members[0] ?? { id: `lead:${planner.siteLabel}`, label: planner.siteLabel, adapter: planner };
    this.plannerMembers.set(task.taskId, [leadMember, ...members.slice(1)]);
    if (input.debateAgentIds && input.debateAgentIds.length > 0) {
      this.debateAgents.set(task.taskId, input.debateAgentIds);
    }

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
      expertise: input.expertise,
      collaborationPlan: input.collaborationPlan,
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
      throw new Error(`计划已过期，请让 ${this.adapterFor(input.taskId).siteLabel} 重新生成`);
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
      // 完全权限下是 `off`——那一档已经等于「都允许」，再逐步问是重复确认。
      stepApproval: this.deps.stepApproval?.() ?? approvalPolicyFor(task.permissionPreset).stepApproval
    };

    const budgetViolations = checkCodingBudget(plan);
    if (budgetViolations.length > 0) {
      throw new Error(`计划超出编码预算：${budgetViolations.join('；')}`);
    }

    // 外部 CLI 自带工具循环，不能让它直接改主工作区：审批时先建独立
    // Worktree，把路径写进授权。取消/失败保留这棵树，合并是用户的下一个显式动作。
    if (plan.steps.some(step => step.tool === 'agent.exec')) {
      const worktree = await (this.deps.worktree ?? ensureTaskWorktree)({
        rootDir,
        taskId: task.taskId
      });
      grant.worktreeDir = worktree.dir;
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId: task.taskId,
        level: 'info',
        message: `外部 Agent 将在独立工作树中执行：${worktree.dir}（分支 ${worktree.branch}）。主工作区不会被直接修改；合并需要你确认。`
      });
    }

    this.deps.store.updatePlan(stored.planId, { approvalStatus: 'approved' });
    this.tasks.transition(task.taskId, 'executing', { workspaceRoot: rootDir });
    this.busy.add(task.taskId);

    let report: ExecutionReport;
    try {
      report = await runPlan(plan, grant, this.deps.dbPath(), this.planTimeout(task.timeoutMs, plan), {
        roundId: stored.roundId,
        planId: stored.planId,
        ...(task.conversationId ? { conversationId: task.conversationId } : {})
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 用户取消后，Runtime 的拒绝是预期结果：不能再从 cancelled 迁到 failed，
      // 否则取消操作会以「状态流转非法」的错误收场。
      if (this.tasks.get(task.taskId).status === 'cancelled') {
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId: task.taskId,
          level: 'warn',
          message: `执行已按用户取消结束：${message}`
        });
        return;
      }
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

    // 取消发生在执行过程中时，报告仍然要落库（轨迹与证据不能丢），但状态
    // 已经由 cancel() 置为 cancelled，不能再走 verifying / report_pending。
    if (TERMINAL.includes(this.tasks.get(task.taskId).status)) return;

    // 独立评审只读执行事实，不改任务状态；失败也不该把已经完成的执行作废。
    // 需要修复时只是给出结论：下一轮计划要不要人重新批准，由权限预设决定
    // （完全权限下自动执行，其余档位仍需点击）。
    let review: { reviewer: string; verdict: string; issues: string[]; needsFix: boolean } | null = null;
    if (this.deps.review) {
      try {
        const verdict = await this.deps.review(report, plan, task);
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

    if (report.verification && !verificationIsComplete(report.verification)) {
      const reason = report.verification.reasons.join('；') || '本轮未通过验证';
      const codeFiles = (report.verification as { changedPaths?: string[] }).changedPaths ?? [];
      const touchesCode = codeFiles.some(path => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rs)$/i.test(path));
      if (touchesCode) {
        // 完全权限下不能停在 VERIFYING：用户已经把审批权交出来了，任务应当
        // 自己进入下一轮修复，而不是让他点「接受未验证」。非完全权限仍停在
        // 这里，保留「补验证 / 接受缺口」的选择。
        const autoRepair = approvalPolicyFor(this.tasks.get(task.taskId).permissionPreset).autoApprovePlan;
        this.tasks.patch(task.taskId, {
          codingState: 'BLOCKED',
          error: autoRepair
            ? `未验证：${reason}。完全权限：自动进入下一轮修复。`
            : `未验证：${reason}。补一次会跑构建/测试的命令（或对输出做断言），或 code.diagnostics 后再继续；也可以直接确认收尾。`
        });
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId: task.taskId,
          level: 'warn',
          message: autoRepair
            ? `未验证：${reason}。完全权限：自动进入下一轮修复，不把未验证报告标完成。`
            : `编码工作流停在 VERIFYING：${reason}`
        });
        if (!autoRepair) return;
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

  /** 执行中提问的回答。校验同样在 agent-manager：它认不出这个 key 就明确报错。 */
  async answerQuestion(input: {
    taskId: string;
    stepId: string;
    answer?: string;
    cancelled?: boolean;
  }): Promise<void> {
    answerStepQuestion(input);
  }

  async acceptUnverified(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task.status !== 'report_pending') {
      throw new Error(`任务当前状态为 ${task.status}，没有待确认的交付`);
    }
    this.tasks.transition(taskId, 'completed', { summary: '执行完成（未验证，已确认接受）', error: undefined });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'warn',
      message: '你确认接受「未验证」：任务按完成收尾。验证缺口保留在报告里，不会被当成已验证。'
    });
    this.deps.emit({ type: 'task.completed', at: Date.now(), taskId, summary: '执行完成（未验证，已确认接受）' });
  }

  /**
   * 按当前环境继续修复一个停在 report_pending 的任务。
   *
   * 与 recheckVerification 不同：这里不猜结论，而是把报告交回模型，重新
   * 规划并执行。用于验证失败的原因是本机环境（例如 Go 缓存目录）而代码
   * 本身没问题的情况——用户点一下就能让任务自己跑完，而不是接受未验证。
   */
  async resumeRepair(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task.status !== 'report_pending') {
      throw new Error(`任务当前状态为 ${task.status}，没有待修复的交付`);
    }
    const report = this.deps.store.reportFor(taskId, task.currentPlanId ?? undefined);
    if (!report) throw new Error('没有找到这一轮的执行报告，无法继续修复');
    if (report.verification && verificationIsComplete(report.verification)) {
      throw new Error('这一轮已经完成全部检查，不需要继续修复');
    }
    this.deps.emit({
      type: 'log',
      at: Date.now(),
      taskId,
      level: 'warn',
      message: '按当前环境继续修复：重新规划并执行未通过的验证。'
    });
    await this.continueAfterReport(taskId, report, null);
  }

  /**
   * 用当前口径重新判定这一轮的验证结论。
   *
   * 存在的理由：验证口径本身会变（例如把 `shell.run` 里的 javac / mvn / 输出
   * 断言也算作证据）。口径改宽之后，早先被卡在 report_pending 的任务不该逼着
   * 用户点「接受未验证」——执行事实没变，只是判定该重算。重算只读已落库的
   * 报告，不会重新执行任何步骤。
   */
  async recheckVerification(taskId: string): Promise<{ verified: boolean; reasons: string[] }> {
    const task = this.tasks.get(taskId);
    if (task.status !== 'report_pending') {
      throw new Error(`任务当前状态为 ${task.status}，只有等待确认的交付可以重新判定`);
    }
    const report = this.deps.store.reportFor(taskId, task.currentPlanId ?? undefined);
    if (!report) throw new Error('没有找到这一轮的执行报告，无法重新判定');

    const verification = verifyExecution(report.results);
    const updated: ExecutionReport = { ...report, verification };
    this.deps.store.updateReport(updated);
    // 让界面重新读同一条报告（task-view 收到它只更新验证 / 改动 / 诊断，不追加时间线）。
    this.deps.emit({ type: 'report.ready', at: Date.now(), taskId, roundId: report.roundId, report: updated });

    if (!verification.verified) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'warn',
        message: `重新判定仍未通过：${verification.reasons.join('；') || '没有可用的检查证据'}`
      });
      return { verified: false, reasons: verification.reasons };
    }

    this.tasks.transition(taskId, 'completed', { summary: '执行完成，验证通过', error: undefined });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: '按当前口径重新判定：这一轮已有成功的构建 / 测试 / 运行断言，任务按完成收尾。'
    });
    this.deps.emit({ type: 'task.completed', at: Date.now(), taskId, summary: '执行完成，验证通过' });
    return { verified: true, reasons: verification.reasons };
  }

  /** 用户暂停：保留当前状态，恢复时回到暂停前状态。 */
  async pause(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (['completed', 'failed', 'cancelled', 'paused'].includes(task.status)) return;
    this.tasks.transition(taskId, 'paused', { resumeStatus: task.status });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: '任务已暂停；恢复会回到暂停前的状态，不会重复已完成的写入。'
    });
  }

  /**
   * 用户继续：
   * - paused：回到暂停前状态；
   * - interrupted/budget/blocked：开新一轮，先检查现有工作区，不自动重跑旧步骤。
   */
  async resume(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!['paused', 'interrupted', 'budget_exhausted', 'blocked'].includes(task.status)) {
      throw new Error(`任务当前状态为 ${task.status}，不能继续`);
    }
    if (task.status === 'paused' && task.resumeStatus) {
      this.tasks.transition(taskId, task.resumeStatus, { resumeStatus: undefined });
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'info',
        message: `任务已继续，回到 ${task.resumeStatus} 状态。`
      });
      return;
    }

    const rounds = this.tasks.listRounds(taskId);
    if (rounds.length >= task.maxRounds) {
      this.tasks.transition(taskId, 'failed', { error: `达到最大轮数 ${task.maxRounds}，无法继续`, resumeStatus: undefined });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: `达到最大轮数 ${task.maxRounds}` });
      return;
    }
    this.tasks.transition(taskId, 'planning', { resumeStatus: undefined });
    const round = this.tasks.createRound({ taskId, inputType: 'user_prompt', requestText: '' });
    const prompt = buildInitialPrompt({
      prompt: `${task.userPrompt}

继续上次任务：先检查现有工作区、执行报告与证据，确认哪些步骤已经完成；不要重复已完成的写操作。`,
      taskId,
      roundId: round.roundId,
      permissionPreset: task.permissionPreset,
      workspaceRoot: task.workspaceRoot ?? '(未指定工作区)',
      allowedTools: allowedToolsForPreset(task.permissionPreset),
      maxSteps: task.maxSteps
    });
    this.tasks.updateRound(round.roundId, { requestText: prompt });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: '任务已继续：开始新一轮，先检查现有结果，不自动重跑旧步骤。'
    });
    void this.driveRound(taskId, round.roundId, prompt).catch(error => this.fail(taskId, error));
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (TERMINAL.includes(task.status)) return;

    const round = task.currentRoundId ? this.tasks.getRound(task.currentRoundId) : null;
    if (round) this.adapterFor(taskId).cancelWait(round.requestId);
    this.cancelPeers(taskId);

    // 取消要传到 Runtime：否则它还在跑计划，外部 CLI 也还在改文件。
    cancelPlan(taskId);

    this.tasks.transition(taskId, 'cancelled', { error: '用户取消任务' });
    this.deps.emit({ type: 'task.cancelled', at: Date.now(), taskId });
  }

  /**
   * 一份计划的执行预算。
   *
   * CLI 任务的单步上限是 30 分钟，而普通任务的 180 秒是给本地工具准备的。
   * 这里只对含 agent.exec 的计划放宽，且不会超过授权本身的 30 分钟：
   * 真正的硬边界仍是 grant.expiresAt（`agent.exec` 自己会按剩余时间截断）。
   */
  private planTimeout(base: number, plan: AgentPlan): number {
    if (!plan.steps.some(step => step.tool === 'agent.exec')) return base;
    return Math.max(base, 31 * 60 * 1000);
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
    // 删除是用户的最终意图：运行中的任务先取消、停外部进程，再删除记录。
    // 不能因为“还没结束”把行留在列表里，那会让用户无法清掉卡住的任务。
    if (task && !TERMINAL.includes(task.status)) {
      await this.cancel(taskId);
    }
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

      // 超时从排队前开始计时：队列被旧请求占住时也必须能失败收敛。
      let timer: ReturnType<typeof setTimeout> | undefined;
      let answer: string;
      try {
        answer = await Promise.race([
          this.withPlanningSlot(taskId, async () => {
            const queued = this.tasks.get(taskId);
            if (queued.status === 'cancelled' || queued.status === 'failed') throw new Error('WAIT_CANCELLED');
            return this.askRound(taskId, roundId, prompt);
          }),
          new Promise<string>((_, reject) => {
            timer = setTimeout(() => {
              this.adapterFor(taskId).cancelWait(this.tasks.getRound(roundId)?.requestId ?? '');
              reject(new Error('模型规划超时（120 秒）：没有返回可解析的计划。请换模型或重试。'));
            }, PLANNING_TIMEOUT_MS);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      this.tasks.updateRound(roundId, { status: 'answer_ready', answerText: answer, completedAt: Date.now() });
      // 同一轮的答案要能对回是哪一次模型调用：streamId/modelCallId 都是这个 requestId。
      const answerCallId = this.tasks.getRound(roundId)?.requestId;
      // 主导成员也带上 participantId：工作台按成员分列时，主卡片不能没有名字。
      const leadMember = this.plannerMembers.get(taskId)?.[0];
      this.deps.emit({ type: 'round.answer', at: Date.now(), taskId, roundId, text: answer, ...(answerCallId ? { modelCallId: answerCallId } : {}), ...(leadMember ? { participantId: leadMember.id } : {}) });

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
  /**
   * 这一轮问一次，但可能是多个成员。
   *
   * 单成员时完全走 askPage（零行为变化）。多成员时并行发同一句 prompt：
   * 主导的回答用于生成计划，其余成员的回答只作为独立输出落事件。为什么不让
   * 旁听者回答也参与「合成计划」：那需要再一次模型调用、还会把不同成员的计划
   * 步骤搅成一份没人负责的混合体；V2.1 要的是「各自独立可查」，不是合并。
   */
  /**
   * 这份回答能不能当计划用。
   *
   * 只看协议层（有没有可解析的 desktop-agent/v1 块），不评价内容质量：
   * 内容由后续的计划校验与评审负责。这里多判一次，是为了在「主导答坏了、
   * 旁听答对了」时不必再花一轮修复。
   */
  private answerUsable(taskId: string, roundId: string, text: string): boolean {
    const echo = this.tasks.getRound(roundId)?.requestText;
    const result = parseAnswer(text, { taskId, roundId }, { ignoreEcho: echo });
    return result.kind !== 'none' && result.kind !== 'invalid' && result.kind !== 'conflict';
  }

  private async askRound(taskId: string, roundId: string, prompt: string): Promise<string> {
    const members = this.plannerMembers.get(taskId) ?? [];
    const [lead, ...peers] = members;
    if (!lead) return this.askPage(taskId, roundId, prompt);
    // 主导先报「开始」：无论有没有旁听，工作台都要有它这张卡片。
    this.deps.emit({
      type: 'round.peer',
      at: Date.now(),
      taskId,
      roundId,
      memberId: lead.id,
      label: lead.label,
      status: 'started',
      participantId: lead.id
    });
    if (peers.length === 0) return this.askPage(taskId, roundId, prompt, lead.id);
    return this.askWithPeers(taskId, roundId, prompt, lead, peers);
  }

  private async askWithPeers(
    taskId: string,
    roundId: string,
    prompt: string,
    lead: PlannerMember,
    peers: readonly PlannerMember[]
  ): Promise<string> {
    // 主导的「开始」已经在 askRound 里报过；这里只发旁听。
    // 旁听者与主导并行发；它们的回答不影响主线，失败也只落到自己卡片上。
    const peerRuns = peers.map(peer => this.askPeer(taskId, roundId, prompt, peer));
    const leadOutcome = this.askPage(taskId, roundId, prompt, lead.id).then(
      text => ({ ok: true as const, text }),
      (error: unknown) => ({ ok: false as const, error })
    );

    const leadResult = await leadOutcome;
    if (leadResult.ok) {
      if (this.answerUsable(taskId, roundId, leadResult.text)) return leadResult.text;
      // 主导答了，但答的东西不能当计划用（常见：模型返回缺字段的 JSON）。
      // 旁听者里只要有一份可用的，就用它——这正是「多模型并行」该有的价值，
      // 而不是把一份坏答案送去修复轮再花一次调用。换人要写明，不静默。
      for (const [index, run] of peerRuns.entries()) {
        const result = await run;
        if (!result.ok || !this.answerUsable(taskId, roundId, result.text)) continue;
        const label = peers[index]?.label ?? '旁听成员';
        this.deps.emit({
          type: 'round.peer',
          at: Date.now(),
          taskId,
          roundId,
          memberId: lead.id,
          label: lead.label,
          status: 'failed',
          error: `${lead.label} 的回答不能作为计划（缺少协议字段），本轮改用 ${label} 的回答`,
          participantId: lead.id
        });
        return result.text;
      }
      return leadResult.text;
    }

    // 主导失败：按完成顺序找第一个真的答出东西的旁听者，并把这件事说清楚。
    // 不静默换人——用户要能看出「计划来自 B，不是 A」。
    const leadError = leadResult.error instanceof Error ? leadResult.error.message : String(leadResult.error);
    let fallback: string | null = null;
    let fallbackLabel = '';
    for (const [index, run] of peerRuns.entries()) {
      const result = await run;
      if (result.ok && result.text.trim() && fallback === null) {
        fallback = result.text;
        fallbackLabel = peers[index]?.label ?? '其他成员';
        break;
      }
    }
    this.deps.emit({
      type: 'round.peer',
      at: Date.now(),
      taskId,
      roundId,
      memberId: lead.id,
      label: lead.label,
      status: 'failed',
      error: fallback === null
        ? leadError
        : `${lead.label} 没给出可用计划（${leadError}），本轮改用 ${fallbackLabel} 的回答`,
      participantId: lead.id
    });
    if (fallback !== null) return fallback;
    throw leadResult.error;
  }

  /**
   * 一个旁听成员的提问。失败只落在它自己的卡片上：限流、超时、没登录都不该
   * 让主导那条线停摆（V2.1 §10.1-4）。
   */
  private async askPeer(
    taskId: string,
    roundId: string,
    prompt: string,
    peer: PlannerMember
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    this.peerRequests.add(`${taskId}:${requestId}`);
    this.deps.emit({
      type: 'round.peer',
      at: startedAt,
      taskId,
      roundId,
      memberId: peer.id,
      label: peer.label,
      status: 'started',
      participantId: peer.id
    });
    try {
      const { snapshotBefore } = await peer.adapter.sendMessage(prompt, requestId, chunk => {
        this.deps.emit({
          type: 'round.delta',
          at: Date.now(),
          taskId,
          roundId,
          streamId: requestId,
          modelCallId: requestId,
          participantId: peer.id,
          ...(chunk.text ? { text: chunk.text } : {}),
          ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}),
          ...(chunk.reset ? { reset: true } : {}),
          ...(chunk.mode ? { mode: chunk.mode } : {}),
          ...(chunk.providerId ? { providerId: chunk.providerId } : {}),
          ...(chunk.modelId ? { modelId: chunk.modelId } : {})
        });
      });
      const text = await peer.adapter.waitForAnswer(
        requestId,
        snapshotBefore,
        this.tasks.get(taskId).timeoutMs,
        prompt
      );
      this.deps.emit({
        type: 'round.peer',
        at: Date.now(),
        taskId,
        roundId,
        memberId: peer.id,
        label: peer.label,
        status: 'answered',
        text,
        durationMs: Date.now() - startedAt,
        participantId: peer.id
      });
      return { ok: true, text };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const cancelled = this.tasks.get(taskId).status === 'cancelled';
      this.deps.emit({
        type: 'round.peer',
        at: Date.now(),
        taskId,
        roundId,
        memberId: peer.id,
        label: peer.label,
        status: cancelled ? 'cancelled' : 'failed',
        error: detail,
        durationMs: Date.now() - startedAt,
        participantId: peer.id
      });
      return { ok: false, text: '', error: detail };
    } finally {
      this.peerRequests.delete(`${taskId}:${requestId}`);
    }
  }

  /** 取消时连旁听成员一起掐断；它们的 adapter 各自有自己的 AbortController。 */
  private cancelPeers(taskId: string): void {
    const members = this.plannerMembers.get(taskId) ?? [];
    for (const peer of members.slice(1)) {
      for (const key of [...this.peerRequests]) {
        if (!key.startsWith(`${taskId}:`)) continue;
        peer.adapter.cancelWait(key.slice(taskId.length + 1));
      }
    }
  }

  private async askPage(taskId: string, roundId: string, prompt: string, participantId?: string): Promise<string> {
    const attempt = async (requestId: string) => {
      const { snapshotBefore } = await this.adapterFor(taskId).sendMessage(prompt, requestId, chunk => {
        this.deps.emit({ type: 'round.delta', at: Date.now(), taskId, roundId, streamId: requestId, modelCallId: requestId, ...(participantId ? { participantId } : {}), ...(chunk.text ? { text: chunk.text } : {}), ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}), ...(chunk.reset ? { reset: true } : {}), ...(chunk.mode ? { mode: chunk.mode } : {}), ...(chunk.providerId ? { providerId: chunk.providerId } : {}), ...(chunk.modelId ? { modelId: chunk.modelId } : {}) });
      });
      this.tasks.updateRound(roundId, { status: 'awaiting_answer' });
      return this.adapterFor(taskId).waitForAnswer(
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

      const reset = await this.adapterFor(taskId).newConversation();
      if (!reset.ok) {
        throw new Error(
          `${this.adapterFor(taskId).siteLabel} 这条会话的上下文已满，自动开新会话也没成功（${reset.detail ?? '原因未知'}）。` +
            '在右侧页面点一次「新对话」，再重新提交。'
        );
      }
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: `${this.adapterFor(taskId).siteLabel} 这条会话的上下文已满，已自动开新会话后重问`
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
          message: `${this.adapterFor(taskId).siteLabel} 声明完成，但本地仍有未处理的轮次，拒绝标记完成`
        });
        throw new Error('本地状态与完成声明不一致，已停止并等待人工处理');
      }
      // 空轮假完成闸门：有执行报告历史、但从没真写过文件并通过验证的任务，
      // 模型一句「任务完成」不能交付。没有报告历史（纯问答）照旧允许完成。
      const reports = this.deps.store.allReportsFor(taskId);
      if (reports.length > 0 && !hasGenuineDelivery(reports)) {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: '模型声明完成，但整条执行链没有一次成功写入并通过验证；拒绝标记完成，改为继续修复'
        });
        if (this.repairPlan(taskId, '任务尚未真实交付：没有成功写入并验证过的文件，请给出能真正落盘并验证的计划')) return;
        this.tasks.transition(taskId, 'failed', { error: '任务没有真实交付：没有成功写入并验证过的文件' });
        this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: '任务没有真实交付' });
        return;
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
    const gate = checkPlanCapabilities(stored.plan);
    this.deps.emit({
      type: 'plan.ready', at: Date.now(), taskId, roundId,
      plan: toPreview(stored, gate.missing)
    });
    // 计划选中了这些工具，但一个都还没执行；界面必须能区分“准备”与“开始”。
    // 计划由主导成员产出，所以这些步骤的「发起者」就是它。带上 participantId，
    // 工作台才能在轨迹里回答「这个工具是哪个模型发起的」。
    const planOwner = this.plannerMembers.get(taskId)?.[0]?.id;
    for (const step of stored.plan.steps) {
      this.deps.emit({
        type: 'step.preparing', at: Date.now(), taskId, roundId,
        ...(planOwner ? { participantId: planOwner } : {}),
        stepId: step.id, callId: step.id, tool: step.tool, args: step.args as Record<string, unknown>
      });
    }

    const debate = await this.reviewPlanWithDebate(taskId, roundId, stored);
    this.tasks.transition(taskId, 'awaiting_approval', { currentPlanId: stored.planId });
    if (debate) {
      this.deps.emit({
        type: 'plan.debated', at: debate.at, taskId, roundId, planId: stored.planId, debate
      });
    }

    // 完全权限就不再要人点两次：计划审批与逐步骤审批问的都是「这台机器允许
    // 做这些吗」，而这一档已经回答过了。评审仍然跑（那是质量问题，不是权限
    // 问题）；评审结束就开工，并留一条事件说明这是自动的，不是漏了审批。
    if (approvalPolicyFor(task.permissionPreset).autoApprovePlan) {
      this.autoApprovePlan(taskId, roundId, stored.planId);
    }
  }

  /**
   * 完全权限下的自动批准。
   *
   * 不 await：`approve()` 会一路跑到执行、验证、报告结束，把它挂在计划轮的
   * 收尾上会让 `driveRound` 的 Promise 拖住整条链；失败了也不能让计划轮跟着
   * 失败——计划本身是好的，只是自动批准没成（例如过期），此时留着可点的
   * 审批按钮让人接手，比把任务判死有用。
   */
  private autoApprovePlan(taskId: string, roundId: string, planId: string): void {
    setImmediate(() => {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'info',
        message: '完全权限：计划已自动批准并开始执行，步骤不再逐次询问。'
      });
      void this.approve({ taskId, roundId, planId, approved: true }).catch(error => {
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `自动批准没有成功：${detail}。计划仍可手动确认后执行。`
        });
      });
    });
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
    // 轮次由计划规模决定；在评审开始前就给界面一个明确依据，别让人等完
    // 三分钟才知道为什么是两轮。
    const plannedRounds = planReviewRounds(stored.plan, task.debateAgentIds?.length ?? 1);
    const startedAt = Date.now();
    const emitProgress = (state: 'started' | 'waiting' | 'done', message: string) => {
      this.deps.emit({
        type: 'plan.review.progress', at: Date.now(), taskId, roundId,
        planId: stored.planId, state, topics: topics.length, topicTexts: topics,
        ...(decision.reason ? { reason: decision.reason } : {}),
        maxRounds: plannedRounds.rounds,
        roundsReason: plannedRounds.reason,
        elapsedMs: Date.now() - startedAt, message
      });
    };
    // 最长 300 秒（3 轮评审）的等待不能只有开头一句 log：每 10 秒一次心跳，界面才有
    // 「还在跑」的证据。心跳不是审批信号，审批仍只在辩论真正结束后发生。
    emitProgress('started', `方案评审开始：${topics.length} 个议题，成员逐个给出意见`);
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      emitProgress('waiting', `方案评审进行中，已等待 ${String(seconds)} 秒`);
    }, 10_000);
    try {
      const task = this.tasks.get(taskId);
      const result = await this.deps.debatePlan({
        taskId, roundId, planId: stored.planId, plan: stored.plan, topics,
        ...(task.debateAgentIds && task.debateAgentIds.length > 0 ? { debateAgentIds: task.debateAgentIds } : {})
      });
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
        // 轮次与理由要一起进 plan.debated：审批的人看到「3 轮」才知道
        // 这场评审有回应轮；丢了字段，界面只能显示结论，解释不了为什么这次
        // 比上次慢。
        ...(typeof result.rounds === 'number' ? { rounds: result.rounds } : {}),
        ...(typeof result.maxRounds === 'number' ? { maxRounds: result.maxRounds } : {}),
        ...(result.roundsReason ? { roundsReason: result.roundsReason } : {}),
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
    } finally {
      clearInterval(heartbeat);
      emitProgress('done', '方案评审等待结束');
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

    // 执行报告已经完成、没有可执行评审问题：直接交付，不再无意义地
    // 让模型生成下一轮计划。以前这里无条件再规划，成功的任务也会被
    // 后续非法计划拖成 failed。
    const commandTestsPassed = report.results.some(item => {
      const result = item.result as { command?: unknown; exitCode?: unknown } | null;
      return typeof result?.command === 'string' &&
        /(?:^|\s)(?:npm\s+test|node\s+--test|mvn\s+(?:-B\s+)?test|pytest|go\s+test)/.test(result.command) &&
        result.exitCode === 0;
    });
    const testsPassed = report.verification?.checks?.tests.status === 'passed' || commandTestsPassed;
    // 验证未通过时，即使报告自报 completed / nextAction=complete，也不能
    // 直接收尾。完全权限下会走到这里进入下一轮修复；这是「全部完成后才
    // 算好」的底线，不能因为报告文字写完成就跳过。
    if (report.status === 'completed' &&
        (!report.verification || verificationIsComplete(report.verification)) &&
        (report.nextAction === 'complete' || testsPassed)) {
      // 空轮假完成闸门：报告自报 completed 不等于真交付。整条链从没成功写过
      // 文件并通过验证（例如只跑了 fs.list/fs.tree 的空轮），不能标完成。
      if (!hasGenuineDelivery([...this.deps.store.allReportsFor(taskId), report])) {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: '报告声明完成，但整条执行链没有一次成功写入并通过验证；拒绝标记完成'
        });
        this.tasks.transition(taskId, 'failed', { error: '任务没有真实交付：没有成功写入并验证过的文件' });
        this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: '任务没有真实交付' });
        return;
      }
      this.tasks.transition(taskId, 'completed', { summary: report.errors.length === 0 ? '执行完成，验证通过' : '执行完成' });
      this.deps.emit({ type: 'task.completed', at: Date.now(), taskId, summary: '执行完成，验证通过' });
      return;
    }

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
      // 下一轮要不要人点，由权限预设决定：完全权限下说「仍需重新批准」是错的，
      // 那一档的计划会自动执行。
      const needsClick = !approvalPolicyFor(this.tasks.get(taskId).permissionPreset).autoApprovePlan;
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: review.needsFix ? 'warn' : 'info',
        message: `修复任务：${review.reviewer} 指出 ${review.issues.length} 项问题，已并入下一轮计划请求${needsClick ? '（仍需你重新批准）' : '（完全权限：下一轮计划会自动执行）'}`
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
    // 失败或超时后旁听者不能继续占着页面：它们的结果已经没有主线可回。
    try { this.cancelPeers(taskId); } catch { /* 取消失败不影响失败收敛 */ }
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

export function toPreview(stored: StoredPlan, warnings: string[] = []): PlanPreview {
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
    })),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}
