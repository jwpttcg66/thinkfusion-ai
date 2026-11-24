/**
 * 长任务与上下文压缩的共享契约（LT-P0-02 / LT-P0-05）。
 *
 * 这里只定义类型、常量和无副作用的校验函数；不实现 ContextManager、
 * 不读写磁盘、不调用 Provider。
 *
 * 契约冻结依据：
 * - docs/spec/LONG_TASK_CONTEXT_CONTRACTS.md
 * - docs/architecture/CONTEXT_CHECKPOINT_STORAGE.md
 * - docs/adr/0010-context-checkpoint-storage.md
 */

export const CONTEXT_CONTRACT_VERSION = 1 as const;
export type ContextContractVersion = typeof CONTEXT_CONTRACT_VERSION;

/**
 * 上下文所有权。
 *
 * Engineering 用 agent-task；General/Knowledge 用 conversation。
 * 不能为了复用接口伪造 AgentTask。
 */
export type ContextOwner =
  | {
      ownerType: 'agent-task';
      ownerId: string;
      taskId: string;
      runId: string;
    }
  | {
      ownerType: 'conversation';
      ownerId: string;
      conversationId: string;
      runId: string;
    };

export type BudgetConfidence = 'verified' | 'configured' | 'estimated' | 'unknown';
export type BudgetSource = 'provider' | 'config' | 'estimated' | 'conservative';

export interface ContextBudget {
  providerId: string;
  modelId: string;
  /** Provider 声明或配置的窗口；未知为 null，不伪造。 */
  contextWindow: number | null;
  /** 为输出预留的 Token；未知为 null。 */
  maxOutputTokens: number | null;
  /** 本次请求估算输入；不是 Provider 实际值。 */
  estimatedInputTokens: number;
  /** Provider 返回的真实输入；没有为 null。 */
  actualInputTokens: number | null;
  /** 0–1，默认 0.65。 */
  warningThreshold: number;
  /** 0–1，默认 0.85。 */
  compactionThreshold: number;
  budgetSource: BudgetSource;
  /** 用户或系统配置的保守输入上限；没有为 undefined。 */
  configuredInputLimit?: number;
  confidence: BudgetConfidence;
}

export interface BudgetDecision {
  budget: ContextBudget;
  /** window - outputReserve - safetyMargin；未知为 null。 */
  inputLimit: number | null;
  /** 有可靠分母时才计算；未知窗口为 null。 */
  usageRatio: number | null;
  level: 'normal' | 'warning' | 'compaction' | 'overflow' | 'unknown';
  reason: string;
}

export type ContextCompactionStatus =
  | 'not-needed'
  | 'preparing'
  | 'summarizing'
  | 'validating'
  | 'committed'
  | 'failed'
  | 'stale';

export interface ContextHistoryItem {
  eventId: string;
  kind: 'message' | 'tool' | 'model' | 'system' | 'evidence';
  role?: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
  roundId?: string;
  stepId?: string;
  attemptId?: string;
  /** 工具调用必须与结果成对；未配对不压缩。 */
  toolCallId?: string;
  evidenceRefs?: string[];
  /** 原始内容的位置；裁剪后仍可回查。 */
  sourceRef?: string;
}

export interface PreparedContext {
  contextId: string;
  owner: ContextOwner;
  /** 兼容镜像：agent-task 时有 taskId；conversation 时没有。 */
  taskId?: string;
  /** 兼容镜像：conversation 时有 conversationId；agent-task 时没有。 */
  conversationId?: string;
  runId: string;
  checkpointId?: string;
  includedEventIds: string[];
  retainedEventIds: string[];
  evidenceRefs: string[];
  memoryRequestId?: string;
  estimatedTokens: number;
  contextWindow: number | null;
  compactionStatus: ContextCompactionStatus;
}

export type CheckpointStatus = 'prepared' | 'committed' | 'failed';

export interface SummaryItem {
  text: string;
  /** verified 只能来自执行事件；模型推测必须标 claim。 */
  certainty: 'verified' | 'claim';
  eventIds: string[];
}

export interface SummaryDecision {
  text: string;
  status: 'active' | 'superseded';
  /** 被后续决定取代时必须写清；不能保留两条矛盾决策。 */
  supersededBy?: string;
  eventIds: string[];
}

export interface SummaryEvidence {
  ref: string;
  kind: 'file' | 'commit' | 'test' | 'assertion' | 'pack';
  path?: string;
  hash?: string;
  eventIds: string[];
}

export interface ContextSummary {
  goal: string;
  constraints: string[];
  completed: SummaryItem[];
  decisions: SummaryDecision[];
  evidence: SummaryEvidence[];
  openIssues: string[];
  currentStep: string | null;
  nextActions: string[];
  risks: string[];
  stopConditions: string[];
}

export interface ContextCheckpoint {
  contractVersion: ContextContractVersion;
  checkpointId: string;
  owner: ContextOwner;
  taskId?: string;
  conversationId?: string;
  runId: string;
  contextId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  /** 完整来源引用：用于校验、恢复、审计；不得截断。 */
  sourceEventIds: string[];
  /** 仅用于 UI/事件 payload 的预览；不能用于完整性校验。 */
  sourceEventIdsPreview?: string[];
  /** 原始事件归档段；Journal 裁剪前必须已存在。 */
  archiveRef?: string;
  summary: ContextSummary;
  summaryHash: string;
  retainedEventIds: string[];
  evidenceRefs: string[];
  modelId: string;
  inputTokensBefore: number | null;
  inputTokensAfter: number | null;
  /**
   * 文件状态。注意：status=prepared 不等于未提交；Journal 活动指针
   * （owner + runId + checkpointId）才是提交权威。
   */
  status: CheckpointStatus;
  createdAt: number;
  committedAt?: number;
  failureReason?: string;
}

/** 检查点文件（按 owner 聚合）。activeCache 只能由 Journal 指针重建。 */
export interface ContextOwnerFile {
  contractVersion: ContextContractVersion;
  owner: ContextOwner;
  checkpoints: ContextCheckpoint[];
  activeCache?: { runId: string; checkpointId: string } | null;
  updatedAt: number;
}

export type ContextEventType =
  | 'context.budget.warning'
  | 'context.compaction.started'
  | 'context.compaction.summary.ready'
  | 'context.compaction.committed'
  | 'context.compaction.failed'
  | 'context.compaction.stale'
  | 'context.recovered';

export interface ContextEventPayload {
  contextId: string;
  ownerType?: ContextOwner['ownerType'];
  ownerId?: string;
  checkpointId?: string;
  modelId?: string;
  providerId?: string;
  level?: 'normal' | 'warning' | 'compaction' | 'overflow';
  inputTokensBefore?: number | null;
  inputTokensAfter?: number | null;
  /** 事件 payload 只放展示用预览；完整来源在检查点文件。 */
  sourceEventIdsPreview?: string[];
  reason?: string;
}

export interface PrepareContextInput {
  owner: ContextOwner;
  /** 兼容镜像：agent-task 时由 owner 带出；conversation 时不存在。 */
  taskId?: string;
  conversationId?: string;
  runId: string;
  roundId?: string;
  stepId?: string;
  attemptId?: string;
  question: string;
  context: string[];
  system: string[];
  history: ContextHistoryItem[];
  evidenceRefs: string[];
  providerId: string;
  modelId: string;
}

export interface FinalizeContextInput {
  contextId: string;
  owner: ContextOwner;
  runId: string;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  providerId: string;
  modelId: string;
}

export interface ContextManager {
  prepare(input: PrepareContextInput): Promise<{
    context: PreparedContext;
    question: string;
    contextLines: string[];
    systemLines: string[];
  }>;
  finalize(input: FinalizeContextInput): Promise<void>;
  recover(input: { owner: ContextOwner; runId: string }): Promise<PreparedContext | null>;
}

/**
 * 长任务新增状态先作为独立类型定义，P5 再并入 TaskStatus。
 * 这样 P0 不会因为状态机/UI 的 exhaustive switch 立刻断裂。
 */
export type LongTaskStatus = 'paused' | 'interrupted' | 'budget_exhausted' | 'blocked';

export const LONG_TASK_STATUSES: readonly LongTaskStatus[] = [
  'paused',
  'interrupted',
  'budget_exhausted',
  'blocked'
];

const CHECKPOINT_STATUSES: readonly CheckpointStatus[] = ['prepared', 'committed', 'failed'];
const COMPACTION_STATUSES: readonly ContextCompactionStatus[] = [
  'not-needed',
  'preparing',
  'summarizing',
  'validating',
  'committed',
  'failed',
  'stale'
];

/** 稳定的 owner key：用于文件路径/日志，不做安全边界判断。 */
export function contextOwnerKey(owner: ContextOwner): string {
  return `${owner.ownerType}:${owner.ownerId}`;
}

/** 运行时守卫：来自持久化数据时先校验，避免把任意对象当 owner。 */
export function isContextOwner(value: unknown): value is ContextOwner {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (item.ownerType === 'agent-task') {
    return typeof item.ownerId === 'string'
      && item.ownerId.length > 0
      && typeof item.taskId === 'string'
      && item.taskId.length > 0
      && typeof item.runId === 'string'
      && item.runId.length > 0;
  }
  if (item.ownerType === 'conversation') {
    return typeof item.ownerId === 'string'
      && item.ownerId.length > 0
      && typeof item.conversationId === 'string'
      && item.conversationId.length > 0
      && typeof item.runId === 'string'
      && item.runId.length > 0;
  }
  return false;
}

export function isCheckpointStatus(value: unknown): value is CheckpointStatus {
  return typeof value === 'string' && CHECKPOINT_STATUSES.includes(value as CheckpointStatus);
}

export function isContextCompactionStatus(value: unknown): value is ContextCompactionStatus {
  return typeof value === 'string'
    && COMPACTION_STATUSES.includes(value as ContextCompactionStatus);
}

export function isLongTaskStatus(value: unknown): value is LongTaskStatus {
  return typeof value === 'string' && LONG_TASK_STATUSES.includes(value as LongTaskStatus);
}
