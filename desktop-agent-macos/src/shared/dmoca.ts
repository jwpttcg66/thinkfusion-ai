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

/**
 * 正式职责：会产出「可被当成工程结论」的角色。
 *
 * 旁听、提假设、补充信息不属于正式职责——那正是上下文不足时仍然允许的部分。
 */
export const FORMAL_DMOCA_ROLES: readonly DmocaRole[] = [
  'architect',
  'reviewer',
  'verifier',
  'adjudicator'
];

/** 上下文不足时的保留角色：可以旁听与补充信息，但不产出正式结论。 */
export const OBSERVER_DMOCA_ROLE: DmocaRole = 'analyst';

export function isFormalRole(role: DmocaRole): boolean {
  return FORMAL_DMOCA_ROLES.includes(role);
}

/** 参与决定里某个人的职责限制：被挡下的正式角色与保留角色都写清。 */
export interface RoleRestriction {
  participantId: string;
  blockedRoles: DmocaRole[];
  allowedRoles: DmocaRole[];
  reason: string;
}

export interface EcoGate {
  sufficiency: 'sufficient' | 'partial' | 'insufficient' | 'stale';
  /** 是否有正式职责被门禁挡下（不是「所有人都不许参与」）。 */
  formalRolesBlocked: boolean;
  reason: string;
  /** 逐人的限制明细；界面与 Journal 靠它解释「为什么他只能旁听」。 */
  restrictions?: RoleRestriction[];
  /** 门禁依据的上下文版本；恢复时用来判断是否已刷新。 */
  contextVersion?: number;
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
    /** 因为上下文不足被摘掉的正式角色；有值说明只能旁听/辅助分析。 */
    blockedRoles?: DmocaRole[];
    reason: string;
  }>;
  excluded: Array<{ participantId: string; reason: string }>;
  debate: 'skip' | 'on_demand' | 'required';
  modelReview: 'skip' | 'on_demand' | 'required';
  maxExtraModels: number;
  reasons: string[];
  userPinned: boolean;
  at: number;
  ecoGate?: EcoGate;
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

/**
 * 风险 → 默认参与策略（与 CB L0–L3 对齐，不另建分级）。
 *
 * 人数/角色可按风险克制；**debate / modelReview 不得标 skip**——
 * 辩题、是否辩论、是否审核一定走模型（五段 + 执行后模型审），风险只影响编制规模。
 */
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
        debate: 'on_demand',
        modelReview: 'on_demand',
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
 * 会话侧风险等级：从这一轮的辩论证据反推，而不是拍一个固定等级。
 *
 * - 只有一路回答：没有交叉验证的必要，L0（单人或自辩）；
 * - 有存疑：说明证据不足以支撑结论，按 L3 处理；
 * - 至少两个辩题：分歧会影响结论，L3；
 * - 一个辩题：L2；没有辩题但多路一致：L1。
 */
export function conversationRiskFromDebate(input: {
  answers: number;
  topics: number;
  doubts: number;
}): CollaborationRiskLevel {
  if (input.answers <= 1) return 'L0';
  if (input.doubts > 0 || input.topics >= 2) return 'L3';
  if (input.topics === 1) return 'L2';
  return 'L1';
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

/**
 * ECO 充分度硬门禁：把「能否参与」与「能否承担正式职责」拆开。
 *
 * 用户钉住的模型仍然参与（不能因为上下文不足就把人选换掉），但**不再保留**
 * 原有正式角色：architect / reviewer / verifier / adjudicator 一律摘掉，
 * 换成旁听角色并记进 blockedRoles。以前这里对 pinned 只加一句 reason、
 * 角色原样保留，等于「门禁写了但没拦住」。
 *
 * partial 不算充分：高风险（L3）阶段同样摘正式角色，普通阶段允许辅助分析。
 */
export function applyEcoGateToDecision(
  decision: ParticipationDecision,
  sufficiency: 'sufficient' | 'partial' | 'insufficient' | 'stale',
  options?: { contextVersion?: number }
): ParticipationDecision {
  const withVersion = (gate: EcoGate): EcoGate =>
    options?.contextVersion === undefined ? gate : { ...gate, contextVersion: options.contextVersion };

  if (sufficiency === 'sufficient') {
    return {
      ...decision,
      ecoGate: withVersion({ sufficiency, formalRolesBlocked: false, reason: 'ECO sufficient' }),
      reasons: [...decision.reasons, `ECO ${sufficiency}`]
    };
  }

  if (sufficiency === 'partial' && decision.risk !== 'L3') {
    return {
      ...decision,
      ecoGate: withVersion({
        sufficiency,
        formalRolesBlocked: false,
        reason: 'ECO partial：可有限参与，正式架构仍建议补充上下文'
      }),
      reasons: [...decision.reasons, 'ECO partial：建议补充工程上下文']
    };
  }

  const reason = sufficiency === 'stale'
    ? 'ECO stale：上下文过期，阻断正式架构/审核/验证/裁决'
    : sufficiency === 'partial'
      ? 'ECO partial + 高风险：正式架构/审核/验证/裁决须先补齐上下文'
      : 'ECO insufficient：上下文不足，阻断正式架构/审核/验证/裁决';

  const restrictions: RoleRestriction[] = [];
  const participants = decision.participants.map(item => {
    const blocked = item.roles.filter(isFormalRole);
    if (blocked.length === 0) return { ...item };
    const kept = item.roles.filter(role => !isFormalRole(role));
    const allowedRoles: DmocaRole[] = kept.length > 0 ? kept : [OBSERVER_DMOCA_ROLE];
    restrictions.push({
      participantId: item.participantId,
      blockedRoles: blocked,
      allowedRoles,
      reason
    });
    return {
      ...item,
      roles: allowedRoles,
      blockedRoles: [...(item.blockedRoles ?? []), ...blocked],
      reason: `${item.reason}（${reason}；正式角色 ${blocked.join('/')} 已摘除，仅可旁听/补充信息）`
    };
  });

  // 非 pinned 时仍然收敛到一个人：上下文不足还要多人并行，只是烧预算。
  // lead 属于协作身份，不是工程裁决，保留；没有非正式角色时退到旁听。
  const trimmed = decision.userPinned
    ? participants
    : participants.slice(0, 1).map(item => ({
        ...item,
        roles: (item.roles.filter(role => !isFormalRole(role)).length > 0
          ? item.roles.filter(role => !isFormalRole(role))
          : [OBSERVER_DMOCA_ROLE]) as DmocaRole[],
        reason: `${item.reason}；${reason}，仅保留非正式角色`
      }));
  const dropped = decision.userPinned
    ? []
    : decision.participants.slice(1).map(item => ({
        participantId: item.participantId,
        reason: `ECO ${sufficiency}：非 pinned 截断`
      }));

  return {
    ...decision,
    participants: trimmed,
    excluded: [...decision.excluded, ...dropped],
    ecoGate: withVersion({
      sufficiency,
      formalRolesBlocked: restrictions.length > 0 || trimmed.length !== decision.participants.length,
      reason,
      restrictions
    }),
    reasons: [...decision.reasons, reason]
  };
}

/**
 * 派发前的职责复核。
 *
 * 门禁不能只在选人那一刻算一次：计划评审、执行、验证是三次独立派发，
 * 中间上下文可能已经过期。每次派发前都要能回答「这个人现在能不能承担这个角色」。
 */
export function roleEligibility(
  decision: ParticipationDecision,
  participantId: string,
  role: DmocaRole
): { ok: boolean; reason: string } {
  const member = decision.participants.find(item => item.participantId === participantId);
  if (!member) {
    return { ok: false, reason: `${participantId} 不在本次参与决策里` };
  }
  if ((member.blockedRoles ?? []).includes(role)) {
    return {
      ok: false,
      reason: `${participantId} 的 ${role} 已被 ECO 门禁摘除（${decision.ecoGate?.reason ?? '上下文不足'}）`
    };
  }
  if (isFormalRole(role) && decision.ecoGate?.formalRolesBlocked === true) {
    return { ok: false, reason: `ECO ${decision.ecoGate.sufficiency} 期间不得派发正式角色 ${role}` };
  }
  if (!member.roles.includes(role)) {
    return { ok: false, reason: `${participantId} 本次只被分配了 ${member.roles.join('/') || '无角色'}` };
  }
  return { ok: true, reason: `${participantId} 可承担 ${role}` };
}

/** 正式角色名单（派发用）：被门禁摘掉的人不会出现在这里。 */
export function formalRoleHolders(
  decision: ParticipationDecision,
  role: DmocaRole
): string[] {
  return decision.participants
    .filter(item => item.roles.includes(role) && !(item.blockedRoles ?? []).includes(role))
    .map(item => item.participantId);
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
      // 事件里带了 decisionId 就用它：回放出来的决策必须和当时那条一一对应，
      // 不能再用时间戳拼一个「看起来一样」的新 id。
      decisionId: event.decisionId || `pd:${event.taskId}:${event.stage}:${String(event.at)}`,
      workId: event.taskId,
      ...(event.workTaskId ? { workTaskId: event.workTaskId } : {}),
      ...(event.cycleId ? { cycleId: event.cycleId } : {}),
      stage: event.stage,
      risk: event.risk,
      participants: event.participants.map(item => ({
        participantId: item.participantId,
        roles: item.roles as DmocaRole[],
        ...(item.blockedRoles && item.blockedRoles.length > 0
          ? { blockedRoles: item.blockedRoles as DmocaRole[] }
          : {}),
        reason: item.reason
      })),
      excluded: event.excluded,
      debate: event.debate,
      modelReview: event.modelReview,
      maxExtraModels: event.maxExtraModels ?? defaultPolicyForRisk(event.risk).maxExtraModels,
      reasons: event.reasons,
      userPinned: event.userPinned,
      ...(event.ecoGate ? { ecoGate: event.ecoGate as EcoGate } : {}),
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

/**
 * 正式决策快照校验（P0-05）。
 *
 * 决策必须引用**确定版本**的贡献：快照里选的稿件要存在、版本要一致、
 * 不能是已经被 superseded 的旧稿。这里只做只读核对，返回问题清单，
 * 由调用方决定是拒发决策还是记录风险——不静默改数据。
 */
export function assertDecisionSnapshotIntegrity(
  decision: DecisionSnapshotView,
  artifacts: readonly ContributionArtifactView[]
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const byId = new Map(artifacts.map(item => [item.artifactId, item]));
  const pinned = decision.contributions ?? [];
  if (pinned.length === 0) {
    issues.push('决策没有钉住任何贡献版本');
  }
  const seen = new Set<string>();
  for (const ref of pinned) {
    if (seen.has(ref.participantId)) {
      issues.push(`${ref.participantId} 在同一份决策里被固定了多个版本`);
    }
    seen.add(ref.participantId);
    const artifact = byId.get(ref.artifactId);
    if (!artifact) {
      issues.push(`决策引用的贡献不存在：${ref.artifactId}`);
      continue;
    }
    if (artifact.participantId !== ref.participantId) {
      issues.push(`贡献 ${ref.artifactId} 不属于 ${ref.participantId}`);
    }
    if (artifact.version !== ref.version) {
      issues.push(`决策钉的版本 v${String(ref.version)} 与稿件实际 v${String(artifact.version)} 不一致`);
    }
    if (artifact.status === 'superseded') {
      issues.push(`决策引用了已被覆盖的旧稿：${ref.artifactId}`);
    }
    if (artifact.status === 'partial') {
      issues.push(`决策引用了未完成稿件：${ref.artifactId}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 从辩论交锋生成不可变贡献快照与决策快照。
 *
 * 工程任务的正式决策发生在方案评审，而不是会话的 round.answer：这里把
 * 每次发言落成 artifact（同人后续发言递增版本并覆盖前一版 final），
 * 决策只钉每人最后一版终稿。这样「结论用了哪一版」可追溯，异步完成
 * 也不会互相覆盖。
 */
export function snapshotFromExchanges(input: {
  workId: string;
  workTaskId?: string;
  participants: readonly string[];
  exchanges: ReadonlyArray<{ author: string; kind: string; text: string; roundIndex: number }>;
  conclusion: string;
  at?: number;
}): {
  artifacts: ContributionArtifactView[];
  snapshot: ContributionSnapshotView | null;
  decision: DecisionSnapshotView | null;
} {
  const at = input.at ?? Date.now();
  const artifacts: ContributionArtifactView[] = [];
  const versions = new Map<string, number>();

  for (const exchange of input.exchanges) {
    const text = exchange.text.trim();
    if (text.length === 0) continue;
    const author = exchange.author;
    versions.set(author, (versions.get(author) ?? 0) + 1);
    const version = versions.get(author)!;
    for (const item of artifacts) {
      if (item.participantId === author && item.status === 'final') item.status = 'superseded';
    }
    artifacts.push({
      artifactId: `ex:${input.workId}:${author}:${String(exchange.roundIndex)}:${String(at)}:${String(version)}`,
      runId: `run:${author}:r${String(exchange.roundIndex)}`,
      participantId: author,
      kind: version > 1 ? 'revision' : 'complete_response',
      version,
      status: 'final',
      contentPreview: text.slice(0, 400),
      at,
      ...(version > 1
        ? { supersedesArtifactId: artifacts.filter(item => item.participantId === author).at(-1)?.artifactId }
        : {})
    });
  }

  const participants = [...new Set([...input.participants, ...artifacts.map(item => item.participantId)])];
  if (participants.length === 0) {
    return { artifacts, snapshot: null, decision: null };
  }

  const selected = participants.map(participantId => {
    const finals = artifacts.filter(
      item => item.participantId === participantId && item.status === 'final'
    );
    return { participantId, artifact: finals.at(-1) };
  });
  const answered = selected.filter(item => item.artifact).length;
  const alignmentStatus: AlignmentStatus = answered === 0
    ? 'blocked'
    : answered === participants.length
      ? 'ready'
      : answered > 0
        ? 'partial'
        : 'waiting';

  const snapshot: ContributionSnapshotView = {
    snapshotId: `cs:${input.workId}:${String(at)}`,
    workId: input.workId,
    ...(input.workTaskId ? { workTaskId: input.workTaskId } : {}),
    alignmentStatus,
    participants: selected.map(item => ({
      participantId: item.participantId,
      runId: item.artifact?.runId ?? `run:${item.participantId}:missing`,
      role: 'analyst',
      artifactIds: artifacts
        .filter(entry => entry.participantId === item.participantId)
        .map(entry => entry.artifactId),
      ...(item.artifact ? { selectedArtifactId: item.artifact.artifactId } : {}),
      status: item.artifact ? 'completed' : 'excluded'
    })),
    createdAt: at
  };

  const decision: DecisionSnapshotView = {
    decisionId: `ds:${input.workId}:${String(at)}`,
    workId: input.workId,
    contributionSnapshotId: snapshot.snapshotId,
    contributions: selected
      .filter(item => item.artifact)
      .map(item => ({
        participantId: item.participantId,
        artifactId: item.artifact!.artifactId,
        version: item.artifact!.version
      })),
    conclusion: input.conclusion,
    unresolvedIssues: alignmentStatus === 'ready' ? [] : [`${String(participants.length - answered)} 位参与者没有终稿`],
    status: alignmentStatus === 'ready'
      ? 'accepted'
      : alignmentStatus === 'blocked'
        ? 'unresolved'
        : 'accepted_with_risks',
    createdAt: at
  };

  return { artifacts, snapshot, decision };
}

/**
 * General / Knowledge 的决策快照（P1-03）。
 *
 * 三个场景共用同一套贡献结构与「决策钉版本」规则：工程方案评审走
 * {@link snapshotFromExchanges}，对话轮次也走它，只是把「谁答了什么」换成
 * 会话回答列表。以前会话侧只有一份描述性的参与记录，决策从来不钉版本，
 * 同一模型改口后无法判断最终结论引用的是哪一稿。
 *
 * 刻意不做的事：
 * - 不派发、不追加模型：这条路只记录已经发生的回答，小任务不会被强行多问一遍；
 * - 没有回答就不造决策（`decision:null`），不写「空快照已成立」；
 * - 失败/超时的成员按缺席记入 unresolvedIssues，不阻塞结论，也不假装参与过。
 */
export function conversationDecisionSnapshot(input: {
  workId: string;
  stage?: string;
  lead: { participantId: string; text: string; at?: number };
  peers?: ReadonlyArray<{
    participantId: string;
    text?: string;
    status?: 'answered' | 'failed' | 'cancelled' | 'pending' | 'timed_out';
    at?: number;
  }>;
  /** 辩论交锋稿；给了就按轮次排版本，主答排在它们之前。 */
  exchanges?: ReadonlyArray<{ author: string; text: string; roundIndex: number; kind?: string }>;
  conclusion: string;
  completed?: boolean;
  at?: number;
}): {
  artifacts: ContributionArtifactView[];
  snapshot: ContributionSnapshotView | null;
  decision: DecisionSnapshotView | null;
  integrity: { ok: boolean; issues: string[] };
  /** 只有一个回答者：结论成立，但没有交叉验证，界面要如实这么写。 */
  singleModel: boolean;
} {
  const at = input.at ?? Date.now();
  const peers = input.peers ?? [];
  const participants = [...new Set([
    input.lead.participantId,
    ...peers.map(item => item.participantId)
  ])];
  const exchanges = input.exchanges && input.exchanges.length > 0
    ? input.exchanges.map(item => ({ ...item, kind: item.kind ?? 'answer' }))
    : [
        { author: input.lead.participantId, text: input.lead.text, roundIndex: 0, kind: 'answer' },
        ...peers
          .filter(item => (item.text ?? '').trim().length > 0)
          .map(item => ({
            author: item.participantId,
            text: item.text ?? '',
            roundIndex: 0,
            kind: 'answer'
          }))
      ];
  const built = snapshotFromExchanges({
    workId: input.workId,
    participants,
    exchanges,
    conclusion: input.conclusion,
    at
  });
  const missing = peers.filter(item => item.status !== undefined && item.status !== 'answered' && item.status !== 'pending');
  if (built.decision && missing.length > 0) {
    const note = `${missing.map(item => `${item.participantId}（${item.status ?? 'failed'}）`).join('、')}未给出终稿`;
    if (!built.decision.unresolvedIssues.includes(note)) built.decision.unresolvedIssues.push(note);
  }
  const integrity = built.decision
    ? assertDecisionSnapshotIntegrity(built.decision, built.artifacts)
    : { ok: false, issues: ['没有可用回答，未形成决策'] };
  const hasText = [...exchanges].some(item => item.text.trim().length > 0);
  return {
    ...built,
    // 没有任何正文时快照不能成立：空决策比没有决策更容易被误读成「已定论」。
    snapshot: hasText ? built.snapshot : null,
    decision: hasText ? built.decision : null,
    integrity: hasText ? integrity : { ok: false, issues: ['没有可用回答，未形成决策'] },
    singleModel: participants.length <= 1
  };
}

/**
 * General / Knowledge 的 DMOCA 投影（P1-03）。
 *
 * 与 {@link projectDmocaFromEvents} 产出同一个视图结构、同一套快照字段：
 * 参与决策读 `model.participation.observed`，决策读 `model.decision.snapshot`。
 * 这样三个场景的工作台不必各写一套「谁参与了 / 结论引用了哪一版」。
 */
export function projectDmocaFromConversationEvents(input: {
  conversationId: string;
  events: ReadonlyArray<{ at: number; type: string } & Record<string, unknown>>;
}): DmocaWorkbenchView {
  const ordered = [...input.events]
    .filter(event => event.conversationId === input.conversationId)
    .sort((a, b) => a.at - b.at);
  let decision: ParticipationDecision | null = null;
  let snapshot: ContributionSnapshotView | null = null;
  let decisionSnapshot: DecisionSnapshotView | null = null;
  let artifacts: ContributionArtifactView[] = [];
  for (const event of ordered) {
    if (event.type === 'model.participation.observed') {
      const participants = (event.participants ?? []) as Array<{ participantId: string }>;
      const excluded = (event.excluded ?? []) as Array<{ participantId: string; reason: string }>;
      decision = {
        decisionId: typeof event.decisionId === 'string' ? event.decisionId : `obs:${String(event.at)}`,
        workId: input.conversationId,
        stage: typeof event.stage === 'string' ? event.stage : 'answers',
        risk: (event.risk ?? 'L0') as CollaborationRiskLevel,
        participants: participants.map(item => ({
          participantId: item.participantId,
          roles: [OBSERVER_DMOCA_ROLE],
          reason: typeof event.note === 'string' ? event.note : '会话侧回答'
        })),
        excluded: excluded.map(item => ({ participantId: item.participantId, reason: item.reason })),
        // 会话侧观察记录不做派发决策：辩论与模型审核仍由各自的模型判断。
        debate: 'on_demand',
        modelReview: 'on_demand',
        maxExtraModels: typeof event.maxExtraModels === 'number' ? event.maxExtraModels : 0,
        reasons: (event.reasons ?? []) as string[],
        userPinned: false,
        at: event.at
      };
      continue;
    }
    if (event.type === 'model.decision.snapshot') {
      const nextSnapshot = (event.snapshot ?? null) as ContributionSnapshotView | null;
      const nextDecision = (event.decision ?? null) as DecisionSnapshotView | null;
      if (nextDecision) decisionSnapshot = nextDecision;
      if (nextSnapshot) snapshot = nextSnapshot;
      if (Array.isArray(event.artifacts)) artifacts = event.artifacts as ContributionArtifactView[];
    }
  }
  return { decision, runs: [], contributions: artifacts, snapshot, decisionSnapshot };
}

/**
 * 子任务/会话通用的决策完整性复核入口：把「快照 + 稿件」放在一起查。
 * 三个场景都调这一个，避免某一处自己实现一遍版本比对。
 */
export function checkConversationDecision(view: DmocaWorkbenchView): { ok: boolean; issues: string[] } {
  if (!view.decisionSnapshot) return { ok: false, issues: ['这一轮没有形成决策快照'] };
  return assertDecisionSnapshotIntegrity(view.decisionSnapshot, view.contributions);
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
