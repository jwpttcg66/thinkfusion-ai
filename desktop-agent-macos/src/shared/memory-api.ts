/**
 * 渲染层与主进程之间的记忆契约。
 *
 * 刻意不复用 `src/main/memory/types.ts`：那一层是主进程内部（含 SQLite
 * 行类型与 store 输入），让渲染层依赖它会把数据库类型带进沙箱。
 * 这里只放界面真正需要的视图字段。
 */

import type { MemoryCandidate, MemoryRecord, MemorySettings, MemoryUsageEvent } from './memory';

export type MemoryMigrationState = 'absent' | 'done' | 'failed' | 'mismatch' | 'blocked';

export interface MemoryStatusView {
  state: 'ready' | 'degraded';
  /** degraded 的原因；ready 时为空。 */
  detail?: string;
  file: string;
  schemaVersion: number;
  records: number;
  candidates: number;
  migration: MemoryMigrationState;
  migrationDetail?: string;
  settings: MemorySettings;
  /** 记忆总开关（enabled 且库可用）。 */
  enabled: boolean;
}

export interface MemoryAuditEntry {
  at: number;
  action: string;
  memoryId?: string;
  detail?: string;
}

export interface MemoryConflictGroup {
  scope: string;
  scopeId: string;
  normalizedKey: string;
  memoryIds: string[];
}

export interface MemoryLinkView {
  symbolKey: string;
  linkType: string;
  filePath?: string;
}

export interface MemoryCandidateDecisionView {
  candidate: MemoryCandidate;
  record?: MemoryRecord;
  reason?: string;
}

export interface MemoryApi {
  status(): Promise<MemoryStatusView>;
  getSettings(): Promise<MemorySettings>;
  setSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>;

  listCandidates(status?: 'pending' | 'approved' | 'rejected' | 'all'): Promise<MemoryCandidate[]>;
  confirmCandidate(candidateId: string): Promise<MemoryCandidateDecisionView>;
  rejectCandidate(candidateId: string): Promise<MemoryCandidateDecisionView>;

  listRecords(query?: unknown): Promise<MemoryRecord[]>;
  getRecord(memoryId: string): Promise<MemoryRecord | null>;
  remember(input: unknown): Promise<MemoryRecord | null>;
  patchRecord(memoryId: string, patch: unknown): Promise<MemoryRecord | null>;
  deleteRecord(memoryId: string): Promise<boolean>;

  conflicts(): Promise<MemoryConflictGroup[]>;
  refute(memoryId: string): Promise<MemoryRecord | null>;
  expire(memoryId: string): Promise<MemoryRecord | null>;
  archive(memoryId: string): Promise<MemoryRecord | null>;
  supersede(oldMemoryId: string, input: unknown): Promise<{ record: MemoryRecord; previous: MemoryRecord | null } | null>;

  getUsage(requestId: string): Promise<MemoryUsageEvent | null>;
  listUsage(conversationId?: string): Promise<MemoryUsageEvent[]>;
  audit(limit?: number): Promise<MemoryAuditEntry[]>;

  exportAll(): Promise<unknown>;
  /**
   * 导出到磁盘（主进程写 Downloads，返回真实路径）。
   *
   * 不用渲染层 `Blob` + `a[download]`：真机验收发现 Electron 里这两步
   * 不一定落地（下载被 session 拦掉或需要保存框），界面会显示「已导出」
   * 但磁盘上没有文件。主进程写文件是唯一能验收的方式。
   */
  exportToFile(): Promise<{ path: string; records: number; candidates: number }>;
  importAll(data: unknown): Promise<{ imported: number; archivedForConflict: number }>;
  links(memoryId: string): Promise<MemoryLinkView[]>;

  /** 抽取失败后的人工重试（MEM-09）。 */
  extract(input: unknown): Promise<unknown>;
}
