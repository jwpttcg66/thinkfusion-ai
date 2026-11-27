/**
 * Goal-Driven Cycle（GDC）投影层。
 *
 * 展示派生视图，不是第二套权威状态：从 ConversationGoal / 任务摘要 / AgentEvent
 * 重建目标、循环阶段、产物与下一步。执行仍走 Orchestrator + Journal。
 */

import type { AgentEvent } from './contracts';
import type { ConversationGoal } from './conversation';
import { CODING_BUDGET } from './coding-workflow';
import { impactedByReplan, isTerminalWorkStatus, type WorkTask } from './task-decomposition';

export type GoalStatusGdc =
  | 'draft'
  | 'clarifying'
  | 'confirmed'
  | 'active'
  | 'at_risk'
  | 'change_proposed'
  | 'blocked'
  | 'achieved'
  | 'abandoned';

export type GoalChangeKind = 'clarify' | 'optimize' | 'change';

export type CycleStage =
  | 'goal_reasoning'
  | 'analysis'
  | 'design'
  | 'design_debate'
  | 'planning'
  | 'implementation'
  | 'review'
  | 'review_debate'
  | 'conclusion'
  | 'done';

export type CycleConclusionType =
  | 'accepted'
  | 'accepted_with_risks'
  | 'needs_fix'
  | 'needs_review'
  | 'needs_redesign'
  | 'needs_analysis'
  | 'unresolved'
  | 'blocked'
  | 'aborted'
  | 'in_progress';

export type GoalFitStatus = 'pending' | 'met' | 'gap' | 'unknown';

export type ArtifactKindGdc =
  | 'goal'
  | 'analysis'
  | 'design'
  | 'debate'
  | 'plan'
  | 'implementation'
  | 'review'
  | 'review_debate'
  | 'conclusion'
  | 'other';

export type ArtifactStatusGdc = 'draft' | 'accepted' | 'rejected' | 'superseded' | 'archived';

export interface GoalCriterionView {
  criterionId: string;
  description: string;
  priority: 'MUST' | 'SHOULD' | 'NICE';
  status: string;
  evidenceRefs: string[];
}

export interface EngineeringGoalView {
  goalId: string;
  workId: string;
  originalRequest: string;
  intent: string;
  desiredOutcome: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
  openQuestions: string[];
  goalVersion: number;
  status: GoalStatusGdc;
  fit: GoalFitStatus;
  fitNotes: string[];
  source: 'conversation' | 'task' | 'derived';
  /** GCE：逐条 Criterion；旧任务没有时为空。 */
  criteria?: GoalCriterionView[];
  /** GCE 新口径；旧 fit 无法表达 WITH_RISKS / PARTIAL。 */
  gceFit?: import('./goal-contract').GoalContractFit;
}

export interface WorkCycleView {
  cycleId: string;
  workId: string;
  cycleNumber: number;
  status: 'running' | 'completed' | 'blocked' | 'aborted';
  currentStage: CycleStage;
  stages: Array<{ stage: CycleStage; status: 'pending' | 'active' | 'done' | 'skipped'; reason?: string }>;
  entryReason: string;
  conclusionType: CycleConclusionType;
  conclusionSummary: string;
  nextAction: string;
  debateSkipped: boolean;
  reviewDebateSkipped: boolean;
  rollback?: { from: CycleStage; to: CycleStage; reason: string };
  budget: {
    maxIterations: number;
    roundCount: number;
    nearLimit: boolean;
  };
}

export interface WorkArtifactRef {
  artifactId: string;
  workId: string;
  cycleId: string;
  artifactType: ArtifactKindGdc;
  version: number;
  status: ArtifactStatusGdc;
  label: string;
  eventType?: string;
  eventAt?: number;
  supersedesArtifactId?: string;
}

export interface WorkDecisionRef {
  decisionId: string;
  workId: string;
  cycleId: string;
  decisionType: string;
  decision: string;
  rationale: string;
  eventAt?: number;
}

export interface GoalDrivenWorkbenchView {
  workId: string;
  goal: EngineeringGoalView;
  cycle: WorkCycleView;
  artifacts: WorkArtifactRef[];
  decisions: WorkDecisionRef[];
  projectedAt: number;
}

/**
 * 编排器用的下一动作：把循环结论落到执行决策。
 * 不替代 TaskGrant / 验证闸门，只统一「完成 / 修复 / 预算耗尽」分支命名。
 */
export function decideNextEngineeringAction(input: {
  cycle: WorkCycleView;
  verifiedDone: boolean;
  actionableReview: boolean;
  atMaxRounds: boolean;
  genuineDelivery: boolean;
}): 'complete' | 'repair' | 'fail_budget' | 'fail_delivery' {
  if (input.verifiedDone && !input.actionableReview) {
    return input.genuineDelivery ? 'complete' : 'fail_delivery';
  }
  if (input.atMaxRounds) return 'fail_budget';
  if (input.cycle.conclusionType === 'needs_fix' || input.actionableReview) return 'repair';
  if (input.verifiedDone) return input.genuineDelivery ? 'complete' : 'fail_delivery';
  return 'repair';
}

/** 实质变更才抬升 goalVersion；澄清/优化路径不变。 */
export function applyGoalVersionBump(previousVersion: number, kind: GoalChangeKind): number {
  const base = Number.isFinite(previousVersion) && previousVersion > 0 ? Math.floor(previousVersion) : 1;
  return kind === 'change' ? base + 1 : base;
}

/** 目标变更分类：缩小成功标准 → change（禁止静默降级当 clarify）。 */
export function classifyGoalChange(input: {
  previousCriteria: readonly string[];
  nextCriteria: readonly string[];
  userConfirmedChange?: boolean;
}): GoalChangeKind {
  const prev = new Set(input.previousCriteria.map(item => item.trim()).filter(Boolean));
  const next = new Set(input.nextCriteria.map(item => item.trim()).filter(Boolean));
  let removed = 0;
  for (const item of prev) {
    if (!next.has(item)) removed += 1;
  }
  let added = 0;
  for (const item of next) {
    if (!prev.has(item)) added += 1;
  }
  if (removed > 0 && !input.userConfirmedChange) return 'change';
  if (added > 0 && removed === 0) return 'clarify';
  if (added === 0 && removed === 0) return 'optimize';
  return input.userConfirmedChange ? 'change' : 'change';
}

/**
 * 目标修订的比较基线。
 *
 * 计划生成时建立契约但未必写回 `task.goalCriteria`；界面展示的是契约里的
 * Criterion。若仍拿空的 `goalCriteria` 当基线，用户删掉契约里已有的标准会
 * 被当成「只补充」，既不抬版本也不要求确认。契约存在时必须以契约为准。
 */
export function revisionBaselineCriteria(input: {
  contractCriteria?: readonly string[];
  goalCriteria?: readonly string[];
}): string[] {
  const fromContract = (input.contractCriteria ?? []).map(item => item.trim()).filter(Boolean);
  if (fromContract.length > 0) return fromContract;
  return (input.goalCriteria ?? []).map(item => item.trim()).filter(Boolean);
}

/**
 * 目标修订 → 版本与任务影响（P0-03）。
 *
 * 目标变更不能只改一句 userPrompt：已完成的成果要能继承，未完成的任务要
 * 局部重规划，旧版本任务不能冒充新目标交付。这里给出确定性判断，写事件
 * 仍由 Orchestrator 走正式 work.task.upserted / work.breakdown.replanned。
 */
export interface GoalRevisionPlan {
  kind: GoalChangeKind;
  nextVersion: number;
  versionChanged: boolean;
  /** 缩小成功标准属于重大变更，未经用户确认不得直接生效。 */
  requiresUserConfirmation: boolean;
  impactedTaskIds: string[];
  inheritedTaskIds: string[];
  reason: string;
}

export function planGoalRevision(input: {
  tasks: readonly WorkTask[];
  previousVersion: number;
  previousCriteria: readonly string[];
  nextCriteria: readonly string[];
  userConfirmedChange?: boolean;
  /** 已知受影响的子任务；缺省时目标变更视为影响全部未完成任务。 */
  changedTaskIds?: readonly string[];
}): GoalRevisionPlan {
  const kind = classifyGoalChange({
    previousCriteria: input.previousCriteria,
    nextCriteria: input.nextCriteria,
    ...(input.userConfirmedChange === undefined ? {} : { userConfirmedChange: input.userConfirmedChange })
  });
  const nextVersion = applyGoalVersionBump(input.previousVersion, kind);

  if (kind !== 'change') {
    return {
      kind,
      nextVersion,
      versionChanged: nextVersion !== input.previousVersion,
      requiresUserConfirmation: false,
      impactedTaskIds: [],
      inheritedTaskIds: input.tasks.map(task => task.workTaskId),
      reason: kind === 'clarify'
        ? '目标澄清：成功标准只是补充，不构成版本变更'
        : '目标优化：成功标准未增删，保持现有任务版本'
    };
  }

  const seeds = input.changedTaskIds && input.changedTaskIds.length > 0
    ? [...input.changedTaskIds]
    : input.tasks.filter(task => !isTerminalWorkStatus(task.status)).map(task => task.workTaskId);
  const impactedTaskIds = impactedByReplan(input.tasks, seeds);
  const impacted = new Set(impactedTaskIds);
  const inheritedTaskIds = input.tasks
    .filter(task => !impacted.has(task.workTaskId))
    .map(task => task.workTaskId);

  return {
    kind,
    nextVersion,
    versionChanged: nextVersion !== input.previousVersion,
    requiresUserConfirmation: input.userConfirmedChange !== true,
    impactedTaskIds,
    inheritedTaskIds,
    reason: seeds.length === 0
      ? '目标变更，但没有未完成任务需要重规划'
      : `目标变更影响 ${String(impactedTaskIds.length)} 个未完成任务；已完成且不受影响的成果可继承`
  };
}

/**
 * 待确认的目标变更（V4 M1-3）。
 *
 * Orchestrator 在 `requiresUserConfirmation` 时发 `goal.revision.pending`，
 * 界面上要显示的是事件里那份原话，而不是再算一遍——两边算法一旦漂移，
 * 用户确认的内容和真正落库的内容就不是同一件事了。
 */
export interface GoalRevisionPendingEvent {
  type: 'goal.revision.pending';
  taskId: string;
  goalId: string;
  fromVersion: number;
  nextVersion: number;
  reason: string;
  nextCriteria: string[];
  impactedTaskIds: string[];
  impactedTasks: { workTaskId: string; title: string; status: string }[];
  inheritedCount: number;
  at: number;
}

export function isGoalRevisionPendingEvent(event: { type: string }): event is GoalRevisionPendingEvent {
  return event.type === 'goal.revision.pending';
}

/**
 * 从事件流里投影出「还压在用户这儿没确认」的那一条。
 *
 * 只看时间最新的一条 pending：更早的那条要么已被确认，要么已被更新的修订盖掉。
 * 任务版本已经追平或超过 `nextVersion` 就认为这条已经生效/过期，不再弹卡片——
 * 否则用户确认完之后每次进来都被问一遍同一件事。
 * 用户点「取消」时后端什么都没写，所以版本没变，重进任务卡片会再出现：
 * 这次变更确实还没处理，不把它假装掉。
 */
export function projectPendingGoalRevision<T extends GoalRevisionPendingEvent>(input: {
  events: readonly T[];
  currentVersion: number;
}): T | null {
  // 按事件时间取最新一条，不按数组先后：恢复时事件可能分批回填，位置靠后不代表更新。
  let latest: T | null = null;
  for (const event of input.events) {
    if (event.type !== 'goal.revision.pending') continue;
    if (latest === null || event.at >= latest.at) latest = event;
  }
  if (!latest) return null;
  return input.currentVersion >= latest.nextVersion ? null : latest;
}



export function assessGoalFit(input: {
  successCriteria: readonly string[];
  verified: boolean;
  fullyVerified: boolean;
  needsFix: boolean;
  openReviewIssues: number;
}): { fit: GoalFitStatus; notes: string[] } {
  const notes: string[] = [];
  if (input.successCriteria.length === 0) {
    notes.push('尚未写明成功标准');
    return { fit: 'unknown', notes };
  }
  if (input.needsFix || input.openReviewIssues > 0) {
    notes.push(`仍有 ${String(input.openReviewIssues || 1)} 项评审待处理`);
    return { fit: 'gap', notes };
  }
  if (input.fullyVerified) {
    notes.push('验证已通过且无待修评审');
    return { fit: 'met', notes };
  }
  if (input.verified) {
    notes.push('部分验证通过，目标符合度仍待完整证据');
    return { fit: 'pending', notes };
  }
  notes.push('尚无通过的验证证据');
  return { fit: 'pending', notes };
}

function mapConversationStatus(status: ConversationGoal['status'] | undefined): GoalStatusGdc {
  switch (status) {
    case 'done': return 'achieved';
    case 'blocked': return 'blocked';
    case 'paused': return 'at_risk';
    case 'active': return 'active';
    default: return 'draft';
  }
}

export function projectEngineeringGoal(input: {
  workId: string;
  originalRequest: string;
  summary?: string;
  conversationGoal?: ConversationGoal | null;
  successCriteria?: readonly string[];
  constraints?: readonly string[];
  fit?: GoalFitStatus;
  fitNotes?: readonly string[];
  goalVersion?: number;
}): EngineeringGoalView {
  const text = input.conversationGoal?.text?.trim() || input.originalRequest.trim();
  // 成功标准必须来自明确的用户目标或 Criterion；任务摘要不是成功标准。
  // 没有标准时保持空列表并暴露 openQuestions，由 P1 Goal Contract 补齐。
  const criteria = input.successCriteria?.length ? [...input.successCriteria] : [];
  return {
    goalId: `goal:${input.workId}`,
    workId: input.workId,
    originalRequest: input.originalRequest,
    intent: text.slice(0, 400),
    desiredOutcome: text.slice(0, 400),
    successCriteria: criteria,
    constraints: [...(input.constraints ?? [])],
    assumptions: [],
    openQuestions: criteria.length === 0 ? ['成功标准尚未明确'] : [],
    goalVersion: input.goalVersion ?? 1,
    status: mapConversationStatus(input.conversationGoal?.status) === 'draft' && text
      ? 'active'
      : mapConversationStatus(input.conversationGoal?.status),
    fit: input.fit ?? 'unknown',
    fitNotes: [...(input.fitNotes ?? [])],
    source: input.conversationGoal ? 'conversation' : input.summary ? 'task' : 'derived'
  };
}

const STAGE_ORDER: CycleStage[] = [
  'goal_reasoning',
  'analysis',
  'design',
  'design_debate',
  'planning',
  'implementation',
  'review',
  'review_debate',
  'conclusion',
  'done'
];

function stageIndex(stage: CycleStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** GCE 阶段名（大写）映射到现有 UI 阶段（小写）。 */
export function legacyStageOfGceStage(stage: string): CycleStage {
  switch (stage) {
    case 'GOAL_REASONING': return 'goal_reasoning';
    case 'ANALYSIS': return 'analysis';
    case 'DESIGN': return 'design';
    case 'DESIGN_DEBATE': return 'design_debate';
    case 'PLANNING': return 'planning';
    case 'IMPLEMENTATION': return 'implementation';
    case 'REVIEW': return 'review';
    case 'REVIEW_DEBATE': return 'review_debate';
    case 'CONCLUSION':
    case 'GOAL_FIT':
    case 'NEXT_DECISION':
    default:
      return 'conclusion';
  }
}

/**
 * 从权威事件派生当前循环视图（可重放）。
 */
export function projectWorkCycleFromEvents(input: {
  workId: string;
  events: readonly AgentEvent[];
  summary?: string;
  status?: string;
}): WorkCycleView {
  const ordered = [...input.events].sort((a, b) => a.at - b.at);
  let current: CycleStage = 'goal_reasoning';
  let debateSkipped = true;
  let reviewDebateSkipped = true;
  let conclusionType: CycleConclusionType = 'in_progress';
  let conclusionSummary = '';
  let nextAction = '继续目标理解与分析';
  let rollback: WorkCycleView['rollback'];
  let roundCount = 0;
  let hadPlan = false;
  let hadDebate = false;
  let hadExec = false;
  let hadReview = false;
  let needsFix = false;
  let completed = false;
  let failed = false;
  /** GCE 真实阶段事件：只覆盖该阶段的显示状态，不伪造阶段。 */
  const explicitStages = new Map<CycleStage, 'active' | 'done' | 'skipped'>();
  const explicitReasons = new Map<CycleStage, string>();

  for (const event of ordered) {
    switch (event.type) {
      case 'cycle.stage.started': {
        const stage = legacyStageOfGceStage(event.stage);
        explicitStages.set(stage, 'active');
        if (event.reason) explicitReasons.set(stage, event.reason);
        current = stage;
        break;
      }
      case 'cycle.stage.completed': {
        const stage = legacyStageOfGceStage(event.stage);
        explicitStages.set(stage, 'done');
        if (event.reason) explicitReasons.set(stage, event.reason);
        break;
      }
      case 'cycle.stage.skipped': {
        const stage = legacyStageOfGceStage(event.stage);
        explicitStages.set(stage, 'skipped');
        explicitReasons.set(stage, event.reason ?? '未执行');
        break;
      }
      case 'round.started':
        roundCount = Math.max(roundCount, event.roundNumber ?? roundCount + 1);
        if (!hadPlan) current = 'analysis';
        break;
      case 'plan.ready':
        hadPlan = true;
        current = 'planning';
        nextAction = '等待计划审批或进入实现';
        break;
      case 'plan.debated': {
        hadDebate = true;
        debateSkipped = event.debate?.status === 'skipped';
        current = debateSkipped ? 'planning' : 'design_debate';
        if (!debateSkipped) nextAction = '根据方案辩论结果确认计划';
        break;
      }
      case 'step.started':
      case 'step.completed':
        hadExec = true;
        current = 'implementation';
        nextAction = '继续实现与收集执行证据';
        break;
      case 'report.ready':
        hadExec = true;
        current = 'implementation';
        break;
      case 'review.ready':
        hadReview = true;
        needsFix = Boolean(event.needsFix);
        current = 'review';
        nextAction = needsFix ? '处理评审问题或进入修复轮' : '形成结论';
        break;
      case 'review.disposition':
        reviewDebateSkipped = false;
        current = 'review_debate';
        nextAction = '根据处理决定继续修正或关闭问题';
        break;
      case 'task.completed':
        completed = true;
        current = 'done';
        conclusionType = needsFix ? 'accepted_with_risks' : 'accepted';
        conclusionSummary = event.summary?.trim() || input.summary?.trim() || '任务完成';
        nextAction = '无需下一轮；可做整体验收';
        break;
      case 'task.failed':
        failed = true;
        current = 'conclusion';
        conclusionType = 'aborted';
        conclusionSummary = event.error ?? '任务失败';
        nextAction = '检查失败原因后决定是否重启循环';
        break;
      default:
        break;
    }
  }

  if (needsFix && hadReview && !completed && !failed) {
    conclusionType = 'needs_fix';
    conclusionSummary = '评审指出需修复项';
    nextAction = '返回实现阶段修复';
    rollback = { from: 'review', to: 'implementation', reason: '评审 needsFix' };
    current = 'implementation';
  } else if (hadReview && !needsFix && !completed && !failed) {
    current = 'conclusion';
    conclusionType = 'in_progress';
    nextAction = '汇总证据并给出本轮结论';
  } else if (hadPlan && !hadExec && !completed) {
    current = stageIndex(current) < stageIndex('planning') ? 'planning' : current;
  }

  if (!hadDebate) debateSkipped = true;
  if (ordered.every(event => event.type !== 'review.disposition')) reviewDebateSkipped = true;

  const nearLimitBase = roundCount >= CODING_BUDGET.maxIterations - 1;

  // 编排器写入的 cycle.snapshot 覆盖派生；但终态任务事件优先。
  // 否则 repair 轮留下的 needs_fix snapshot 会把已完成任务钉死在「需修复」
  // （真机 2026-11-25：Go HTTP demo 已 complete 仍显示需修复 / 返回实现阶段修复）。
  const snapshot = [...ordered].reverse().find(event => event.type === 'cycle.snapshot');
  if (snapshot && snapshot.type === 'cycle.snapshot' && !completed && !failed) {
    current = (STAGE_ORDER.includes(snapshot.currentStage as CycleStage)
      ? snapshot.currentStage
      : current) as CycleStage;
    conclusionType = (snapshot.conclusionType as CycleConclusionType) || conclusionType;
    nextAction = snapshot.nextAction || nextAction;
    debateSkipped = snapshot.debateSkipped;
    roundCount = Math.max(roundCount, snapshot.budget.roundCount);
  } else if (snapshot && snapshot.type === 'cycle.snapshot') {
    // 终态仍吸收预算计数与辩论跳过标记，但不改 conclusionType / stage / nextAction。
    debateSkipped = snapshot.debateSkipped;
    roundCount = Math.max(roundCount, snapshot.budget.roundCount);
  }
  if (completed) {
    current = 'done';
    if (
      conclusionType === 'needs_fix'
      || conclusionType === 'in_progress'
      || conclusionType === 'needs_review'
      || conclusionType === 'needs_redesign'
      || conclusionType === 'needs_analysis'
    ) {
      conclusionType = needsFix ? 'accepted_with_risks' : 'accepted';
    }
    conclusionSummary = conclusionSummary
      || input.summary?.trim()
      || '任务完成';
    nextAction = '无需下一轮；可做整体验收';
    rollback = undefined;
  }

  const activeIdx = stageIndex(current);
  const stages = STAGE_ORDER.filter(stage => stage !== 'done' || completed).map(stage => {
    const idx = stageIndex(stage);
    const explicit = explicitStages.get(stage);
    if (explicit) {
      return {
        stage,
        status: explicit,
        ...(explicitReasons.get(stage) ? { reason: explicitReasons.get(stage) } : {})
      };
    }
    if (stage === 'design_debate' && debateSkipped && hadPlan) {
      return { stage, status: 'skipped' as const, reason: '无实质方案争议' };
    }
    if (stage === 'review_debate' && reviewDebateSkipped && hadReview && !ordered.some(e => e.type === 'review.disposition')) {
      return { stage, status: 'skipped' as const, reason: '无审核争议处理事件' };
    }
    if (completed && idx <= stageIndex('conclusion')) {
      return { stage, status: 'done' as const };
    }
    if (idx < activeIdx) return { stage, status: 'done' as const };
    if (idx === activeIdx) return { stage, status: 'active' as const };
    return { stage, status: 'pending' as const };
  });

  const nearLimit = nearLimitBase || Boolean(snapshot && snapshot.type === 'cycle.snapshot' && snapshot.budget.nearLimit);

  return {
    cycleId: snapshot && snapshot.type === 'cycle.snapshot'
      ? snapshot.cycleId
      : `cycle:${input.workId}:1`,
    workId: input.workId,
    cycleNumber: snapshot && snapshot.type === 'cycle.snapshot'
      ? snapshot.cycleNumber
      : 1,
    status: completed ? 'completed' : failed ? 'aborted' : 'running',
    currentStage: current,
    stages,
    entryReason: '由任务事件派生的第 1 轮工程循环',
    conclusionType,
    conclusionSummary,
    nextAction: nearLimit && !completed
      ? `${nextAction}（接近迭代预算 ${String(CODING_BUDGET.maxIterations)}）`
      : nextAction,
    debateSkipped,
    reviewDebateSkipped,
    ...(rollback ? { rollback } : {}),
    budget: {
      maxIterations: CODING_BUDGET.maxIterations,
      roundCount,
      nearLimit
    }
  };
}

export function projectArtifactsFromEvents(input: {
  workId: string;
  cycleId: string;
  events: readonly AgentEvent[];
}): WorkArtifactRef[] {
  const ordered = [...input.events].sort((a, b) => a.at - b.at);
  const artifacts: WorkArtifactRef[] = [];
  let planVersion = 0;
  let reviewVersion = 0;
  let lastPlanId: string | undefined;

  for (const event of ordered) {
    if (event.type === 'plan.ready') {
      planVersion += 1;
      const artifactId = `artifact:plan:${input.workId}:${String(planVersion)}`;
      artifacts.push({
        artifactId,
        workId: input.workId,
        cycleId: input.cycleId,
        artifactType: 'plan',
        version: planVersion,
        status: 'accepted',
        label: event.plan?.title ?? `计划 v${String(planVersion)}`,
        eventType: event.type,
        eventAt: event.at,
        ...(lastPlanId ? { supersedesArtifactId: lastPlanId } : {})
      });
      if (lastPlanId) {
        const prev = artifacts.find(item => item.artifactId === lastPlanId);
        if (prev) prev.status = 'superseded';
      }
      lastPlanId = artifactId;
    }
    if (event.type === 'plan.debated' && event.debate?.status !== 'skipped') {
      artifacts.push({
        artifactId: `artifact:debate:${input.workId}:${String(event.at)}`,
        workId: input.workId,
        cycleId: input.cycleId,
        artifactType: 'debate',
        version: 1,
        status: 'accepted',
        label: '方案辩论记录',
        eventType: event.type,
        eventAt: event.at
      });
    }
    if (event.type === 'report.ready') {
      artifacts.push({
        artifactId: `artifact:impl:${input.workId}:${String(event.at)}`,
        workId: input.workId,
        cycleId: input.cycleId,
        artifactType: 'implementation',
        version: 1,
        status: 'accepted',
        label: `执行报告 ${event.report.status}`,
        eventType: event.type,
        eventAt: event.at
      });
    }
    if (event.type === 'review.ready') {
      reviewVersion += 1;
      artifacts.push({
        artifactId: `artifact:review:${input.workId}:${String(reviewVersion)}`,
        workId: input.workId,
        cycleId: input.cycleId,
        artifactType: 'review',
        version: reviewVersion,
        status: event.needsFix ? 'draft' : 'accepted',
        label: `第 ${String(reviewVersion)} 次独立评审`,
        eventType: event.type,
        eventAt: event.at
      });
    }
    if (event.type === 'task.completed') {
      artifacts.push({
        artifactId: `artifact:conclusion:${input.workId}:${String(event.at)}`,
        workId: input.workId,
        cycleId: input.cycleId,
        artifactType: 'conclusion',
        version: 1,
        status: 'accepted',
        label: event.summary?.trim() || '本轮结论',
        eventType: event.type,
        eventAt: event.at
      });
    }
  }
  return artifacts;
}

export function projectDecisionsFromEvents(input: {
  workId: string;
  cycleId: string;
  events: readonly AgentEvent[];
}): WorkDecisionRef[] {
  const reviewDecisions = input.events
    .filter((event): event is Extract<AgentEvent, { type: 'review.disposition' }> =>
      event.type === 'review.disposition')
    .map(event => ({
      decisionId: `decision:${event.issueId}:${String(event.at)}`,
      workId: input.workId,
      cycleId: input.cycleId,
      decisionType: 'review.disposition',
      decision: event.disposition,
      rationale: event.reason,
      eventAt: event.at
    }));
  const cycleDecisions = input.events
    .filter((event): event is Extract<AgentEvent, { type: 'cycle.decision.created' }> =>
      event.type === 'cycle.decision.created')
    .map(event => ({
      decisionId: `decision:cycle:${String(event.at)}`,
      workId: input.workId,
      cycleId: event.cycleId || input.cycleId,
      decisionType: event.decisionType,
      decision: event.decisionType,
      rationale: event.reason,
      eventAt: event.at
    }));
  return [...reviewDecisions, ...cycleDecisions];
}

/** Engineering 工作台：目标 + 循环 + 产物 + 决策一次投影。 */
export function projectGoalDrivenWorkbench(input: {
  workId: string;
  originalRequest: string;
  events: readonly AgentEvent[];
  summary?: string;
  status?: string;
  conversationGoal?: ConversationGoal | null;
}): GoalDrivenWorkbenchView {
  const ordered = [...input.events].sort((a, b) => a.at - b.at);
  const cycle = projectWorkCycleFromEvents({
    workId: input.workId,
    events: ordered,
    summary: input.summary,
    status: input.status
  });
  const lastReview = [...ordered].reverse().find(event => event.type === 'review.ready');
  const lastReport = [...ordered].reverse().find(event => event.type === 'report.ready');
  const openIssues = lastReview && 'issueDetails' in lastReview
    ? (lastReview.issueDetails ?? []).filter(issue => issue.disposition === 'pending').length
    : (lastReview && 'needsFix' in lastReview && lastReview.needsFix ? 1 : 0);
  const verified = Boolean(
    lastReport && lastReport.type === 'report.ready'
      ? lastReport.report.verification?.verified
      : false
  );
  const fullyVerified = Boolean(
    lastReport && lastReport.type === 'report.ready'
      ? lastReport.report.verification?.fullyVerified
      : false
  );
  const fallbackFit = assessGoalFit({
    successCriteria: [],
    verified,
    fullyVerified,
    needsFix: Boolean(lastReview && 'needsFix' in lastReview && lastReview.needsFix),
    openReviewIssues: openIssues
  });
  const latestGoalFit = [...ordered].reverse().find(event => event.type === 'goal.fit');
  const latestContract = [...ordered].reverse().find(event => event.type === 'goal.contract.updated');
  const latestStale = [...ordered].reverse().find(event => event.type === 'goal.contract.stale');
  const staleIsCurrent = Boolean(
    latestStale && (!latestContract || latestStale.at >= latestContract.at)
  );
  const fitIsCurrent = Boolean(
    latestGoalFit && (!latestStale || latestGoalFit.at > latestStale.at)
  );
  let goal = projectEngineeringGoal({
    workId: input.workId,
    originalRequest: input.originalRequest,
    summary: input.summary,
    conversationGoal: input.conversationGoal,
    fit: fitIsCurrent && latestGoalFit
      ? latestGoalFit.fit
      : fallbackFit.fit,
    fitNotes: fitIsCurrent && latestGoalFit
      ? latestGoalFit.notes
      : latestStale
        ? latestStale.reasons
        : fallbackFit.notes
  });
  const contractCriteria = !staleIsCurrent && latestContract
    ? latestContract.contract.criteria
    : !staleIsCurrent
      ? latestGoalFit?.criteria ?? []
      : [];
  if (staleIsCurrent) {
    goal = {
      ...goal,
      ...(latestStale ? { goalVersion: latestStale.goalVersion } : {}),
      successCriteria: [],
      criteria: [],
      fit: 'unknown',
      gceFit: 'UNKNOWN',
      openQuestions: ['目标契约已过期；继续前会按当前目标重新建立']
    };
  } else if (contractCriteria.length > 0) {
    goal = {
      ...goal,
      ...(latestContract ? { goalVersion: latestContract.contract.goalVersion } : {}),
      successCriteria: contractCriteria.map(item => item.description ?? item.criterionId),
      openQuestions: [],
      // 契约已经有标准时，不再沿用“尚未写明成功标准”的兜底说明。
      fitNotes: fitIsCurrent && latestGoalFit ? latestGoalFit.notes : [],
      criteria: contractCriteria.map(item => ({
        criterionId: item.criterionId,
        description: item.description ?? item.criterionId,
        priority: item.priority ?? 'MUST',
        status: item.status,
        evidenceRefs: [...(item.evidenceRefs ?? [])]
      }))
    };
  }
  if (fitIsCurrent && latestGoalFit?.gceFit) {
    goal = { ...goal, gceFit: latestGoalFit.gceFit };
  }
  return {
    workId: input.workId,
    goal,
    cycle,
    artifacts: projectArtifactsFromEvents({
      workId: input.workId,
      cycleId: cycle.cycleId,
      events: ordered
    }),
    decisions: projectDecisionsFromEvents({
      workId: input.workId,
      cycleId: cycle.cycleId,
      events: ordered
    }),
    projectedAt: Date.now()
  };
}

/** General / Knowledge：只投影目标，不强制八阶段。 */
export function projectConversationGoalWorkbench(input: {
  conversationId: string;
  originalRequest: string;
  conversationGoal?: ConversationGoal | null;
  status?: string;
}): GoalDrivenWorkbenchView {
  const goal = projectEngineeringGoal({
    workId: input.conversationId,
    originalRequest: input.originalRequest,
    conversationGoal: input.conversationGoal,
    fit: input.status === 'answered' ? 'pending' : 'unknown',
    fitNotes: input.status === 'answered'
      ? ['问答场景：目标符合度由用户对照结论判断']
      : ['会话进行中']
  });
  const cycle: WorkCycleView = {
    cycleId: `cycle:${input.conversationId}:qa`,
    workId: input.conversationId,
    cycleNumber: 1,
    status: input.status === 'answered' ? 'completed' : 'running',
    currentStage: input.status === 'answered' ? 'conclusion' : 'analysis',
    stages: [
      { stage: 'goal_reasoning', status: 'done' },
      { stage: 'analysis', status: input.status === 'answered' ? 'done' : 'active' },
      { stage: 'design_debate', status: 'skipped', reason: '问答场景不强制方案辩论' },
      { stage: 'planning', status: 'skipped', reason: '非工程执行' },
      { stage: 'implementation', status: 'skipped', reason: '非工程执行' },
      { stage: 'review', status: 'skipped', reason: '非工程执行' },
      { stage: 'conclusion', status: input.status === 'answered' ? 'active' : 'pending' }
    ],
    entryReason: 'General/Knowledge 轻量循环',
    conclusionType: input.status === 'answered' ? 'accepted' : 'in_progress',
    conclusionSummary: input.status === 'answered' ? '已形成会话结论' : '',
    nextAction: input.status === 'answered' ? '可继续追问或转入工程' : '继续分析与综合',
    debateSkipped: true,
    reviewDebateSkipped: true,
    budget: {
      maxIterations: CODING_BUDGET.maxIterations,
      roundCount: 0,
      nearLimit: false
    }
  };
  return {
    workId: input.conversationId,
    goal,
    cycle,
    artifacts: [],
    decisions: [],
    projectedAt: Date.now()
  };
}
