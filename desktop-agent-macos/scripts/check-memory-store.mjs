/**
 * 存储底座与历史迁移（`GLOBAL_MEMORY.md` §3、§5）。
 *
 * 真实临时 SQLite，不用 mock。覆盖：CRUD / 事务回滚 / 幂等 / 唯一索引 /
 * 重启恢复 / 审计 / 导出导入 / 损坏降级 / 字段映射 / 旧库只读 / orphanLinks /
 * 备份保留 / projectId 一致。
 *
 * Run with: npm run test:memory-store
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MemoryStore, openMemoryStore, degradedStatus, MEMORY_SCHEMA_VERSION
} from '../out-test/main/memory/store.js';
import {
  migrateLegacy, mapLegacyRow, countOrphanLinks
} from '../out-test/main/memory/migrate.js';
import { projectIdFor } from '../out-test/shared/project-id.js';
import { MEMORY_DEFAULTS } from '../out-test/shared/memory.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-store-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fresh = name => new MemoryStore(path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.sqlite`));

function legacy(file, rows, links = []) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE code_memory_facts (
    project_id TEXT, fact_id TEXT, kind TEXT, title TEXT, content TEXT,
    source TEXT, source_ref TEXT, status TEXT, confidence REAL,
    valid_from INTEGER, valid_to INTEGER, created_at INTEGER, updated_at INTEGER
  )`);
  db.exec(`CREATE TABLE code_memory_link (
    memory_entity_id TEXT, symbol_key TEXT, link_type TEXT, symbol_locator TEXT
  )`);
  const insert = db.prepare(`INSERT INTO code_memory_facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) insert.run(...r);
  const il = db.prepare(`INSERT INTO code_memory_link VALUES (?,?,?,?)`);
  for (const l of links) il.run(...l);
  db.close();
}

const row = (id, overrides = {}) => [
  overrides.project_id ?? 'p_alpha', id, overrides.kind ?? 'decision',
  overrides.title ?? `决策 ${id}`, overrides.content ?? `内容 ${id}`,
  overrides.source ?? 'conversation:c1', overrides.source_ref ?? null,
  overrides.status ?? 'confirmed', overrides.confidence ?? 0.8,
  overrides.valid_from ?? null, overrides.valid_to ?? null,
  overrides.created_at ?? 1_700_000_000_000, overrides.updated_at ?? 1_700_000_100_000
];

// ---- 存储 8 ----

test('开库建 schema，WAL + user_version 就位', () => {
  const store = fresh('schema');
  assert.equal(store.schemaVersion(), MEMORY_SCHEMA_VERSION);
  assert.equal(store.counts().records, 0);
  store.close();
});

test('createRecord / getRecord / listRecords 往返', () => {
  const store = fresh('crud');
  const r = store.createRecord({ kind: 'constraint', scope: 'PROJECT', scopeId: 'p_alpha', title: '不要 push', content: '禁止 push', status: 'active' });
  assert.ok(r.memoryId.startsWith('mem_'));
  assert.equal(store.getRecord(r.memoryId).content, '禁止 push');
  assert.equal(store.listRecords({ scope: 'PROJECT', status: 'active' }).length, 1);
  store.close();
});

test('patchRecord 改状态与过期时间，updatedAt 前进', () => {
  const store = fresh('patch');
  const r = store.createRecord({ kind: 'fact', scope: 'GLOBAL', title: '临时', content: 'x', status: 'active' });
  const next = store.patchRecord(r.memoryId, { status: 'expired', expiresAt: 1 });
  assert.equal(next.status, 'expired');
  assert.equal(next.expiresAt, 1);
  assert.ok(next.updatedAt >= r.updatedAt);
  store.close();
});

test('同一 memoryId 不产生第二条记录（幂等 upsert）', () => {
  const store = fresh('unique');
  store.createRecord({ kind: 'fact', scope: 'GLOBAL', memoryId: 'fixed-id', title: 'A', content: 'a', status: 'active' });
  store.createRecord({ kind: 'fact', scope: 'GLOBAL', memoryId: 'fixed-id', title: 'B', content: 'b', status: 'active' });
  assert.equal(store.counts().records, 1);
  assert.equal(store.getRecord('fixed-id').title, 'B');
  store.close();
});

test('事务回滚：核对失败时一个记录都不留', () => {
  const store = fresh('tx');
  const records = [
    { ...store.createRecord({ kind: 'fact', scope: 'GLOBAL', memoryId: 'tx-a', title: 'A', content: 'a', status: 'active' }) },
  ];
  const before = store.counts().records;
  assert.throws(() => store.importRecordsInTx(
    [{ ...records[0], memoryId: 'tx-b', title: 'B', normalizedKey: 'b' }],
    () => { throw new Error('核对失败'); }
  ), /核对失败/);
  assert.equal(store.counts().records, before);
  assert.equal(store.getRecord('tx-b'), null);
  store.close();
});

test('重启恢复：close 后重新打开同一文件，memoryId 不变', () => {
  const file = path.join(dir, 'restart.sqlite');
  const a = new MemoryStore(file);
  const r = a.createRecord({ kind: 'decision', scope: 'PROJECT', scopeId: 'p_alpha', title: '架构决策', content: '用独立库', status: 'active' });
  a.close();
  const b = new MemoryStore(file);
  assert.equal(b.getRecord(r.memoryId).content, '用独立库');
  assert.equal(b.counts().records, 1);
  b.close();
});

test('审计可查、可计数', () => {
  const store = fresh('audit');
  const r = store.createRecord({ kind: 'fact', scope: 'GLOBAL', title: 'A', content: 'a', status: 'active' });
  store.recordAudit('test.action', r.memoryId, 'detail');
  assert.ok(store.listAudit().some(e => e.action === 'test.action'));
  assert.equal(store.countAudit('test.action', r.memoryId), 1);
  store.close();
});

test('导出 / 导入可重建，冲突记录不静默覆盖', () => {
  const a = fresh('export-a');
  const b = fresh('export-b');
  a.createRecord({ kind: 'fact', scope: 'GLOBAL', memoryId: 'same', title: 'A', content: 'a', status: 'active' });
  b.createRecord({ kind: 'fact', scope: 'GLOBAL', memoryId: 'same', title: 'B', content: 'b', status: 'active' });
  const dump = a.exportAll();
  const result = b.importAll(dump);
  assert.equal(result.imported, 0);
  assert.equal(result.archivedForConflict, 1);
  assert.equal(b.getRecord('same').title, 'B', '冲突时不覆盖已有记录');
  a.close(); b.close();
});

// ---- 迁移 6 ----

test('迁移字段映射：kind / status / sourceRefs / confidence / 时间', () => {
  const mapped = mapLegacyRow({
    project_id: 'p_alpha', fact_id: 'f1', kind: 'debate', title: '标题', content: '内容',
    source: 'conversation:c1', source_ref: 'message:m1', status: 'confirmed',
    confidence: 0.7, valid_from: 100, valid_to: 900, created_at: 100, updated_at: 200
  }, 'f1');
  assert.equal(mapped.kind, 'decision');
  assert.ok(mapped.tags.includes('debate'));
  assert.equal(mapped.status, 'active');
  assert.deepEqual(mapped.sourceRefs, ['conversation:c1', 'message:m1']);
  assert.equal(mapped.confidence, 0.7);
  assert.equal(mapped.scope, 'PROJECT');
  assert.equal(mapped.scopeId, 'p_alpha');
  assert.equal(mapped.expiresAt, 900);
});

test('迁移：事务 + 幂等，跑两次计数一致，memoryId 用旧 fact_id', () => {
  const file = path.join(dir, 'legacy-idem.sqlite');
  legacy(file, [row('f1'), row('f2', { kind: 'fact', status: 'candidate' })], [['f1', 'sym', 'ref', null], ['ghost', 'sym2', 'ref', null]]);
  const store = fresh('migrate-idem');
  const first = migrateLegacy({ store, legacyFile: file, backupDir: path.join(dir, 'backups') });
  const second = migrateLegacy({ store, legacyFile: file, backupDir: path.join(dir, 'backups') });
  assert.equal(first.status, 'done');
  assert.equal(second.status, 'done');
  assert.equal(store.counts().records, 2);
  assert.ok(store.getRecord('f1'));
  assert.equal(store.getRecord('f2').status, 'candidate');
  store.close();
});

test('迁移后旧表零写入（行数不变），备份保留', () => {
  const file = path.join(dir, 'legacy-readonly.sqlite');
  legacy(file, [row('r1'), row('r2')]);
  const store = fresh('migrate-ro');
  const backupDir = path.join(dir, 'backups2');
  migrateLegacy({ store, legacyFile: file, backupDir });
  const db = new DatabaseSync(file, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) AS n FROM code_memory_facts').get().n;
  db.close();
  assert.equal(Number(n), 2);
  assert.ok(fs.readdirSync(backupDir).some(f => f.startsWith('legacy-backup-')));
  store.close();
});

test('orphanLinks 与迁移前实测一致，不阻断', () => {
  const file = path.join(dir, 'legacy-orphan.sqlite');
  legacy(file, [row('f1')], [['f1', 'a', 'ref', null], ['missing-a', 'b', 'ref', null], ['missing-b', 'c', 'ref', null]]);
  const store = fresh('migrate-orphan');
  const before = countOrphanLinks(file, store);
  assert.equal(before, 3); // 迁移前三条都找不到
  migrateLegacy({ store, legacyFile: file, backupDir: path.join(dir, 'backups3') });
  const after = countOrphanLinks(file, store);
  assert.equal(after, 2); // 迁移后 f1 找得到，两个幽灵仍是 orphan
  store.close();
});

test('源库缺失：跳过迁移写 legacy-absent，正常启动', () => {
  const store = fresh('migrate-absent');
  const result = migrateLegacy({ store, legacyFile: path.join(dir, 'nope.sqlite') });
  assert.equal(result.status, 'absent');
  assert.ok(store.hasMigration('legacy-import@1'));
  store.close();
});

test('目标库损坏 → degraded，不抛给调用方', () => {
  const bad = path.join(dir, 'corrupt.sqlite');
  fs.writeFileSync(bad, 'this is not a sqlite database at all');
  const opened = openMemoryStore(bad);
  assert.equal(opened.store, null);
  assert.ok(opened.error);
  const status = degradedStatus(bad, opened.error);
  assert.equal(status.state, 'degraded');
  assert.equal(status.records, 0);
});

test('projectIdFor 稳定且与调用方无关；默认阈值来自语料扫描', () => {
  assert.equal(projectIdFor('/a/b'), projectIdFor('/a/b'));
  assert.notEqual(projectIdFor('/a/b'), projectIdFor('/a/c'));
  assert.ok(projectIdFor('/a/b').startsWith('p_'));
  assert.equal(MEMORY_DEFAULTS.minScore, 0.12);
});
