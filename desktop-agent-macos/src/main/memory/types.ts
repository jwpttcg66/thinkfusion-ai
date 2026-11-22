/**
 * 记忆子系统的内部类型（只给主进程用）。
 *
 * 与 `src/shared/memory.ts` 的区别：shared 里是"跨进程要传的契约"，
 * 这里放 store / service 之间的输入输出，以及数据库状态。
 */

import type {
  CandidateStatus,
  MemoryCandidate,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySettings,
  MemoryStatus,
  MemoryUsageEvent
} from '../../shared/memory';

export interface MemoryStoreStatus {
  state: 'ready' | 'degraded';
  /** degraded 的原因；ready 时为空。 */
  detail?: string;
  file: string;
  schemaVersion: number;
  records: number;
  candidates: number;
  /** 迁移状态：absent / done / failed / mismatch / blocked。 */
  migration: 'absent' | 'done' | 'failed' | 'mismatch' | 'blocked';
  migrationDetail?: string;
}

export interface RememberInput {
  kind: MemoryKind;
  scope: MemoryScope;
  scopeId?: string;
  projectRoot?: string;
  title: string;
  content: string;
  normalizedKey?: string;
  sourceRefs?: string[];
  evidenceRefs?: string[];
  codeRefs?: MemoryRecord['codeRefs'];
  tags?: string[];
  confidence?: number;
  riskLevel?: MemoryRecord['riskLevel'];
  sensitivity?: MemoryRecord['sensitivity'];
  validFrom?: number;
  expiresAt?: number;
  status?: MemoryStatus;
  supersedes?: string[];
  /** 显式指定 id（迁移用）。 */
  memoryId?: string;
}

export interface RecordPatch {
  title?: string;
  content?: string;
  normalizedKey?: string;
  tags?: string[];
  confidence?: number;
  riskLevel?: MemoryRecord['riskLevel'];
  status?: MemoryStatus;
  expiresAt?: number | null;
  lastConfirmedAt?: number | null;
  supersededBy?: string | null;
  supersedes?: string[];
}

export interface CandidateInput {
  sourceConversationId: string;
  sourceMessageIds: string[];
  sourceTaskId?: string;
  projectRoot?: string;
  proposedKind: MemoryKind;
  proposedScope: MemoryScope;
  proposedScopeId?: string;
  proposedTitle: string;
  proposedContent: string;
  quote: string;
  sourceRefs?: string[];
  confidence: number;
  riskLevel: MemoryCandidate['riskLevel'];
  reason: string;
  requiresConfirmation: boolean;
  dedupeKey: string;
  candidateId?: string;
  createdAt?: number;
}

export interface ListRecordsQuery {
  scope?: MemoryScope;
  scopeId?: string;
  status?: MemoryStatus | MemoryStatus[];
  limit?: number;
  /** 管理面板用：标题/内容包含。召回不走这里。 */
  contains?: string;
}

export interface MemoryExport {
  version: number;
  exportedAt: number;
  records: MemoryRecord[];
  candidates: MemoryCandidate[];
}

/** 召回请求。projectId / workspaceId 空表示该项不参与范围过滤。 */
export interface RecallQuery {
  question: string;
  conversationId: string;
  projectId?: string;
  workspaceId?: string;
  /** 参与排序的 scope 集合；默认按 query 里给了哪些 id 决定。 */
  limit?: number;
  minScore?: number;
  now?: number;
  /** 用于 stale 判定：项目当前 HEAD。 */
  headCommit?: string;
}

export interface RecallCandidateScore {
  memoryId: string;
  score: number;
  lex: number;
  kindWeight: number;
  scopeWeight: number;
  recency: number;
  confidence: number;
  confirmBonus: number;
  penalty: number;
}

export interface OmittedMemory {
  memoryId: string;
  reason: 'expired' | 'stale' | 'conflict' | 'superseded' | 'refuted' | 'archived' | 'candidate' | 'scope' | 'budget' | 'low-score';
}

export interface RecallResult {
  included: MemoryRecord[];
  omitted: OmittedMemory[];
  scores: RecallCandidateScore[];
  threshold: number;
}

export type MemorySettingsPatch = Partial<MemorySettings>;

export interface UsageRecordInput extends MemoryUsageEvent {}

export interface CandidateDecisionResult {
  candidate: MemoryCandidate;
  record?: MemoryRecord;
  /** 拒绝/批准之外的副作用说明，例如密钥丢弃。 */
  reason?: string;
}

/** 迁移结果，写进 `memory_audit` 并进 status。 */
export interface MigrationResult {
  status: 'absent' | 'done' | 'failed' | 'mismatch' | 'blocked';
  detail?: string;
  imported?: number;
  expected?: number;
  orphanLinks?: number;
  backup?: string;
}

export interface MemoryServiceOptions {
  /** memory.sqlite 路径。 */
  file: string;
  /** code-index.sqlite 路径；缺失就不迁移。 */
  legacyFile?: string;
  /** 设置文件路径；缺省与 memory.sqlite 同目录 settings.json。 */
  settingsFile?: string;
  now?: () => number;
}

export interface MemoryServiceStatus extends MemoryStoreStatus {
  settings: MemorySettings;
  enabled: boolean;
}

export type CandidateStatusFilter = CandidateStatus | 'all';
