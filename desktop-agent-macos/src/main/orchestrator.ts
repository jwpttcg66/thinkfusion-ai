import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEvent,
  AgentPlan,
  AgentTask,
  ApprovePlanInput,
  ExecutionReport,
  PermissionPreset,
  PlanDebate,
  PlanPreview,
  OrphanCleanup,
  StepApprovalMode,
  StoredPlan,
  TaskCleanup,
  TaskGrant
} from '../shared/contracts';
import type { ContextHistoryItem, ContextManager, SideEffectLedger } from '../shared/context';
import { scopeHistory } from './context/entry-policy';
import { recoveryPromptData, type TaskRecoveryResult } from './context/recovery/task-recovery';
import {
  decideContinuation,
  mergeReusedResults,
  type CompletedStep,
  type ContinuationPlan,
  type ReusedStepInput
} from './context/recovery/continuation';
import type { PauseCheckpointOutcome } from './context/checkpoint/pause';
import { collectReportedAndInFlightSideEffects, reconcileSideEffects } from './context/recovery/side-effects';
import { allowedToolsForPreset, buildClarificationAnswerPrompt, buildInitialPrompt, buildPlanRepairPrompt, buildReportPrompt, parseAnswer } from '../shared/protocol';
import { READ_ONLY_TOOLS, TOOL_NAMES } from '../shared/contracts';
import type { WorkflowDefinition } from '../shared/workflow';
import { validateWorkflow, workflowToPlan } from '../shared/workflow';
import { findWorkflow, selectWorkflow } from '../shared/workflow-registry';
import { buildResumeVersionChainInput, checkVersionChain, versionConsistencyPrompt } from '../shared/version-consistency';
import { approvalPolicyFor, planApprovalGate } from '../shared/approval';
import {
  assessCollaborationRisk,
  checkPlanCapabilities,
  planReviewRounds,
  shouldDebatePlan
} from './engineering/plan-review';
import { checkCodingBudget } from '../shared/coding-workflow';
import { collectDiffStats, withDiffStats } from './engineering/diff-stats';
import { verifyExecution, hasGenuineDelivery } from '../agent/verification';
import { verificationIsComplete } from '../shared/task-view';
import {
  planGoalRevision,
  projectGoalDrivenWorkbench,
  revisionBaselineCriteria
} from '../shared/goal-driven-cycle';
import { createGoalCriterion, type GoalContract } from '../shared/goal-contract';
import { resolveGoalEntity, tasksUnderGoal } from '../shared/goal-entity';
import { legacyGoalFitEvent } from '../shared/goal-compat';
import {
  assessReportsAgainstGoal,
  goalContractFromPlan
} from './engineering/goal-contract-runtime';
import type { CycleDecisionInput, CycleDecisionResult, CycleNoProgressLimits, CycleProgress, GceCycleStage } from '../shared/cycle-decision';
import {
  cycleFingerprint,
  cycleNoProgressLimits,
  CYCLE_NO_PROGRESS_CAUSE_TEXT,
  decideCycleAction,
  deriveCycleDiagnosis,
  deriveNoProgressCause,
  detectNoProgress,
  EMPTY_CYCLE_PROGRESS,
  legacyDecisionOf,
  openCriteriaKey
} from '../shared/cycle-decision';
import type { BudgetState, TaskBudget } from '../shared/task-budget';
import { deliveryFromReport, evidenceFacts, repeatedCommands, shouldOpenRepairRound, type RepairGateResult } from '../shared/repair-loop';
import {
  applyEcoGateToDecision,
  assertDecisionSnapshotIntegrity,
  decideParticipation,
  dispatchedParticipantIds,
  snapshotFromExchanges
} from '../shared/dmoca';
import {
  buildEngineeringContextPackage,
  contextInvalidation,
  contextRequestsForGaps,
  contextRequestForGaps,
  engineeringEvidenceOf,
  fulfillContextRequest,
  invalidateContextPackage,
  projectEcoFromEvents,
  type ContextRequest,
  type ContextResourceRef,
  type EcoEvidenceSummary,
  type EngineeringContextPackage
} from '../shared/eco';
import { planEvidencePaths } from './engineering/eco-evidence';
import { exploreContextRequest } from './engineering/eco-explore';
import {
  decompositionWarnings,
  ensurePlanDecomposition,
  rebuildWorkTasksFromEvents,
  seedWorkEventsFromPlan
} from '../shared/task-decomposition';
import { assessGoalDecomposition } from '../shared/goal-decomposition';
import { reconcileGoalContractOnResume } from '../shared/goal-recovery';
import {
  detectSubtaskConflicts,
  integrateSubtaskCycles,
  projectSubtaskCyclesFromEvents
} from '../shared/subtask-cycle';
import { desktopActionStillOpen } from '../shared/computer-use-view';
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
    rawVerdict?: string;
    issues: string[];
    issueDetails?: import('../shared/contracts').ReviewIssueDetail[];
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
    /** 用户原话：五段汇总的「问题」侧，与知识问答一致。 */
    userPrompt?: string;
    /** ECO：已核验工程证据（路径+摘要），以材料身份交给评审，不是指令。 */
    ecoEvidence?: readonly EcoEvidenceSummary[];
    debateAgentIds?: readonly string[];
    /**
     * 五段一出、辩论尚未开始时回调：编排器立刻刷新心跳议题与原文，
     * 避免界面在辩题已定时仍写「主导模型撰写五段结论中」。
     */
    onLeadReady?: (brief: {
      topics: string[];
      topicGoals: string[];
      expressTarget: string;
      expressGoal: string;
      leadSummary: string;
    }) => void;
  }) => Promise<{
    debateId?: string;
    status: 'completed' | 'stopped' | 'skipped';
    participants: string[];
    summary: string;
    topics: string[];
    topicGoals?: string[];
    expressTarget?: string;
    expressGoal?: string;
    /** 主导模型五段原文（结论/一致/分歧/存疑/辩题）。 */
    leadSummary?: string;
    /** 实际跑了几轮、最多允许几轮、为什么结束；老调用方不给也不影响。 */
    rounds?: number;
    maxRounds?: number;
    roundsReason?: string;
    skippedReason?: string;
    result?: import('../shared/contracts').PlanDebateResultSlice;
  } | null>;
  /**
   * 审批时给外部 Agent 建独立工作树。默认实现是 main/task-worktree。
   * 测试可以注入一个只返回路径的假实现，不必真起 git。
   */
  worktree?: (input: { rootDir: string; taskId: string }) => Promise<{ dir: string; branch: string }>;
  /**
   * LT-P5-03/04：恢复任务上下文与核对工具副作用。
   *
   * 不传表示没有接入检查点存储——`resume` 保持原来的「先检查工作区」路径，
   * 不会假装恢复过。返回 stale 时任务停在 interrupted，要求人工处理。
   */
  contextRecovery?: (task: AgentTask, reports: readonly ExecutionReport[]) => Promise<TaskRecoveryResult>;
  /**
   * LT-P4-02：Engineering 的 Provider 规划通道。Web/CLI 适配器没有
   * `withContext`，仍按原话直发；这里不做任何注入。
   */
  contextManager?: ContextManager | null;
  /** P0-4：暂停/取消时提交可恢复检查点；生产由主进程的 checkpoint 事务注入。 */
  pauseCheckpoint?: (input: {
    task: AgentTask;
    reason: 'pause' | 'cancel';
    reports: readonly ExecutionReport[];
    taskRevision: number;
    ledger: SideEffectLedger;
    needsReconciliation: number;
  }) => Promise<PauseCheckpointOutcome>;
  /** 规划看门狗的静默阈值；测试可调小，生产默认 120 秒。 */
  planningIdleMs?: number;
  /** 恢复流程产生的副作用核对；已含在 result 里，这里只给测试/旁路观察。 */
  onRecovery?: (task: AgentTask, result: TaskRecoveryResult) => void;
  /**
   * 把已批准计划交给 Runtime。默认用 agent-manager 的实现；
   * 续跑分支要能在单测里跑通「跳过哪些步骤、报告怎么合并」，不注入就只能真起子进程。
   */
  runPlan?: typeof runPlan;
  /**
   * 检查点续跑开关（M2-2 的回退路径）。默认开：关掉它就是回到「继续一律重规划」
   * 的旧行为，改一个返回值即可，不需要回滚续跑分支本身。
   */
  resumeContinue?: () => boolean;
  /**
   * 空转阈值（M3-2 的回退路径）。不注入就是默认值：证据连续重复 2 轮、未满足标准
   * 连续停滞 2 轮才算空转。把它配成很大的数等效于关掉反空转——不需要删判定分支，
   * 也不用回滚「无进展时不许继续执行」这条行为。
   */
  noProgressLimits?: () => Partial<CycleNoProgressLimits> | null;
  /**
   * 删除任务时回收它的检查点文件与归档段（M2-2 垃圾回收）。
   *
   * 注入而不是直接 import 存储：检查点落在 userData 目录下、由宿主决定基路径，
   * 编排器只负责说「这个任务没了」。没注入时回收数为 0，删除照常成功——
   * 回收失败不能把用户的删除动作变成报错。
   */
  deleteContextArtifacts?: (task: AgentTask) => Promise<{ checkpointsRemoved: boolean; archiveSegments: number }>;
  /**
   * 启动扫描的孤儿回收入口（M2-2 垃圾回收）：只给「现在还活着的任务 id」，
   * 其余 owner 段一律按孤儿回收。判据由调用方给，宿主只管删文件——编排器不认识
   * userData 目录结构。
   */
  reclaimOrphanArtifacts?: (liveTaskIds: readonly string[]) =>
    Promise<{ checkpointsRemoved: number; archiveSegments: number }>;
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

/** 计划引用路径的最长公共目录；用于「看看这个目录里到底有什么」。取不到就不问。 */
function commonDirectory(paths: readonly string[]): string | undefined {
  const dirs = paths
    .map(item => path.posix.dirname(item.replaceAll('\\', '/')))
    .filter(item => item && item !== '.' && item !== '/');
  const first = dirs[0];
  if (!first) return undefined;
  let common = first.split('/');
  for (const dir of dirs.slice(1)) {
    const segments = dir.split('/');
    const next: string[] = [];
    for (let index = 0; index < Math.min(common.length, segments.length); index += 1) {
      if (common[index] !== segments[index]) break;
      next.push(common[index]!);
    }
    common = next;
    if (common.length === 0) return undefined;
  }
  return common.length > 0 ? common.join('/') : undefined;
}

/**
 * 执行前桥接的步骤预览：把计划步骤映射成「第几步、用什么工具、针对哪个目标」。
 *
 * 审批执行与检查点续跑共用这份映射。续跑只列出本轮真正要执行的步骤，但序号仍按
 * 原计划位置——用户对着审批时看到的计划，得能认出少跑的是哪几步。
 */
function bridgeSteps(
  steps: AgentPlan['steps'],
  onlyIds?: ReadonlySet<string>
): Array<{ index: number; tool: string; description: string; target?: string }> {
  return steps
    .map((step, position) => ({ step, index: position + 1 }))
    .filter(({ step }) => !onlyIds || onlyIds.has(step.id))
    .slice(0, 20)
    .map(({ step, index }) => {
      const args = (step.args ?? {}) as Record<string, unknown>;
      const target = typeof args.path === 'string'
        ? args.path
        : typeof args.command === 'string'
          ? args.command
          : typeof args.to === 'string'
            ? args.to
            : undefined;
      return {
        index,
        tool: step.tool,
        description: step.description?.trim() || step.tool,
        ...(target ? { target: String(target) } : {})
      };
    });
}

export class AgentOrchestrator {
  /** taskIds with an active wait or execution, to prevent double-driving. */
  private busy = new Set<string>();
  /** 正在恢复的任务；同一任务只允许一个恢复流程（LT-P5-05）。 */
  private resuming = new Set<string>();
  /** 每个任务最后一次收到规划增量的时间；用于「无输出」看门狗。 */
  private readonly planningActivity = new Map<string, number>();

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
    /**
     * V4 M1-2：把这条新任务挂到既有目标下。
     *
     * 不传就是「一个任务一个目标 v1」的既有行为。传了则新任务采用该目标当前的
     * 版本与成功标准——挂在同一个目标下却各跑各的版本，目标聚合视图就成了假的。
     */
    goalId?: string;
  }): Promise<AgentTask> {
    const members = (input.planners ?? []).filter(member => member.id);
    const planner = members[0]?.adapter ?? input.planningAdapter ?? this.deps.adapter();
    const site = planner.siteLabel;
    const status = await planner.getStatus();
    if (!status.loggedIn) throw new Error(`${site} 未登录：${status.detail ?? '请先在内嵌页面登录'}`);
    if (!status.pageReady) throw new Error(`${site} 页面不可用：${status.detail ?? '未找到输入框'}`);
    if (status.generating) throw new Error(`${site} 正在生成上一条回答，请等待完成后再提交`);

    const boundGoalId = input.goalId?.trim() ?? '';
    const boundGoal = boundGoalId
      ? resolveGoalEntity({
        goalId: boundGoalId,
        stored: this.deps.store.getGoal(boundGoalId),
        tasks: this.deps.store.listTasks()
      })
      : null;
    const task = this.tasks.create({
      prompt: input.prompt,
      permissionPreset: input.permissionPreset,
      workspaceRoot: input.workspaceRoot,
      planDebate: input.planDebate,
      ...(input.debateAgentIds && input.debateAgentIds.length > 0 ? { debateAgentIds: [...input.debateAgentIds] } : {}),
      ...(boundGoalId ? { goalId: boundGoalId } : {}),
      ...(boundGoal && boundGoal.version !== null ? { goalVersion: boundGoal.version } : {}),
      ...(boundGoal && boundGoal.criteria.length > 0 ? { goalCriteria: boundGoal.criteria } : {})
    });
    this.tasks.transition(task.taskId, 'planning');
    this.emitCycleStage(task.taskId, 'GOAL_REASONING', 'started');
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

  /**
   * 生产工作流入口（P1-04）。
   *
   * 固定流程不经过模型规划，也不再问一遍「要不要辩」：它就是一条已经写死的
   * 能力序列。但执行仍然走既有审批、TaskGrant、Journal、执行报告与验证，
   * 所以事件、证据与交付物和模型计划完全同构。
   *
   * 条件/循环/并行在 `workflowToPlan` 里就展开成真实步骤；approval 节点只把
   * 「必须人工批准」抬上来——完全权限也不能跳过它。
   */
  async submitWorkflow(input: {
    workflow?: WorkflowDefinition;
    workflowId?: string;
    goal?: string;
    permissionPreset: PermissionPreset;
    workspaceRoot?: string;
    argsByNode?: Record<string, Record<string, unknown>>;
    inputs?: Record<string, unknown>;
    completionCondition?: string;
    /**
     * 固定工作流不向模型要计划，但恢复时可能要重新规划。这里记下当前执行档
     * 的规划成员，进程重启后才能按成员重建 adapter，不悄悄退回网页。
     */
    debateAgentIds?: readonly string[];
  }): Promise<AgentTask> {
    const known: readonly string[] = TOOL_NAMES;
    const entry = input.workflow
      ? null
      : input.workflowId
        ? findWorkflow(input.workflowId)
        : selectWorkflow(input.goal ?? '', known).entry;
    const definition = input.workflow ?? entry?.definition;
    if (!definition) {
      const selected = selectWorkflow(input.goal ?? '', known);
      throw new Error(
        input.workflowId
          ? `没有注册这个工作流：${input.workflowId}`
          : `没有可执行的固定工作流：${selected.reason}`
      );
    }
    const validation = validateWorkflow(definition, known);
    if (!validation.ok) throw new Error(`工作流定义不合法：${validation.errors.join('；')}`);

    const task = this.tasks.create({
      prompt: `工作流：${definition.title}`,
      permissionPreset: input.permissionPreset,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      // 固定流程不生成模型计划，也就没有「方案评审」；不写 off 会被当成默认 auto 记一笔假辩论。
      planDebate: 'off',
      ...(input.debateAgentIds && input.debateAgentIds.length > 0
        ? { debateAgentIds: [...input.debateAgentIds] }
        : {})
    });
    this.tasks.transition(task.taskId, 'planning');
    const round = this.tasks.createRound({
      taskId: task.taskId,
      inputType: 'user_prompt',
      requestText: `工作流 ${definition.id}：${definition.title}`
    });
    const built = workflowToPlan({
      definition,
      knownCapabilities: known,
      taskId: task.taskId,
      roundId: round.roundId,
      ...(input.argsByNode ? { argsByNode: input.argsByNode } : {}),
      ...(input.inputs ? { inputs: input.inputs } : {}),
      ...(input.completionCondition ? { completionCondition: input.completionCondition } : {})
    });
    if (!built.plan) {
      const message = built.error ?? '工作流无法生成计划';
      this.tasks.transition(task.taskId, 'failed', { error: message });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId: task.taskId, error: message });
      throw new Error(message);
    }
    this.deps.emit({
      type: 'workflow.run',
      at: Date.now(),
      taskId: task.taskId,
      workflowId: definition.id,
      title: definition.title,
      stepCount: built.plan.steps.length,
      skipped: built.skipped ?? [],
      notes: built.notes ?? [],
      requiresApproval: Boolean(built.requiresApproval)
    });
    for (const note of built.notes ?? []) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId: task.taskId, level: 'info',
        message: `工作流：${note}`
      });
    }
    for (const item of built.skipped ?? []) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId: task.taskId, level: 'warn',
        message: `工作流节点 ${item.nodeId} 未执行：${item.reason}`
      });
    }

    const stored: StoredPlan = {
      planId: randomUUID(),
      taskId: task.taskId,
      roundId: round.roundId,
      plan: built.plan,
      contentHash: hashPlan(built.plan),
      approvalStatus: 'pending',
      createdAt: Date.now()
    };
    this.deps.store.insertPlan(stored);
    this.tasks.updateRound(round.roundId, { status: 'plan_ready' });
    this.tasks.patch(task.taskId, { currentPlanId: stored.planId });
    // 固定工作流没有模型规划轮，但状态机仍要走 plan_ready；否则后面
    // planning → awaiting_approval 会被判成非法转换（真机 2026-11-27）。
    if (this.tasks.get(task.taskId).status === 'planning') {
      this.tasks.transition(task.taskId, 'plan_ready');
    }
    const goalContract = this.ensureGoalContract(task, built.plan);
    this.emitCycleStage(task.taskId, 'GOAL_REASONING', 'completed');
    this.emitCycleStage(task.taskId, 'ANALYSIS', 'completed');
    this.emitCycleStage(task.taskId, 'PLANNING', 'started');
    this.emitCycleStage(task.taskId, 'PLANNING', 'completed');

    const gate = checkPlanCapabilities(stored.plan);
    const perStep = approvalPolicyFor(task.permissionPreset).stepApproval;
    const planPreview = toPreview(stored, [
      ...gate.missing,
      ...(built.requiresApproval ? ['工作流包含必须人工批准的节点'] : [])
    ]);
    // 工作流也要有任务树与「准备中」步骤：否则进度面板对这条任务一片空白。
    const seededWork = this.buildPlanWorkEvents({
      taskId: task.taskId,
      title: definition.title,
      plan: planPreview,
      ...(task.goalId ? { goalId: task.goalId } : {}),
      ...(task.goalVersion ? { goalVersion: task.goalVersion } : {}),
      goalContract
    });
    if (seededWork.blocked) {
      planPreview.warnings = [...(planPreview.warnings ?? []), ...seededWork.reasons];
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId: task.taskId,
        level: 'warn',
        message: `GCE 分解门禁：${seededWork.reasons.join('；')}；工作流计划保留，但不会自动批准。`
      });
    }
    for (const event of seededWork.events) {
      this.deps.emit(event);
    }
    this.deps.emit({
      type: 'plan.ready',
      at: Date.now(),
      taskId: task.taskId,
      roundId: round.roundId,
      plan: planPreview
    });
    // 顺序不能反：`plan.ready` 会清掉步骤身份索引（见 shared/event-identity）。
    // 先报准备再发 plan.ready 的话，Runtime 回来的 step.started/completed 补不到
    // roundId，副作用核对与检查点续跑就认不出这一步属于哪一轮，只能整计划重跑。
    for (const step of stored.plan.steps) {
      this.deps.emit({
        type: 'step.preparing',
        at: Date.now(),
        taskId: task.taskId,
        roundId: round.roundId,
        stepId: step.id,
        callId: step.id,
        tool: step.tool,
        args: step.args as Record<string, unknown>
      });
    }
    this.tasks.transition(task.taskId, 'awaiting_approval', { currentPlanId: stored.planId });

    if (built.requiresApproval) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId: task.taskId, level: 'warn',
        message: `工作流包含审批节点：即使权限为「完全权限」也必须人工确认（逐步骤审批档位 ${perStep}）。`
      });
      return this.tasks.get(task.taskId);
    }
    if (approvalPolicyFor(task.permissionPreset).autoApprovePlan && !seededWork.blocked) {
      this.autoApprovePlan(task.taskId, round.roundId, stored.planId);
    }
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

    const grant = await this.grantForApprovedPlan(task, stored, rootDir);

    const budgetViolations = checkCodingBudget(plan);
    if (budgetViolations.length > 0) {
      throw new Error(`计划超出编码预算：${budgetViolations.join('；')}`);
    }

    this.deps.store.updatePlan(stored.planId, { approvalStatus: 'approved' });
    this.tasks.transition(task.taskId, 'executing', { workspaceRoot: rootDir });
    this.emitCycleStage(task.taskId, 'IMPLEMENTATION', 'started');

    // 执行前先画出依据：将跑哪些步骤、针对什么目标；不能一批准就静默开工。
    this.deps.emit({
      type: 'execution.bridge',
      at: Date.now(),
      taskId: task.taskId,
      roundId: stored.roundId,
      planId: stored.planId,
      message: `计划已批准，将按 ${String(plan.steps.length)} 步执行「${plan.title}」${plan.completion ? `（完成条件：${plan.completion}）` : ''}`,
      steps: bridgeSteps(plan.steps)
    });

    await this.executeApprovedPlan({ task, stored, grant });
  }

  /**
   * 执行一份已批准的计划并走统一收尾。
   *
   * 审批执行与检查点续跑共用这一条：两边的失败收敛必须一样——用户取消后 Runtime
   * 的拒绝是预期结果，不能从 cancelled 再迁到 failed。分开写就会出现「批准执行时
   * 取消是静默结束、续跑时取消是报错」这种说不清的区别。
   */
  private async executeApprovedPlan(input: {
    task: AgentTask;
    stored: StoredPlan;
    grant: TaskGrant;
    reusedSteps?: ReusedStepInput[];
    /** 续跑判定用的完成证据；收尾时把「本轮没跑」的步骤还原成真实结果。 */
    completed?: ReadonlyMap<string, CompletedStep>;
  }): Promise<void> {
    const { task, stored } = input;
    let report: ExecutionReport;
    this.busy.add(task.taskId);
    try {
      report = await this.dispatchPlan(input);
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

    // 复用步骤要还原成上次的真实结果（报告 completed 或事件 started+completed）。
    // 不还原就等于把已经做过的构建/测试当没做，任务会白停在 VERIFYING。
    await this.finishPlanExecution(task, stored, mergeReusedResults(report, input.completed ?? null));
  }

  /**
   * 按已批准的计划装配执行授权。
   *
   * 审批执行与检查点续跑必须共用这一份装配逻辑：两边各写一遍，续跑就会漏掉外部
   * Agent 的独立工作树或审批粒度，Runtime 报「未授权工具」时界面看不出跟权限档
   * 有任何关系。
   */
  private async grantForApprovedPlan(task: AgentTask, stored: StoredPlan, rootDir: string): Promise<TaskGrant> {
    const plan = stored.plan;
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
    return grant;
  }

  /**
   * 把计划交给 Runtime。
   *
   * `reusedSteps` 只让 Runtime 少跑几步（并如实发 `step.reused`），计划内容、
   * planId、roundId 都不动——续跑改的是「这一步还要不要执行」，不是「批准了什么」。
   */
  private dispatchPlan(input: {
    task: AgentTask;
    stored: StoredPlan;
    grant: TaskGrant;
    reusedSteps?: ReusedStepInput[];
  }): Promise<ExecutionReport> {
    const run = this.deps.runPlan ?? runPlan;
    const reused = input.reusedSteps ?? [];
    return run(
      input.stored.plan,
      input.grant,
      this.deps.dbPath(),
      this.planTimeout(input.task.timeoutMs, input.stored.plan),
      {
        roundId: input.stored.roundId,
        planId: input.stored.planId,
        ...(input.task.conversationId ? { conversationId: input.task.conversationId } : {})
      },
      reused.length > 0 ? { reusedSteps: reused } : undefined
    );
  }

  /** 一份已批准计划跑完之后的统一收尾：落报告、评审、验证判定、决定下一轮。 */
  private async finishPlanExecution(
    task: AgentTask,
    stored: StoredPlan,
    initialReport: ExecutionReport
  ): Promise<void> {
    const plan = stored.plan;
    let report = initialReport;

    // 改动量必须在报告成形的这一刻取：读完报告再回头跑 git diff，
    // 工作区可能已经被下一轮改过，数字就不是这份报告的了。
    if (report.verification && report.verification.changedFiles > 0) {
      const stats = collectDiffStats({
        workspaceRoot: task.workspaceRoot,
        paths: report.verification.changedPaths ?? []
      });
      report = {
        ...report,
        verification: withDiffStats(report.verification, stats)
      };
    }

    this.deps.store.insertReport(report);
    this.emitCycleStage(task.taskId, 'IMPLEMENTATION', 'completed');
    this.emitCycleStage(task.taskId, 'REVIEW', 'started');
    this.deps.emit({ type: 'report.ready', at: Date.now(), taskId: task.taskId, roundId: stored.roundId, report });
    try {
      this.deps.onReport?.(task, report);
    } catch {
      // 轨迹是旁路：记录失败不能让已经完成的执行看起来失败。
    }

    // 取消发生在执行过程中时，报告仍然要落库（轨迹与证据不能丢），但状态
    // 已经由 cancel() 置为 cancelled，不能再走 verifying / report_pending。
    if (TERMINAL.includes(this.tasks.get(task.taskId).status)) return;

    // 用户点的是「暂停」不是「取消」，但 Runtime 对两种停止请求回的是同一份
    // status='cancelled' 报告。让它继续往下走会把任务从 paused 带去
    // verifying → report_pending → cancelled，而 resume 只认
    // paused/interrupted/budget_exhausted/blocked——暂停检查点就此再也续不上
    // （M2-2 真机：暂停后点「继续」提示状态不允许）。
    if (['pause_requested', 'pausing', 'paused'].includes(this.tasks.get(task.taskId).status)) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId: task.taskId, level: 'info',
        message: '任务处于暂停：本轮执行报告已落库（已完成步骤的证据不丢），状态保持暂停，点「继续」按暂停检查点核对后续跑。'
      });
      return;
    }

    // 独立评审只读执行事实，不改任务状态；失败也不该把已经完成的执行作废。
    // 需要修复时只是给出结论：下一轮计划要不要人重新批准，由权限预设决定
    // （完全权限下自动执行，其余档位仍需点击）。
    let review: {
      reviewer: string;
      verdict: string;
      issues: string[];
      needsFix: boolean;
      rawVerdict?: string;
      issueDetails?: import('../shared/contracts').ReviewIssueDetail[];
    } | null = null;
    if (this.deps.review) {
      try {
        const verdict = await this.deps.review(report, plan, task);
        review = {
          reviewer: verdict.reviewer,
          verdict: verdict.verdict,
          issues: verdict.issues,
          needsFix: verdict.needsFix,
          ...(verdict.rawVerdict ? { rawVerdict: verdict.rawVerdict } : {}),
          ...(verdict.issueDetails ? { issueDetails: verdict.issueDetails } : {})
        };
        this.deps.emit({
          type: 'review.ready', at: verdict.at, taskId: task.taskId, roundId: stored.roundId,
          reviewer: verdict.reviewer, backend: verdict.backend, verdict: verdict.verdict,
          issues: verdict.issues, needsFix: verdict.needsFix,
          ...(verdict.rawVerdict ? { rawVerdict: verdict.rawVerdict } : {}),
          ...(verdict.issueDetails ? { issueDetails: verdict.issueDetails } : {})
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.deps.emit({ type: 'log', at: Date.now(), taskId: task.taskId, level: 'warn', message: `独立评审没有完成：${detail}` });
      }
    }
    this.emitCycleStage(
      task.taskId,
      'REVIEW',
      review ? 'completed' : 'skipped',
      review ? undefined : '未启用独立评审'
    );
    this.emitCycleStage(
      task.taskId,
      review?.needsFix ? 'IMPLEMENTATION' : 'CONCLUSION',
      'started',
      review?.needsFix ? '评审要求修复' : undefined
    );

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

  /** P0-4：把暂停点的目标版本、任务树 revision 与副作用缺口落进检查点。 */
  private async commitPauseCheckpoint(taskId: string, reason: 'pause' | 'cancel'): Promise<void> {
    const task = this.tasks.get(taskId);
    const reports = this.deps.store.allReportsFor(taskId);
    const events = this.deps.store.listEvents(taskId);
    const entries = collectReportedAndInFlightSideEffects({ reports, events });
    const ledger = await reconcileSideEffects(entries, {
      workspaceRoot: task.workspaceRoot
    });
    const taskRevision = Math.max(0, ...[...rebuildWorkTasksFromEvents(
      taskId, events
    ).values()].map(item => item.revision ?? 1));
    let checkpoint: PauseCheckpointOutcome | null = null;
    let unavailableReason: string | undefined;
    if (this.deps.pauseCheckpoint) {
      try {
        checkpoint = await this.deps.pauseCheckpoint({
          task, reason, reports, taskRevision,
          ledger, needsReconciliation: ledger.needsReconciliation
        });
        // 指针三字段由 Journal 事务（store.commitContextCheckpoint）一次写完，
        // 这里不能再 patch 一遍：上一版补写时漏了 activeRunId，等于用一份不完整的
        // 指针盖掉权威值，恢复时 runId 门判不过，检查点看着在却读不出。
      } catch (error) {
        unavailableReason = error instanceof Error ? error.message : String(error);
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `暂停检查点未提交：${unavailableReason}；状态照常落库，恢复时按缺失检查点处理。`
        });
      }
    } else {
      unavailableReason = '当前宿主未注入检查点能力';
    }
    this.deps.emit({
      type: 'context.checkpoint.paused',
      at: Date.now(), taskId, reason,
      goalVersion: task.goalVersion ?? 1,
      taskRevision,
      needsReconciliation: ledger.needsReconciliation,
      // 完整指针进事件流：任务字段丢了（旧库、半套写入、宿主没走 Journal 事务）
      // 恢复时还能从事件里重建，不必把已落盘的检查点判成不存在。
      ...(checkpoint
        ? {
            contextId: checkpoint.contextId,
            checkpointId: checkpoint.checkpointId,
            activeRunId: checkpoint.activeRunId
          }
        : {}),
      ...(unavailableReason ? { unavailableReason } : {})
    });
  }

  /** 用户暂停：请求态 → Runtime 确认 → 检查点 → 实际态；恢复按这份检查点决定续跑还是重规划。 */
  async pause(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const pending = ['pause_requested', 'pausing', 'cancel_requested', 'cancelling'];
    if (['completed', 'failed', 'cancelled', 'paused', ...pending].includes(task.status)) return;
    const originalStatus = task.status;
    const inFlight = ['planning', 'executing', 'verifying'].includes(originalStatus);

    // 请求态先落库：界面不能再把「已点暂停」显示成仍在规划/执行。
    this.tasks.transition(taskId, 'pause_requested', {
      resumeStatus: originalStatus, error: undefined
    });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: inFlight
        ? '已收到暂停请求：正在等待在途模型与工具停止。'
        : '已收到暂停请求：正在写入暂停检查点。'
    });

    if (inFlight) {
      const round = task.currentRoundId ? this.tasks.getRound(task.currentRoundId) : null;
      if (round) this.adapterFor(taskId).cancelWait(round.requestId);
      this.cancelPeers(taskId);
      const cancel = await cancelPlan(taskId);
      if (cancel.sent && !cancel.confirmed) {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: '已下发停止请求，但未能确认在途工具终止；继续前请核对文件与进程副作用。'
        });
      }
    }

    // Runtime 回执（或有界等待）之后才进入停止中，再落检查点。
    this.tasks.transition(taskId, 'pausing', { resumeStatus: originalStatus });
    await this.commitPauseCheckpoint(taskId, 'pause');
    this.tasks.transition(taskId, 'paused', {
      resumeStatus: originalStatus,
      ...(inFlight
        ? { error: '用户暂停：在途请求已停止；继续时先核对现有结果，不自动重跑旧步骤。' }
        : {})
    });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: inFlight
        ? '任务已暂停：停止请求与检查点均已落库；继续时按这份检查点核对副作用，能续跑就直接续，核对不过才重规划。'
        : '任务已暂停：检查点已落库；继续会回到暂停前的等待状态。'
    });
  }

  /**
   * 用户继续：
   * - 暂停在等待态：回到暂停前的等待状态；
   * - 暂停在规划/执行/校验：重新开一轮，先核对现有结果；
   * - interrupted/budget/blocked：检查点有效时恢复摘要与副作用清单，再开新一轮。
   *
   * 恢复失败（stale）不猜：任务留在 interrupted，要求人工处理。
   */
  async resume(taskId: string): Promise<void> {
    if (this.busy.has(taskId) || this.resuming.has(taskId)) {
      throw new Error('任务正在执行或恢复中，不能重复继续');
    }
    const task = this.tasks.get(taskId);
    if (!['paused', 'interrupted', 'budget_exhausted', 'blocked'].includes(task.status)) {
      throw new Error(`任务当前状态为 ${task.status}，不能继续`);
    }

    const waitingStates = ['awaiting_clarification', 'awaiting_approval', 'plan_ready', 'report_pending', 'awaiting_next_round'];
    if (task.status === 'paused' && task.resumeStatus && waitingStates.includes(task.resumeStatus)) {
      this.tasks.transition(taskId, task.resumeStatus, { resumeStatus: undefined, error: undefined });
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'info',
        message: `任务已继续，回到 ${task.resumeStatus} 状态。`
      });
      return;
    }

    this.resuming.add(taskId);
    try {
      const reports = this.deps.store.allReportsFor(taskId);
      const recovery = this.deps.contextRecovery
        ? await this.deps.contextRecovery(task, reports)
        : null;

      if (recovery?.status === 'stale') {
        this.deps.emit({
          type: 'context.event', at: Date.now(), taskId,
          event: 'context.compaction.stale',
          context: {
            contextId: recovery.contextId ?? task.contextId ?? '',
            ...(recovery.checkpointId ? { checkpointId: recovery.checkpointId } : {}),
            ...(recovery.pointerSource ? { pointerSource: recovery.pointerSource } : {}),
            reason: recovery.reason ?? '检查点不可用'
          }
        });
        throw new Error(`检查点不可用，任务保持原状态：${recovery.reason ?? '未知原因'}`);
      }
      if (recovery?.status === 'recovered') {
        const ledger = recovery.ledger;
        this.deps.emit({
          type: 'context.event', at: Date.now(), taskId,
          event: 'context.recovered',
          context: {
            contextId: recovery.contextId ?? task.contextId ?? '',
            ...(recovery.checkpointId ? { checkpointId: recovery.checkpointId } : {}),
            // M2-1：把「这次恢复到底读的是落库指针还是事件流重建」记进事件。
            // 不记的话两条路径产出同一个 recovered，出问题只看得到结果看不到来源。
            ...(recovery.pointerSource ? { pointerSource: recovery.pointerSource } : {}),
            reason: recovery.pointerSource === 'events-replay'
              ? '任务指针字段缺失，已按事件流最后一条检查点事件重建指针并校验通过'
              : '从 Journal 活动指针恢复',
            ...(ledger
              ? {
                  sideEffects: {
                    applied: ledger.applied,
                    missing: ledger.missing,
                    needsReconciliation: ledger.needsReconciliation
                  }
                }
              : {})
          }
        });
      }
      // 检查点能读、上下文过期：可以恢复，但必须先把「重新采集」这件事
      // 落到事件里，后续规划才知道不能沿用旧结论。
      if (recovery?.status === 'needs_context_refresh') {
        this.deps.emit({
          type: 'context.event', at: Date.now(), taskId,
          event: 'context.refresh.required',
          context: {
            contextId: recovery.contextId ?? task.contextId ?? '',
            ...(recovery.checkpointId ? { checkpointId: recovery.checkpointId } : {}),
            ...(recovery.pointerSource ? { pointerSource: recovery.pointerSource } : {}),
            reason: recovery.eco?.reason ?? recovery.reason ?? '工程上下文已过期'
          }
        });
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `恢复时工程上下文不兼容：${recovery.eco?.reason ?? recovery.reason ?? '未知原因'}；本次继续先重新读取工程，正式角色在补齐上下文前不派发。`
        });
      }
      if (recovery?.ledger && recovery.ledger.missing > 0) {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `恢复核对发现 ${String(recovery.ledger.missing)} 个改动文件已不存在；继续时会重新规划并补做，不把缺失当已完成。`
        });
      }
      this.deps.onRecovery?.(task, recovery ?? { status: 'none' });

      // P1-05：恢复前把「目标 → 任务树 → 上下文 → 贡献 → 决策」逐层比一遍。
      // 不是算给人看：requiresReplan 会真的改写继续提示词，旧结论不会被静默复用。
      const resumeEvents = this.deps.store.listEvents(taskId);
      const resumeTasks = [...rebuildWorkTasksFromEvents(taskId, resumeEvents).values()];
      // P0-1：取源交给共享纯函数。「任务记录」与「事件流当前事实」必须分开，
      // 否则两个字段同源，checkVersionChain 判得再准也永远碰不到过期分支。
      const { chain: versionChainInput, sources: versionSources } = buildResumeVersionChainInput({
        task,
        events: resumeEvents,
        workTasks: resumeTasks,
        ecoRef: recovery?.ecoRef ?? null
      });
      const versionChain = checkVersionChain(versionChainInput);

      // GCE：旧 GoalContract 可能比当前任务目标旧；过期契约不能再被当成当前目标。
      const goalRecovery = reconcileGoalContractOnResume({
        goalId: task.goalId ?? `goal:${taskId}`,
        goalVersion: task.goalVersion ?? 1,
        ...(task.goalCriteria ? { goalCriteria: task.goalCriteria } : {}),
        ...(task.goalContract ? { contract: task.goalContract } : {}),
        tasks: resumeTasks
      });

      // P0-2：needs_replan 不能只写进提示词。第一次判出过期时作废未完成任务树、
      // 发 WAIT_USER 并停在 blocked；用户再次继续才按新目标重新规划。
      // 同版本已经执行过门禁的事件表示用户已确认，不重复挡住。
      const needsReplan = versionChain.requiresReplan || goalRecovery.status === 'needs_replan';
      const lastGoalEventAt = [...resumeEvents].reverse()
        .find(event => event.type === 'goal.contract.updated')?.at ?? 0;
      const gateConsumed = [...resumeEvents].reverse().some(event =>
        event.type === 'version.consistency' && event.actedOnReplan === true && event.at >= lastGoalEventAt
      );
      const gateBlocks = needsReplan && !gateConsumed;
      this.deps.emit({
        type: 'version.consistency',
        at: Date.now(),
        taskId,
        consistent: versionChain.consistent,
        issues: versionChain.issues,
        inheritable: versionChain.inheritable,
        expired: versionChain.expired,
        requiresReplan: versionChain.requiresReplan,
        requiresContextRefresh: versionChain.requiresContextRefresh,
        notes: versionChain.notes,
        sources: versionSources,
        actedOnReplan: gateBlocks
      });
      if (!versionChain.consistent) {
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId,
          level: 'warn',
          message: `版本核对：${versionChain.issues.map(item => `[${item.layer}] ${item.reason}`).join('；')}；可继承 ${versionChain.inheritable.join('、') || '无'}`
        });
      }

      if (goalRecovery.status === 'needs_replan') {
        this.deps.emit({
          type: 'goal.contract.stale',
          at: Date.now(),
          taskId,
          goalId: task.goalId ?? `goal:${taskId}`,
          goalVersion: task.goalVersion ?? 1,
          reasons: goalRecovery.reasons
        });
        this.tasks.patch(taskId, { goalContract: undefined });
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId,
          level: 'warn',
          message: `GCE 目标契约已过期：${goalRecovery.reasons.join('；')}；继续时按当前目标重新建立，不复用旧 Criterion。`
        });
      }

      // 用户在恢复/核对期间取消或暂停：不能继续开新一轮。
      const current = this.tasks.get(taskId);
      if (!['paused', 'interrupted', 'budget_exhausted', 'blocked'].includes(current.status)) {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'info',
          message: `恢复完成前任务已变为 ${current.status}，不再继续。`
        });
        return;
      }

      if (gateBlocks) {
        const impacted = resumeTasks
          .filter(item => !['completed', 'cancelled', 'skipped'].includes(item.status))
          .map(item => item.workTaskId);
        if (impacted.length > 0) {
          this.deps.emit({
            type: 'work.breakdown.replanned', at: Date.now(), taskId, workId: taskId, impactedIds: impacted
          });
        }
        const reason = `旧目标计划未执行：${versionChain.issues.map(item => `[${item.layer}] ${item.reason}`).join('；') || goalRecovery.reasons.join('；') || '目标契约已过期'}；等待确认后按新目标重规划`;
        // 恢复门禁也走同一个出口：这条路径的结论是「外部阻塞」，标签与行为（转 blocked）同源。
        this.decideAndEmit(
          taskId,
          this.tasks.get(taskId).currentRoundId ?? 'resume',
          {
            ...(this.tasks.get(taskId).goalContract
              ? { goalStatus: this.tasks.get(taskId).goalContract!.status }
              : {}),
            goalFit: null,
            delivery: { execution: 'PENDING', verification: 'UNVERIFIED', goal: 'UNKNOWN' },
            review: { needsFix: false, blockingIssues: 0, unresolved: 0 },
            task: { blockedReason: reason },
            progress: EMPTY_CYCLE_PROGRESS,
            diagnosis: 'goal',
            gates: {}
          },
          ['version.consistency']
        );
        this.tasks.transition(taskId, 'blocked', { error: reason, resumeStatus: undefined });
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `${reason}；旧步骤不进入 planning，也不作为当前有效决策复用。`
        });
        return;
      }

      // M2-2：检查点 fresh、副作用账本无缺口、门禁放行、且任务挂着已批准计划时，
      // 直接把那份计划剩下的步骤跑完，不再问一轮 Planner。放在轮数预算之前是有意的：
      // 续跑不建新一轮，不该被「轮数用尽」判死——用户点的是继续一份已经批准的计划。
      const resumePlan = task.currentPlanId ? this.deps.store.getPlan(task.currentPlanId) : null;
      const verdict = decideContinuation({
        taskId,
        recovery,
        enabled: this.deps.resumeContinue?.() ?? true,
        plan: resumePlan,
        planHashMatches: !!resumePlan && hashPlan(resumePlan.plan) === resumePlan.contentHash,
        reports,
        events: resumeEvents,
        gateBlocks,
        requiresReplan: versionChain.requiresReplan
      });
      if (verdict.mode === 'continue') {
        await this.continueFromCheckpoint(task, verdict);
        return;
      }
      // 恢复要开新一轮，先过同一道门禁。超限的落点是 `budget_exhausted`（可追加预算续跑），
      // 不是 `failed`——原来判死之后状态表里没有回得来的边，用户加完预算也接不回去。
      const resumeGate = this.tasks.budgetView(taskId).gate;
      if (!resumeGate.ok) {
        this.pauseOnBudget(taskId, resumeGate.reason);
        return;
      }
      // 重新规划这条路要留下事件：续跑与轮数耗尽都不该发它，所以放在两道判定之后。
      this.deps.emit({
        type: 'context.event', at: Date.now(), taskId,
        event: 'context.resume.replanned',
        context: {
          contextId: recovery?.contextId ?? task.contextId ?? '',
          ...(recovery?.checkpointId ? { checkpointId: recovery.checkpointId } : {}),
          ...(recovery?.pointerSource ? { pointerSource: recovery.pointerSource } : {}),
          reason: verdict.reasons[0] ?? '按新一轮重新规划',
          resume: { mode: 'replan', reasons: verdict.reasons }
        }
      });
      this.tasks.transition(taskId, 'planning', { resumeStatus: undefined, error: undefined });
      const round = this.tasks.createRound({ taskId, inputType: 'user_prompt', requestText: '' });
      const recovered = recovery ? recoveryPromptData(recovery) : '';
      const versionNote = versionConsistencyPrompt(versionChain);
      const prompt = buildInitialPrompt({
        prompt: [
          `${task.userPrompt}

继续上次任务：先检查现有工作区、执行报告与证据，确认哪些步骤已经完成；不要重复已完成的写操作。`,
          ...(recovered ? ['', recovered] : []),
          ...(versionNote ? ['', versionNote] : [])
        ].join('\n'),
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
        message: recovery?.status === 'recovered'
          ? '任务已继续：使用最近检查点摘要与副作用核对结果，先检查现状，不自动重跑旧步骤。'
          : recovery?.status === 'needs_context_refresh'
            ? '任务已继续：检查点有效但工程上下文已过期，先重新读取工程再规划，不沿用旧结论。'
            : '任务已继续：开始新一轮，先检查现有结果，不自动重跑旧步骤。'
      });
      void this.driveRound(taskId, round.roundId, prompt).catch(error => this.fail(taskId, error));
    } finally {
      this.resuming.delete(taskId);
    }
  }

  /**
   * 检查点续跑：把已批准计划里没跑完的步骤跑掉，不开新一轮、不再问 Planner。
   *
   * 三条口径必须和审批执行完全一致，否则「续跑」这条路会出现独立的一套行为：
   * - 授权由 `grantForApprovedPlan` 装配（含外部 Agent 的独立工作树）；
   * - planId / roundId 沿用被中断那一份计划，报告归属不能挂到新的轮次上；
   * - 收尾走 `executeApprovedPlan`，失败收敛、报告落库、评审与验证判定同一条路。
   */
  private async continueFromCheckpoint(task: AgentTask, verdict: ContinuationPlan): Promise<void> {
    const taskId = task.taskId;
    const stored = verdict.plan;
    const rootDir = await this.resolveWorkspace(task);
    const grant = await this.grantForApprovedPlan(task, stored, rootDir);
    this.tasks.transition(taskId, 'executing', {
      workspaceRoot: rootDir,
      resumeStatus: undefined,
      error: undefined
    });
    this.emitCycleStage(taskId, 'IMPLEMENTATION', 'started');

    this.deps.emit({
      type: 'context.event', at: Date.now(), taskId,
      event: 'context.resume.continued',
      context: {
        contextId: verdict.contextId ?? task.contextId ?? '',
        ...(verdict.checkpointId ? { checkpointId: verdict.checkpointId } : {}),
        ...(verdict.pointerSource ? { pointerSource: verdict.pointerSource } : {}),
        reason: `检查点有效、副作用账本无未知缺口，直接续跑已批准计划 ${stored.planId}`,
        resume: {
          mode: 'continue',
          planId: stored.planId,
          roundId: stored.roundId,
          reusedStepIds: verdict.reusedStepIds,
          pendingStepIds: verdict.pendingStepIds,
          reasons: verdict.reasons
        }
      }
    });
    this.deps.emit({
      type: 'execution.bridge',
      at: Date.now(),
      taskId,
      roundId: stored.roundId,
      planId: stored.planId,
      message: `从检查点续跑：跳过 ${String(verdict.reusedStepIds.length)} 步已完成，执行剩余 ${String(verdict.pendingStepIds.length)} 步「${stored.plan.title}」`,
      steps: bridgeSteps(stored.plan.steps, new Set(verdict.pendingStepIds))
    });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: verdict.reusedStepIds.length > 0
        ? `任务已继续：不重新规划，沿用已批准计划 ${stored.planId}，复用上轮完成的 ${verdict.reusedStepIds.join('、')}，本轮执行 ${verdict.pendingStepIds.join('、')}。`
        : `任务已继续：不重新规划，沿用已批准计划 ${stored.planId}，本轮执行全部 ${String(verdict.pendingStepIds.length)} 步。`
    });

    await this.executeApprovedPlan({
      task,
      stored,
      grant,
      reusedSteps: verdict.reusedSteps,
      completed: verdict.completed
    });
  }

  /**
   * 目标修订（P0-03 + V4 M1-2 目标实体化）。
   *
   * 做四件事：按目标口径算版本、算影响、把新口径落到目标实体、把该目标下
   * **全部**任务一起重打版本。
   * - 澄清 / 优化不抬版本，但新标准照样落库；
   * - 重大变更未经用户确认只发 `goal.revision.pending`，不落库、不抬版本（不允许静默换目标）；
   * - 受影响任务按 replan 闭包重打版本，已完成且不受影响的成果保留原版本。
   *
   * 影响面按任务分别算：`changedTaskIds` 是界面从当前任务的结构里读出来的，
   * 套到兄弟任务上会漏算，所以兄弟任务按保守口径（全部未完成任务受影响）。
   */
  async reviseGoal(
    taskId: string,
    input: { nextCriteria: string[]; userConfirmedChange?: boolean; changedTaskIds?: string[] }
  ): Promise<ReturnType<typeof planGoalRevision>> {
    const task = this.tasks.get(taskId);
    const goalId = task.goalId ?? `goal:${taskId}`;
    const allTasks = this.deps.store.listTasks();
    const entity = resolveGoalEntity({ goalId, stored: this.deps.store.getGoal(goalId), tasks: allTasks });
    const previousVersion = entity.version ?? task.goalVersion ?? 1;
    // 基线优先取目标口径（落库实体，或同目标里版本最高的契约）；一条依据都没有
    // 才退回本任务自己的契约。计划生成时 `goalCriteria` 可能还是空的，拿它比较
    // 会把「删除已有标准」误判成「只补充」。
    const previousCriteria = entity.criteria.length > 0
      ? entity.criteria
      : revisionBaselineCriteria({
        contractCriteria: task.goalContract?.criteria.map(item => item.description),
        goalCriteria: task.goalCriteria
      });
    const workTasks = [...rebuildWorkTasksFromEvents(taskId, this.deps.store.listEvents(taskId)).values()];
    const plan = planGoalRevision({
      tasks: workTasks,
      previousVersion,
      previousCriteria,
      nextCriteria: input.nextCriteria,
      ...(input.userConfirmedChange === undefined ? {} : { userConfirmedChange: input.userConfirmedChange }),
      ...(input.changedTaskIds ? { changedTaskIds: input.changedTaskIds } : {})
    });
    const targets = tasksUnderGoal(goalId, allTasks).map(item => {
      if (item.taskId === taskId) return { task: item, workTasks, plan };
      const itemWorkTasks = [...rebuildWorkTasksFromEvents(item.taskId, this.deps.store.listEvents(item.taskId)).values()];
      return {
        task: item,
        workTasks: itemWorkTasks,
        plan: planGoalRevision({
          tasks: itemWorkTasks,
          previousVersion,
          previousCriteria,
          nextCriteria: input.nextCriteria,
          ...(input.userConfirmedChange === undefined ? {} : { userConfirmedChange: input.userConfirmedChange })
        })
      };
    });
    const goalTasks = targets.map(item => ({
      taskId: item.task.taskId,
      title: item.task.title,
      status: String(item.task.status)
    }));

    if (plan.requiresUserConfirmation) {
      for (const target of targets) {
        const impacted = new Set(target.plan.impactedTaskIds);
        this.deps.emit({
          type: 'log', at: Date.now(), taskId: target.task.taskId, level: 'warn',
          message: `目标变更等待用户确认：${target.plan.reason}；确认前不抬版本、不改任务。`
        });
        // M1-3：影响面不能只留一行日志。发结构化事件，界面据此弹确认卡；
        // 受影响任务的标题取事件当时重建出来的那份任务树，事后不回填。
        this.deps.emit({
          type: 'goal.revision.pending',
          taskId: target.task.taskId,
          goalId,
          fromVersion: previousVersion,
          nextVersion: target.plan.nextVersion,
          reason: target.plan.reason,
          nextCriteria: input.nextCriteria,
          impactedTaskIds: target.plan.impactedTaskIds,
          impactedTasks: target.workTasks
            .filter(workTask => impacted.has(workTask.workTaskId))
            .map(workTask => ({ workTaskId: workTask.workTaskId, title: workTask.title, status: String(workTask.status) })),
          inheritedCount: target.plan.inheritedTaskIds.length,
          // M1-2：确认后这些任务会一起抬版本，卡片必须说清还有谁被带着走。
          goalTasks,
          at: Date.now()
        });
      }
      return plan;
    }
    const at = Date.now();
    const nextCriteriaLines = input.nextCriteria.map(item => item.trim()).filter(Boolean);
    // 即使用户只是补充标准（不抬版本），目标实体也要落库；否则界面刚保存的
    // 目标下一次投影又回到旧值。重大变更已在上面被拦住，走到这里的都是可生效的。
    this.deps.store.upsertGoal({
      goalId,
      title: entity.title || (task.goalContract?.originalRequest ?? '').trim(),
      version: plan.nextVersion,
      criteria: nextCriteriaLines,
      updatedAt: at
    });
    for (const target of targets) {
      // 任务上的契约是目标口径的快照：取证链路照旧读它，但版本由目标决定。
      const snapshotCriteria = target.task.goalContract
        ? nextCriteriaLines.map((description, index) => createGoalCriterion({
          goalId,
          goalVersion: target.plan.nextVersion,
          criterionId: `criterion:${target.task.taskId}:user:${String(index + 1)}`,
          description,
          source: 'USER_EXPLICIT',
          priority: 'MUST',
          verificationMethod: '执行报告中的测试/编译/运行/诊断或非代码回读证据',
          acceptanceThreshold: '存在与该标准匹配的 PASSED 证据，且没有 FAILED 证据',
          updatedAt: at
        }))
        : null;
      const nextContract: GoalContract | undefined = target.task.goalContract && snapshotCriteria
        ? {
          ...target.task.goalContract,
          goalId,
          goalVersion: target.plan.nextVersion,
          criteria: snapshotCriteria,
          status: 'ACTIVE',
          updatedAt: at
        }
        : undefined;
      this.tasks.patch(target.task.taskId, {
        goalId,
        goalVersion: target.plan.nextVersion,
        goalCriteria: [...nextCriteriaLines],
        ...(nextContract ? { goalContract: nextContract } : {})
      });
      if (nextContract) {
        this.deps.emit({
          type: 'goal.contract.updated',
          at,
          taskId: target.task.taskId,
          contract: nextContract
        });
      }
      if (!target.plan.versionChanged) {
        this.deps.emit({
          type: 'log', at, taskId: target.task.taskId, level: 'info',
          message: `${target.plan.reason}；目标版本保持 v${String(previousVersion)}。`
        });
        continue;
      }
      const impacted = new Set(target.plan.impactedTaskIds);
      for (const item of target.workTasks) {
        if (!impacted.has(item.workTaskId)) continue;
        this.deps.emit({
          type: 'work.task.upserted',
          at,
          taskId: target.task.taskId,
          workId: target.task.taskId,
          task: {
            ...item,
            goalId,
            goalVersion: target.plan.nextVersion,
            revision: item.revision + 1,
            updatedAt: at
          }
        });
      }
      this.deps.emit({
        type: 'work.breakdown.replanned',
        at,
        taskId: target.task.taskId,
        workId: target.task.taskId,
        impactedIds: target.plan.impactedTaskIds
      });
      this.deps.emit({
        type: 'log', at, taskId: target.task.taskId, level: 'warn',
        message: `目标版本 → v${String(target.plan.nextVersion)}（${target.plan.kind}）：${target.plan.reason}。`
      });
    }
    return plan;
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    const pending = ['pause_requested', 'pausing', 'cancel_requested', 'cancelling'];
    if (TERMINAL.includes(task.status) || pending.includes(task.status)) return;
    const originalStatus = task.status;

    // 请求态先落库：用户在 Runtime 回执前就能看到「取消已发出」。
    this.tasks.transition(taskId, 'cancel_requested', {
      resumeStatus: originalStatus, error: undefined
    });
    this.deps.emit({
      type: 'log', at: Date.now(), taskId, level: 'info',
      message: '已收到取消请求：正在等待在途模型与工具停止。'
    });

    const round = task.currentRoundId ? this.tasks.getRound(task.currentRoundId) : null;
    if (round) this.adapterFor(taskId).cancelWait(round.requestId);
    this.cancelPeers(taskId);

    // 取消要传到 Runtime：否则它还在跑计划，外部 CLI 也还在改文件。
    const cancel = await cancelPlan(taskId);
    if (cancel.sent && !cancel.confirmed) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'warn',
        message: '已下发取消请求，但未能确认在途工具终止；任务标记为取消，副作用需人工核对。'
      });
    }

    this.tasks.transition(taskId, 'cancelling', { resumeStatus: originalStatus });
    await this.commitPauseCheckpoint(taskId, 'cancel');
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

  /**
   * 删除任务，并回收只属于它的附属实体。
   *
   * 两类东西的判据完全不同，不能一把切：
   * - **检查点与归档**：owner 就是 `agent-task:<taskId>`。任务记录一删，Journal 指针
   *   和事件流同时消失，这份文件再也寻不到——留着只是磁盘孤儿，直接回收。
   * - **目标实体**：目标是「同一目标下几条任务」的共享口径。只有**最后一条绑定任务
   *   被删**它才成孤儿。按 `updatedAt` 猜「很久没人动」会误删：用户删掉一条旧任务，
   *   剩下几条的侧栏分组标题就凭空换了。
   *
   * 回收结果原样返回：`task.deleted` 只在 IPC 上发一次、不落 Journal（任务事件已随
   * 删除清掉），它是删除之后唯一还能对用户交代「少了什么」的入口。
   */
  async deleteTask(taskId: string): Promise<TaskCleanup> {
    const task = this.deps.store.getTask(taskId);
    // 删除是用户的最终意图：运行中的任务先取消、停外部进程，再删除记录。
    // 不能因为“还没结束”把行留在列表里，那会让用户无法清掉卡住的任务。
    // `created` 例外：这条状态下一步都没派发过（driveRound 第一件事就是转 planning），
    // 没有在途请求可停，而转移表刻意不给它 cancel_requested 这条边——照着走一遍
    // 只会让「删掉一条没启动的记录」抛成非法状态转换，用户从此删不掉它。
    if (task && !TERMINAL.includes(task.status) && task.status !== 'created') {
      await this.cancel(taskId);
    }
    const goalId = task?.goalId;
    this.deps.store.deleteTask(taskId);

    const cleanup: TaskCleanup = {
      taskId,
      checkpointsRemoved: false,
      archiveSegments: 0,
      ...(goalId ? { goalId } : {}),
      goalReclaimed: false
    };
    if (task && this.deps.deleteContextArtifacts) {
      try {
        const reclaimed = await this.deps.deleteContextArtifacts(task);
        cleanup.checkpointsRemoved = reclaimed.checkpointsRemoved;
        cleanup.archiveSegments = reclaimed.archiveSegments;
      } catch {
        // 磁盘回收失败（只读、权限、并发写）不能让删除任务变成报错：任务已经删掉了。
      }
    }
    if (goalId) {
      // 判据只认「还有没有任务绑着它」，算的是删除之后的事实。
      const stillBound = tasksUnderGoal(goalId, this.deps.store.listTasks()).length > 0;
      if (!stillBound) cleanup.goalReclaimed = this.deps.store.deleteGoal(goalId);
    }
    return cleanup;
  }

  /**
   * 启动扫描：把「已经没有任务对应」的检查点、归档段与目标实体收掉（M2-2 垃圾回收）。
   *
   * 为什么删除任务时回收还不够：这台机器实测过 store 里 0 条任务、磁盘上 11 个归属
   * 文件、6 条孤儿目标——那些任务是在回收逻辑存在之前删掉的，再也没有「删除动作」
   * 会来清它们。判据只有「任务表里查不到这条 id」，不按时间、不按文件大小猜：
   * 活动很旧的任务仍在表里，它的检查点必须留着。
   *
   * 只在启动时跑：那会儿还没有新任务能并发写入，也就不会把刚落的检查点判成孤儿。
   * 计数如实返回，回收失败（只读、权限）只让数字变小，不让启动失败。
   */
  async reclaimOrphanArtifacts(): Promise<OrphanCleanup> {
    const tasks = this.deps.store.listTasks();
    const liveTaskIds = tasks.map(task => task.taskId);
    const result: OrphanCleanup = {
      liveTasks: liveTaskIds.length,
      checkpointsRemoved: 0,
      archiveSegments: 0,
      goalsRemoved: 0
    };
    if (this.deps.reclaimOrphanArtifacts) {
      try {
        const reclaimed = await this.deps.reclaimOrphanArtifacts(liveTaskIds);
        result.checkpointsRemoved = reclaimed.checkpointsRemoved;
        result.archiveSegments = reclaimed.archiveSegments;
      } catch {
        // 磁盘扫描失败只报零，不能因为清不掉孤儿就把应用启动挡在门外。
      }
    }
    // 先取快照再删：listGoals() 给的是 store 里那份数组，边遍历边 splice 会跳过条目。
    for (const goal of [...this.deps.store.listGoals()]) {
      if (tasksUnderGoal(goal.goalId, tasks).length === 0 && this.deps.store.deleteGoal(goal.goalId)) {
        result.goalsRemoved += 1;
      }
    }
    if (result.checkpointsRemoved > 0 || result.archiveSegments > 0 || result.goalsRemoved > 0) {
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        level: 'info',
        message: `已清理无人认领的上下文残留：检查点 ${String(result.checkpointsRemoved)} 份、`
          + `归档段 ${String(result.archiveSegments)} 个、目标 ${String(result.goalsRemoved)} 条`
          + `（现存任务 ${String(result.liveTasks)} 条）`
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Round driving
  // -------------------------------------------------------------------------

  private touchPlanning(taskId: string) {
    this.planningActivity.set(taskId, Date.now());
  }

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
      // 规划看门狗只看「多久没有新输出」：模型一直在流正文/推理时，
      // 每一块都重置计时；只有连续静默才中止。总时长不再作为硬上限。
      const idleMs = this.deps.planningIdleMs ?? PLANNING_TIMEOUT_MS;
      this.touchPlanning(taskId);
      try {
        answer = await Promise.race([
          this.withPlanningSlot(taskId, async () => {
            const queued = this.tasks.get(taskId);
            if (queued.status === 'cancelled' || queued.status === 'failed') throw new Error('WAIT_CANCELLED');
            return this.askRound(taskId, roundId, prompt);
          }),
          new Promise<string>((_, reject) => {
            const check = () => {
              const last = this.planningActivity.get(taskId) ?? Date.now();
              const idle = Date.now() - last;
              if (idle >= idleMs) {
                this.adapterFor(taskId).cancelWait(this.tasks.getRound(roundId)?.requestId ?? '');
                this.cancelPeers(taskId);
                reject(new Error(`模型连续 ${String(Math.round(idleMs / 1000))} 秒没有输出，已停止。请重试或换模型。`));
                return;
              }
              timer = setTimeout(check, Math.max(20, idleMs - idle));
            };
            timer = setTimeout(check, idleMs);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        this.planningActivity.delete(taskId);
      }
      const afterAnswer = this.tasks.get(taskId);
      if (['paused', 'interrupted', 'cancelled', 'failed'].includes(afterAnswer.status)) {
        // 暂停/中断后到达的回答不再进入计划流程：新一轮会重新规划。
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'info',
          message: `任务已${afterAnswer.status === 'paused' ? '暂停' : afterAnswer.status === 'interrupted' ? '中断' : '结束'}，本次回答不再生成计划。`
        });
        return;
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
    // 旁听已经开始输出了，就不能在主计划可用时悄悄把评审开在它们前面：
    // 界面上会出现「模型还在输出，方案评审已进行」；评审成员还会和这些
    // 未结束的流抢 Provider 并发。先把旁听全部收尾（成功/失败/超时），
    // 再决定计划并进入评审。单个旁听最多等 PLANNING_TIMEOUT_MS；驱动层
    // 在有旁听时把整轮预算放宽同样的时间。
    const peerResults = await Promise.all(peerRuns);
    if (leadResult.ok) {
      if (this.answerUsable(taskId, roundId, leadResult.text)) return leadResult.text;
      // 主导答了，但答的东西不能当计划用（常见：模型返回缺字段的 JSON）。
      // 旁听者里只要有一份可用的，就用它——这正是「多模型并行」该有的价值，
      // 而不是把一份坏答案送去修复轮再花一次调用。换人要写明，不静默。
      for (const [index, result] of peerResults.entries()) {
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
    for (const [index, result] of peerResults.entries()) {
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
        this.touchPlanning(taskId);
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
        peer.adapter.streamIdleTimeout ? 0 : Math.min(this.tasks.get(taskId).timeoutMs, PLANNING_TIMEOUT_MS),
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

  /**
   * Engineering 历史：前序计划回答 + 已执行步骤。只给 Provider 规划器，
   * Web/CLI 不经过这里（它们的适配器没有 withContext）。
   */
  private taskContextHistory(taskId: string): ContextHistoryItem[] {
    const task = this.tasks.get(taskId);
    const history: ContextHistoryItem[] = [{
      eventId: `task:${taskId}`,
      kind: 'message',
      role: 'user',
      text: task.userPrompt,
      at: task.createdAt
    }];
    for (const round of this.tasks.listRounds(taskId)) {
      if (!round.answerText || round.status !== 'answer_ready') continue;
      history.push({
        eventId: `round:${round.roundId}`,
        kind: 'message',
        role: 'assistant',
        text: round.answerText,
        at: round.completedAt ?? round.createdAt,
        roundId: round.roundId
      });
    }
    for (const report of this.deps.store.allReportsFor(taskId)) {
      for (const [index, result] of report.results.entries()) {
        const args = result.args as { path?: unknown } | undefined;
        const file = typeof args?.path === 'string' ? ` ${args.path}` : '';
        history.push({
          eventId: `step:${report.roundId}:${result.stepId}`,
          kind: 'tool',
          text: `${result.tool} ${result.status}${file}${result.error ? ` error=${result.error}` : ''}`,
          at: report.createdAt + index,
          roundId: report.roundId,
          stepId: result.stepId,
          toolCallId: result.stepId
        });
      }
    }
    return scopeHistory('engineering', history);
  }

  /** 只在适配器支持时准备上下文；失败降级为原适配器，不阻塞规划。 */
  private async adapterWithContext(taskId: string, prompt: string): Promise<PlanningAdapter> {
    const adapter = this.adapterFor(taskId);
    const manager = this.deps.contextManager;
    if (!manager || !adapter.withContext) return adapter;
    const task = this.tasks.get(taskId);
    const runId = task.runId ?? taskId;
    const meta = adapter.contextMeta ?? { providerId: 'unknown', modelId: 'unknown' };
    try {
      const prepared = await manager.prepare({
        owner: { ownerType: 'agent-task', ownerId: taskId, taskId, runId },
        taskId,
        runId,
        question: prompt,
        context: [],
        system: [],
        history: this.taskContextHistory(taskId),
        evidenceRefs: [],
        providerId: meta.providerId,
        modelId: meta.modelId
      });
      return adapter.withContext({
        system: prepared.systemLines,
        context: prepared.contextLines
      });
    } catch (error) {
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: `规划上下文准备失败，按原请求继续：${error instanceof Error ? error.message : String(error)}`
      });
      return adapter;
    }
  }

  private async askPage(taskId: string, roundId: string, prompt: string, participantId?: string): Promise<string> {
    const attempt = async (requestId: string) => {
      const adapter = await this.adapterWithContext(taskId, prompt);
      const { snapshotBefore } = await adapter.sendMessage(prompt, requestId, chunk => {
        this.touchPlanning(taskId);
        this.deps.emit({ type: 'round.delta', at: Date.now(), taskId, roundId, streamId: requestId, modelCallId: requestId, ...(participantId ? { participantId } : {}), ...(chunk.text ? { text: chunk.text } : {}), ...(chunk.reasoning ? { reasoning: chunk.reasoning } : {}), ...(chunk.reset ? { reset: true } : {}), ...(chunk.mode ? { mode: chunk.mode } : {}), ...(chunk.providerId ? { providerId: chunk.providerId } : {}), ...(chunk.modelId ? { modelId: chunk.modelId } : {}) });
      });
      this.tasks.updateRound(roundId, { status: 'awaiting_answer' });
      return adapter.waitForAnswer(
        requestId,
        snapshotBefore,
        adapter.streamIdleTimeout ? 0 : this.tasks.get(taskId).timeoutMs,
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
          message: '模型声明完成，但尚未确认交付（计划中的检查未落到可核对的验证结论）；拒绝标记完成，改为继续修复'
        });
        if (this.repairPlan(taskId, '任务尚未确认交付：请按你设计的完成条件给出可核对的检查步骤并执行')) return;
        this.tasks.transition(taskId, 'failed', { error: '任务尚未确认交付：计划中的检查未完成或不成立' });
        this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: '任务尚未确认交付' });
        return;
      }
      this.tasks.transition(taskId, 'completed', { summary: result.summary });
      this.deps.emit({ type: 'task.completed', at: Date.now(), taskId, summary: result.summary });
      return;
    }

    // result.kind === 'plan'
    const task = this.tasks.get(taskId);
    const plan = result.plan;

    // TDL L2：多写入目标却没有 decomposition 时只保留可见警告，不触发重规划。
    // 真机试过「让模型带着原因重出」：repair 轮里模型经常只回一段裸 JSON，
    // 解析不到协议块，任务直接从「计划未分解」变成「任务失败」——代价比缺 L2 大。
    // 这里不做硬校验；缺 L2 的事实由 plan.ready 的 warnings 暴露给审批的人。

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
    const goalContract = this.ensureGoalContract(this.tasks.get(taskId), plan);
    this.emitCycleStage(taskId, 'GOAL_REASONING', 'completed');
    this.emitCycleStage(taskId, 'ANALYSIS', 'completed');
    this.emitCycleStage(taskId, 'PLANNING', 'started');
    this.emitCycleStage(taskId, 'PLANNING', 'completed');
    // 计划卡片先给出去：方案评审辩论可能要跑几分钟，让审批的人对着空白等
    // 不是产品行为。此时状态是 plan_ready 而不是 awaiting_approval，审批会
    // 被明确拒绝——「还在评审」和「可以批准了」不能长得一样。
    const gate = checkPlanCapabilities(stored.plan);
    // TDL L2：分解在审批前定稿。模型给了用模型的；没给且任务够复杂就按写入
    // 目标归纳；归纳不出来标 NEEDS_ANALYSIS，作为计划警告与日志记录。
    // 它是质量问题，不是权限问题：不能拿它推翻完全权限的自动批准。
    const decomposition = ensurePlanDecomposition(stored.plan);
    const planGate = planApprovalGate(task.permissionPreset, decomposition.needsAnalysis);
    const planPreview = toPreview(stored, [
      ...gate.missing,
      ...decompositionWarnings(decomposition)
    ]);
    if (decomposition.items.length > 0) {
      planPreview.decomposition = decomposition.items;
    }
    const seededWork = this.buildPlanWorkEvents({
      taskId,
      title: stored.plan.title || task.title || taskId,
      plan: planPreview,
      ...(task.goalId ? { goalId: task.goalId } : {}),
      ...(task.goalVersion ? { goalVersion: task.goalVersion } : {}),
      goalContract
    });
    if (seededWork.blocked) {
      planPreview.warnings = [...(planPreview.warnings ?? []), ...seededWork.reasons];
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: `GCE 分解门禁：${seededWork.reasons.join('；')}；计划保留，但不会自动批准。`
      });
    }
    if (planGate.decompositionNote) {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'warn',
        message: `TDL：${decomposition.reason}；${planGate.decompositionNote}，任务树暂无独立验收的 L2。`
      });
    }
    this.deps.emit({
      type: 'plan.ready', at: Date.now(), taskId, roundId,
      plan: planPreview
    });
    // TDL：把计划步骤落成显式分解事件，进度面板只投影这些事件（也可从 plan/step 派生兜底）。
    // 这份计划替换了上一份分解：先作废旧任务，再种新树，否则两棵树会并存、
    // 进度分母被旧步骤拖住。只有已经存在的分解才需要这一步。
    {
      const existing = rebuildWorkTasksFromEvents(taskId, this.deps.store.listEvents(taskId));
      const impacted = [...existing.values()]
        .filter(item => item.status !== 'completed' && item.status !== 'cancelled' && item.status !== 'skipped')
        .map(item => item.workTaskId);
      if (impacted.length > 0) {
        this.deps.emit({ type: 'work.breakdown.replanned', at: Date.now(), taskId, workId: taskId, impactedIds: impacted });
      }
    }
    for (const event of seededWork.events) {
      this.deps.emit(event);
    }
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
    // 做这些吗」，而这一档已经回答过了。方案评审、NEEDS_ANALYSIS 都是质量
    // 问题，照常跑、照常记警告，但不能把它们变成第二次权限申请。
    if (planGate.autoApprovePlan && !seededWork.blocked) {
      this.autoApprovePlan(taskId, roundId, stored.planId);
    } else if (planGate.autoApprovePlan && seededWork.blocked) {
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: '完全权限也没有自动批准：目标标准没有任务承接，先补齐任务分解或调整目标。'
      });
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
  /**
   * 工程上下文探索（P1-01）。
   *
   * 每条请求都先落事件（可审计「模型要过什么」），再真实读取，再把带 provenance
   * 的资源并进包里抬版本。读不到就写 warn，不把「发过请求」当成「读过工程」。
   */
  private exploreIntoPackage(input: {
    taskId: string;
    workspaceRoot?: string;
    pkg: EngineeringContextPackage;
    requests: readonly ContextRequest[];
  }): EngineeringContextPackage {
    if (!input.workspaceRoot || input.requests.length === 0) return input.pkg;
    let pkg = input.pkg;
    for (const request of input.requests) {
      this.deps.emit({ type: 'eco.context.requested', at: Date.now(), taskId: input.taskId, request });
      const kind = request.kind ?? 'FILE_READ';
      const explored = exploreContextRequest({ workspaceRoot: input.workspaceRoot, request });
      if (explored.resources.length > 0) {
        pkg = fulfillContextRequest(pkg, request, explored.resources);
      }
      const skipped = explored.skipped.slice(0, 3).map(item => `${item.path}: ${item.reason}`).join('；');
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId: input.taskId,
        level: explored.resources.length === 0 ? 'warn' : 'info',
        message:
          explored.resources.length === 0
            ? `ECO ${kind} 未取得证据：${skipped || explored.detail}`
            : `ECO ${kind}：${explored.detail}${explored.skipped.length > 0 ? `；跳过 ${String(explored.skipped.length)} 项（${skipped}）` : ''}`
      });
    }
    return pkg;
  }

  /**
   * 代码指纹：不是 git 仓库时只写「绑定过工作区」，不伪造提交号。
   *
   * 只取 HEAD 与 dirty 文件数，不算 diff 哈希：这里每次计划评审都会调用，
   * 拿整个 `git diff --binary` 去换一个哈希会在大仓库上明显拖慢规划。
   */
  private repoStateFor(workspaceRoot?: string): EngineeringContextPackage['repository'] {
    if (!workspaceRoot) return undefined;
    try {
      const options = {
        encoding: 'utf8' as const,
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'] as Array<'ignore' | 'pipe'>
      };
      const commit = execFileSync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], options).trim();
      const status = execFileSync('git', ['-C', workspaceRoot, 'status', '--porcelain'], options);
      const dirty = status.split('\n').filter(line => line.trim().length > 0).length;
      return {
        ...(commit ? { commit } : {}),
        workingTreeState: dirty > 0 ? `dirty:${String(dirty)}` : 'clean'
      };
    } catch {
      return { workingTreeState: 'bound' };
    }
  }

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
    // DMOCA：记录参与决策（人数/角色/辩论策略），不另建调度器。
    const risk = decision.risk?.level ?? assessCollaborationRisk(stored.plan).level;
    // ECO：先准备工程上下文包，正式架构/审核角色受充分度约束（旁听≠已读工程）。
    //
    // 计划本身与工作区路径只算「知道在哪」，不算读过工程：它们分别记为
    // provided_context，充分度只有在真正读到带 sha256 的文件后才可能通过。
    // 不足时先发一条补充请求，再按计划里的路径真读文件，最后抬版本重建包——
    // 这样「读了什么、读没读到」都留在事件里，而不是靠计划标题自证。
    const baseResources: ContextResourceRef[] = [
      {
        resourceId: `plan:${stored.planId}`,
        kind: 'decision',
        pathOrLabel: `plan:${stored.planId}`,
        verified: false,
        factClass: 'provided_context'
      },
      ...(task.workspaceRoot
        ? [{
            resourceId: `ws:${task.workspaceRoot}`,
            kind: 'other' as const,
            pathOrLabel: task.workspaceRoot,
            verified: false,
            factClass: 'provided_context' as const
          }]
        : [])
    ];
    // 代码指纹：包上记下当时的提交与工作树状态，恢复/重评时才判得出「包已过期」（P1-05）。
    const repoState = this.repoStateFor(task.workspaceRoot);
    // 上一轮的包如果对不上现在的代码/目标，先明确作废再重建：悄悄换一份新包会让
    // 界面以为还是同一份证据，旧包里的行号与调用关系却可能早已指向别处。
    {
      const previous = projectEcoFromEvents({ workId: taskId, events: this.deps.store.listEvents(taskId) }).package;
      if (previous) {
        const invalidation = contextInvalidation(previous, {
          ...repoState,
          goalVersion: task.goalVersion
        });
        if (invalidation.stale) {
          const voided = invalidateContextPackage(previous, invalidation.reasons.join('；'));
          this.deps.emit({
            type: 'eco.context.invalidated',
            at: Date.now(),
            taskId,
            contextPackageId: voided.contextPackageId,
            contextVersion: voided.contextVersion,
            reason: voided.invalidatedBy ?? invalidation.reasons.join('；')
          });
        }
      }
    }
    const buildPackage = (resources: ContextResourceRef[], version?: number) =>
      buildEngineeringContextPackage({
        workId: taskId,
        stage: 'planning',
        role: risk === 'L0' || risk === 'L1' ? 'planner' : 'architect',
        architectureSummary: stored.plan?.title
          ? `计划「${stored.plan.title}」相关工程上下文（编排阶段）`
          : '计划评审阶段工程上下文',
        resources,
        constraints: ['Local/Remote 范围不得静默回退', '不得将推断升级为 VERIFIED_FACT'],
        repository: repoState,
        ...(version === undefined ? {} : { version })
      });

    let ecoPackage = buildPackage(baseResources);
    if (ecoPackage.sufficiency !== 'sufficient') {
      const requestedPaths = planEvidencePaths(stored.plan.steps);
      // ① 模型主动请求（符号/调用关系/测试定位/目录/diff）。这是唯一「模型说要看什么」
      //    的入口：没有它就还是系统按路径猜。每条都真读，读不到写进日志，不假装读过。
      const planRequests: ContextRequest[] = (stored.plan.contextRequests ?? []).map((item, index) => ({
        requestId: `eco-req:${taskId}:${String(Date.now())}:plan:${String(index + 1)}`,
        workId: taskId,
        reason: item.reason,
        requiredFor: 'review',
        priority: index === 0 ? 'high' : 'normal',
        kind: item.kind,
        ...(item.paths ? { requestedPaths: item.paths } : {}),
        ...(item.directory ? { directory: item.directory } : {}),
        ...(item.symbol ? { symbol: item.symbol } : {}),
        ...(item.baseRef ? { baseRef: item.baseRef } : {})
      }));
      if (planRequests.length > 0) {
        ecoPackage = this.exploreIntoPackage({
          taskId,
          workspaceRoot: task.workspaceRoot,
          pkg: ecoPackage,
          requests: planRequests
        });
      }
      // ② 仍有缺口：按计划路径补一次「读文件」，再按工程事实补测试/目录/diff。
      if (ecoPackage.sufficiency !== 'sufficient') {
        const request = contextRequestForGaps(ecoPackage, {
          requestedPaths,
          requiredFor: 'review',
          reason:
            requestedPaths.length === 0
              ? '上下文不足：计划没有引用任何工程文件，无法核验「读过工程」'
              : `上下文不足：计划引用的 ${String(requestedPaths.length)} 个文件尚未真实读取`
        });
        if (request) {
          const before = ecoPackage;
          ecoPackage = task.workspaceRoot
            ? this.exploreIntoPackage({
                taskId,
                workspaceRoot: task.workspaceRoot,
                pkg: ecoPackage,
                requests: [{ ...request, kind: 'FILE_READ' }]
              })
            : ecoPackage;
          if (task.workspaceRoot && requestedPaths.length > 0 && ecoPackage.contextVersion === before.contextVersion) {
            // 一个都没读到：充分度不会变，必须如实说清，不能让「发过请求」看起来像「读过工程」。
            this.deps.emit({
              type: 'log',
              at: Date.now(),
              taskId,
              level: 'warn',
              message: `ECO：计划引用的 ${String(requestedPaths.length)} 个文件一个都没能核验，这些文件不计入工程证据。`
            });
          }
          const typed = contextRequestsForGaps(ecoPackage, {
            paths: requestedPaths,
            directory: requestedPaths.length > 0 ? commonDirectory(requestedPaths) : undefined,
            discoverTests: requestedPaths.length > 0,
            readDiff: repoState?.workingTreeState?.startsWith('dirty') === true,
            requiredFor: 'review'
          }).filter(item => item.kind !== 'FILE_READ' && item.kind !== 'SYMBOL_LOOKUP' && item.kind !== 'CALL_RELATION');
          if (typed.length > 0 && task.workspaceRoot) {
            ecoPackage = this.exploreIntoPackage({
              taskId,
              workspaceRoot: task.workspaceRoot,
              pkg: ecoPackage,
              requests: typed.slice(0, 2)
            });
          }
        }
      }
    }
    this.deps.emit({
      type: 'eco.context.prepared',
      at: Date.now(),
      taskId,
      package: ecoPackage
    });
    const participation = applyEcoGateToDecision(
      decideParticipation({
        workId: taskId,
        stage: 'planning',
        risk,
        candidates: (task.debateAgentIds ?? []).map(id => ({ id, available: true })),
        selectedIds: task.debateAgentIds,
        userPinned: Boolean(task.debateAgentIds && task.debateAgentIds.length > 0)
      }),
      ecoPackage.sufficiency,
      { contextVersion: ecoPackage.contextVersion }
    );
    this.deps.emit({
      type: 'model.participation.selected',
      at: Date.now(),
      taskId,
      decisionId: participation.decisionId,
      ...(participation.workTaskId ? { workTaskId: participation.workTaskId } : {}),
      ...(participation.cycleId ? { cycleId: participation.cycleId } : {}),
      stage: participation.stage,
      risk: participation.risk,
      debate: participation.debate,
      modelReview: participation.modelReview,
      maxExtraModels: participation.maxExtraModels,
      ...(participation.ecoGate ? { ecoGate: participation.ecoGate } : {}),
      participants: participation.participants.map(item => ({
        participantId: item.participantId,
        roles: item.roles,
        ...(item.blockedRoles && item.blockedRoles.length > 0 ? { blockedRoles: item.blockedRoles } : {}),
        reason: item.reason
      })),
      excluded: participation.excluded,
      reasons: [
        ...participation.reasons,
        `ECO ctx v${String(ecoPackage.contextVersion)}`,
        ...(participation.ecoGate?.formalRolesBlocked
          ? [`formalRolesBlocked=${String(participation.ecoGate.formalRolesBlocked)}`]
          : [])
      ],
      userPinned: participation.userPinned
    });
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

    // 与知识问答一致：先让主导模型写五段，再按【辩题】决定是否辩论。
    // 议题在 debatePlan 内从五段解析，这里不预造 topics。
    const plannedRounds = planReviewRounds(stored.plan, task.debateAgentIds?.length ?? 1);
    const startedAt = Date.now();
    let progressTopics: string[] = [];
    let progressGoals: string[] = [];
    let progressTarget = '';
    let progressGoal = '';
    let progressLeadSummary = '';
    const emitProgress = (state: 'started' | 'waiting' | 'done', message: string) => {
      this.deps.emit({
        type: 'plan.review.progress', at: Date.now(), taskId, roundId,
        planId: stored.planId, state, topics: progressTopics.length,
        ...(progressTopics.length > 0 ? { topicTexts: progressTopics } : {}),
        ...(progressGoals.length > 0 ? { topicGoals: progressGoals } : {}),
        ...(progressTarget ? { expressTarget: progressTarget } : {}),
        ...(progressGoal ? { expressGoal: progressGoal } : {}),
        ...(progressLeadSummary ? { leadSummary: progressLeadSummary } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
        maxRounds: plannedRounds.rounds,
        roundsReason: plannedRounds.reason,
        elapsedMs: Date.now() - startedAt, message
      });
    };
    emitProgress('started', '方案评审开始：主导模型先写【结论/一致/分歧/存疑/辩题】');
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      emitProgress(
        'waiting',
        progressLeadSummary
          ? (progressTopics.length > 0
            ? `五段结论已出（${String(progressTopics.length)} 个议题），成员表态中，已等待 ${String(seconds)} 秒`
            : `五段结论已出，主导未指定辩题，已等待 ${String(seconds)} 秒`)
          : `主导模型撰写五段结论中，已等待 ${String(seconds)} 秒`
      );
    }, 10_000);
    try {
      const live = this.tasks.get(taskId);
      // DMOCA 决策驱动派发：只请决策里留下的人；用户钉住的不裁。
      const dispatchedIds = dispatchedParticipantIds(participation, live.debateAgentIds);
      const result = await this.deps.debatePlan({
        taskId, roundId, planId: stored.planId, plan: stored.plan,
        userPrompt: live.userPrompt,
        ecoEvidence: engineeringEvidenceOf(ecoPackage),
        ...(dispatchedIds.length > 0 ? { debateAgentIds: dispatchedIds } : {}),
        onLeadReady: brief => {
          progressTopics = brief.topics;
          progressGoals = brief.topicGoals;
          progressTarget = brief.expressTarget;
          progressGoal = brief.expressGoal;
          progressLeadSummary = brief.leadSummary;
          emitProgress(
            'waiting',
            brief.topics.length > 0
              ? `五段结论已出，主导模型指定 ${String(brief.topics.length)} 个辩题`
              : '五段结论已出，主导模型未指定辩题，跳过辩论'
          );
        }
      });
      if (!result) {
        return {
          status: 'skipped', topics: [], participants: [], summary: '',
          skippedReason: '辩论没有可用成员，计划未经评审', at: Date.now()
        };
      }
      progressTopics = result.topics;
      progressGoals = result.topicGoals ?? [];
      progressTarget = result.expressTarget ?? '';
      progressGoal = result.expressGoal ?? '';
      // DMOCA：把这次交锋落成不可变贡献快照，正式决策钉住每人最后一版终稿。
      // 没有结构化交锋（老记录 / 只有摘要）时不造快照，避免假装可追溯。
      const pinned = snapshotFromExchanges({
        workId: taskId,
        participants: result.participants,
        exchanges: result.result?.exchanges ?? [],
        conclusion: result.summary,
        at: Date.now()
      });
      if (pinned.decision) {
        const integrity = assertDecisionSnapshotIntegrity(pinned.decision, pinned.artifacts);
        if (!integrity.ok) {
          this.deps.emit({
            type: 'log', at: Date.now(), taskId, level: 'warn',
            message: `DMOCA 贡献快照不完整：${integrity.issues.slice(0, 3).join('；')}`
          });
        }
        this.deps.emit({
          type: 'model.decision.snapshot',
          at: Date.now(),
          taskId,
          snapshot: pinned.decision
        });
      }
      return {
        status: result.status,
        debateId: result.debateId,
        topics: result.topics,
        ...(result.topicGoals ? { topicGoals: result.topicGoals } : {}),
        ...(result.expressTarget ? { expressTarget: result.expressTarget } : {}),
        ...(result.expressGoal ? { expressGoal: result.expressGoal } : {}),
        ...(result.leadSummary ? { leadSummary: result.leadSummary } : {}),
        participants: result.participants,
        summary: result.summary,
        ...(result.result ? { result: result.result } : {}),
        ...(typeof result.rounds === 'number' ? { rounds: result.rounds } : {}),
        ...(typeof result.maxRounds === 'number' ? { maxRounds: result.maxRounds } : {}),
        ...(result.roundsReason ? { roundsReason: result.roundsReason } : {}),
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
        ...(pinned.snapshot ? { contributionSnapshot: pinned.snapshot } : {}),
        ...(pinned.decision ? { decisionSnapshot: pinned.decision } : {}),
        at: Date.now()
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 主导模型超时/报错不是「辩论没跑起来」，而是根本没拿到五段结论：
      // 继续审批等于拿未评审的计划开工。直接抛出，让 driveRound 把任务停掉。
      if ((error as { code?: string }).code === 'LEAD_SUMMARY_FAILED') {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `方案评审停止：${detail}；按设置不降级到其它来源，任务不继续执行`
        });
        throw error;
      }
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'warn',
        message: `方案评审辩论没有完成：${detail}；计划仍可审批，但要知道它没被辩过`
      });
      return {
        status: 'skipped', topics: progressTopics, participants: [], summary: '',
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
    // 自纠也要开一轮，所以走同一道门禁；原来这里是第四处自己比轮数上限。
    if (!this.tasks.budgetView(taskId).gate.ok) return false;

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

  /**
   * 用户或系统写回单条评审问题的处理决定。
   * 拒绝/暂缓必须带非空 reason；事件落盘后由投影重建，不改写历史 review.ready。
   */
  async setReviewDisposition(input: {
    taskId: string;
    issueId: string;
    disposition: 'accepted' | 'rejected' | 'deferred' | 'pending';
    reason: string;
    roundId?: string;
  }): Promise<void> {
    this.tasks.get(input.taskId);
    const reason = input.reason.trim();
    if ((input.disposition === 'rejected' || input.disposition === 'deferred') && !reason) {
      throw new Error(input.disposition === 'rejected' ? '拒绝评审问题必须写明原因' : '暂缓评审问题必须写明条件或原因');
    }
    const events = this.deps.store.listEvents(input.taskId);
    const known = events.some(event => {
      if (event.type !== 'review.ready') return false;
      if (event.issueDetails?.some(detail => detail.issueId === input.issueId)) return true;
      return event.issues.some((text, index) => {
        const reviewIndex = events.filter(item => item.type === 'review.ready' && item.at <= event.at).length;
        const slug = text.trim().slice(0, 48).replace(/\s+/g, ' ');
        return `review:${String(reviewIndex)}:issue:${String(index)}:${slug}` === input.issueId;
      });
    });
    if (!known) throw new Error(`找不到评审问题 ${input.issueId}`);
    this.deps.emit({
      type: 'review.disposition',
      at: Date.now(),
      taskId: input.taskId,
      issueId: input.issueId,
      disposition: input.disposition,
      reason: reason || (input.disposition === 'accepted' ? '已采纳' : input.disposition === 'pending' ? '改回待决定' : reason),
      ...(input.roundId ? { roundId: input.roundId } : {})
    });
  }

  private emitAcceptedDispositions(input: {
    taskId: string;
    reviewRoundId: string;
    repairRoundId: string;
    review: {
      issues: string[];
      issueDetails?: import('../shared/contracts').ReviewIssueDetail[];
    };
  }): void {
    const { taskId, reviewRoundId, repairRoundId, review } = input;
    const details = review.issueDetails && review.issueDetails.length > 0
      ? review.issueDetails
      : null;
    if (details) {
      for (const detail of details) {
        this.deps.emit({
          type: 'review.disposition',
          at: Date.now(),
          taskId,
          roundId: reviewRoundId,
          issueId: detail.issueId,
          disposition: 'accepted',
          reason: '已并入下一轮修复计划',
          repairRoundId
        });
      }
      return;
    }
    if (review.issues.length === 0) return;
    const reviewIndex = this.deps.store.listEvents(taskId).filter(event => event.type === 'review.ready').length;
    for (const [index, text] of review.issues.entries()) {
      const slug = text.trim().slice(0, 48).replace(/\s+/g, ' ');
      this.deps.emit({
        type: 'review.disposition',
        at: Date.now(),
        taskId,
        roundId: reviewRoundId,
        issueId: `review:${String(reviewIndex)}:issue:${String(index)}:${slug}`,
        disposition: 'accepted',
        reason: '已并入下一轮修复计划',
        repairRoundId
      });
    }
  }

  /**
   * 本轮之前那份执行报告（按存储顺序），第一轮返回 null。
   *
   * 比对必须按「本轮在历史里的位置」取前一份，不能拿 `history[history.length-2]`：
   * 报告是执行完就落库的，续跑或失败重报时最后两份不一定是相邻两轮。
   */
  private previousReport(report: ExecutionReport): ExecutionReport | null {
    const history = this.deps.store.allReportsFor(report.taskId);
    const index = history.findIndex(item => item.roundId === report.roundId && item.planId === report.planId);
    return index > 0 ? history[index - 1] : null;
  }

  /**
   * 这一轮修复该不该真的开。
   *
   * 只看报告里的事实与评审的问题，不看模型自述。没有上一轮报告（第一次
   * 修复）或没有评审（用户手动点「继续修复」）时返回 null，照常开轮。
   */
  private guardRepairRound(
    report: ExecutionReport,
    review: { issues: string[] } | null,
    events: readonly AgentEvent[]
  ): RepairGateResult | null {
    if (!review) return null;
    const previous = this.previousReport(report);
    if (!previous) return null;
    const previousReview = [...events]
      .reverse()
      .find(event => event.type === 'review.ready' && event.roundId === previous.roundId);
    return shouldOpenRepairRound({
      previous: {
        facts: evidenceFacts(previous),
        issues: previousReview?.type === 'review.ready' ? previousReview.issues : []
      },
      current: { facts: evidenceFacts(report), issues: review.issues }
    });
  }

  /**
   * 种任务树并做 GCE 覆盖门禁。
   *
   * 单一 MUST 会覆盖所有 L2；多 Criterion 按关键词保守映射，匹配不上就保持
   * 未覆盖。未覆盖时计划仍可查看，但不自动批准，避免“计划完整”是假的。
   */
  private buildPlanWorkEvents(input: {
    taskId: string;
    title: string;
    plan: PlanPreview;
    goalId?: string;
    goalVersion?: number;
    goalContract?: GoalContract;
  }): { events: AgentEvent[]; blocked: boolean; reasons: string[] } {
    const events = seedWorkEventsFromPlan({
      workId: input.taskId,
      title: input.title,
      plan: input.plan,
      at: Date.now(),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.goalVersion ? { goalVersion: input.goalVersion } : {}),
      ...(input.goalContract ? { criteria: input.goalContract.criteria } : {})
    });
    if (!input.goalContract) return { events, blocked: false, reasons: [] };
    const tasks = [...rebuildWorkTasksFromEvents(input.taskId, events).values()];
    const assessment = assessGoalDecomposition(input.goalContract, tasks);
    return { events, blocked: !assessment.ok, reasons: assessment.reasons };
  }

  /** 真实阶段事件：只在流程真正进入/完成某阶段时调用，不从旧事件反推。 */
  private emitCycleStage(
    taskId: string,
    stage: GceCycleStage,
    status: 'started' | 'completed' | 'skipped',
    reason?: string
  ): void {
    this.deps.emit({
      type: status === 'started'
        ? 'cycle.stage.started'
        : status === 'completed'
          ? 'cycle.stage.completed'
          : 'cycle.stage.skipped',
      at: Date.now(),
      taskId,
      workId: taskId,
      cycleId: `cycle:${taskId}:1`,
      stage,
      ...(reason ? { reason } : {})
    });
  }

  /** 实际决策落事件；这是执行过的决策，不是建议。 */
  /**
   * 上一轮的进展状态从事件里读，不另建内存计数。
   *
   * 空转判定要是只活在内存里，进程重启一次就把「同一件事已经重复三轮」忘了，
   * 又会开始烧轮次预算——M2-2 的续跑路径正需要这一点。
   */
  private lastCycleProgress(events: readonly AgentEvent[], taskId: string): CycleProgress | null {
    const last = [...events]
      .reverse()
      .find(event => event.type === 'cycle.decision.created' && event.taskId === taskId);
    return last?.type === 'cycle.decision.created' ? last.progress : null;
  }

  /**
   * 超限的唯一落点（M3-3）：`budget_exhausted` 是可恢复态，界面上的「追加预算或结束」
   * 因此真的有路可走（`task:set-budget` → `extendBudget` → 门禁放行 → 继续规划）。
   *
   * 原来这里 transition 到 `failed`：那是终态，等于「预算用尽 = 任务判死」，
   * 与状态表里 `budget_exhausted` 那条可恢复的边互相矛盾，而且那条边没人走所以是死代码。
   */
  private pauseOnBudget(taskId: string, reason: string): void {
    const task = this.tasks.get(taskId);
    const error = `预算已用尽（${reason}），任务暂停等你追加预算或选择收口`;
    if (task.status !== 'budget_exhausted') {
      this.tasks.transition(taskId, 'budget_exhausted', { error, resumeStatus: undefined });
    } else {
      this.tasks.patch(taskId, { error });
    }
    this.deps.emit({
      type: 'task.budget.exhausted',
      at: Date.now(),
      taskId,
      reason,
      budget: task.budget ?? null,
      budgetUsage: this.tasks.budgetView(taskId).state.usage
    });
    this.deps.emit({
      type: 'log',
      at: Date.now(),
      taskId,
      level: 'warn',
      message: `预算门禁：${error}`
    });
  }

  /**
   * 判定 + 落事件在同一处：事件里记的既是纯函数的输出，也是它看到的输入
   * （诊断、进展计数、目标证据、预算），事后核对时不存在「事件说 A、代码判 B」的空间。
   *
   * M3-3：预算不再由调用方算好塞进来。三处各写一遍「轮数够不够」的结果是没人说得清
   * 「这一轮到底用了多少」，而且事件里的 used/limit 与判定用的布尔可以
   * 悄悄不一致。现在两处都取自同一次 `tasks.budgetView()` 核算——判定看到的超限、
   * 事件记下的 exceeded 清单、界面显示的比例，是同一份数。
   */
  private decideAndEmit(
    taskId: string,
    roundId: string,
    input: Omit<CycleDecisionInput, 'budget'>,
    evidenceRefs: string[]
  ): CycleDecisionResult {
    const view = this.tasks.budgetView(taskId);
    const budget: CycleDecisionInput['budget'] = {
      atMaxRounds: view.state.exceeded.includes('rounds'),
      tokenExhausted: view.state.exceeded.includes('tokens'),
      roundUsed: view.state.usage.rounds,
      roundLimit: view.state.limits.maxRounds,
      exceeded: view.state.exceeded,
      note: view.gate.reason
    };
    const decision = decideCycleAction({ ...input, budget });
    this.deps.emit({
      type: 'cycle.decision.created',
      at: Date.now(),
      taskId,
      workId: taskId,
      cycleId: `cycle:${taskId}:1`,
      roundId,
      decisionType: decision.decision,
      reason: decision.reason,
      evidenceRefs,
      nextAction: decision.nextAction,
      requiresUser: decision.requiresUser,
      targetStage: decision.targetStage,
      diagnosis: input.diagnosis,
      progress: input.progress,
      // 记的是判定**用上**的分类：非空转判定这里是 null，不拿输入里的分类冒充。
      noProgressCause: decision.noProgressCause,
      goalFit: input.goalFit
        ? {
            fit: input.goalFit.fit,
            met: input.goalFit.met,
            unmet: input.goalFit.unmet,
            unverified: input.goalFit.unverified,
            blockingRisks: [...input.goalFit.blockingRisks]
          }
        : null,
      budget: {
        atMaxRounds: budget.atMaxRounds,
        exceeded: [...budget.exceeded ?? []],
        unknowns: [...view.state.unknowns],
        roundUsed: budget.roundUsed ?? null,
        roundLimit: budget.roundLimit ?? null,
        note: budget.note
      }
    });
    return decision;
  }

  /**
   * 计划生成时建立目标契约；后续计划不静默改写已确认的标准。
   *
   * 用户显式标准来自任务绑定目标（USER_EXPLICIT），计划 completion.condition
   * 只能作为模型推断的标准。没有标准就不生成，Goal Fit 保持 UNKNOWN。
   */
  private ensureGoalContract(task: AgentTask, plan: AgentPlan): GoalContract {
    if (task.goalContract) {
      const known = new Set(task.goalContract.criteria.map(item => item.description.trim()));
      const condition = plan.completion?.condition?.trim();
      if (condition && !known.has(condition)) {
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId: task.taskId,
          level: 'warn',
          message: `GCE：本轮计划的完成条件与已建立目标不同（「${condition.slice(0, 120)}」）；不静默改写用户目标，只把本轮执行证据记到既有标准下。`
        });
      }
      return task.goalContract;
    }
    const contract = goalContractFromPlan({
      taskId: task.taskId,
      userPrompt: task.userPrompt,
      ...(task.goalId ? { goalId: task.goalId } : {}),
      ...(task.goalVersion ? { goalVersion: task.goalVersion } : {}),
      ...(task.goalCriteria ? { goalCriteria: task.goalCriteria } : {}),
      planTitle: plan.title,
      planDescription: plan.description,
      ...(plan.completion?.condition ? { completionCondition: plan.completion.condition } : {})
    });
    this.tasks.patch(task.taskId, { goalContract: contract });
    this.deps.emit({
      type: 'goal.contract.updated',
      at: Date.now(),
      taskId: task.taskId,
      contract
    });
    return contract;
  }

  private async continueAfterReport(
    taskId: string,
    report: ExecutionReport,
    review: {
      reviewer: string;
      verdict: string;
      issues: string[];
      needsFix: boolean;
      issueDetails?: import('../shared/contracts').ReviewIssueDetail[];
    } | null = null
  ): Promise<void> {
    const task = this.tasks.get(taskId);

    // 验证未通过时，即使报告自报 completed / nextAction=complete，也不能
    // 直接收尾。完全权限下会走到这里进入下一轮修复；这是「全部完成后才
    // 算好」的底线，不能因为报告文字写完成就跳过。
    //
    // 已确认交付时：评审没有可执行问题（needsFix/issues 都空），即使
    // nextAction 仍写 continue，也直接收尾——否则会再开一轮规划，被非法
    // 协议块拖成 failed，结果面板出现「像完成又像失败」的残缺状态
    // （真机 2026-11-24：只读列目录已验证通过，仍因 continue 进入修复轮失败）。
    const actionableReview =
      Boolean(review?.needsFix) || (review?.issues?.length ?? 0) > 0;
    const reports = [...this.deps.store.allReportsFor(taskId), report];
    const genuineDelivery = hasGenuineDelivery(reports);
    // Computer Use：桌面动作链未收口时不得 complete（与 main 闸门一致）。
    const desktopStillOpen = desktopActionStillOpen(task.userPrompt, report.results);

    // GDC：用既有事件派生循环结论，再决定 complete / repair / fail_*。
    // 不另建状态机；决策落点发 cycle.snapshot / goal.fit 供 UI 与重放对账。
    const priorEvents = this.deps.store.listEvents(taskId);
    // TDL：每个 L2 的独立循环与跨子任务冲突（P1-02）。失败只影响依赖者，
    // 这里只负责把「哪些子任务过了、哪些没过、哪里撞车了」变成可核对的事实。
    const subtaskTasks = [...rebuildWorkTasksFromEvents(taskId, priorEvents).values()];
    const subtaskCycles = projectSubtaskCyclesFromEvents({
      workId: taskId,
      tasks: subtaskTasks,
      events: priorEvents
    });
    const subtaskIntegration = integrateSubtaskCycles(subtaskCycles.cycles);
    const subtaskConflicts = detectSubtaskConflicts({
      cycles: subtaskCycles.cycles,
      results: report.results.map(item => ({
        stepId: item.stepId,
        tool: item.tool,
        ...(item.args ? { args: item.args } : {})
      }))
    });
    if (subtaskConflicts.length > 0) {
      this.deps.emit({
        type: 'cycle.subtask.conflict',
        at: Date.now(),
        taskId,
        conflicts: subtaskConflicts
      });
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: `TDL：发现 ${String(subtaskConflicts.length)} 处跨子任务写冲突——${subtaskConflicts
          .slice(0, 3)
          .map(item => item.reason)
          .join('；')}`
      });
    }
    const workbench = projectGoalDrivenWorkbench({
      workId: taskId,
      originalRequest: task.userPrompt,
      events: priorEvents,
      summary: task.summary,
      status: task.status
    });
    // 当前报告/评审尚未全部进 listEvents 时，用即时标志修正结论类型。
    if (
      (actionableReview || desktopStillOpen) &&
      workbench.cycle.conclusionType === 'in_progress'
    ) {
      workbench.cycle.conclusionType = 'needs_fix';
      workbench.cycle.nextAction = desktopStillOpen
        ? '继续完成未收口的桌面操作'
        : '处理评审问题或进入修复轮';
    }
    // GCE：先按目标契约逐条判定，再决定执行/验证完成是否等于目标达成。
    // 没有契约时保持旧行为，但不伪造 met。
    const activePlan = task.currentPlanId
      ? this.deps.store.getPlan(task.currentPlanId)
      : this.deps.store.getPlan(report.planId);
    const goalContract = activePlan
      ? this.ensureGoalContract(this.tasks.get(taskId), activePlan.plan)
      : this.tasks.get(taskId).goalContract;
    const goalReports = this.deps.store.allReportsFor(taskId);
    const goalAssessment = goalContract
      ? assessReportsAgainstGoal({
          contract: goalContract,
          reports: goalReports.length > 0 ? goalReports : [report],
          at: Date.now()
        })
      : null;
    if (goalAssessment) {
      this.tasks.patch(taskId, { goalContract: goalAssessment.contract });
      this.deps.emit({
        type: 'goal.contract.updated',
        at: Date.now(),
        taskId,
        contract: goalAssessment.contract
      });
    }
    const goalFitEvent = goalAssessment
      ? legacyGoalFitEvent(goalAssessment.contract, goalAssessment.fit)
      : null;
    // M3-1：判定只有一个出口。执行层只把事实摆进输入——验证收口没有、交付有没有证据、
    // 桌面收口没有、修复闸门停没停、这一轮比上一轮多了什么——结论与实际落点都出自
    // `decideCycleAction`。以前这里先让执行层判一遍四出口、再按标签映射一遍行为，
    // 两处判定不在同一个条件上，事件里的标签和实际发生的事可以各说各话。
    const autoApprove = approvalPolicyFor(this.tasks.get(taskId).permissionPreset).autoApprovePlan;
    const repairGate = this.guardRepairRound(report, review, priorEvents);
    // 逐条判定后的契约才是这一轮的判据；任务记录上的那份可能还是上一轮的。
    const liveContract = goalAssessment?.contract ?? goalContract ?? null;
    const linkedCriteria = new Set(
      (goalAssessment?.links ?? [])
        .map(link => link.criterionId)
        .filter((id): id is string => typeof id === 'string')
    );
    const errorCodes = report.errors.map(item => item.code.split(':')[0]?.trim() ?? item.code);
    const diagnosis = deriveCycleDiagnosis({
      goalFit: goalAssessment?.fit ?? null,
      // 「覆盖不到」= 契约里的标准没有任何一条证据链指向它。
      uncoveredCriteria: liveContract
        ? liveContract.criteria.filter(item => !linkedCriteria.has(item.criterionId)).length
        : 0,
      verification: report.verification?.checks
        ? {
            compile: report.verification.checks.compile.status,
            run: report.verification.checks.run?.status,
            tests: report.verification.checks.tests.status
          }
        : null,
      reportStatus: report.status,
      failedSteps: report.results.filter(item => item.status === 'failed').length,
      errorCodes,
      reviewIssues: review?.issues.length ?? 0
    });
    // 空转的分类只取自两轮报告的硬事实（错误码、执行条数、同命令同退出码的条数），
    // 不看模型自述：真机上出现过「报告说换了思路、交回来的命令一字未改」。
    const previousReport = this.previousReport(report);
    const repeats = repeatedCommands(previousReport, report);
    const noProgressCause = deriveNoProgressCause({
      errorCodes,
      steps: report.results.length,
      evidence: report.evidence?.refs.length ?? 0,
      repeatedCommands: repeats.length
    });
    const limits = cycleNoProgressLimits(this.deps.noProgressLimits?.() ?? null);
    const progress = detectNoProgress({
      previous: this.lastCycleProgress(priorEvents, taskId),
      fingerprint: cycleFingerprint(evidenceFacts(report)),
      criterionKey: openCriteriaKey(liveContract),
      repeatLimit: limits.repeatLimit,
      criteriaLimit: limits.criteriaLimit
    });
    const cycleDecision = this.decideAndEmit(
      taskId,
      report.roundId,
      {
        ...(liveContract ? { goalStatus: liveContract.status } : {}),
        goalFit: goalAssessment?.fit ?? null,
        delivery: deliveryFromReport(report, goalAssessment?.fit.fit ?? 'UNKNOWN'),
        review: {
          needsFix: Boolean(review?.needsFix),
          blockingIssues: (review?.issueDetails ?? []).filter(
            item => item.severity === 'high' && item.disposition !== 'rejected'
          ).length,
          unresolved: (review?.issueDetails ?? []).filter(
            item => item.disposition === 'pending' || item.disposition === 'deferred'
          ).length
        },
        task: {},
        progress,
        diagnosis,
        noProgressCause,
        gates: {
          deliveryUnconfirmed: !genuineDelivery,
          desktopOpen: desktopStillOpen,
          ...(repairGate
            ? { repairBlocked: !repairGate.open, repairBlockedReason: repairGate.reason }
            : {}),
          risksAccepted: autoApprove
        }
      },
      [
        ...(goalAssessment?.links.map(item => item.evidenceId) ?? []),
        ...(report.evidence?.refs.map(ref =>
          ref.kind === 'file'
            ? `file:${ref.path}`
            : ref.kind === 'command'
              ? `cmd:${ref.command}#${String(ref.exitCode)}`
              : `url:${ref.url}`
        ) ?? [])
      ]
    );
    const nextAction = cycleDecision.nextAction;
    const finished = nextAction === 'finish_completed';
    // snapshot 的阶段/结论/下一步全部取自同一条决策：以前这里按本地 `decision`
    // 再拼一遍，和事件里的标签是两处判定，改一处忘一处就会对不上。
    const snapshotStage = finished ? 'done' : workbench.cycle.currentStage;
    const snapshotConclusion = finished
      ? (actionableReview ? 'accepted_with_risks' : 'accepted')
      : nextAction === 'stop_and_wait' || nextAction === 'pause_budget'
        ? 'blocked'
        : workbench.cycle.conclusionType;
    const snapshotNext = finished
      ? '无需下一轮；可做整体验收'
      : cycleDecision.reason;
    this.deps.emit({
      type: 'cycle.snapshot',
      at: Date.now(),
      taskId,
      cycleId: workbench.cycle.cycleId,
      cycleNumber: workbench.cycle.cycleNumber,
      currentStage: snapshotStage,
      conclusionType: snapshotConclusion,
      nextAction: snapshotNext,
      debateSkipped: workbench.cycle.debateSkipped,
      decision: legacyDecisionOf(cycleDecision.decision),
      budget: workbench.cycle.budget
    });
    this.deps.emit({
      type: 'goal.fit',
      at: Date.now(),
      taskId,
      ...(goalFitEvent ?? {
        fit: workbench.goal.fit,
        notes: workbench.goal.fitNotes
      })
    });

    if (nextAction === 'stop_and_wait') {
      // 停在这里的三种原因（目标缺口、修复闸门关闭、计划待确认）都由决策说清楚，
      // 这里不再分情况另判。状态留在 report_pending：那里本来就有「接受未验证」
      // 「继续修复」两个出口，不新造一个只能干等的状态。
      this.deps.emit({
        type: 'log',
        at: Date.now(),
        taskId,
        level: 'warn',
        message: `GDC 停在待确认：${cycleDecision.reason}`
      });
      this.emitCycleStage(taskId, 'CONCLUSION', 'completed', '未形成可交付结论，停在待确认');
      this.emitCycleStage(taskId, 'NEXT_DECISION', 'started');
      this.emitCycleStage(taskId, 'NEXT_DECISION', 'completed', '等待用户决定继续修复或接受缺口');
      this.tasks.patch(taskId, {
        error: `${cycleDecision.reason}。可以「接受未验证」收尾，或改清楚需求后重新开始。`
      });
      return;
    }

    if (nextAction === 'abort') {
      this.tasks.transition(taskId, 'cancelled', { error: cycleDecision.reason });
      this.deps.emit({ type: 'task.cancelled', at: Date.now(), taskId });
      return;
    }

    if (finished) {
      // 完全权限下的「修复闸门已停」等于风险已接受：摘要必须写明还有未验证缺口，
      // 不能和正常完成共用一句「执行完成，验证通过」。
      const repairStopped = Boolean(repairGate && !repairGate.open);
      this.emitCycleStage(taskId, 'CONCLUSION', 'completed', '已形成交付结论');
      this.emitCycleStage(taskId, 'GOAL_FIT', 'started');
      this.emitCycleStage(taskId, 'GOAL_FIT', 'completed');
      this.emitCycleStage(taskId, 'NEXT_DECISION', 'started');
      this.emitCycleStage(taskId, 'NEXT_DECISION', 'completed', '任务收尾，无需下一轮');
      const gceFit = goalAssessment?.fit.fit;
      const summary = repairStopped
        ? '执行完成（存在未验证缺口；完全权限按风险接受，未再开修复轮）'
        : gceFit === 'MET'
          ? (report.errors.length === 0 ? '执行完成，验证通过，目标标准已满足' : '执行完成，目标标准已满足')
          : gceFit === 'WITH_RISKS'
            ? '执行完成（目标带风险达成：存在未验证或豁免项）'
            : gceFit
              ? '执行完成（目标尚未完全验证，不以执行完成冒充达成）'
              : (report.errors.length === 0 ? '执行完成，验证通过' : '执行完成');
      if (repairStopped) {
        this.deps.emit({
          type: 'log',
          at: Date.now(),
          taskId,
          level: 'warn',
          message: `GDC 停止自动修复：${repairGate?.reason ?? '两轮之间没有新证据'}；完全权限：不再询问，按接受未验证收尾。`
        });
      }
      this.tasks.transition(taskId, 'completed', { summary });
      this.deps.emit({ type: 'task.completed', at: Date.now(), taskId, summary });
      return;
    }

    if (nextAction === 'fail_delivery') {
      this.emitCycleStage(taskId, 'CONCLUSION', 'completed', '未确认交付');
      this.emitCycleStage(taskId, 'NEXT_DECISION', 'completed', '停止：交付条件不成立');
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'warn',
        message: `GDC：${cycleDecision.reason}；拒绝标记完成`
      });
      this.tasks.transition(taskId, 'failed', { error: '任务尚未确认交付：计划中的检查未完成或不成立' });
      this.deps.emit({ type: 'task.failed', at: Date.now(), taskId, error: '任务尚未确认交付' });
      return;
    }

    if (nextAction === 'pause_budget') {
      this.emitCycleStage(taskId, 'CONCLUSION', 'completed', '预算用尽，暂停等你追加预算');
      this.emitCycleStage(taskId, 'NEXT_DECISION', 'completed', '暂停：预算门禁拦下再开一轮');
      // 与恢复路径同一个落点：状态、事件、理由都由 pauseOnBudget 一处产出，
      // 不再在这里 transition 到 `failed`（终态，加完预算接不回去）。
      this.pauseOnBudget(taskId, this.tasks.budgetView(taskId).gate.reason);
      return;
    }

    // nextAction === 'open_next_round'
    // 下一轮干什么，跟着决策标签写。原来这里三处都写死「修复」：空转轮判的是 REPLAN
    // （要改的是计划与手段），界面却显示「进入下一轮修复」，事件与活动流就对不上。
    const roundPurpose: Partial<Record<typeof cycleDecision.decision, string>> = {
      CONTINUE: '继续当前阶段未完成的步骤',
      REPAIR: '按评审与验证问题修复',
      REPLAN: '重做计划与手段',
      REDESIGN: '重做方案设计',
      REANALYZE: '补足事实后重做分析'
    };
    const purpose = roundPurpose[cycleDecision.decision] ?? `按 ${cycleDecision.decision} 推进`;
    this.emitCycleStage(taskId, 'NEXT_DECISION', 'started');
    this.emitCycleStage(taskId, 'NEXT_DECISION', 'completed', `进入下一轮：${purpose}`);
    this.emitCycleStage(taskId, 'PLANNING', 'started', `下一轮重新规划（${purpose}）`);
    this.tasks.transition(taskId, 'awaiting_next_round');
    this.tasks.transition(taskId, 'planning');

    // 下一轮干什么必须进计划请求，否则「重做」只是把同一个计划重新生成一遍。
    // 这里显式记一条，界面上能看出这一轮是修什么、还是换手段。
    const idleNote = cycleDecision.noProgressCause
      ? `（连续无进展·${CYCLE_NO_PROGRESS_CAUSE_TEXT[cycleDecision.noProgressCause]}，已把「不得重复」的命令清单并进计划请求）`
      : '';
    if (review && review.issues.length > 0) {
      // 下一轮要不要人点，由权限预设决定：完全权限下说「仍需重新批准」是错的，
      // 那一档的计划会自动执行。
      const needsClick = !approvalPolicyFor(this.tasks.get(taskId).permissionPreset).autoApprovePlan;
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: review.needsFix ? 'warn' : 'info',
        message: `GDC 下一轮=${cycleDecision.decision.toLowerCase()}：${review.reviewer} 指出 ${String(review.issues.length)} 项问题，已并入下一轮计划请求${needsClick ? '（仍需你重新批准）' : '（完全权限：下一轮计划会自动执行）'}${idleNote}`
      });
    } else {
      this.deps.emit({
        type: 'log', at: Date.now(), taskId, level: 'info',
        message: `GDC 下一轮=${cycleDecision.decision.toLowerCase()}：${purpose}${idleNote || `（${workbench.cycle.nextAction}）`}`
      });
    }

    const round = this.tasks.createRound({ taskId, inputType: 'execution_report', requestText: '' });
    // 子任务循环：把「哪些过了、哪些没过」写进下一轮，避免整条工程从头再跑一遍。
    const subtaskScope = subtaskCycles.cycles.length > 0
      ? {
          label: subtaskIntegration.summary,
          notes: [
            `只做未通过的子任务：${subtaskCycles.cycles
              .filter(item => item.verdict === 'failed' || item.verdict === 'blocked')
              .map(item => item.title)
              .join('、') || '（没有失败/受阻的子任务，按评审问题修复）'}`,
            `已通过的 ${String(subtaskIntegration.accepted)} 个子任务不要重跑，也不要重复写入同样的内容`,
            ...(subtaskConflicts.length > 0
              ? [`跨子任务写冲突待处理：${subtaskConflicts.map(item => item.path).join('、')}`]
              : [])
          ]
        }
      : null;
    const prompt = buildReportPrompt({
      taskId,
      roundId: round.roundId,
      report,
      review,
      // 空转判定要随计划请求下发：只在事件里记「不要重复」，下一轮拿到的还是同一份报告，
      // REPLAN 就只是个标签。清单点名到命令 + 退出码，模型换没换做法事后能核对。
      noProgress: cycleDecision.noProgressCause
        ? { reason: cycleDecision.reason, commands: repeats.slice(0, 8) }
        : null,
      ...(subtaskScope ? { subtaskScope } : {})
    });
    this.tasks.updateRound(round.roundId, { requestText: prompt, status: 'sending' });

    // 进入修复轮即视为采纳这些问题：写 disposition 事件，投影才能从 pending 变成 accepted。
    if (review && (review.issueDetails?.length || review.issues.length > 0)) {
      this.emitAcceptedDispositions({
        taskId,
        reviewRoundId: report.roundId,
        repairRoundId: round.roundId,
        review
      });
    }

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
      if (task.status === 'paused' || task.status === 'interrupted') {
        this.deps.emit({
          type: 'log', at: Date.now(), taskId, level: 'warn',
          message: `任务已${task.status === 'paused' ? '暂停' : '中断'}，忽略在途失败：${message}`
        });
        return;
      }
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
    ...(stored.plan.decomposition && stored.plan.decomposition.length > 0
      ? {
          decomposition: stored.plan.decomposition.map(item => ({
            id: item.id,
            title: item.title,
            ...(item.description ? { description: item.description } : {}),
            ...(item.acceptanceCriteria && item.acceptanceCriteria.length > 0
              ? { acceptanceCriteria: item.acceptanceCriteria }
              : {}),
            stepIds: [...item.stepIds]
          }))
        }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}
