/**
 * 全局记忆的持久层：独立 `memory.sqlite`。
 *
 * 为什么不是 code-index.sqlite：`CodeIndexStore.deleteProject()` 会连
 * `code_memory_facts` 一起截断（store.ts 的删表列表）——删一次工程索引
 * 就把项目记忆一起删了。记忆的生命周期比代码索引长，必须解耦。
 *
 * 为什么不是 JSON：`KnowledgeStore` 那种 whole-file 重写，一损坏就整库丢，
 * 且并发写没有事务。
 *
 * 可靠性口径（`docs/spec/GLOBAL_MEMORY.md` §5）：
 * - WAL + busy_timeout=5000，写操作 `BEGIN IMMEDIATE`；
 * - `user_version` 管 schema，`migrations` 表管数据迁移（两者不是一回事）；
 * - 打不开/写失败 → `degraded`，由 service 对外报告，回答链路照常。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  MemoryCandidate,
  MemoryCodeRef,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemoryUsageEvent
} from '../../shared/memory';
import type {
  CandidateInput,
  ListRecordsQuery,
  MemoryExport,
  MemoryStoreStatus,
  RecordPatch,
  RememberInput
} from './types';

export const MEMORY_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_records (
  memory_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  project_root TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  code_refs TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'candidate',
  risk_level TEXT NOT NULL DEFAULT 'low',
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  valid_from INTEGER,
  expires_at INTEGER,
  last_confirmed_at INTEGER,
  supersedes TEXT NOT NULL DEFAULT '[]',
  superseded_by TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
-- 不能给 (scope, scope_id, normalized_key) 加 UNIQUE：迁移残留 / 并发写入
-- 会产生两条同 key 的 active，那是需要 detectConflicts 报出来由人裁决的
-- 冲突，不是数据库该悄悄拒绝的事（§2.3 / §5）。旧版建过唯一索引，升级时拆掉。
DROP INDEX IF EXISTS memory_active_key;
CREATE INDEX IF NOT EXISTS memory_scope_key
  ON memory_records(scope, scope_id, normalized_key, status);
CREATE INDEX IF NOT EXISTS memory_scope_status
  ON memory_records(scope, scope_id, status);
CREATE INDEX IF NOT EXISTS memory_key
  ON memory_records(normalized_key);

CREATE TABLE IF NOT EXISTS memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  source_conversation_id TEXT NOT NULL,
  source_message_ids TEXT NOT NULL,
  source_task_id TEXT,
  project_root TEXT,
  proposed_kind TEXT NOT NULL,
  proposed_scope TEXT NOT NULL,
  proposed_scope_id TEXT NOT NULL DEFAULT '',
  proposed_title TEXT NOT NULL,
  proposed_content TEXT NOT NULL,
  quote TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL,
  risk_level TEXT NOT NULL,
  reason TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_candidate_dedupe
  ON memory_candidates(dedupe_key);
CREATE INDEX IF NOT EXISTS memory_candidate_status
  ON memory_candidates(status, created_at);

CREATE TABLE IF NOT EXISTS memory_usage (
  request_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  task_id TEXT,
  participant_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  memory_ids TEXT NOT NULL DEFAULT '[]',
  context_hash TEXT,
  submitted_system_hash TEXT,
  provider_system_hash TEXT,
  context_id TEXT,
  injection_point TEXT,
  status TEXT NOT NULL,
  provider_confirmed INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  char_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_usage_conversation
  ON memory_usage(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  memory_id TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  detail TEXT
);
`;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

interface RecordRow {
  memory_id: string;
  kind: string;
  scope: string;
  scope_id: string;
  project_root: string | null;
  title: string;
  content: string;
  normalized_key: string;
  source_refs: string;
  evidence_refs: string;
  code_refs: string;
  tags: string;
  confidence: number;
  status: string;
  risk_level: string;
  sensitivity: string;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  expires_at: number | null;
  last_confirmed_at: number | null;
  supersedes: string;
  superseded_by: string | null;
  schema_version: number;
}

interface CandidateRow {
  candidate_id: string;
  source_conversation_id: string;
  source_message_ids: string;
  source_task_id: string | null;
  project_root: string | null;
  proposed_kind: string;
  proposed_scope: string;
  proposed_scope_id: string;
  proposed_title: string;
  proposed_content: string;
  quote: string;
  source_refs: string;
  confidence: number;
  risk_level: string;
  reason: string;
  requires_confirmation: number;
  dedupe_key: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function toRecord(row: RecordRow): MemoryRecord {
  return {
    memoryId: row.memory_id,
    kind: row.kind as MemoryKind,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id,
    ...(row.project_root ? { projectRoot: row.project_root } : {}),
    title: row.title,
    content: row.content,
    normalizedKey: row.normalized_key,
    sourceRefs: parseJson<string[]>(row.source_refs, []),
    evidenceRefs: parseJson<string[]>(row.evidence_refs, []),
    codeRefs: parseJson<MemoryCodeRef[]>(row.code_refs, []),
    tags: parseJson<string[]>(row.tags, []),
    confidence: row.confidence,
    status: row.status as MemoryStatus,
    riskLevel: (row.risk_level as MemoryRecord['riskLevel']) ?? 'low',
    sensitivity: (row.sensitivity as MemoryRecord['sensitivity']) ?? 'normal',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.valid_from === null ? {} : { validFrom: row.valid_from }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.last_confirmed_at === null ? {} : { lastConfirmedAt: row.last_confirmed_at }),
    supersedes: parseJson<string[]>(row.supersedes, []),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    schemaVersion: row.schema_version
  };
}

function toCandidate(row: CandidateRow): MemoryCandidate {
  return {
    candidateId: row.candidate_id,
    sourceConversationId: row.source_conversation_id,
    sourceMessageIds: parseJson<string[]>(row.source_message_ids, []),
    ...(row.source_task_id ? { sourceTaskId: row.source_task_id } : {}),
    ...(row.project_root ? { projectRoot: row.project_root } : {}),
    proposedKind: row.proposed_kind as MemoryKind,
    proposedScope: row.proposed_scope as MemoryScope,
    proposedScopeId: row.proposed_scope_id,
    proposedTitle: row.proposed_title,
    proposedContent: row.proposed_content,
    quote: row.quote,
    sourceRefs: parseJson<string[]>(row.source_refs, []),
    confidence: row.confidence,
    riskLevel: row.risk_level as MemoryCandidate['riskLevel'],
    reason: row.reason,
    requiresConfirmation: row.requires_confirmation === 1,
    dedupeKey: row.dedupe_key,
    status: row.status as MemoryCandidate['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(
    readonly file: string,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0
    );
    if (version < MEMORY_SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${String(MEMORY_SCHEMA_VERSION)}`);
      this.recordAudit('schema.upgraded', undefined, `${String(version)} → ${String(MEMORY_SCHEMA_VERSION)}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** 写操作一律 IMMEDIATE：先拿写锁，避免读事务升级时死等。 */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败说明事务已不在；保留原始错误更有用。
      }
      throw error;
    }
  }

  private nowMs(): number {
    return this.now();
  }

  schemaVersion(): number {
    return Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0
    );
  }

  counts(): { records: number; candidates: number } {
    const records = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM memory_records').get() as { n?: number }).n ?? 0
    );
    // 只算**待审**。全部候选会把已确认/已拒绝的也算进去，界面「待审候选 2」
    // 而实际 0 条——真机验收踩到的语义错误。
    const candidates = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE status = 'pending'").get() as { n?: number }).n ?? 0
    );
    return { records, candidates };
  }

  hasMigration(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM migrations WHERE id = ?').get(id));
  }

  migrationDetail(id: string): string | undefined {
    const row = this.db.prepare('SELECT detail FROM migrations WHERE id = ?').get(id) as
      | { detail?: string | null }
      | undefined;
    return row?.detail ?? undefined;
  }

  markMigration(id: string, detail: string): void {
    this.db
      .prepare(
        'INSERT INTO migrations(id, applied_at, detail) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET applied_at = excluded.applied_at, detail = excluded.detail'
      )
      .run(id, this.nowMs(), detail);
  }

  recordAudit(action: string, memoryId?: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO memory_audit(at, action, memory_id, detail) VALUES(?, ?, ?, ?)')
      .run(this.nowMs(), action, memoryId ?? null, detail ?? null);
  }

  listAudit(limit = 50): Array<{ at: number; action: string; memoryId?: string; detail?: string }> {
    const rows = this.db
      .prepare('SELECT at, action, memory_id, detail FROM memory_audit ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as Array<{
      at: number;
      action: string;
      memory_id: string | null;
      detail: string | null;
    }>;
    return rows.map(row => ({
      at: row.at,
      action: row.action,
      ...(row.memory_id ? { memoryId: row.memory_id } : {}),
      ...(row.detail ? { detail: row.detail } : {})
    }));
  }

  countAudit(action: string, memoryId?: string): number {
    const row = memoryId
      ? (this.db
          .prepare('SELECT COUNT(*) AS n FROM memory_audit WHERE action = ? AND memory_id = ?')
          .get(action, memoryId) as { n?: number })
      : (this.db.prepare('SELECT COUNT(*) AS n FROM memory_audit WHERE action = ?').get(action) as { n?: number });
    return Number(row.n ?? 0);
  }

  /** 插入或按 memoryId 覆盖。唯一 active 冲突会抛——调用方须先 supersede。 */
  createRecord(input: RememberInput): MemoryRecord {
    const at = this.nowMs();
    const existing = input.memoryId ? this.getRecord(input.memoryId) : null;
    const status = input.status ?? 'candidate';
    const record: MemoryRecord = {
      memoryId: input.memoryId ?? makeMemoryId(input, at),
      kind: input.kind,
      scope: input.scope,
      scopeId: input.scopeId ?? '',
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      title: input.title.trim(),
      content: input.content.trim(),
      normalizedKey: input.normalizedKey ?? normalizeKey(input.title),
      sourceRefs: input.sourceRefs ?? [],
      evidenceRefs: input.evidenceRefs ?? [],
      codeRefs: input.codeRefs ?? [],
      tags: input.tags ?? [],
      confidence: clamp01(input.confidence ?? 0.5),
      status,
      riskLevel: input.riskLevel ?? 'low',
      sensitivity: input.sensitivity ?? 'normal',
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(status === 'active' ? { lastConfirmedAt: at } : existing?.lastConfirmedAt ? { lastConfirmedAt: existing.lastConfirmedAt } : {}),
      supersedes: input.supersedes ?? [],
      schemaVersion: MEMORY_SCHEMA_VERSION
    };
    this.tx(() => this.insertRecord(record));
    this.recordAudit(existing ? 'record.updated' : 'record.created', record.memoryId, record.title);
    return record;
  }

  private insertRecord(record: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO memory_records (
           memory_id, kind, scope, scope_id, project_root, title, content, normalized_key,
           source_refs, evidence_refs, code_refs, tags, confidence, status, risk_level,
           sensitivity, created_at, updated_at, valid_from, expires_at, last_confirmed_at,
           supersedes, superseded_by, schema_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           kind = excluded.kind, scope = excluded.scope, scope_id = excluded.scope_id,
           project_root = excluded.project_root, title = excluded.title, content = excluded.content,
           normalized_key = excluded.normalized_key, source_refs = excluded.source_refs,
           evidence_refs = excluded.evidence_refs, code_refs = excluded.code_refs, tags = excluded.tags,
           confidence = excluded.confidence, status = excluded.status, risk_level = excluded.risk_level,
           sensitivity = excluded.sensitivity, updated_at = excluded.updated_at,
           valid_from = excluded.valid_from, expires_at = excluded.expires_at,
           last_confirmed_at = excluded.last_confirmed_at, supersedes = excluded.supersedes,
           superseded_by = excluded.superseded_by, schema_version = excluded.schema_version`
      )
      .run(
        record.memoryId,
        record.kind,
        record.scope,
        record.scopeId,
        record.projectRoot ?? null,
        record.title,
        record.content,
        record.normalizedKey,
        JSON.stringify(record.sourceRefs),
        JSON.stringify(record.evidenceRefs),
        JSON.stringify(record.codeRefs),
        JSON.stringify(record.tags),
        record.confidence,
        record.status,
        record.riskLevel,
        record.sensitivity,
        record.createdAt,
        record.updatedAt,
        record.validFrom ?? null,
        record.expiresAt ?? null,
        record.lastConfirmedAt ?? null,
        JSON.stringify(record.supersedes),
        record.supersededBy ?? null,
        record.schemaVersion
      );
  }

  getRecord(memoryId: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memory_records WHERE memory_id = ?').get(memoryId) as
      | RecordRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  findByKey(scope: MemoryScope, scopeId: string, normalizedKey: string): MemoryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_records WHERE scope = ? AND scope_id = ? AND normalized_key = ? ORDER BY updated_at DESC')
      .all(scope, scopeId, normalizedKey) as unknown as RecordRow[];
    return rows.map(toRecord);
  }

  patchRecord(memoryId: string, patch: RecordPatch): MemoryRecord | null {
    const existing = this.getRecord(memoryId);
    if (!existing) return null;
    const next: MemoryRecord = {
      ...existing,
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.content === undefined ? {} : { content: patch.content.trim() }),
      ...(patch.normalizedKey === undefined ? {} : { normalizedKey: patch.normalizedKey }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
      ...(patch.confidence === undefined ? {} : { confidence: clamp01(patch.confidence) }),
      ...(patch.riskLevel === undefined ? {} : { riskLevel: patch.riskLevel }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.expiresAt === undefined
        ? {}
        : patch.expiresAt === null
          ? { expiresAt: undefined }
          : { expiresAt: patch.expiresAt }),
      ...(patch.lastConfirmedAt === undefined
        ? {}
        : patch.lastConfirmedAt === null
          ? { lastConfirmedAt: undefined }
          : { lastConfirmedAt: patch.lastConfirmedAt }),
      ...(patch.supersededBy === undefined
        ? {}
        : patch.supersededBy === null
          ? { supersededBy: undefined }
          : { supersededBy: patch.supersededBy }),
      ...(patch.supersedes === undefined ? {} : { supersedes: patch.supersedes }),
      updatedAt: this.nowMs()
    };
    // 去掉被显式置空的字段，避免把 undefined 写成 "undefined"。
    if (patch.expiresAt === null) delete next.expiresAt;
    if (patch.lastConfirmedAt === null) delete next.lastConfirmedAt;
    if (patch.supersededBy === null) delete next.supersededBy;
    this.tx(() => this.insertRecord(next));
    this.recordAudit('record.patched', memoryId, patch.status ?? '');
    return next;
  }

  listRecords(query: ListRecordsQuery = {}): MemoryRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.scope) {
      where.push('scope = ?');
      params.push(query.scope);
    }
    if (query.scopeId !== undefined) {
      where.push('scope_id = ?');
      params.push(query.scopeId);
    }
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (query.contains) {
      where.push('(title LIKE ? OR content LIKE ?)');
      params.push(`%${query.contains}%`, `%${query.contains}%`);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const sql = `SELECT * FROM memory_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, memory_id ASC LIMIT ?`;
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as unknown as RecordRow[]).map(toRecord);
  }

  /** 召回候选池：只取这批 scope 下的 active，状态过滤在 SQL 里做掉。 */
  activeForScopes(scopes: Array<{ scope: MemoryScope; scopeId: string }>, limit = 2000): MemoryRecord[] {
    if (scopes.length === 0) return [];
    const clause = scopes.map(() => '(scope = ? AND scope_id = ?)').join(' OR ');
    const params: Array<string | number> = [];
    for (const item of scopes) params.push(item.scope, item.scopeId);
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM memory_records WHERE status = 'active' AND (${clause}) LIMIT ?`)
      .all(...params) as unknown as RecordRow[];
    return rows.map(toRecord);
  }

  /**
   * 召回候选池：取这批 scope 下的**全部状态**，状态过滤交给 `recallMemories`。
   *
   * 只取 active 会让「被替代 / 被否定 / 已过期」的记录根本进不了候选池，
   * 界面就解释不了「这条为什么没注入」（§5 可观测性要求排除项带 reason）。
   */
  allForScopes(scopes: Array<{ scope: MemoryScope; scopeId: string }>, limit = 2000): MemoryRecord[] {
    if (scopes.length === 0) return [];
    const clause = scopes.map(() => '(scope = ? AND scope_id = ?)').join(' OR ');
    const params: Array<string | number> = [];
    for (const item of scopes) params.push(item.scope, item.scopeId);
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM memory_records WHERE (${clause}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as unknown as RecordRow[];
    return rows.map(toRecord);
  }

  deleteRecord(memoryId: string): boolean {
    const exists = this.getRecord(memoryId);
    if (!exists) return false;
    this.tx(() => {
      this.db.prepare('DELETE FROM memory_records WHERE memory_id = ?').run(memoryId);
      this.db
        .prepare('INSERT INTO memory_audit(at, action, memory_id, detail) VALUES(?, ?, ?, ?)')
        .run(this.nowMs(), 'record.deleted', memoryId, exists.title);
    });
    return true;
  }

  // ---- candidates ----

  addCandidate(input: CandidateInput): { candidate: MemoryCandidate; duplicate: boolean } {
    const at = input.createdAt ?? this.nowMs();
    const candidate: MemoryCandidate = {
      candidateId: input.candidateId ?? `c_${String(at)}_${Math.random().toString(16).slice(2, 10)}`,
      sourceConversationId: input.sourceConversationId,
      sourceMessageIds: input.sourceMessageIds,
      ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      proposedKind: input.proposedKind,
      proposedScope: input.proposedScope,
      proposedScopeId: input.proposedScopeId ?? '',
      proposedTitle: input.proposedTitle.trim(),
      proposedContent: input.proposedContent.trim(),
      quote: input.quote,
      sourceRefs: input.sourceRefs ?? [],
      confidence: clamp01(input.confidence),
      riskLevel: input.riskLevel,
      reason: input.reason,
      requiresConfirmation: input.requiresConfirmation,
      dedupeKey: input.dedupeKey,
      status: 'pending',
      createdAt: at,
      updatedAt: at
    };
    const result = this.tx(() =>
      this.db
        .prepare(
          `INSERT INTO memory_candidates (
             candidate_id, source_conversation_id, source_message_ids, source_task_id, project_root,
             proposed_kind, proposed_scope, proposed_scope_id, proposed_title, proposed_content,
             quote, source_refs, confidence, risk_level, reason, requires_confirmation,
             dedupe_key, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(dedupe_key) DO NOTHING`
        )
        .run(
          candidate.candidateId,
          candidate.sourceConversationId,
          JSON.stringify(candidate.sourceMessageIds),
          candidate.sourceTaskId ?? null,
          candidate.projectRoot ?? null,
          candidate.proposedKind,
          candidate.proposedScope,
          candidate.proposedScopeId,
          candidate.proposedTitle,
          candidate.proposedContent,
          candidate.quote,
          JSON.stringify(candidate.sourceRefs),
          candidate.confidence,
          candidate.riskLevel,
          candidate.reason,
          candidate.requiresConfirmation ? 1 : 0,
          candidate.dedupeKey,
          candidate.createdAt,
          candidate.updatedAt
        )
    );
    if (result.changes === 0) {
      const existing = this.db
        .prepare('SELECT * FROM memory_candidates WHERE dedupe_key = ?')
        .get(candidate.dedupeKey) as CandidateRow | undefined;
      return { candidate: existing ? toCandidate(existing) : candidate, duplicate: true };
    }
    this.recordAudit('candidate.created', undefined, candidate.reason);
    return { candidate, duplicate: false };
  }

  getCandidate(candidateId: string): MemoryCandidate | null {
    const row = this.db.prepare('SELECT * FROM memory_candidates WHERE candidate_id = ?').get(candidateId) as
      | CandidateRow
      | undefined;
    return row ? toCandidate(row) : null;
  }

  listCandidates(status: MemoryCandidate['status'] | 'all' = 'pending', limit = 100): MemoryCandidate[] {
    const rows =
      status === 'all'
        ? (this.db
            .prepare('SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT ?')
            .all(Math.min(limit, 500)) as unknown as CandidateRow[])
        : (this.db
            .prepare('SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?')
            .all(status, Math.min(limit, 500)) as unknown as CandidateRow[]);
    return rows.map(toCandidate);
  }

  setCandidateStatus(candidateId: string, status: MemoryCandidate['status']): MemoryCandidate | null {
    this.db
      .prepare('UPDATE memory_candidates SET status = ?, updated_at = ? WHERE candidate_id = ?')
      .run(status, this.nowMs(), candidateId);
    this.recordAudit(`candidate.${status}`, undefined, candidateId);
    return this.getCandidate(candidateId);
  }

  // ---- usage ----

  upsertUsage(event: MemoryUsageEvent, contextId?: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_usage (
           request_id, conversation_id, task_id, participant_id, provider_id, model_id, memory_ids,
           context_hash, submitted_system_hash, provider_system_hash, context_id, injection_point,
           status, provider_confirmed, skip_reason, char_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           conversation_id = excluded.conversation_id, task_id = excluded.task_id,
           participant_id = excluded.participant_id, provider_id = excluded.provider_id,
           model_id = excluded.model_id, memory_ids = excluded.memory_ids,
           context_hash = excluded.context_hash, submitted_system_hash = excluded.submitted_system_hash,
           provider_system_hash = excluded.provider_system_hash, context_id = excluded.context_id,
           injection_point = excluded.injection_point, status = excluded.status,
           provider_confirmed = excluded.provider_confirmed, skip_reason = excluded.skip_reason,
           char_count = excluded.char_count, created_at = excluded.created_at`
      )
      .run(
        event.requestId,
        event.conversationId,
        event.taskId ?? null,
        event.participantId ?? null,
        event.providerId ?? null,
        event.modelId ?? null,
        JSON.stringify(event.memoryIds),
        event.contextHash,
        event.submittedSystemHash ?? null,
        event.providerSystemHash ?? null,
        contextId ?? null,
        event.injectionPoint,
        event.status,
        event.providerConfirmed ? 1 : 0,
        event.skipReason ?? null,
        event.charCount,
        event.timestamp
      );
  }

  getUsage(requestId: string): MemoryUsageEvent | null {
    const row = this.db.prepare('SELECT * FROM memory_usage WHERE request_id = ?').get(requestId) as
      | UsageRow
      | undefined;
    return row ? toUsage(row) : null;
  }

  listUsage(conversationId?: string, limit = 100): MemoryUsageEvent[] {
    const rows = conversationId
      ? (this.db
          .prepare('SELECT * FROM memory_usage WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(conversationId, Math.min(limit, 500)) as unknown as UsageRow[])
      : (this.db
          .prepare('SELECT * FROM memory_usage ORDER BY created_at DESC LIMIT ?')
          .all(Math.min(limit, 500)) as unknown as UsageRow[]);
    return rows.map(toUsage);
  }

  // ---- export / import ----

  exportAll(): MemoryExport {
    return {
      version: MEMORY_SCHEMA_VERSION,
      exportedAt: this.nowMs(),
      records: this.listRecords({ limit: 1000 }),
      candidates: this.listCandidates('all', 500)
    };
  }

  /**
   * 导入：按 memoryId 幂等，但**绝不静默覆盖已有 active 事实**（§5 冲突约束）。
   *
   * 之前用 `INSERT OR REPLACE` 直接把同名记录改掉，等于「导入一份备份就把当前
   * 决策抹了」。现在遇到「已有 active 且内容不同」一律保留旧的、记冲突审计，
   * 由用户在治理界面裁决；导入方不会以为自己写进去了。
   */
  importAll(data: MemoryExport): { imported: number; archivedForConflict: number } {
    let imported = 0;
    const conflicts: string[] = [];
    this.tx(() => {
      for (const record of data.records) {
        const existing = this.getRecord(record.memoryId);
        if (existing && existing.status === 'active' && existing.content !== record.content) {
          conflicts.push(record.memoryId);
          continue;
        }
        try {
          this.insertRecord({
            ...record,
            createdAt: record.createdAt ?? this.nowMs(),
            updatedAt: record.updatedAt ?? this.nowMs(),
            schemaVersion: MEMORY_SCHEMA_VERSION
          });
          imported += 1;
        } catch {
          // 唯一索引等其它冲突同样不覆盖，统一按冲突记录。
          conflicts.push(record.memoryId);
        }
      }
    });
    for (const id of conflicts) this.recordAudit('export.conflict', id, 'kept-existing');
    this.recordAudit('export.imported', undefined, `${String(imported)}/${String(data.records.length)}`);
    return { imported, archivedForConflict: conflicts.length };
  }

  /** 迁移核对用：精确统计这批 id 里有多少条真的落库（分块，避免 SQL 变量上限）。 */
  countRecordsByIds(ids: readonly string[]): number {
    let found = 0;
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM memory_records WHERE memory_id IN (${chunk.map(() => '?').join(', ')})`)
        .get(...chunk) as { n?: number };
      found += Number(row.n ?? 0);
    }
    return found;
  }

  allRecordIds(): Set<string> {
    const rows = this.db.prepare('SELECT memory_id FROM memory_records').all() as Array<{ memory_id: string }>;
    return new Set(rows.map(row => row.memory_id));
  }

  /**
   * 迁移专用：一个事务里插完全部记录，并在**同一事务内**跑核对；
   * `verify` 抛错则整体 ROLLBACK，两侧都不留半成品（`GLOBAL_MEMORY.md` §3.2）。
   */
  importRecordsInTx(records: readonly MemoryRecord[], verify?: () => void): number {
    return this.tx(() => {
      for (const record of records) this.insertRecord(record);
      verify?.();
      return records.length;
    });
  }

  // ---- 旧链接（不搬表） ----

  /**
   * `code_memory_link` 留在 code-index.sqlite。这里只读打开，按
   * `memory_entity_id` 反查；旧库不在就直接返回空，不影响记忆本身可用。
   */
  linksForMemory(memoryId: string, legacyFile?: string): Array<{ symbolKey: string; linkType: string; filePath?: string }> {
    if (!legacyFile || !fs.existsSync(legacyFile)) return [];
    let source: DatabaseSync | null = null;
    try {
      source = new DatabaseSync(legacyFile, { readOnly: true });
      const rows = source
        .prepare('SELECT symbol_key, link_type, symbol_locator FROM code_memory_link WHERE memory_entity_id = ?')
        .all(memoryId) as Array<{ symbol_key: string; link_type: string; symbol_locator: string | null }>;
      return rows.map(row => {
        const locator = parseJson<{ filePath?: string }>(row.symbol_locator ?? '', {});
        return {
          symbolKey: row.symbol_key,
          linkType: row.link_type,
          ...(locator.filePath ? { filePath: locator.filePath } : {})
        };
      });
    } catch {
      return [];
    } finally {
      try {
        source?.close();
      } catch {
        // 只读连接关闭失败没有后果。
      }
    }
  }
}

interface UsageRow {
  request_id: string;
  conversation_id: string | null;
  task_id: string | null;
  participant_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  memory_ids: string;
  context_hash: string | null;
  submitted_system_hash: string | null;
  provider_system_hash: string | null;
  injection_point: string | null;
  status: string;
  provider_confirmed: number;
  skip_reason: string | null;
  char_count: number;
  created_at: number;
}

function toUsage(row: UsageRow): MemoryUsageEvent {
  return {
    requestId: row.request_id,
    conversationId: row.conversation_id ?? '',
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.participant_id ? { participantId: row.participant_id } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    memoryIds: parseJson<string[]>(row.memory_ids, []),
    contextHash: row.context_hash ?? '',
    ...(row.submitted_system_hash ? { submittedSystemHash: row.submitted_system_hash } : {}),
    ...(row.provider_system_hash ? { providerSystemHash: row.provider_system_hash } : {}),
    injectionPoint: row.injection_point ?? 'unknown',
    status: row.status as MemoryUsageEvent['status'],
    providerConfirmed: row.provider_confirmed === 1,
    ...(row.skip_reason ? { skipReason: row.skip_reason } : {}),
    charCount: row.char_count,
    timestamp: row.created_at
  };
}

function makeMemoryId(input: RememberInput, at: number): string {
  const base = [input.scope, input.scopeId ?? '', input.kind, input.title, input.content.slice(0, 40)].join('|');
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) {
    hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  }
  return `mem_${String(at)}_${hash.toString(16)}`;
}

/** 归一化 key：去空白、标点、大小写，用来判"同一条记忆"。 */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）()\[\]【】<>《》,.!?;:'"]/g, '')
    .slice(0, 120);
}

/** 打开失败不抛给调用方：返回 null，由 service 转成 degraded。 */
export function openMemoryStore(
  file: string,
  options: { now?: () => number } = {}
): { store: MemoryStore | null; error?: string } {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { store: new MemoryStore(file, options) };
  } catch (error) {
    return { store: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function degradedStatus(file: string, detail: string): MemoryStoreStatus {
  return {
    state: 'degraded',
    detail,
    file,
    schemaVersion: 0,
    records: 0,
    candidates: 0,
    migration: 'absent'
  };
}
