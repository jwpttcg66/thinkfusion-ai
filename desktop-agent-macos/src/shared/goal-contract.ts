/**
 * 目标契约（GCE-P1）纯函数层。
 *
 * 只定义用户目标的结构化表达、Criterion、状态机和逐条 Goal Fit；
 * 不读写存储、不调用模型、不修改任务状态。
 *
 * 规范：docs/spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md
 */

export type GoalSource =
  | 'USER_EXPLICIT'
  | 'USER_CONFIRMED'
  | 'MODEL_INFERRED'
  | 'PROJECT_EVIDENCE'
  | 'SYSTEM_CONSTRAINT'
  | 'UNRESOLVED';

export type GoalDimensionKind =
  | 'USER_INTENT'
  | 'DESIRED_OUTCOME'
  | 'GOAL_VALUE'
  | 'SUCCESS_CRITERIA'
  | 'IMPLICIT_CONSTRAINT'
  | 'FEASIBILITY';

export const GOAL_DIMENSION_KINDS: readonly GoalDimensionKind[] = [
  'USER_INTENT',
  'DESIRED_OUTCOME',
  'GOAL_VALUE',
  'SUCCESS_CRITERIA',
  'IMPLICIT_CONSTRAINT',
  'FEASIBILITY'
];

export interface GoalDimension {
  kind: GoalDimensionKind;
  text: string;
  source: GoalSource;
  confidence: number;
  confirmedByUser: boolean;
  conflictsWith: string[];
  evidenceRefs: string[];
  updatedAt: number;
}

export type CriterionPriority = 'MUST' | 'SHOULD' | 'NICE';
export type CriterionStatus = 'PENDING' | 'MET' | 'PARTIAL' | 'UNMET' | 'UNVERIFIED' | 'WAIVED';

export type GoalEvidenceType =
  | 'MODEL_CLAIM'
  | 'TOOL_RESULT'
  | 'FILE_READBACK'
  | 'BUILD_RESULT'
  | 'TEST_RESULT'
  | 'RUNTIME_RESULT'
  | 'INTEGRATION_RESULT'
  | 'USER_ACCEPTANCE';

export interface GoalEvidenceLink {
  evidenceId: string;
  workId: string;
  cycleId: string;
  workTaskId?: string;
  criterionId?: string;
  goalVersion: number;
  evidenceType: GoalEvidenceType;
  source: string;
  contentHash?: string;
  verificationStatus: 'PENDING' | 'PASSED' | 'FAILED' | 'UNKNOWN';
  linkedAt: number;
}

export interface GoalCriterion {
  criterionId: string;
  goalId: string;
  goalVersion: number;
  description: string;
  source: GoalSource;
  priority: CriterionPriority;
  verificationMethod: string;
  acceptanceThreshold: string;
  status: CriterionStatus;
  evidenceRefs: string[];
  /** 该 Criterion 接受的证据类型；缺省不限制，但仍排除 MODEL_CLAIM 单独成立。 */
  acceptedEvidenceTypes?: GoalEvidenceType[];
  waiver?: { authorizedBy: string; reason: string; at: number };
  updatedAt: number;
}

export type GoalContractStatus =
  | 'DRAFT'
  | 'UNDERSTANDING'
  | 'CLARIFYING'
  | 'READY_FOR_CONFIRMATION'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'AT_RISK'
  | 'CHANGE_PROPOSED'
  | 'BLOCKED'
  | 'ACHIEVED'
  | 'ACHIEVED_WITH_RISKS'
  | 'PARTIAL_ACHIEVEMENT'
  | 'ABANDONED';

export interface GoalContract {
  goalId: string;
  workId: string;
  originalRequest: string;
  dimensions: GoalDimension[];
  criteria: GoalCriterion[];
  goalVersion: number;
  status: GoalContractStatus;
  assumptions: string[];
  openQuestions: string[];
  blockingRisks: string[];
  createdAt: number;
  updatedAt: number;
}

export type GoalContractFit = 'MET' | 'WITH_RISKS' | 'PARTIAL' | 'GAP' | 'UNKNOWN';

export interface GoalFitAssessment {
  goalId: string;
  goalVersion: number;
  fit: GoalContractFit;
  met: number;
  partial: number;
  unmet: number;
  unverified: number;
  waived: number;
  blockingRisks: string[];
  evidenceCompleteness: number;
  notes: string[];
}

export interface GoalContractValidation {
  ok: boolean;
  reasons: string[];
}

export type GoalChangeKind = 'clarify' | 'optimize' | 'change';

export interface GoalChangeResult {
  contract: GoalContract;
  kind: GoalChangeKind;
  requiresUserConfirmation: boolean;
  changed: boolean;
  reason: string;
}

const TRANSITIONS: Record<GoalContractStatus, readonly GoalContractStatus[]> = {
  DRAFT: ['UNDERSTANDING'],
  UNDERSTANDING: ['CLARIFYING', 'READY_FOR_CONFIRMATION', 'ACTIVE'],
  CLARIFYING: ['UNDERSTANDING'],
  READY_FOR_CONFIRMATION: ['CONFIRMED', 'UNDERSTANDING'],
  CONFIRMED: ['ACTIVE'],
  ACTIVE: ['AT_RISK', 'CHANGE_PROPOSED', 'BLOCKED', 'ACHIEVED', 'ACHIEVED_WITH_RISKS', 'PARTIAL_ACHIEVEMENT'],
  AT_RISK: ['ACTIVE', 'CHANGE_PROPOSED', 'BLOCKED'],
  CHANGE_PROPOSED: ['ACTIVE', 'BLOCKED'],
  BLOCKED: ['ACTIVE', 'ABANDONED'],
  ACHIEVED: [],
  ACHIEVED_WITH_RISKS: [],
  PARTIAL_ACHIEVEMENT: [],
  ABANDONED: []
};

const CONFIRM_REQUIRED: readonly GoalContractStatus[] = [
  'CONFIRMED',
  'ACHIEVED',
  'ACHIEVED_WITH_RISKS',
  'PARTIAL_ACHIEVEMENT'
];

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function emptyDimension(kind: GoalDimensionKind): GoalDimension {
  return {
    kind,
    text: '',
    source: 'UNRESOLVED',
    confidence: 0,
    confirmedByUser: false,
    conflictsWith: [],
    evidenceRefs: [],
    updatedAt: 0
  };
}

/** 创建/补齐六维目标；缺失维度保持 UNRESOLVED，不猜内容。 */
export function normalizeGoalDimensions(
  input: readonly Partial<GoalDimension>[],
  at = Date.now()
): GoalDimension[] {
  const byKind = new Map(input.map(item => [item.kind, item]));
  return GOAL_DIMENSION_KINDS.map(kind => {
    const item = byKind.get(kind);
    if (!item) return { ...emptyDimension(kind), updatedAt: at };
    return {
      kind,
      text: typeof item.text === 'string' ? item.text : '',
      source: item.source ?? 'UNRESOLVED',
      confidence: clampConfidence(item.confidence ?? 0),
      confirmedByUser: item.confirmedByUser === true,
      conflictsWith: [...(item.conflictsWith ?? [])],
      evidenceRefs: [...(item.evidenceRefs ?? [])],
      updatedAt: item.updatedAt ?? at
    };
  });
}

export function createGoalContract(input: {
  goalId: string;
  workId: string;
  originalRequest: string;
  dimensions?: readonly Partial<GoalDimension>[];
  criteria?: readonly GoalCriterion[];
  goalVersion?: number;
  status?: GoalContractStatus;
  assumptions?: readonly string[];
  openQuestions?: readonly string[];
  blockingRisks?: readonly string[];
  createdAt?: number;
}): GoalContract {
  const at = input.createdAt ?? Date.now();
  return {
    goalId: input.goalId,
    workId: input.workId,
    originalRequest: input.originalRequest.trim(),
    dimensions: normalizeGoalDimensions(input.dimensions ?? [], at),
    criteria: [...(input.criteria ?? [])],
    goalVersion: input.goalVersion ?? 1,
    status: input.status ?? 'DRAFT',
    assumptions: [...(input.assumptions ?? [])],
    openQuestions: [...(input.openQuestions ?? [])],
    blockingRisks: [...(input.blockingRisks ?? [])],
    createdAt: at,
    updatedAt: at
  };
}

export function createGoalCriterion(input: {
  goalId: string;
  goalVersion: number;
  criterionId: string;
  description: string;
  source: GoalSource;
  priority?: CriterionPriority;
  verificationMethod: string;
  acceptanceThreshold: string;
  status?: CriterionStatus;
  evidenceRefs?: readonly string[];
  acceptedEvidenceTypes?: readonly GoalEvidenceType[];
  waiver?: GoalCriterion['waiver'];
  updatedAt?: number;
}): GoalCriterion {
  return {
    criterionId: input.criterionId,
    goalId: input.goalId,
    goalVersion: input.goalVersion,
    description: input.description.trim(),
    source: input.source,
    priority: input.priority ?? 'MUST',
    verificationMethod: input.verificationMethod.trim(),
    acceptanceThreshold: input.acceptanceThreshold.trim(),
    status: input.status ?? 'PENDING',
    evidenceRefs: [...(input.evidenceRefs ?? [])],
    ...(input.acceptedEvidenceTypes && input.acceptedEvidenceTypes.length > 0
      ? { acceptedEvidenceTypes: [...input.acceptedEvidenceTypes] }
      : {}),
    ...(input.waiver ? { waiver: { ...input.waiver } } : {}),
    updatedAt: input.updatedAt ?? Date.now()
  };
}

export function canTransitionGoalContract(
  from: GoalContractStatus,
  to: GoalContractStatus
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionGoalContract(
  contract: GoalContract,
  to: GoalContractStatus,
  at = Date.now()
): GoalContract {
  if (!canTransitionGoalContract(contract.status, to)) {
    throw new Error(`非法目标状态转换：${contract.status} → ${to}`);
  }
  return { ...contract, status: to, updatedAt: at };
}

/** 校验不变量；只报告，不静默修正。 */
export function validateGoalContract(contract: GoalContract): GoalContractValidation {
  const reasons: string[] = [];
  if (!contract.goalId.trim()) reasons.push('goalId 为空');
  if (!contract.originalRequest.trim()) reasons.push('原始用户请求为空');
  if (contract.goalVersion < 1) reasons.push('goalVersion 必须 ≥ 1');

  const ids = new Set<string>();
  for (const criterion of contract.criteria) {
    if (!criterion.criterionId.trim()) reasons.push('Criterion 缺少 criterionId');
    if (ids.has(criterion.criterionId)) reasons.push(`Criterion id 重复：${criterion.criterionId}`);
    ids.add(criterion.criterionId);
    if (criterion.goalId !== contract.goalId) {
      reasons.push(`${criterion.criterionId} 绑定了其他 goalId`);
    }
    if (criterion.goalVersion !== contract.goalVersion) {
      reasons.push(`${criterion.criterionId} 的 goalVersion 与目标不一致`);
    }
    if (!criterion.description.trim()) reasons.push(`${criterion.criterionId} 描述为空`);
    if (criterion.status === 'MET' && criterion.evidenceRefs.length === 0) {
      reasons.push(`${criterion.criterionId} 标为 MET 但没有证据`);
    }
    if (criterion.status === 'WAIVED' && !criterion.waiver) {
      reasons.push(`${criterion.criterionId} 标为 WAIVED 但没有授权记录`);
    }
  }

  for (const dimension of contract.dimensions) {
    if (dimension.source === 'MODEL_INFERRED' && dimension.confirmedByUser) {
      reasons.push(`${dimension.kind} 是模型推断，不能标记为用户确认`);
    }
    if (dimension.source === 'USER_CONFIRMED' && !dimension.confirmedByUser) {
      reasons.push(`${dimension.kind} 来源为 USER_CONFIRMED 但未经确认`);
    }
  }

  if (CONFIRM_REQUIRED.includes(contract.status) && contract.criteria.length === 0) {
    reasons.push(`${contract.status} 状态至少需要一条成功标准`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** 逐条汇总 Goal Fit；不使用整体 verified/fullyVerified 代替。 */
export function assessGoalContractFit(contract: GoalContract): GoalFitAssessment {
  const total = contract.criteria.length;
  const met = contract.criteria.filter(item => item.status === 'MET').length;
  const partial = contract.criteria.filter(item => item.status === 'PARTIAL').length;
  const unmet = contract.criteria.filter(item => item.status === 'UNMET').length;
  const unverified = contract.criteria.filter(item => item.status === 'UNVERIFIED').length;
  const waived = contract.criteria.filter(item => item.status === 'WAIVED').length;
  const must = contract.criteria.filter(item => item.priority === 'MUST');
  const mustBlocked = must.filter(item =>
    item.status === 'UNMET'
    || item.status === 'UNVERIFIED'
    || item.status === 'PARTIAL'
  ).length;
  const evidenceCompleteness = total === 0
    ? 0
    : contract.criteria.filter(item => item.evidenceRefs.length > 0 || item.status === 'WAIVED').length / total;

  let fit: GoalContractFit = 'UNKNOWN';
  if (total > 0) {
    if (contract.blockingRisks.length > 0 || must.some(item => item.status === 'UNMET')) {
      fit = 'GAP';
    } else if (mustBlocked > 0) {
      fit = 'PARTIAL';
    } else if (waived > 0 || partial > 0 || unverified > 0) {
      fit = 'WITH_RISKS';
    } else if (met === total) {
      fit = 'MET';
    }
  }

  const notes: string[] = [];
  if (total === 0) notes.push('尚未建立成功标准');
  if (contract.blockingRisks.length > 0) notes.push(`存在 ${String(contract.blockingRisks.length)} 个阻塞风险`);
  if (mustBlocked > 0) notes.push(`${String(mustBlocked)} 条强制标准尚未满足或未验证`);
  if (waived > 0) notes.push(`${String(waived)} 条标准已授权豁免`);

  return {
    goalId: contract.goalId,
    goalVersion: contract.goalVersion,
    fit,
    met,
    partial,
    unmet,
    unverified,
    waived,
    blockingRisks: [...contract.blockingRisks],
    evidenceCompleteness,
    notes
  };
}

function classifyCriteriaChange(
  previous: readonly string[],
  next: readonly string[]
): GoalChangeKind {
  const prev = new Set(previous.map(item => item.trim()).filter(Boolean));
  const nextSet = new Set(next.map(item => item.trim()).filter(Boolean));
  let removed = 0;
  let added = 0;
  for (const item of prev) if (!nextSet.has(item)) removed += 1;
  for (const item of nextSet) if (!prev.has(item)) added += 1;
  if (removed > 0) return 'change';
  if (added > 0) return 'clarify';
  return 'optimize';
}

/**
 * 目标变更：删减标准属于 change，必须用户确认；确认才抬版本，拒绝则保持旧目标。
 * 不通过任务摘要或模型推断偷偷改变用户目标。
 */
export function applyGoalContractChange(
  contract: GoalContract,
  nextCriteria: readonly GoalCriterion[],
  options: { userConfirmed?: boolean; at?: number } = {}
): GoalChangeResult {
  const kind = classifyCriteriaChange(
    contract.criteria.map(item => item.description),
    nextCriteria.map(item => item.description)
  );
  const requires = kind === 'change' && options.userConfirmed !== true;
  if (requires) {
    return {
      contract,
      kind,
      requiresUserConfirmation: true,
      changed: false,
      reason: '成功标准被删减，必须由用户确认后才改变目标版本'
    };
  }
  const nextVersion = kind === 'change' ? contract.goalVersion + 1 : contract.goalVersion;
  const updated: GoalContract = {
    ...contract,
    criteria: nextCriteria.map(item => ({ ...item, goalVersion: nextVersion })),
    goalVersion: nextVersion,
    status: contract.status === 'CHANGE_PROPOSED' ? 'ACTIVE' : contract.status,
    updatedAt: options.at ?? Date.now()
  };
  return {
    contract: updated,
    kind,
    requiresUserConfirmation: false,
    changed: nextVersion !== contract.goalVersion || kind === 'clarify',
    reason: kind === 'change'
      ? '用户已确认目标变更，版本递增'
      : kind === 'clarify'
        ? '补充成功标准，不改变目标版本'
        : '目标与标准未变化'
  };
}
