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
 * owner id / checkpoint id 在磁盘上的段名（无副作用，纯字符串变换）。
 *
 * 检查点文件、归档目录、回收扫描都要用同一个形态拼路径；各处各写一份的话，
 * 回收就会去删一个从来没被写出来的文件名。转换不可逆（`%`→`_` 有歧义），
 * 所以扫描只比段名、不解码。
 */
export function contextOwnerSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}

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

/**
 * 恢复时的副作用核对（LT-P5-04）。
 *
 * `applied` 只表示「执行报告记录过这个路径，恢复时它仍然存在」，
 * 不是「内容与当时完全一致」——没有记录 hash 就不能这么声称。
 * 无法从报告确认的写操作一律 `needs_reconciliation`，不猜。
 */
export type SideEffectStatus = 'applied' | 'missing' | 'needs_reconciliation';

export interface SideEffectEntry {
  stepId: string;
  /**
   * 步骤所属轮次。模型给的 stepId 每轮都从 step-1 开始，只按 stepId 去重会把
   * 第二轮的在途写操作当成「上一轮已经报告过」而漏掉，所以核对必须带轮次。
   */
  roundId?: string;
  tool: string;
  paths: string[];
  status: SideEffectStatus;
  detail: string;
}

export interface SideEffectLedger {
  entries: SideEffectEntry[];
  applied: number;
  missing: number;
  needsReconciliation: number;
  checkedAt: number;
}

export type ContextEventType =
  | 'context.prepared'
  | 'context.budget.warning'
  | 'context.compaction.started'
  | 'context.compaction.summary.ready'
  | 'context.compaction.committed'
  | 'context.compaction.failed'
  | 'context.compaction.stale'
  /** 检查点可读但工程上下文已过期：恢复前必须重新采集。 */
  | 'context.refresh.required'
  | 'context.recovered'
  /** M2-2：继续时真走的是哪条路——直达执行续跑，还是重新规划。两者都必须可观察。 */
  | 'context.resume.continued'
  | 'context.resume.replanned';

/**
 * 上下文事件在界面上的一句话。时间线（execution-timeline）与对话流（task-conversation）
 * 共用这一份：两处各写一套，迟早变成「在线时和刷新后看到的不是同一句话」。
 * 续跑与重规划必须一眼分得开——前者说明检查点接住了工作，后者意味着有一轮要重做，
 * 只看「上下文事件」四个字，用户无法判断自己该不该等。
 */
export const CONTEXT_EVENT_LABELS: Record<ContextEventType, string> = {
  'context.prepared': '上下文已准备',
  'context.budget.warning': '上下文接近上限',
  'context.compaction.started': '开始压缩上下文',
  'context.compaction.summary.ready': '摘要已生成',
  'context.compaction.committed': '上下文检查点已提交',
  'context.compaction.failed': '上下文压缩失败',
  'context.compaction.stale': '上下文摘要已过期',
  'context.refresh.required': '工程上下文已过期，恢复前需重新采集',
  'context.recovered': '已从检查点恢复上下文',
  'context.resume.continued': '已从检查点续跑：沿用已批准计划，未重新规划',
  'context.resume.replanned': '已重新规划：检查点不足以安全续跑'
};

/** 需要用户注意的上下文事件：预算告警、压缩失败、上下文过期、被迫重规划。 */
const CONTEXT_EVENT_WARN: ReadonlySet<ContextEventType> = new Set([
  'context.budget.warning',
  'context.compaction.failed',
  'context.refresh.required',
  'context.resume.replanned'
]);

export function contextEventView(event: ContextEventType): { text: string; tone: 'warn' | 'muted' } {
  return {
    text: CONTEXT_EVENT_LABELS[event] ?? '上下文事件',
    tone: CONTEXT_EVENT_WARN.has(event) ? 'warn' : 'muted'
  };
}

export interface ContextEventPayload {
  contextId: string;
  ownerType?: ContextOwner['ownerType'];
  ownerId?: string;
  checkpointId?: string;
  modelId?: string;
  providerId?: string;
  level?: 'normal' | 'warning' | 'compaction' | 'overflow' | 'unknown';
  estimatedTokens?: number;
  contextWindow?: number | null;
  usageRatio?: number | null;
  inputTokensBefore?: number | null;
  inputTokensAfter?: number | null;
  /** 事件 payload 只放展示用预览；完整来源在检查点文件。 */
  sourceEventIdsPreview?: string[];
  reason?: string;
  /**
   * 恢复用的活动指针来自哪里：任务字段（Journal 事务写的权威指针）还是事件流重放
   * （任务字段缺失时按最后一条检查点事件重建）。M2-1 要求恢复路径可观测。
   */
  pointerSource?: 'task-fields' | 'events-replay';
  /** 恢复时附带的副作用核对计数；只有 context.recovered 会带。 */
  sideEffects?: {
    applied: number;
    missing: number;
    needsReconciliation: number;
  };
  /**
   * 「继续」这一条路走的是直达续跑还是重新规划，以及为什么。只有
   * context.resume.continued / context.resume.replanned 会带——判错一次就要
   * 重跑写操作或白重规划一轮，事后必须能对回依据。
   */
  resume?: {
    mode: 'continue' | 'replan';
    planId?: string;
    roundId?: string;
    /** 上轮报告已 completed、本轮不重做的步骤。 */
    reusedStepIds?: string[];
    /** 本轮真正要执行的步骤。 */
    pendingStepIds?: string[];
    /** 判定理由；replan 时是「为什么不续跑」。 */
    reasons?: string[];
  };
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
