/**
 * MemoryService：应用级记忆门面（主进程单例）。
 *
 * 它是横切服务，不是第二套 Runtime：只管长期记忆的写入、召回、注入、治理与
 * 送达记录，不碰任务调度 / Journal / Verifier / EvidenceStore。
 *
 * 三条硬约束：
 * 1. 记忆库打不开 → `degraded`，回答照常，不注入、不写入、界面红字；
 * 2. 抽取、落库、usage 全部旁路，任何异常都不能把主链路带下去；
 * 3. 关闭记忆后不读、不写、不注入。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MEMORY_DEFAULTS,
  RECALL_THRESHOLD,
  type MemoryCandidate,
  type MemoryContext,
  type MemoryRecord,
  type MemoryScope,
  type MemorySettings,
  type MemoryUsageEvent
} from '../../shared/memory';
import type { SubAgentAnswer, SubAgentTask } from '../agents/types';
import { attachMemory, finalizeInjection, type AttachDeps, type AttachResult, type MemorySourceType } from './inject';
import type { PendingInjection } from './usage';
import { migrateLegacy, countOrphanLinks } from './migrate';
import { candidateToRecordInput, decideCandidate, type CandidateReason } from './policy';
import { extractFromMessage, extractFromTaskReport, type ExtractMessageInput, type ExtractResult, type TaskReportInput } from './extract';
import { recallMemories } from './recall';
import { degradedStatus, openMemoryStore, MemoryStore } from './store';
import type {
  CandidateDecisionResult,
  CandidateInput,
  CandidateStatusFilter,
  ListRecordsQuery,
  MemoryExport,
  MemoryServiceOptions,
  MemoryServiceStatus,
  MemorySettingsPatch,
  MemoryStoreStatus,
  MigrationResult,
  RecallResult,
  RecordPatch,
  RememberInput
} from './types';

/** degraded 时的空实现：让注入链路仍能走完（判 skipped），不落库也不抛错。 */
const NULL_STORE: Pick<MemoryStore, 'allForScopes' | 'upsertUsage'> = {
  allForScopes: () => [],
  upsertUsage: () => undefined
};

export interface AttachExtra {
  sourceType: MemorySourceType;
  agentId: string;
  providerId?: string;
  modelId?: string;
}

export interface ConflictingGroup {
  scope: string;
  scopeId: string;
  normalizedKey: string;
  memoryIds: string[];
}

export class MemoryService {
  readonly file: string;
  readonly legacyFile?: string;
  readonly settingsFile: string;
  private readonly now: () => number;
  private settings: MemorySettings;
  private baseStatus: MemoryStoreStatus;
  private migration: MigrationResult;
  private seq = 0;
  private store: MemoryStore | null;

  constructor(options: MemoryServiceOptions) {
    this.file = options.file;
    this.legacyFile = options.legacyFile;
    this.settingsFile = options.settingsFile ?? path.join(path.dirname(options.file), 'settings.json');
    this.now = options.now ?? Date.now;
    this.settings = { ...MEMORY_DEFAULTS };

    const opened = openMemoryStore(this.file, { now: this.now });
    this.store = opened.store;
    this.migration = { status: 'absent' };

    if (!this.store) {
      this.baseStatus = degradedStatus(this.file, opened.error ?? 'unknown');
      return;
    }

    this.settings = this.loadSettings();
    this.baseStatus = this.readStoreStatus();
    try {
      this.migration = migrateLegacy({
        store: this.store,
        ...(this.legacyFile ? { legacyFile: this.legacyFile } : {}),
        backupDir: path.join(path.dirname(this.file), 'backups'),
        now: this.now
      });
      this.baseStatus = this.readStoreStatus();
      if (this.legacyFile) {
        const orphanLinks = countOrphanLinks(this.legacyFile, this.store);
        this.store.recordAudit('migration.orphan-links', undefined, `orphanLinks=${String(orphanLinks)}`);
      }
    } catch (error) {
      this.migration = {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error)
      };
      this.baseStatus = { ...this.baseStatus, migration: 'failed', migrationDetail: this.migration.detail };
    }
  }

  // ---- 设置与状态 ----

  private loadSettings(): MemorySettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) as Partial<MemorySettings>;
      const merged = { ...MEMORY_DEFAULTS };
      for (const key of Object.keys(MEMORY_DEFAULTS) as Array<keyof MemorySettings>) {
        const value = raw[key];
        if (typeof value === typeof MEMORY_DEFAULTS[key]) (merged as Record<string, unknown>)[key] = value;
      }
      if (merged.minScore === MEMORY_DEFAULTS.minScore) merged.minScore = RECALL_THRESHOLD;
      return merged;
    } catch {
      return { ...MEMORY_DEFAULTS };
    }
  }

  private writeSettings(): void {
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    const tmp = `${this.settingsFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.settingsFile);
  }

  private readStoreStatus(): MemoryStoreStatus {
    if (!this.store) return degradedStatus(this.file, this.baseStatus?.detail ?? 'unavailable');
    const counts = this.store.counts();
    return {
      state: 'ready',
      file: this.file,
      schemaVersion: this.store.schemaVersion(),
      records: counts.records,
      candidates: counts.candidates,
      migration: 'absent'
    };
  }

  status(): MemoryServiceStatus {
    return {
      ...this.baseStatus,
      migration: this.migration.status,
      ...(this.migration.detail ? { migrationDetail: this.migration.detail } : {}),
      settings: { ...this.settings },
      enabled: this.baseStatus.state === 'ready' && this.settings.enabled
    };
  }

  getSettings(): MemorySettings {
    return { ...this.settings };
  }

  updateSettings(patch: MemorySettingsPatch): MemorySettings {
    const next = { ...this.settings };
    for (const key of Object.keys(MEMORY_DEFAULTS) as Array<keyof MemorySettings>) {
      if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
    }
    this.settings = next;
    try {
      this.writeSettings();
    } catch (error) {
      this.store?.recordAudit('settings.write-failed', undefined, String(error));
    }
    return { ...next };
  }

  /** 只读查看底层 store（测试与迁移核对用）。 */
  rawStore(): MemoryStore | null {
    return this.store;
  }

  // ---- 注入与送达 ----

  attach(task: SubAgentTask, extra: AttachExtra): AttachResult {
    const deps: AttachDeps = {
      store: this.store ?? NULL_STORE,
      settings: { ...this.settings, enabled: this.status().enabled },
      sourceType: extra.sourceType,
      agentId: extra.agentId,
      ...(extra.providerId ? { providerId: extra.providerId } : {}),
      ...(extra.modelId ? { modelId: extra.modelId } : {}),
      now: this.now,
      seq: () => ++this.seq
    };
    return attachMemory(task, deps);
  }

  finalize(
    pending: PendingInjection,
    answer: Pick<SubAgentAnswer, 'systemHash' | 'supportsSystemHash'> | undefined,
    extra: { providerId?: string; modelId?: string; error?: string } = {}
  ): MemoryUsageEvent {
    return finalizeInjection(pending, answer, {
      store: this.store ?? NULL_STORE,
      ...(extra.providerId ? { providerId: extra.providerId } : {}),
      ...(extra.modelId ? { modelId: extra.modelId } : {}),
      ...(extra.error ? { error: extra.error } : {})
    });
  }

  /** 直接按问题召回（设置页/测试用，不注入）。 */
  recall(query: {
    question: string;
    conversationId: string;
    projectId?: string;
    workspaceId?: string;
    now?: number;
    /** 项目当前 HEAD，用于决策类记忆的 stale 判定（MEM-05）。 */
    headCommit?: string;
  }): RecallResult {
    if (!this.store) return { included: [], omitted: [], scores: [], threshold: this.settings.minScore };
    const scopes: Array<{ scope: MemoryScope; scopeId: string }> = [{ scope: 'GLOBAL', scopeId: '' }];
    if (query.projectId) scopes.push({ scope: 'PROJECT', scopeId: query.projectId });
    if (query.workspaceId) scopes.push({ scope: 'WORKSPACE', scopeId: query.workspaceId });
    return recallMemories(this.store.allForScopes(scopes, 2000), query, {
      threshold: this.settings.minScore,
      maxRecords: this.settings.maxRecords,
      now: query.now ?? this.now(),
      ...(query.headCommit ? { headCommit: query.headCommit } : {})
    });
  }

  // ---- 记录 ----

  remember(input: RememberInput): MemoryRecord | null {
    if (!this.canWrite()) return null;
    return this.store!.createRecord(input);
  }

  private canWrite(): boolean {
    return this.store !== null && this.settings.enabled;
  }

  getRecord(memoryId: string): MemoryRecord | null {
    return this.store?.getRecord(memoryId) ?? null;
  }

  listRecords(query: ListRecordsQuery = {}): MemoryRecord[] {
    return this.store?.listRecords(query) ?? [];
  }

  patchRecord(memoryId: string, patch: RecordPatch): MemoryRecord | null {
    if (!this.canWrite()) return null;
    return this.store!.patchRecord(memoryId, patch);
  }

  deleteRecord(memoryId: string): boolean {
    if (!this.canWrite()) return false;
    return this.store!.deleteRecord(memoryId);
  }

  // ---- 候选与抽取 ----

  addCandidate(input: CandidateInput): CandidateDecisionResult {
    if (!this.canWrite()) {
      return { candidate: null as unknown as MemoryCandidate, reason: 'memory-disabled' };
    }
    const { candidate, duplicate } = this.store!.addCandidate(input);
    if (duplicate) return { candidate, reason: 'duplicate' };

    const decision = decideCandidate({
      reason: (input.reason ?? 'stable-preference') as CandidateReason,
      kind: input.proposedKind,
      scope: input.proposedScope,
      confidence: input.confidence,
      sourceMessageIds: input.sourceMessageIds,
      text: input.proposedContent,
      settings: this.settings
    });
    if (decision.action === 'reject') {
      this.store!.setCandidateStatus(candidate.candidateId, 'rejected');
      this.store!.recordAudit('candidate.rejected', candidate.candidateId, decision.reason);
      return { candidate: { ...candidate, status: 'rejected' }, reason: decision.reason };
    }
    if (decision.action === 'auto-approve') return this.confirmCandidate(candidate.candidateId);
    return { candidate, reason: decision.reason };
  }

  listCandidates(status: CandidateStatusFilter = 'pending'): MemoryCandidate[] {
    return this.store?.listCandidates(status) ?? [];
  }

  confirmCandidate(candidateId: string): CandidateDecisionResult {
    if (!this.canWrite()) return { candidate: null as unknown as MemoryCandidate, reason: 'memory-disabled' };
    const candidate = this.store!.getCandidate(candidateId);
    if (!candidate) return { candidate: null as unknown as MemoryCandidate, reason: 'not-found' };
    if (candidate.status === 'approved') return { candidate };
    const fields = candidateToRecordInput(candidate);
    const record = this.store!.createRecord({
      ...fields,
      ...(candidate.projectRoot ? { projectRoot: candidate.projectRoot } : {}),
      sourceRefs: candidate.sourceRefs,
      tags: [],
      status: 'active',
      riskLevel: candidate.riskLevel,
      sensitivity: 'normal'
    });
    const approved = this.store!.setCandidateStatus(candidateId, 'approved') ?? candidate;
    this.store!.recordAudit('candidate.approved', record.memoryId, candidateId);
    return { candidate: approved, record };
  }

  rejectCandidate(candidateId: string): CandidateDecisionResult {
    if (!this.canWrite()) return { candidate: null as unknown as MemoryCandidate, reason: 'memory-disabled' };
    const candidate = this.store!.setCandidateStatus(candidateId, 'rejected');
    if (candidate) this.store!.recordAudit('candidate.rejected', candidate.candidateId, 'user');
    return { candidate: candidate ?? (null as unknown as MemoryCandidate), reason: candidate ? 'rejected' : 'not-found' };
  }

  /** 一条消息 → 候选（规则通道）。抽取失败不影响调用方，返回 dropped 供审计。 */
  extractMessage(input: ExtractMessageInput): ExtractResult & { stored: MemoryCandidate[]; failed?: string } {
    try {
      const result = extractFromMessage(input, this.settings);
      const stored: MemoryCandidate[] = [];
      for (const candidateInput of result.candidates) {
        const outcome = this.addCandidate(candidateInput);
        // duplicate 是「已存在（含曾被拒绝）」的回显，不是新提出的候选；
        // 把它算进 stored 会让「拒绝后不再提」看起来又被提了一次。
        if (outcome.candidate && outcome.reason !== 'duplicate' && outcome.reason !== 'memory-disabled') {
          stored.push(outcome.candidate);
        }
      }
      return { ...result, stored };
    } catch (error) {
      const failed = error instanceof Error ? error.message : String(error);
      this.store?.recordAudit('extraction.failed', undefined, failed);
      return { candidates: [], dropped: [{ reason: 'extraction.failed', quote: failed }], stored: [], failed };
    }
  }

  extractTaskReport(input: TaskReportInput): ExtractResult & { stored: MemoryCandidate[]; failed?: string } {
    try {
      const result = extractFromTaskReport(input);
      const stored: MemoryCandidate[] = [];
      for (const candidateInput of result.candidates) {
        const outcome = this.addCandidate(candidateInput);
        // duplicate 是「已存在（含曾被拒绝）」的回显，不是新提出的候选；
        // 把它算进 stored 会让「拒绝后不再提」看起来又被提了一次。
        if (outcome.candidate && outcome.reason !== 'duplicate' && outcome.reason !== 'memory-disabled') {
          stored.push(outcome.candidate);
        }
      }
      return { ...result, stored };
    } catch (error) {
      const failed = error instanceof Error ? error.message : String(error);
      this.store?.recordAudit('extraction.failed', undefined, failed);
      return { candidates: [], dropped: [{ reason: 'extraction.failed', quote: failed }], stored: [], failed };
    }
  }

  // ---- 治理 ----

  /** 新事实不静默覆盖旧事实：留 supersedes + 旧状态变更 + audit。 */
  supersede(oldMemoryId: string, input: RememberInput): { record: MemoryRecord; previous: MemoryRecord | null } | null {
    if (!this.canWrite()) return null;
    const previous = this.store!.getRecord(oldMemoryId);
    const record = this.store!.createRecord({
      ...input,
      status: 'active',
      supersedes: [...(input.supersedes ?? []), oldMemoryId]
    });
    if (previous) {
      this.store!.patchRecord(oldMemoryId, { status: 'superseded', supersededBy: record.memoryId });
      this.store!.recordAudit('governance.supersede', record.memoryId, oldMemoryId);
    }
    return { record, previous };
  }

  refute(memoryId: string): MemoryRecord | null {
    const record = this.patchRecord(memoryId, { status: 'refuted' });
    if (record) this.store!.recordAudit('governance.refute', memoryId);
    return record;
  }

  expire(memoryId: string): MemoryRecord | null {
    const record = this.patchRecord(memoryId, { status: 'expired' });
    if (record) this.store!.recordAudit('governance.expire', memoryId);
    return record;
  }

  archive(memoryId: string): MemoryRecord | null {
    const record = this.patchRecord(memoryId, { status: 'archived' });
    if (record) this.store!.recordAudit('governance.archive', memoryId);
    return record;
  }

  /** 同 scope 同 key 的多条 active：只报，不自动合并（由用户裁决）。 */
  detectConflicts(): ConflictingGroup[] {
    const groups = new Map<string, MemoryRecord[]>();
    for (const record of this.listRecords({ status: 'active', limit: 1000 })) {
      const key = `${record.scope}|${record.scopeId}|${record.normalizedKey}`;
      const list = groups.get(key);
      if (list) list.push(record);
      else groups.set(key, [record]);
    }
    return [...groups.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => {
        const [scope, scopeId, normalizedKey] = key.split('|');
        return { scope, scopeId, normalizedKey, memoryIds: list.map(r => r.memoryId).sort() };
      });
  }

  // ---- 使用记录 / 导出 / 链接 ----

  getUsage(requestId: string): MemoryUsageEvent | null {
    return this.store?.getUsage(requestId) ?? null;
  }

  listUsage(conversationId?: string): MemoryUsageEvent[] {
    return this.store?.listUsage(conversationId) ?? [];
  }

  listAudit(limit = 50): Array<{ at: number; action: string; memoryId?: string; detail?: string }> {
    return this.store?.listAudit(limit) ?? [];
  }

  exportAll(): MemoryExport {
    return this.store?.exportAll() ?? { version: 1, exportedAt: this.now(), records: [], candidates: [] };
  }

  importAll(data: MemoryExport): { imported: number; archivedForConflict: number } {
    if (!this.canWrite()) return { imported: 0, archivedForConflict: 0 };
    return this.store!.importAll(data);
  }

  linksForMemory(memoryId: string): Array<{ symbolKey: string; linkType: string; filePath?: string }> {
    return this.store?.linksForMemory(memoryId, this.legacyFile) ?? [];
  }

  orphanLinks(): number {
    if (!this.store || !this.legacyFile) return 0;
    return countOrphanLinks(this.legacyFile, this.store);
  }

  migrationResult(): MigrationResult {
    return { ...this.migration };
  }

  close(): void {
    this.store?.close();
    this.store = null;
  }
}

/** 供测试与 UI 展示用：把召回结果转成可解释的上下文摘要。 */
export function contextSummary(context: MemoryContext | undefined): string {
  if (!context) return '本轮没有构建记忆上下文';
  return `命中 ${String(context.includedMemoryIds.length)} 条，排除 ${String(context.omittedMemoryIds.length)} 条，预算 ${String(context.tokenOrCharBudget)} 字`;
}
