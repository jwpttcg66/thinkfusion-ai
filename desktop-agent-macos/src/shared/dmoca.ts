/**
 * DMOCA：动态多模型协作与贡献对齐（薄层）。
 *
 * 不另建 Runtime：从现有 AgentEvent / 风险分级 / 用户选模投影参与决策与贡献快照。
 * 权威状态仍在 Journal 事件与 GDC/TDL。
 */

import type { AgentEvent, AgentPlan } from './contracts';

/** 与 CB `assessCollaborationRisk` 同级口径；定义在 shared，避免 renderer 依赖 main。 */
export type CollaborationRiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

export type DmocaRole =
  | 'lead'
  | 'analyst'
  | 'architect'
  | 'challenger'
  | 'planner'
  | 'implementer'
  | 'reviewer'
  | 'verifier'
  | 'synthesizer'
  | 'adjudicator';

export type ParticipationLife =
  | 'candidate'
  | 'selected'
  | 'active'
  | 'contributed'
  | 'needs_reassessment'
  | 'released'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type AlignmentStatus =
  | 'waiting'
  | 'partial'
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'finalized';

export interface ModelCapabilityView {
  providerId: string;
  modelId: string;
  label: string;
  available: boolean;
  supportsStreaming: boolean;
  capabilities: {
    analysis?: boolean;
    architecture?: boolean;
    coding?: boolean;
    review?: boolean;
    reasoning?: boolean;
    toolUse?: boolean;
  };
}

export interface ParticipationDecision {
  decisionId: string;
  workId: string;
  workTaskId?: string;
  cycleId?: string;
  stage: string;
  risk: CollaborationRiskLevel;
  participants: Array<{
    participantId: string;
    modelId?: string;
    roles: DmocaRole[];
    reason: string;
  }>;
  excluded: Array<{ participantId: string; reason: string }>;
  debate: 'skip' | 'on_demand' | 'required';
  modelReview: 'skip' | 'on_demand' | 'required';
  maxExtraModels: number;
  reasons: string[];
  userPinned: boolean;
  at: number;
  ecoGate?: {
    sufficiency: 'sufficient' | 'partial' | 'insufficient' | 'stale';
    formalRolesBlocked: boolean;
    reason: string;
  };
}

export interface ModelRunView {
  runId: string;
  participantId: string;
  role: DmocaRole | 'unknown';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  startedAt?: number;
  completedAt?: number;
  providerId?: string;
  modelId?: string;
}

export interface ContributionArtifactView {
  artifactId: string;
  runId: string;
  participantId: string;
  kind: 'stream_snapshot' | 'phase_output' | 'complete_response' | 'revision';
  version: number;
  status: 'partial' | 'final' | 'superseded';
  contentPreview: string;
  at: number;
  supersedesArtifactId?: string;
}

export interface ContributionSnapshotView {
  snapshotId: string;
  workId: string;
  workTaskId?: string;
  alignmentStatus: AlignmentStatus;
  participants: Array<{
    participantId: string;
    runId: string;
    role: string;
    artifactIds: string[];
    selectedArtifactId?: string;
    status: 'completed' | 'partial' | 'failed' | 'excluded';
  }>;
  createdAt: number;
}

export interface DecisionSnapshotView {
  decisionId: string;
  workId: string;
  contributionSnapshotId: string;
  /**
   * 这次决策实际用到的是哪一版贡献。
   *
   * 只记 snapshotId 不够：同一参与者可能有多版终稿，snapshot 里只留了
   * selectedArtifactId，回看决策时还得再跳两层。这里把「人 + 稿件 + 版本」
   * 直接钉在决策上，避免「结论引用了已 superseded 的旧稿」却查不出来。
   */
  contributions?: Array<{ participantId: string; artifactId: string; version: number }>;
  conclusion: string;
  unresolvedIssues: string[];
  status:
    | 'accepted'
    | 'accepted_with_risks'
    | 'needs_fix'
    | 'needs_review'
    | 'needs_redesign'
    | 'blocked'
    | 'unresolved'
    | 'in_progress';
  createdAt: number;
}

export interface DmocaWorkbenchView {
  decision: ParticipationDecision | null;
  runs: ModelRunView[];
  contributions: ContributionArtifactView[];
  snapshot: ContributionSnapshotView | null;
  decisionSnapshot: DecisionSnapshotView | null;
}

/** 风险 → 默认参与策略（与 CB L0–L3 对齐，不另建分级）。 */
export function defaultPolicyForRisk(risk: CollaborationRiskLevel): {
  debate: ParticipationDecision['debate'];
  modelReview: ParticipationDecision['modelReview'];
  maxParticipants: number;
  maxExtraModels: number;
  preferredRoles: DmocaRole[];
} {
  switch (risk) {
    case 'L0':
      return {
        debate: 'skip',
        modelReview: 'skip',
        maxParticipants: 1,
        maxExtraModels: 0,
        preferredRoles: ['lead', 'implementer']
      };
    case 'L1':
      return {
        debate: 'on_demand',
        modelReview: 'on_demand',
        maxParticipants: 2,
        maxExtraModels: 1,
        preferredRoles: ['lead', 'reviewer']
      };
    case 'L2':
      return {
        debate: 'on_demand',
        modelReview: 'on_demand',
        maxParticipants: 3,
        maxExtraModels: 1,
        preferredRoles: ['lead', 'analyst', 'reviewer']
      };
    case 'L3':
      return {
        debate: 'required',
        modelReview: 'required',
        maxParticipants: 4,
        maxExtraModels: 2,
        preferredRoles: ['lead', 'architect', 'challenger', 'reviewer']
      };
  }
}

/**
 * 决策 → 实际派发：辩论/评审只请决策里留下的人。
 *
 * 派发名单必须等于 `decision.participants`——否则界面写着「未参与」、
 * 实际却仍在问那个人，等于用记录骗人。人数上限（含用户钉住的情形）
 * 已经在决策里生效，被挡下的人都在 `excluded` 带原因，不是静默减员。
 * 决策里一个都没有时才退回调用方的名单，避免把「无人可用」误读成「请全部模型」。
 */
export function dispatchedParticipantIds(
  decision: ParticipationDecision,
  fallback: readonly string[] | undefined
): string[] {
  const ids = decision.participants.map(item => item.participantId);
  return ids.length > 0 ? ids : [...(fallback ?? [])];
}

/** ECO 充分度硬门禁：不足/过期时阻断正式架构职责；非 pinned 截断为单 lead。 */
export function applyEcoGateToDecision(
  decision: ParticipationDecision,
  sufficiency: 'sufficient' | 'partial' | 'insufficient' | 'stale'
): ParticipationDecision {
  if (sufficiency === 'sufficient') {
    return {
      ...decision,
      ecoGate: { sufficiency, formalRolesBlocked: false, reason: 'ECO sufficient' },
      reasons: [...decision.reasons, `ECO ${sufficiency}`]
    };
  }
  if (sufficiency === 'partial') {
    return {
      ...decision,
      ecoGate: {
        sufficiency,
        formalRolesBlocked: false,
        reason: 'ECO partial：可有限参与，正式架构仍建议补充上下文'
      },
      reasons: [...decision.reasons, 'ECO partial：建议补充工程上下文']
    };
  }
  const reason = sufficiency === 'stale'
    ? 'ECO stale：上下文过期，阻断正式架构/审核裁决'
    : 'ECO insufficient：上下文不足，阻断正式架构/审核裁决';
  const participants = decision.userPinned
    ? decision.participants.map(item => ({
        ...item,
        reason: `${item.reason}（${reason}）`
      }))
    : decision.participants.slice(0, 1).map(item => ({
        ...item,
        roles: ['lead'] as DmocaRole[],
        reason: `${item.reason}；${reason}，仅保留 lead`
      }));
  const dropped = decision.userPinned
    ? []
    : decision.participants.slice(1).map(item => ({
        participantId: item.participantId,
        reason: `ECO ${sufficiency}：非 pinned 截断`
      }));
  return {
    ...decision,
    participants,
    excluded: [...decision.excluded, ...dropped],
    ecoGate: { sufficiency, formalRolesBlocked: true, reason },
    reasons: [...decision.reasons, reason]
  };
}

export function decideParticipation(input: {
  workId: string;
  workTaskId?: string;
  cycleId?: string;
  stage: string;
  risk: CollaborationRiskLevel;
  candidates: Array<{ id: string; label?: string; modelId?: string; available: boolean; detail?: string }>;
  /** 用户硬指定；非空时不得擅自替换。 */
  selectedIds?: readonly string[];
  disabledIds?: readonly string[];
  userPinned?: boolean;
  now?: number;
}): ParticipationDecision {
  const policy = defaultPolicyForRisk(input.risk);
  const at = input.now ?? Date.now();
  const disabled = new Set(input.disabledIds ?? []);
  const pinned = Boolean(input.userPinned || (input.selectedIds && input.selectedIds.length > 0));
  const selected = input.selectedIds && input.selectedIds.length > 0
    ? new Set(input.selectedIds)
    : null;

  const excluded: ParticipationDecision['excluded'] = [];
  const usable = input.candidates.filter(item => {
    if (disabled.has(item.id)) {
      excluded.push({ participantId: item.id, reason: '用户禁用' });
      return false;
    }
    if (selected && !selected.has(item.id)) {
      excluded.push({ participantId: item.id, reason: '未在用户选定列表中' });
      return false;
    }
    if (!item.available) {
      excluded.push({ participantId: item.id, reason: item.detail || '当前不可用' });
      return false;
    }
    return true;
  });

  const capped = usable.slice(0, policy.maxParticipants);
  for (const item of usable.slice(policy.maxParticipants)) {
    excluded.push({
      participantId: item.id,
      reason: `${input.risk} 默认最多 ${String(policy.maxParticipants)} 人（预算克制）`
    });
  }

  const participants = capped.map((item, index) => {
    const roles: DmocaRole[] = index === 0
      ? [policy.preferredRoles[0] ?? 'lead']
      : [policy.preferredRoles[Math.min(index, policy.preferredRoles.length - 1)] ?? 'analyst'];
    return {
      participantId: item.id,
      modelId: item.modelId,
      roles,
      reason: pinned
        ? `用户指定参与（${input.risk} · ${roles.join('+')}）`
        : `${input.risk} 策略分配角色 ${roles.join('+')}：${item.label ?? item.id}`
    };
  });

  const reasons = [
    `阶段 ${input.stage}`,
    `风险 ${input.risk}`,
    `辩论=${policy.debate}`,
    `模型审核=${policy.modelReview}`,
    pinned ? '遵守用户选定模型' : '系统按策略选人'
  ];

  return {
    decisionId: `pd:${input.workId}:${input.stage}:${String(at)}`,
    workId: input.workId,
    workTaskId: input.workTaskId,
    cycleId: input.cycleId,
    stage: input.stage,
    risk: input.risk,
    participants,
    excluded,
    debate: policy.debate,
    modelReview: policy.modelReview,
    maxExtraModels: policy.maxExtraModels,
    reasons,
    userPinned: pinned,
    at
  };
}

/** 从任务事件投影 ModelRun / 贡献（流式不当事终贡献）。 */
export function projectDmocaFromEvents(input: {
  workId: string;
  events: readonly AgentEvent[];
  decision?: ParticipationDecision | null;
  summary?: string;
  status?: string;
}): DmocaWorkbenchView {
  const ordered = [...input.events]
    .filter(event => 'taskId' in event && (event as { taskId?: string }).taskId === input.workId)
    .sort((a, b) => a.at - b.at);

  let decisionFromEvents: ParticipationDecision | null = input.decision ?? null;
  for (const event of ordered) {
    if (event.type !== 'model.participation.selected') continue;
    decisionFromEvents = {
      decisionId: `pd:${event.taskId}:${event.stage}:${String(event.at)}`,
      workId: event.taskId,
      stage: event.stage,
      risk: event.risk,
      participants: event.participants.map(item => ({
        participantId: item.participantId,
        roles: item.roles as DmocaRole[],
        reason: item.reason
      })),
      excluded: event.excluded,
      debate: event.debate,
      modelReview: event.modelReview,
      maxExtraModels: defaultPolicyForRisk(event.risk).maxExtraModels,
      reasons: event.reasons,
      userPinned: event.userPinned,
      at: event.at
    };
  }

  const runs = new Map<string, ModelRunView>();
  const contributions: ContributionArtifactView[] = [];
  const versions = new Map<string, number>();

  const bump = (participantId: string) => {
    const next = (versions.get(participantId) ?? 0) + 1;
    versions.set(participantId, next);
    return next;
  };

  for (const event of ordered) {
    if (event.type === 'round.started') {
      const runId = `run:${event.roundId}`;
      runs.set(runId, {
        runId,
        participantId: 'lead',
        role: 'lead',
        status: 'running',
        startedAt: event.at
      });
    }
    if (event.type === 'round.delta') {
      const participantId = event.providerId ?? event.modelId ?? 'stream';
      const runId = `run:${event.roundId}:${participantId}`;
      if (!runs.has(runId)) {
        runs.set(runId, {
          runId,
          participantId,
          role: 'unknown',
          status: 'running',
          startedAt: event.at,
          providerId: event.providerId,
          modelId: event.modelId
        });
      }
      // 流式快照可记 partial，但不标 final
      const text = (event.text ?? event.reasoning ?? '').trim();
      if (text.length > 0 && event.mode === 'snapshot') {
        contributions.push({
          artifactId: `stream:${runId}:${String(event.at)}`,
          runId,
          participantId,
          kind: 'stream_snapshot',
          version: bump(participantId),
          status: 'partial',
          contentPreview: text.slice(0, 240),
          at: event.at
        });
      }
    }
    if (event.type === 'round.answer') {
      const runId = `run:${event.roundId}`;
      const prev = runs.get(runId);
      runs.set(runId, {
        runId,
        participantId: prev?.participantId ?? 'lead',
        role: 'lead',
        status: 'completed',
        startedAt: prev?.startedAt,
        completedAt: event.at
      });
      // 同轮流式 helper run 随正式回答收口，避免对齐卡在 degraded。
      for (const [id, run] of runs) {
        if (id.startsWith(`run:${event.roundId}`) && run.status === 'running') {
          runs.set(id, { ...run, status: 'completed', completedAt: event.at });
        }
      }
      const version = bump('lead');
      // 同成员先前 partial/final 标记 superseded
      for (const item of contributions) {
        if (item.participantId === 'lead' && item.status === 'final') item.status = 'superseded';
      }
      contributions.push({
        artifactId: `answer:${event.roundId}:${String(event.at)}`,
        runId,
        participantId: 'lead',
        kind: version > 1 ? 'revision' : 'complete_response',
        version,
        status: 'final',
        contentPreview: event.text.trim().slice(0, 400),
        at: event.at,
        ...(version > 1 ? { supersedesArtifactId: contributions.filter(c => c.participantId === 'lead').at(-2)?.artifactId } : {})
      });
    }
    if (event.type === 'round.peer') {
      const participantId = event.memberId;
      const runId = `run:${event.roundId}:peer:${participantId}`;
      const done = event.status === 'answered' || event.status === 'failed' || event.status === 'cancelled';
      runs.set(runId, {
        runId,
        participantId,
        role: 'analyst',
        status: event.status === 'failed' ? 'failed' : event.status === 'cancelled' ? 'cancelled' : event.status === 'answered' ? 'completed' : 'running',
        completedAt: done ? event.at : undefined,
        providerId: event.providerId,
        modelId: event.modelId
      });
      if (event.status === 'answered' && (event.text ?? '').trim()) {
        const version = bump(participantId);
        for (const item of contributions) {
          if (item.participantId === participantId && item.status === 'final') item.status = 'superseded';
        }
        contributions.push({
          artifactId: `peer:${event.roundId}:${participantId}:${String(event.at)}`,
          runId,
          participantId,
          kind: version > 1 ? 'revision' : 'complete_response',
          version,
          status: 'final',
          contentPreview: (event.text ?? '').trim().slice(0, 400),
          at: event.at
        });
      }
    }
  }

  const finals = contributions.filter(item => item.status === 'final');
  const failed = [...runs.values()].filter(item => item.status === 'failed' || item.status === 'timed_out');
  const running = [...runs.values()].filter(item => item.status === 'running');

  let alignmentStatus: AlignmentStatus = 'waiting';
  if (finals.length > 0 && running.length === 0 && failed.length === 0) alignmentStatus = 'ready';
  else if (finals.length > 0 && (running.length > 0 || failed.length > 0)) alignmentStatus = 'degraded';
  else if (failed.length > 0 && finals.length === 0) alignmentStatus = 'blocked';
  else if (finals.length > 0) alignmentStatus = 'partial';

  if (input.status === 'completed' && finals.length > 0) alignmentStatus = 'finalized';

  const snapshot: ContributionSnapshotView | null = finals.length > 0
    ? {
        snapshotId: `cs:${input.workId}:${String(finals.at(-1)!.at)}`,
        workId: input.workId,
        alignmentStatus,
        participants: [...runs.values()].map(run => {
          const arts = contributions.filter(item => item.runId === run.runId).map(item => item.artifactId);
          const selected = contributions.find(item => item.runId === run.runId && item.status === 'final');
          return {
            participantId: run.participantId,
            runId: run.runId,
            role: run.role,
            artifactIds: arts,
            selectedArtifactId: selected?.artifactId,
            status: run.status === 'failed' || run.status === 'timed_out'
              ? 'failed' as const
              : selected
                ? 'completed' as const
                : run.status === 'completed'
                  ? 'partial' as const
                  : 'excluded' as const
          };
        }),
        createdAt: finals.at(-1)!.at
      }
    : null;

  const decisionSnapshot: DecisionSnapshotView | null = snapshot && (input.status === 'completed' || input.summary)
    ? {
        decisionId: `ds:${input.workId}:${String(snapshot.createdAt)}`,
        workId: input.workId,
        contributionSnapshotId: snapshot.snapshotId,
        contributions: snapshot.participants
          .filter(item => item.selectedArtifactId)
          .map(item => {
            const artifact = contributions.find(entry => entry.artifactId === item.selectedArtifactId);
            return {
              participantId: item.participantId,
              artifactId: item.selectedArtifactId!,
              version: artifact?.version ?? 1
            };
          }),
        conclusion: input.summary ?? '见任务结论',
        unresolvedIssues: alignmentStatus === 'blocked' ? ['关键贡献缺失'] : [],
        status: input.status === 'completed'
          ? (alignmentStatus === 'degraded' ? 'accepted_with_risks' : 'accepted')
          : 'in_progress',
        createdAt: snapshot.createdAt
      }
    : null;

  return {
    decision: decisionFromEvents,
    runs: [...runs.values()],
    contributions,
    snapshot,
    decisionSnapshot
  };
}

/** 参与者生命周期转移（保留历史贡献；不覆盖旧 ModelRun）。 */
export function transitionParticipationLife(
  from: ParticipationLife,
  event:
    | 'select'
    | 'activate'
    | 'contribute'
    | 'release'
    | 'fail'
    | 'timeout'
    | 'cancel'
    | 'reassess'
    | 'rejoin'
): ParticipationLife {
  switch (event) {
    case 'select':
      return from === 'candidate' || from === 'released' || from === 'needs_reassessment' ? 'selected' : from;
    case 'activate':
      return from === 'selected' || from === 'needs_reassessment' ? 'active' : from;
    case 'contribute':
      return from === 'active' || from === 'selected' ? 'contributed' : from;
    case 'release':
      return from === 'contributed' || from === 'active' || from === 'selected' ? 'released' : from;
    case 'fail':
      return 'failed';
    case 'timeout':
      return 'timed_out';
    case 'cancel':
      return 'cancelled';
    case 'reassess':
      return from === 'contributed' || from === 'released' ? 'needs_reassessment' : from;
    case 'rejoin':
      return from === 'needs_reassessment' || from === 'released' ? 'active' : from;
  }
}

/** 是否应停止继续加协作（边际收益 / 无新证据）。 */
export function shouldStopCollaboration(input: {
  risk: CollaborationRiskLevel;
  newEvidence: boolean;
  newMaterialClaim: boolean;
  budgetExhausted: boolean;
  userCancel: boolean;
  successMet: boolean;
}): { stop: boolean; reason: string } {
  if (input.userCancel) return { stop: true, reason: '用户取消' };
  if (input.successMet) return { stop: true, reason: '已达成功标准' };
  if (input.budgetExhausted) {
    return {
      stop: input.risk === 'L0' || input.risk === 'L1',
      reason: input.risk === 'L2' || input.risk === 'L3'
        ? '预算不足：高风险任务须暂停并说明，不得静默跳过门禁'
        : '预算用尽，停止追加调用'
    };
  }
  if (!input.newEvidence && !input.newMaterialClaim) {
    return { stop: true, reason: '无新证据且无实质新主张（no_new_evidence）' };
  }
  return { stop: false, reason: '继续' };
}

/**
 * 计划风险包装：供 shared 层测试与 UI；实现委托给传入的 assess 或内置简化。
 * 生产路径请直接用 engineering/plan-review.assessCollaborationRisk。
 */
export function riskFromPlanTools(plan: Pick<AgentPlan, 'steps' | 'kind'>): CollaborationRiskLevel {
  const steps = plan.steps ?? [];
  if (plan.kind === 'design') return 'L3';
  if (steps.some(step => step.tool.startsWith('computer.') || step.tool === 'fs.remove' || step.tool === 'process.kill')) {
    return 'L3';
  }
  const writes = steps.filter(step =>
    step.tool === 'fs.writeFile' || step.tool === 'fs.edit' || step.tool === 'fs.mkdir' || step.tool === 'fs.move' || step.tool === 'fs.copy'
  );
  if (writes.length >= 3 || steps.length >= 9) return 'L2';
  if (writes.length > 0) return 'L1';
  return 'L0';
}
