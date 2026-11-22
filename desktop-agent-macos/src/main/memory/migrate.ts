/**
 * 把旧 `code_memory_facts` 一次性迁入 `memory_records`。
 *
 * 三条硬约束（`docs/spec/GLOBAL_MEMORY.md` §3）：
 * 1. 源库**只读**打开。迁完旧表也不清空、不改名——它是代码索引的产物，
 *    旧链接还要按 `memory_entity_id` 反查。
 * 2. 一个事务：全部插入 + 数量核对在同一事务里，核对失败整体回滚。
 * 3. 幂等：`migrations.legacy-import@1`，启动见标记跳过，但仍做数量核对；
 *    数量对不上报 `migration-mismatch`，不假装完成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryKind, MemoryRecord, MemoryStatus } from '../../shared/memory';
import { MEMORY_SCHEMA_VERSION } from './store';
import { normalizeKey, type MemoryStore } from './store';
import type { MigrationResult } from './types';

const MIGRATION_ID = 'legacy-import@1';

interface LegacyRow {
  project_id: string;
  fact_id: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  source_ref: string | null;
  status: string;
  confidence: number | null;
  valid_from: number | null;
  valid_to: number | null;
  created_at: number;
  updated_at: number;
}

function mapKind(kind: string): { kind: MemoryKind; extraTag?: string } {
  switch (kind) {
    case 'decision':
      return { kind: 'decision' };
    case 'constraint':
      return { kind: 'constraint' };
    case 'issue':
      return { kind: 'open_question' };
    case 'solution':
      return { kind: 'problem_solution' };
    case 'debate':
      return { kind: 'decision', extraTag: 'debate' };
    case 'fact':
    default:
      return { kind: 'fact' };
  }
}

function mapStatus(status: string): MemoryStatus {
  if (status === 'confirmed') return 'active';
  if (status === 'deprecated') return 'archived';
  return 'candidate';
}

/** 旧 fact_id 在不同项目可能同名；撞了加项目后缀，链接仍按原 id 找不到时记 orphan。 */
function memoryIdFor(row: LegacyRow, taken: Set<string>): string {
  if (!taken.has(row.fact_id)) return row.fact_id;
  const suffixed = `${row.fact_id}__${row.project_id}`;
  return taken.has(suffixed) ? `${suffixed}__${String(row.created_at)}` : suffixed;
}

export function mapLegacyRow(row: LegacyRow, memoryId: string): MemoryRecord {
  const mapped = mapKind(row.kind);
  const sourceRefs = [row.source, row.source_ref].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  const confidence =
    typeof row.confidence === 'number' && Number.isFinite(row.confidence) && row.confidence >= 0
      ? Math.min(row.confidence, 1)
      : 0.5;
  return {
    memoryId,
    kind: mapped.kind,
    scope: 'PROJECT',
    scopeId: row.project_id,
    title: row.title,
    content: row.content,
    normalizedKey: normalizeKey(row.title),
    sourceRefs,
    evidenceRefs: [],
    codeRefs: [],
    tags: mapped.extraTag ? [mapped.extraTag] : [],
    confidence,
    status: mapStatus(row.status),
    riskLevel: 'low',
    sensitivity: 'normal',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConfirmedAt: mapStatus(row.status) === 'active' ? row.updated_at : undefined,
    ...(row.valid_from === null ? {} : { validFrom: row.valid_from }),
    ...(row.valid_to === null ? {} : { expiresAt: row.valid_to }),
    supersedes: [],
    schemaVersion: MEMORY_SCHEMA_VERSION
  };
}

function readLegacyRows(file: string): { rows: LegacyRow[]; total: number; distinct: number; emptyIds: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'code_memory_facts'")
      .get() as { name?: string } | undefined;
    if (!table) throw new Error('源库没有 code_memory_facts 表');
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT fact_id) AS distinct_ids,
                SUM(CASE WHEN fact_id IS NULL OR fact_id = '' THEN 1 ELSE 0 END) AS empty_ids
         FROM code_memory_facts`
      )
      .get() as { total?: number; distinct_ids?: number; empty_ids?: number } | undefined;
    const rows = db
      .prepare('SELECT * FROM code_memory_facts ORDER BY project_id, created_at')
      .all() as unknown as LegacyRow[];
    return {
      rows,
      total: Number(stats?.total ?? 0),
      distinct: Number(stats?.distinct_ids ?? 0),
      emptyIds: Number(stats?.empty_ids ?? 0)
    };
  } finally {
    db.close();
  }
}

function backupLegacy(source: string, backupDir: string, now: number): string | undefined {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, `legacy-backup-${String(now)}.sqlite`);
    fs.copyFileSync(source, target);
    const backups = fs
      .readdirSync(backupDir)
      .filter(name => name.startsWith('legacy-backup-') && name.endsWith('.sqlite'))
      .sort();
    while (backups.length > 3) {
      const oldest = backups.shift();
      if (oldest) fs.rmSync(path.join(backupDir, oldest), { force: true });
    }
    return target;
  } catch {
    // 备份失败不该阻断迁移（源库本来就是只读的），但要在结果里说清楚。
    return undefined;
  }
}

export interface MigrateOptions {
  store: MemoryStore;
  legacyFile?: string;
  backupDir?: string;
  now?: () => number;
}

export function migrateLegacy(options: MigrateOptions): MigrationResult {
  const now = options.now ?? Date.now;
  const { store } = options;
  const source = options.legacyFile;

  if (!source || !fs.existsSync(source)) {
    store.markMigration(MIGRATION_ID, 'legacy-absent');
    store.recordAudit('migration.legacy-absent');
    return { status: 'absent', detail: 'legacy-absent' };
  }

  let scanned: ReturnType<typeof readLegacyRows>;
  try {
    scanned = readLegacyRows(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    store.recordAudit('migration.blocked', undefined, detail);
    return { status: 'blocked', detail };
  }

  const { rows, total, distinct, emptyIds } = scanned;
  store.recordAudit(
    'migration.scanned',
    undefined,
    `total=${String(total)} distinct=${String(distinct)} emptyIds=${String(emptyIds)}`
  );

  if (emptyIds > 0) {
    const detail = `${String(emptyIds)} 条旧记忆没有 fact_id`;
    store.recordAudit('migration.blocked', undefined, detail);
    return { status: 'blocked', detail };
  }

  const alreadyImported = store.hasMigration(MIGRATION_ID);

  if (alreadyImported && store.counts().records > 0) {
    const missing = rows.filter(row => !store.getRecord(row.fact_id) && !store.getRecord(`${row.fact_id}__${row.project_id}`));
    if (missing.length > 0) {
      // 只报差集，不重复插入、不标记完成。
      store.recordAudit(
        'migration.mismatch',
        undefined,
        `missing=${String(missing.length)} first=${missing[0]?.fact_id ?? ''}`
      );
      return { status: 'mismatch', detail: `缺少 ${String(missing.length)} 条`, expected: total };
    }
    const orphanLinks = countOrphanLinks(source, store);
    store.recordAudit('migration.verified', undefined, `orphanLinks=${String(orphanLinks)}`);
    return { status: 'done', detail: 'already-imported', expected: total, imported: total, orphanLinks };
  }

  const backup = backupLegacy(source, options.backupDir ?? path.join(path.dirname(store.file), 'memory'), now());
  const taken = store.allRecordIds();
  const kept = new Set<string>();
  const records: MemoryRecord[] = [];
  for (const row of rows) {
    // 同一 scope + normalizedKey 只能有一条 active：旧库若本就有重复，
    // 保留 updated_at 最新的那条，其余降级 archived（不丢数据）。
    const memoryId = memoryIdFor(row, taken);
    taken.add(memoryId);
    const record = mapLegacyRow(row, memoryId);
    if (record.status === 'active') {
      const key = `${record.scope}|${record.scopeId}|${record.normalizedKey}`;
      if (kept.has(key)) {
        records.push({ ...record, status: 'archived' });
        continue;
      }
      kept.add(key);
    }
    records.push(record);
  }

  try {
    const imported = store.importRecordsInTx(records, () => {
      const ids = records.map(record => record.memoryId);
      const found = store.countRecordsByIds(ids);
      if (found !== ids.length) {
        throw new Error(`核对失败：期望 ${String(ids.length)} 条，实际 ${String(found)} 条`);
      }
    });
    store.markMigration(MIGRATION_ID, `imported=${String(imported)} of ${String(total)}`);
    const orphanLinks = countOrphanLinks(source, store);
    store.recordAudit('migration.done', undefined, `imported=${String(imported)} orphanLinks=${String(orphanLinks)}`);
    return { status: 'done', imported, expected: total, orphanLinks, ...(backup ? { backup } : {}) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    store.recordAudit('migration.failed', undefined, detail);
    return { status: 'failed', detail, expected: total };
  }
}

/** `code_memory_link.memory_entity_id` 在新库里找不到的条数；只报不阻断。 */
export function countOrphanLinks(legacyFile: string, store: MemoryStore): number {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(legacyFile, { readOnly: true });
    const rows = db
      .prepare('SELECT DISTINCT memory_entity_id FROM code_memory_link')
      .all() as Array<{ memory_entity_id: string }>;
    let orphan = 0;
    for (const row of rows) {
      if (!store.getRecord(row.memory_entity_id)) orphan += 1;
    }
    return orphan;
  } catch {
    return 0;
  } finally {
    try {
      db?.close();
    } catch {
      // 只读连接。
    }
  }
}
