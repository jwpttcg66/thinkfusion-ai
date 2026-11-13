/**
 * 工程智能的本地事实库：SQLite + FTS5。
 *
 * 这是 V3.0 的“轻量回退/基础层”：不依赖 Neo4j、Graphiti、CGC，也能在真机
 * 上完成代码索引、全文检索、关系查询、记忆与关联。Node 24 / Electron 45
 * 自带 `node:sqlite`（SQLite 3.53.4），不需要 native addon 或 node-gyp。
 *
 * 边界：
 * - 只存索引和记忆，不执行文件写入；
 * - 所有查询必须带 projectId，不能跨工程；
 * - FTS5 用 trigram 覆盖 ≥3 字子串；1–2 字中文走 LIKE 回退（见 fts.ts）；
 * - generation 未提交时不允许被检索。
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  CodeEdge,
  CodeMemoryLink,
  CodeNode,
  EdgeConfidence,
  EdgeSource,
  LinkStatus,
  MemoryFact,
  MemoryStatus,
  SearchDoc,
  SearchHit
} from './types';

const SCHEMA_VERSION = 5;

function hash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function now(): number {
  return Date.now();
}

export interface GenerationState {
  projectId: string;
  generation: number;
  status: 'pending' | 'building' | 'ready' | 'failed' | 'superseded';
  sourceVersion: string;
  createdAt: number;
  completedAt?: number;
  error?: string;
}

export class CodeIndexStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const version = Number(row?.user_version ?? 0);
    if (version >= SCHEMA_VERSION) return;
    if (version < 1) this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_generation (
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        PRIMARY KEY (project_id, generation)
      );

      CREATE TABLE IF NOT EXISTS code_file_state (
        project_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (project_id, generation, file_path)
      );

      CREATE TABLE IF NOT EXISTS code_nodes (
        project_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        language TEXT NOT NULL,
        generation INTEGER NOT NULL,
        symbol_id TEXT,
        symbol_status TEXT NOT NULL DEFAULT 'confirmed',
        module_id TEXT,
        signature TEXT,
        PRIMARY KEY (project_id, generation, node_id)
      );
      CREATE INDEX IF NOT EXISTS code_nodes_name ON code_nodes(project_id, generation, name);
      CREATE INDEX IF NOT EXISTS code_nodes_symbol ON code_nodes(project_id, generation, symbol_id);
      CREATE INDEX IF NOT EXISTS code_nodes_file ON code_nodes(project_id, file_path);

      CREATE TABLE IF NOT EXISTS code_edges (
        project_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source TEXT NOT NULL,
        file_path TEXT,
        line INTEGER,
        generation INTEGER NOT NULL,
        resolution_status TEXT NOT NULL DEFAULT 'resolved',
        call_site_id TEXT,
        PRIMARY KEY (project_id, generation, edge_id)
      );
      CREATE INDEX IF NOT EXISTS code_edges_source ON code_edges(project_id, generation, source_node_id, relation_type);
      CREATE INDEX IF NOT EXISTS code_edges_target ON code_edges(project_id, generation, target_node_id, relation_type);

      CREATE TABLE IF NOT EXISTS code_search_docs (
        project_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        node_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (project_id, generation, doc_id)
      );
      CREATE INDEX IF NOT EXISTS code_search_docs_file ON code_search_docs(project_id, generation, file_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        project_id UNINDEXED,
        doc_id UNINDEXED,
        file_path UNINDEXED,
        name,
        content,
        tokenize = 'trigram'
      );

      CREATE TABLE IF NOT EXISTS code_memory_facts (
        project_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        valid_from INTEGER,
        valid_to INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, fact_id)
      );
      CREATE INDEX IF NOT EXISTS code_memory_status ON code_memory_facts(project_id, status);

      CREATE TABLE IF NOT EXISTS code_memory_link (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        symbol_key TEXT NOT NULL,
        symbol_locator TEXT NOT NULL,
        symbol_fingerprint TEXT NOT NULL,
        memory_entity_id TEXT NOT NULL,
        link_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, symbol_key, memory_entity_id)
      );
      CREATE INDEX IF NOT EXISTS code_memory_link_symbol ON code_memory_link(project_id, symbol_key);

      CREATE TABLE IF NOT EXISTS code_vectors (
        project_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        node_id TEXT,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (project_id, generation, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS code_vectors_file ON code_vectors(project_id, generation, file_path);

      CREATE TABLE IF NOT EXISTS code_outbox (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS code_outbox_status ON code_outbox(project_id, status);

    `);
    // v1 的 outbox 没有 error 列；已有用户库要能原地升级，不丢任务。
    if (version >= 1 && version < 2) {
      try {
        this.db.exec('ALTER TABLE code_outbox ADD COLUMN error TEXT');
      } catch {
        // 列已经存在（重复迁移）时忽略。
      }
    }
    if (version >= 1 && version < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS code_vectors (
          project_id TEXT NOT NULL,
          chunk_id TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          node_id TEXT,
          content_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vector BLOB NOT NULL,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          PRIMARY KEY (project_id, generation, chunk_id)
        );
        CREATE INDEX IF NOT EXISTS code_vectors_file ON code_vectors(project_id, generation, file_path);
      `);
    }
    if (version >= 1 && version < 4) {
      // v4 是加法迁移：旧库保留 node_id 作为主键，symbol_id 先回填为 node_id。
      // 真正的稳定 symbol_id 在索引重建时逐步写入；读路径不依赖它。
      for (const sql of [
        'ALTER TABLE code_nodes ADD COLUMN symbol_id TEXT',
        "ALTER TABLE code_nodes ADD COLUMN symbol_status TEXT NOT NULL DEFAULT 'confirmed'",
        'ALTER TABLE code_nodes ADD COLUMN module_id TEXT',
        'ALTER TABLE code_nodes ADD COLUMN signature TEXT',
        "ALTER TABLE code_edges ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'resolved'",
        'ALTER TABLE code_edges ADD COLUMN call_site_id TEXT',
        'ALTER TABLE code_vectors ADD COLUMN generation INTEGER'
      ]) {
        try {
          this.db.exec(sql);
        } catch {
          // 列已存在：重复迁移或 fresh DB 已经带列。
        }
      }
      this.db.exec('UPDATE code_nodes SET symbol_id = node_id WHERE symbol_id IS NULL');
      this.db.exec('CREATE INDEX IF NOT EXISTS code_nodes_symbol ON code_nodes(project_id, symbol_id)');
    }
    if (version >= 1 && version < 5) this.migrateV5();
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * v5：把 nodes/edges/docs/vectors/file_state 改成 generation 作用域。
   * 现有数据归入当前 ready generation；没有 ready 的工程归入 generation 1。
   * FTS 表保持原结构；检索时 join code_search_docs 过滤 generation。
   */
  private migrateV5(): void {
    const created = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS migration_generation AS
        SELECT project_id, COALESCE(MAX(CASE WHEN status = 'ready' THEN generation END), 1) AS generation
        FROM code_generation GROUP BY project_id;

        ALTER TABLE code_nodes RENAME TO code_nodes_v4;
        CREATE TABLE code_nodes (
          project_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          node_type TEXT NOT NULL,
          name TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          language TEXT NOT NULL,
          generation INTEGER NOT NULL,
          symbol_id TEXT,
          symbol_status TEXT NOT NULL DEFAULT 'confirmed',
          module_id TEXT,
          signature TEXT,
          PRIMARY KEY (project_id, generation, node_id)
        );
        INSERT INTO code_nodes
          (project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, generation,
           symbol_id, symbol_status, module_id, signature)
        SELECT n.project_id, n.node_id, n.node_type, n.name, n.qualified_name, n.file_path,
               n.start_line, n.end_line, n.language,
               COALESCE((SELECT m.generation FROM migration_generation m WHERE m.project_id = n.project_id), 1),
               n.symbol_id, n.symbol_status, n.module_id, n.signature
        FROM code_nodes_v4 n;
        DROP TABLE code_nodes_v4;
        CREATE INDEX IF NOT EXISTS code_nodes_name ON code_nodes(project_id, generation, name);
        CREATE INDEX IF NOT EXISTS code_nodes_file ON code_nodes(project_id, generation, file_path);
        CREATE INDEX IF NOT EXISTS code_nodes_symbol ON code_nodes(project_id, generation, symbol_id);

        ALTER TABLE code_edges RENAME TO code_edges_v4;
        CREATE TABLE code_edges (
          project_id TEXT NOT NULL,
          edge_id TEXT NOT NULL,
          source_node_id TEXT NOT NULL,
          target_node_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence TEXT NOT NULL,
          source TEXT NOT NULL,
          file_path TEXT,
          line INTEGER,
          generation INTEGER NOT NULL,
          resolution_status TEXT NOT NULL DEFAULT 'resolved',
          call_site_id TEXT,
          PRIMARY KEY (project_id, generation, edge_id)
        );
        INSERT INTO code_edges
          (project_id, edge_id, source_node_id, target_node_id, relation_type, confidence, source,
           file_path, line, generation, resolution_status, call_site_id)
        SELECT e.project_id, e.edge_id, e.source_node_id, e.target_node_id, e.relation_type,
               e.confidence, e.source, e.file_path, e.line,
               COALESCE((SELECT m.generation FROM migration_generation m WHERE m.project_id = e.project_id), 1),
               e.resolution_status, e.call_site_id
        FROM code_edges_v4 e;
        DROP TABLE code_edges_v4;
        CREATE INDEX IF NOT EXISTS code_edges_source ON code_edges(project_id, generation, source_node_id, relation_type);
        CREATE INDEX IF NOT EXISTS code_edges_target ON code_edges(project_id, generation, target_node_id, relation_type);

        ALTER TABLE code_search_docs RENAME TO code_search_docs_v4;
        CREATE TABLE code_search_docs (
          project_id TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          node_id TEXT,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          generation INTEGER NOT NULL,
          PRIMARY KEY (project_id, generation, doc_id)
        );
        INSERT INTO code_search_docs
          (project_id, doc_id, file_path, node_id, kind, name, content, generation)
        SELECT d.project_id, d.doc_id, d.file_path, d.node_id, d.kind, d.name, d.content,
               COALESCE((SELECT m.generation FROM migration_generation m WHERE m.project_id = d.project_id), 1)
        FROM code_search_docs_v4 d;
        DROP TABLE code_search_docs_v4;
        CREATE INDEX IF NOT EXISTS code_search_docs_file ON code_search_docs(project_id, generation, file_path);

        ALTER TABLE code_vectors RENAME TO code_vectors_v4;
        CREATE TABLE code_vectors (
          project_id TEXT NOT NULL,
          chunk_id TEXT NOT NULL,
          doc_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          node_id TEXT,
          content_hash TEXT NOT NULL,
          model TEXT NOT NULL,
          dim INTEGER NOT NULL,
          vector BLOB NOT NULL,
          content TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          PRIMARY KEY (project_id, generation, chunk_id)
        );
        INSERT INTO code_vectors
          (project_id, chunk_id, doc_id, file_path, node_id, content_hash, model, dim, vector, content, updated_at, generation)
        SELECT v.project_id, v.chunk_id, v.doc_id, v.file_path, v.node_id, v.content_hash, v.model,
               v.dim, v.vector, v.content, v.updated_at,
               COALESCE((SELECT m.generation FROM migration_generation m WHERE m.project_id = v.project_id), 1)
        FROM code_vectors_v4 v;
        DROP TABLE code_vectors_v4;
        CREATE INDEX IF NOT EXISTS code_vectors_file ON code_vectors(project_id, generation, file_path);

        ALTER TABLE code_file_state RENAME TO code_file_state_v4;
        CREATE TABLE code_file_state (
          project_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (project_id, generation, file_path)
        );
        INSERT INTO code_file_state
          (project_id, file_path, content_hash, size, mtime_ms, generation, indexed_at, status)
        SELECT f.project_id, f.file_path, f.content_hash, f.size, f.mtime_ms,
               COALESCE((SELECT m.generation FROM migration_generation m WHERE m.project_id = f.project_id), 1),
               f.indexed_at, f.status
        FROM code_file_state_v4 f;
        DROP TABLE code_file_state_v4;
      `);
      this.db.prepare(`
        INSERT OR IGNORE INTO code_generation
          (project_id, generation, status, source_version, created_at, completed_at)
        SELECT DISTINCT project_id,
               COALESCE((SELECT generation FROM migration_generation m WHERE m.project_id = code_nodes.project_id), 1),
               'ready', 'migration-v5', ?, ?
        FROM code_nodes
      `).run(created, created);
      this.db.exec('DROP TABLE IF EXISTS migration_generation');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // --- generation ---------------------------------------------------------

  beginGeneration(projectId: string, sourceVersion: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM code_generation WHERE project_id = ?'
    ).get(projectId) as { next: number } | undefined;
    const generation = Number(row?.next ?? 1);
    this.db.prepare(`
      INSERT INTO code_generation (project_id, generation, status, source_version, created_at)
      VALUES (?, ?, 'building', ?, ?)
    `).run(projectId, generation, sourceVersion, now());
    return generation;
  }

  commitGeneration(projectId: string, generation: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE code_generation SET status = 'superseded'
        WHERE project_id = ? AND status = 'ready' AND generation <> ?
      `).run(projectId, generation);
      this.db.prepare(`
        UPDATE code_generation SET status = 'ready', completed_at = ?
        WHERE project_id = ? AND generation = ? AND status = 'building'
      `).run(now(), projectId, generation);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  failGeneration(projectId: string, generation: number, error: string): void {
    this.db.prepare(`
      UPDATE code_generation SET status = 'failed', completed_at = ?, error = ?
      WHERE project_id = ? AND generation = ?
    `).run(now(), error.slice(0, 2000), projectId, generation);
  }

  currentGeneration(projectId: string): number | null {
    const row = this.db.prepare(`
      SELECT generation FROM code_generation
      WHERE project_id = ? AND status = 'ready'
      ORDER BY generation DESC LIMIT 1
    `).get(projectId) as { generation?: number } | undefined;
    return typeof row?.generation === 'number' ? row.generation : null;
  }

  /**
   * 清理旧 generation，只保留最近 keep 个。默认保留 current + 上一代，
   * 给回滚和正在进行的查询留窗口；Evidence Pack 接入后需要先检查 pin。
   */
  pruneGenerations(projectId: string, keep = 2): void {
    const rows = this.db.prepare(`
      SELECT generation FROM code_generation
      WHERE project_id = ? ORDER BY generation DESC
    `).all(projectId) as Array<{ generation?: number }>;
    const remove = rows.map(row => Number(row.generation)).filter(value => Number.isFinite(value)).slice(Math.max(0, keep));
    if (remove.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const generation of remove) {
        const docs = this.db.prepare('SELECT doc_id FROM code_search_docs WHERE project_id = ? AND generation = ?')
          .all(projectId, generation) as Array<{ doc_id?: string }>;
        for (const doc of docs) {
          if (typeof doc.doc_id !== 'string') continue;
          this.db.prepare(`
            DELETE FROM code_fts
            WHERE project_id = ? AND doc_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM code_search_docs d
                WHERE d.project_id = ? AND d.doc_id = ?
              )
          `).run(projectId, doc.doc_id, projectId, doc.doc_id);
        }
        for (const table of ['code_nodes', 'code_edges', 'code_search_docs', 'code_vectors', 'code_file_state']) {
          this.db.prepare(`DELETE FROM ${table} WHERE project_id = ? AND generation = ?`).run(projectId, generation);
        }
        this.db.prepare('DELETE FROM code_generation WHERE project_id = ? AND generation = ?').run(projectId, generation);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  generationState(projectId: string, generation: number): GenerationState | null {
    const row = this.db.prepare(`
      SELECT * FROM code_generation WHERE project_id = ? AND generation = ?
    `).get(projectId, generation) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      projectId,
      generation: Number(row.generation),
      status: String(row.status) as GenerationState['status'],
      sourceVersion: String(row.source_version),
      createdAt: Number(row.created_at),
      ...(typeof row.completed_at === 'number' ? { completedAt: row.completed_at } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {})
    };
  }

  // --- file state ---------------------------------------------------------

  markFile(
    projectId: string,
    filePath: string,
    contentHash: string,
    size: number,
    mtimeMs: number,
    generation: number
  ): void {
    this.db.prepare(`
      INSERT INTO code_file_state
        (project_id, file_path, content_hash, size, mtime_ms, generation, indexed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready')
      ON CONFLICT(project_id, generation, file_path) DO UPDATE SET
        content_hash = excluded.content_hash,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        generation = excluded.generation,
        indexed_at = excluded.indexed_at,
        status = 'ready'
    `).run(projectId, filePath, contentHash, size, mtimeMs, generation, now());
  }

  listFiles(projectId: string): Array<{ filePath: string; contentHash: string; size: number; mtimeMs: number; generation: number }> {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = this.db.prepare(`
      SELECT file_path, content_hash, size, mtime_ms, generation
      FROM code_file_state WHERE project_id = ? AND generation = ?
    `).all(projectId, generation) as Record<string, unknown>[];
    return rows.map(row => ({
      filePath: String(row.file_path),
      contentHash: String(row.content_hash),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      generation: Number(row.generation)
    }));
  }

  /**
   * 文件内容没变时，把上一代该文件的节点/边/文档/向量复制到新 generation。
   * 不复制 FTS：FTS 行按 doc_id 全局保存，搜索时 join current 文档过滤；
   * 未变文件沿用上一代 FTS 行，避免为每个 generation 复制一份全文索引。
   */
  copyFileGeneration(projectId: string, fromGeneration: number, toGeneration: number, filePath: string): boolean {
    const exists = this.db.prepare(`
      SELECT 1 AS ok FROM code_file_state
      WHERE project_id = ? AND generation = ? AND file_path = ?
    `).get(projectId, fromGeneration, filePath) as { ok?: number } | undefined;
    if (!exists) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO code_nodes
          (project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, generation,
           symbol_id, symbol_status, module_id, signature)
        SELECT project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, ?,
               symbol_id, symbol_status, module_id, signature
        FROM code_nodes WHERE project_id = ? AND generation = ? AND file_path = ?
      `).run(toGeneration, projectId, fromGeneration, filePath);
      this.db.prepare(`
        INSERT OR IGNORE INTO code_edges
          (project_id, edge_id, source_node_id, target_node_id, relation_type, confidence, source, file_path, line, generation,
           resolution_status, call_site_id)
        SELECT project_id, edge_id, source_node_id, target_node_id, relation_type, confidence, source, file_path, line, ?,
               resolution_status, call_site_id
        FROM code_edges WHERE project_id = ? AND generation = ? AND file_path = ?
      `).run(toGeneration, projectId, fromGeneration, filePath);
      this.db.prepare(`
        INSERT OR IGNORE INTO code_search_docs
          (project_id, doc_id, file_path, node_id, kind, name, content, generation)
        SELECT project_id, doc_id, file_path, node_id, kind, name, content, ?
        FROM code_search_docs WHERE project_id = ? AND generation = ? AND file_path = ?
      `).run(toGeneration, projectId, fromGeneration, filePath);
      this.db.prepare(`
        INSERT OR IGNORE INTO code_vectors
          (project_id, chunk_id, doc_id, file_path, node_id, content_hash, model, dim, vector, content, updated_at, generation)
        SELECT project_id, chunk_id, doc_id, file_path, node_id, content_hash, model, dim, vector, content, updated_at, ?
        FROM code_vectors WHERE project_id = ? AND generation = ? AND file_path = ?
      `).run(toGeneration, projectId, fromGeneration, filePath);
      this.db.prepare(`
        INSERT OR IGNORE INTO code_file_state
          (project_id, file_path, content_hash, size, mtime_ms, generation, indexed_at, status)
        SELECT project_id, file_path, content_hash, size, mtime_ms, ?, indexed_at, status
        FROM code_file_state WHERE project_id = ? AND generation = ? AND file_path = ?
      `).run(toGeneration, projectId, fromGeneration, filePath);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 外部包节点不属于文件，单独从上一代复制到新代。 */
  copyExternalNodes(projectId: string, fromGeneration: number, toGeneration: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO code_nodes
        (project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, generation,
         symbol_id, symbol_status, module_id, signature)
      SELECT project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, ?,
             symbol_id, symbol_status, module_id, signature
      FROM code_nodes WHERE project_id = ? AND generation = ? AND file_path = ''
    `).run(toGeneration, projectId, fromGeneration);
  }

  fileHash(projectId: string, filePath: string): string | null {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return null;
    const row = this.db.prepare(`
      SELECT content_hash FROM code_file_state WHERE project_id = ? AND generation = ? AND file_path = ?
    `).get(projectId, generation, filePath) as { content_hash?: string } | undefined;
    return typeof row?.content_hash === 'string' ? row.content_hash : null;
  }

  // --- write a file's index ----------------------------------------------

  replaceFileIndex(
    projectId: string,
    generation: number,
    filePath: string,
    nodes: readonly CodeNode[],
    edges: readonly CodeEdge[],
    docs: readonly SearchDoc[]
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM code_nodes WHERE project_id = ? AND generation = ? AND file_path = ?').run(projectId, generation, filePath);
      this.db.prepare('DELETE FROM code_edges WHERE project_id = ? AND generation = ? AND file_path = ?').run(projectId, generation, filePath);
      this.db.prepare('DELETE FROM code_search_docs WHERE project_id = ? AND generation = ? AND file_path = ?').run(projectId, generation, filePath);

      const nodeStmt = this.db.prepare(`
        INSERT INTO code_nodes
          (project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, generation,
           symbol_id, symbol_status, module_id, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of nodes) {
        nodeStmt.run(
          projectId, node.nodeId, node.nodeType, node.name, node.qualifiedName,
          node.filePath, node.startLine, node.endLine, node.language, generation,
          node.symbolId ?? node.nodeId, node.symbolStatus ?? 'confirmed',
          node.moduleId ?? null, node.signature ?? null
        );
      }

      const edgeStmt = this.db.prepare(`
        INSERT OR IGNORE INTO code_edges
          (project_id, edge_id, source_node_id, target_node_id, relation_type, confidence, source, file_path, line, generation,
           resolution_status, call_site_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const edge of edges) {
        edgeStmt.run(
          projectId, edge.edgeId, edge.sourceNodeId, edge.targetNodeId, edge.relationType,
          edge.confidence, edge.source, edge.filePath ?? null, edge.line ?? null, generation,
          edge.resolutionStatus ?? 'resolved', edge.callSiteId ?? null
        );
      }

      const docStmt = this.db.prepare(`
        INSERT INTO code_search_docs
          (project_id, doc_id, file_path, node_id, kind, name, content, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const ftsStmt = this.db.prepare(`
        INSERT INTO code_fts (project_id, doc_id, file_path, name, content)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const doc of docs) {
        docStmt.run(projectId, doc.docId, doc.filePath, doc.nodeId ?? null, doc.kind, doc.name, doc.content, generation);
        ftsStmt.run(projectId, doc.docId, doc.filePath, doc.name, doc.content);
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteFile(projectId: string, filePath: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM code_nodes WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
      this.db.prepare('DELETE FROM code_edges WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
      const docs = this.db.prepare('SELECT doc_id FROM code_search_docs WHERE project_id = ? AND file_path = ?')
        .all(projectId, filePath) as Array<{ doc_id: string }>;
      for (const doc of docs) {
        this.db.prepare('DELETE FROM code_fts WHERE project_id = ? AND doc_id = ?').run(projectId, doc.doc_id);
      }
      this.db.prepare('DELETE FROM code_search_docs WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
      this.db.prepare('DELETE FROM code_file_state WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
      this.db.prepare('DELETE FROM code_vectors WHERE project_id = ? AND file_path = ?').run(projectId, filePath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- vectors -------------------------------------------------------------

  listDocs(projectId: string, limit = 500): Array<{ docId: string; filePath: string; nodeId?: string; name: string; content: string }> {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = this.db.prepare(`
      SELECT doc_id, file_path, node_id, name, content FROM code_search_docs
      WHERE project_id = ? AND generation = ? ORDER BY file_path, name LIMIT ?
    `).all(projectId, generation, limit) as Record<string, unknown>[];
    return rows.map(row => ({
      docId: String(row.doc_id),
      filePath: String(row.file_path),
      ...(typeof row.node_id === 'string' ? { nodeId: row.node_id } : {}),
      name: String(row.name),
      content: String(row.content)
    }));
  }

  replaceVectors(
    projectId: string,
    items: ReadonlyArray<{
      chunkId: string;
      docId: string;
      filePath: string;
      nodeId?: string;
      contentHash: string;
      model: string;
      vector: number[];
      content: string;
    }>
  ): void {
    const generation = this.currentGeneration(projectId) ?? 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM code_vectors WHERE project_id = ? AND generation = ?').run(projectId, generation);
      const stmt = this.db.prepare(`
        INSERT INTO code_vectors
          (project_id, chunk_id, doc_id, file_path, node_id, content_hash, model, dim, vector, content, updated_at, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        const values = new Float32Array(item.vector);
        stmt.run(
          projectId, item.chunkId, item.docId, item.filePath, item.nodeId ?? null,
          item.contentHash, item.model, item.vector.length, Buffer.from(values.buffer), item.content, Date.now(), generation
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listVectors(projectId: string, limit = 10000): Array<{ docId: string; filePath: string; nodeId?: string; model: string; vector: Float32Array; content: string }> {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = this.db.prepare(`
      SELECT doc_id, file_path, node_id, model, vector, content FROM code_vectors
      WHERE project_id = ? AND generation = ? LIMIT ?
    `).all(projectId, generation, limit) as Record<string, unknown>[];
    return rows.map(row => {
      const buffer = row.vector as Uint8Array;
      const copy = new Uint8Array(buffer);
      return {
        docId: String(row.doc_id),
        filePath: String(row.file_path),
        ...(typeof row.node_id === 'string' ? { nodeId: row.node_id } : {}),
        model: String(row.model),
        vector: new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4),
        content: String(row.content)
      };
    });
  }

  countVectors(projectId: string): number {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM code_vectors WHERE project_id = ? AND generation = ?')
      .get(projectId, generation) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 项目删除：本地所有索引/记忆/关联/向量/任务一起清掉。 */
  deleteProject(projectId: string): { files: number; nodes: number; edges: number; docs: number; vectors: number; memory: number; links: number } {
    const counts = {
      files: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_file_state WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0),
      nodes: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_nodes WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0),
      edges: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_edges WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0),
      docs: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_search_docs WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0),
      vectors: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_vectors WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0),
      memory: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_memory_facts WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0),
      links: Number((this.db.prepare('SELECT COUNT(*) AS n FROM code_memory_link WHERE project_id = ?').get(projectId) as { n?: number }).n ?? 0)
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM code_fts WHERE project_id = ?').run(projectId);
      for (const table of [
        'code_vectors', 'code_search_docs', 'code_edges', 'code_nodes',
        'code_file_state', 'code_memory_link', 'code_memory_facts',
        'code_generation', 'code_outbox'
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return counts;
  }

  // --- outbox -------------------------------------------------------------

  enqueueOutbox(input: {
    taskId: string;
    projectId: string;
    generation: number;
    filePath: string;
    operation: string;
    payloadHash: string;
  }): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO code_outbox
        (task_id, project_id, generation, file_path, operation, payload_hash, status, retry_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      input.taskId, input.projectId, input.generation, input.filePath,
      input.operation, input.payloadHash, now(), now()
    );
    return Number(result.changes) > 0;
  }

  claimOutbox(projectId: string, limit = 20): Array<{
    taskId: string;
    generation: number;
    filePath: string;
    operation: string;
    payloadHash: string;
    retryCount: number;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM code_outbox
      WHERE project_id = ? AND status IN ('pending', 'retry')
      ORDER BY created_at
      LIMIT ?
    `).all(projectId, limit) as Record<string, unknown>[];
    const out = rows.map(row => ({
      taskId: String(row.task_id),
      generation: Number(row.generation),
      filePath: String(row.file_path),
      operation: String(row.operation),
      payloadHash: String(row.payload_hash),
      retryCount: Number(row.retry_count)
    }));
    for (const task of out) {
      this.db.prepare(`UPDATE code_outbox SET status = 'running', updated_at = ? WHERE task_id = ?`)
        .run(now(), task.taskId);
    }
    return out;
  }

  completeOutbox(taskId: string): void {
    this.db.prepare(`UPDATE code_outbox SET status = 'done', updated_at = ? WHERE task_id = ?`).run(now(), taskId);
  }

  failOutbox(taskId: string, error: string, maxRetries = 5): void {
    const row = this.db.prepare('SELECT retry_count FROM code_outbox WHERE task_id = ?')
      .get(taskId) as { retry_count?: number } | undefined;
    const retry = Number(row?.retry_count ?? 0) + 1;
    this.db.prepare(`
      UPDATE code_outbox SET status = ?, retry_count = ?, error = ?, updated_at = ?
      WHERE task_id = ?
    `).run(retry >= maxRetries ? 'failed' : 'retry', retry, error.slice(0, 1000), now(), taskId);
  }

  listOutbox(projectId: string): Array<{ taskId: string; status: string; retryCount: number; filePath: string }> {
    const rows = this.db.prepare(`
      SELECT task_id, status, retry_count, file_path FROM code_outbox
      WHERE project_id = ? ORDER BY created_at
    `).all(projectId) as Record<string, unknown>[];
    return rows.map(row => ({
      taskId: String(row.task_id),
      status: String(row.status),
      retryCount: Number(row.retry_count),
      filePath: String(row.file_path)
    }));
  }

  // --- reads --------------------------------------------------------------

  /** 外部包等不属于某个文件的节点：只保证存在，不参与文件替换。 */
  ensureNode(node: CodeNode): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO code_nodes
        (project_id, node_id, node_type, name, qualified_name, file_path, start_line, end_line, language, generation,
         symbol_id, symbol_status, module_id, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.projectId, node.nodeId, node.nodeType, node.name, node.qualifiedName,
      node.filePath, node.startLine, node.endLine, node.language, node.generation,
      node.symbolId ?? node.nodeId, node.symbolStatus ?? 'confirmed',
      node.moduleId ?? null, node.signature ?? null
    );
  }

  getNode(projectId: string, nodeId: string): CodeNode | null {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return null;
    const row = this.db.prepare('SELECT * FROM code_nodes WHERE project_id = ? AND generation = ? AND node_id = ?')
      .get(projectId, generation, nodeId) as Record<string, unknown> | undefined;
    return row ? this.toNode(row) : null;
  }

  findSymbols(projectId: string, name: string, limit = 50): CodeNode[] {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = this.db.prepare(`
      SELECT * FROM code_nodes
      WHERE project_id = ? AND generation = ? AND (name = ? OR qualified_name = ?)
      ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, file_path, start_line
      LIMIT ?
    `).all(projectId, generation, name, name, name, limit) as Record<string, unknown>[];
    return rows.map(row => this.toNode(row));
  }

  listNodes(projectId: string, filePath?: string, limit = 200): CodeNode[] {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = filePath
      ? this.db.prepare('SELECT * FROM code_nodes WHERE project_id = ? AND generation = ? AND file_path = ? ORDER BY start_line LIMIT ?')
          .all(projectId, generation, filePath, limit) as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM code_nodes WHERE project_id = ? AND generation = ? ORDER BY file_path, start_line LIMIT ?')
          .all(projectId, generation, limit) as Record<string, unknown>[];
    return rows.map(row => this.toNode(row));
  }

  getOutgoing(projectId: string, nodeId: string, relations?: readonly string[]): CodeEdge[] {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = this.db.prepare(`
      SELECT * FROM code_edges WHERE project_id = ? AND generation = ? AND source_node_id = ?
      ORDER BY relation_type, line
    `).all(projectId, generation, nodeId) as Record<string, unknown>[];
    return rows
      .map(row => this.toEdge(row))
      .filter(edge => !relations || relations.includes(edge.relationType));
  }

  getIncoming(projectId: string, nodeId: string, relations?: readonly string[]): CodeEdge[] {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const rows = this.db.prepare(`
      SELECT * FROM code_edges WHERE project_id = ? AND generation = ? AND target_node_id = ?
      ORDER BY relation_type, line
    `).all(projectId, generation, nodeId) as Record<string, unknown>[];
    return rows
      .map(row => this.toEdge(row))
      .filter(edge => !relations || relations.includes(edge.relationType));
  }

  impact(projectId: string, nodeId: string, depth = 3, limit = 200): { nodes: CodeNode[]; edges: CodeEdge[] } {
    const seen = new Set<string>([nodeId]);
    const edges: CodeEdge[] = [];
    let frontier = [nodeId];
    for (let level = 0; level < depth && frontier.length > 0 && edges.length < limit; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.getIncoming(projectId, id, ['CALLS', 'REFERENCES', 'IMPLEMENTS', 'EXTENDS', 'IMPORTS'])) {
          if (edges.length >= limit) break;
          edges.push(edge);
          if (!seen.has(edge.sourceNodeId)) {
            seen.add(edge.sourceNodeId);
            next.push(edge.sourceNodeId);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...seen]
      .map(id => this.getNode(projectId, id))
      .filter((node): node is CodeNode => node !== null);
    return { nodes, edges };
  }

  count(projectId: string): { files: number; nodes: number; edges: number; docs: number } {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return { files: 0, nodes: 0, edges: 0, docs: 0 };
    const one = (table: string) => Number((this.db.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND generation = ?`
    ).get(projectId, generation) as { n?: number } | undefined)?.n ?? 0);
    return {
      files: one('code_file_state'),
      nodes: one('code_nodes'),
      edges: one('code_edges'),
      docs: one('code_search_docs')
    };
  }

  nodeAt(projectId: string, filePath: string, line: number): CodeNode | null {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return null;
    const row = this.db.prepare(`
      SELECT * FROM code_nodes
      WHERE project_id = ? AND generation = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
      ORDER BY (end_line - start_line) ASC
      LIMIT 1
    `).get(projectId, generation, filePath, line, line) as Record<string, unknown> | undefined;
    return row ? this.toNode(row) : null;
  }

  /**
   * 只读一致性检查：不修改数据，供 Gate 1B 的 Integrity Checker 和测试使用。
   * 检查 markdown 里最关键的悬空边、孤儿文档/向量、未完成 generation。
   */
  integrity(projectId: string): {
    generation: number | null;
    danglingEdges: number;
    orphanDocs: number;
    orphanVectors: number;
    unfinishedGenerations: number;
    issues: string[];
  } {
    const one = (sql: string) => Number((this.db.prepare(sql).get(projectId) as { n?: number } | undefined)?.n ?? 0);
    const danglingEdges = one(`
      SELECT COUNT(*) AS n FROM code_edges e
      LEFT JOIN code_nodes s ON s.project_id = e.project_id AND s.generation = e.generation AND s.node_id = e.source_node_id
      LEFT JOIN code_nodes t ON t.project_id = e.project_id AND t.generation = e.generation AND t.node_id = e.target_node_id
      WHERE e.project_id = ? AND (s.node_id IS NULL OR t.node_id IS NULL)
    `);
    const orphanDocs = one(`
      SELECT COUNT(*) AS n FROM code_search_docs d
      LEFT JOIN code_nodes n ON n.project_id = d.project_id AND n.generation = d.generation AND n.node_id = d.node_id
      WHERE d.project_id = ? AND d.node_id IS NOT NULL AND n.node_id IS NULL
    `);
    const orphanVectors = one(`
      SELECT COUNT(*) AS n FROM code_vectors v
      LEFT JOIN code_nodes n ON n.project_id = v.project_id AND n.generation = v.generation AND n.node_id = v.node_id
      WHERE v.project_id = ? AND v.node_id IS NOT NULL AND n.node_id IS NULL
    `);
    const unfinishedGenerations = one(`
      SELECT COUNT(*) AS n FROM code_generation
      WHERE project_id = ? AND status IN ('pending', 'building')
    `);
    const issues: string[] = [];
    if (danglingEdges > 0) issues.push(`悬空边 ${String(danglingEdges)} 条`);
    if (orphanDocs > 0) issues.push(`孤儿文档 ${String(orphanDocs)} 条`);
    if (orphanVectors > 0) issues.push(`孤儿向量 ${String(orphanVectors)} 条`);
    if (unfinishedGenerations > 0) issues.push(`未完成 generation ${String(unfinishedGenerations)} 个`);
    return {
      generation: this.currentGeneration(projectId),
      danglingEdges,
      orphanDocs,
      orphanVectors,
      unfinishedGenerations,
      issues
    };
  }

  private toNode(row: Record<string, unknown>): CodeNode {
    return {
      projectId: String(row.project_id),
      nodeId: String(row.node_id),
      nodeType: String(row.node_type) as CodeNode['nodeType'],
      name: String(row.name),
      qualifiedName: String(row.qualified_name),
      filePath: String(row.file_path),
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      language: String(row.language),
      generation: Number(row.generation),
      ...(typeof row.symbol_id === 'string' ? { symbolId: row.symbol_id } : {}),
      ...(typeof row.symbol_status === 'string' ? { symbolStatus: row.symbol_status as CodeNode['symbolStatus'] } : {}),
      ...(typeof row.module_id === 'string' ? { moduleId: row.module_id } : {}),
      ...(typeof row.signature === 'string' ? { signature: row.signature } : {})
    };
  }

  private toEdge(row: Record<string, unknown>): CodeEdge {
    return {
      projectId: String(row.project_id),
      edgeId: String(row.edge_id),
      sourceNodeId: String(row.source_node_id),
      targetNodeId: String(row.target_node_id),
      relationType: String(row.relation_type) as CodeEdge['relationType'],
      confidence: String(row.confidence) as EdgeConfidence,
      source: String(row.source) as EdgeSource,
      ...(typeof row.file_path === 'string' ? { filePath: row.file_path } : {}),
      ...(typeof row.line === 'number' ? { line: row.line } : {}),
      generation: Number(row.generation),
      ...(typeof row.resolution_status === 'string'
        ? { resolutionStatus: row.resolution_status as CodeEdge['resolutionStatus'] }
        : {}),
      ...(typeof row.call_site_id === 'string' ? { callSiteId: row.call_site_id } : {})
    };
  }

  // --- full text ----------------------------------------------------------

  search(projectId: string, query: string, options: { limit?: number; filePatterns?: string[] } = {}): SearchHit[] {
    const generation = this.currentGeneration(projectId);
    if (generation === null) return [];
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const patterns = options.filePatterns ?? [];
    const likeFilter = patterns.length > 0
      ? ` AND (${patterns.map(() => 'file_path LIKE ?').join(' OR ')})`
      : '';
    const likeValues = patterns.map(pattern => `%${pattern.replace(/%/g, '\\%')}%`);

    // ≥3 字符的子串走 trigram；1–2 字符（尤其中文）走 LIKE 回退。
    const minLength = [...query.trim()].length;
    if (minLength >= 3) {
      const fts = buildFtsQuery(query);
      if (fts) {
        try {
          const rows = this.db.prepare(`
            SELECT f.doc_id, f.file_path, f.name, f.content
            FROM code_fts f
            JOIN code_search_docs d
              ON d.project_id = f.project_id AND d.doc_id = f.doc_id AND d.generation = ?
            WHERE code_fts MATCH ? AND f.project_id = ?${likeFilter}
            ORDER BY rank
            LIMIT ?
          `).all(generation, fts, projectId, ...likeValues, limit) as Record<string, unknown>[];
          if (rows.length > 0) {
            return rows.map((row, index) => ({
              docId: String(row.doc_id),
              filePath: String(row.file_path),
              name: String(row.name),
              content: String(row.content),
              source: 'fts' as const,
              score: 1 - index / Math.max(rows.length, 1)
            }));
          }
        } catch {
          // FTS 查询语法失败时走 LIKE，不让搜索整个失败。
        }
      }
    }

    const rows = this.db.prepare(`
      SELECT doc_id, file_path, node_id, name, content
      FROM code_search_docs
      WHERE project_id = ? AND (name LIKE ? OR content LIKE ?)${likeFilter}
      ORDER BY file_path, name
      LIMIT ?
    `).all(projectId, `%${query}%`, `%${query}%`, ...likeValues, limit) as Record<string, unknown>[];
    return rows.map((row, index) => ({
      docId: String(row.doc_id),
      filePath: String(row.file_path),
      ...(typeof row.node_id === 'string' ? { nodeId: row.node_id } : {}),
      name: String(row.name),
      content: String(row.content),
      source: 'like' as const,
      score: 1 - index / Math.max(rows.length, 1)
    }));
  }

  // --- memory -------------------------------------------------------------

  upsertMemory(fact: MemoryFact): void {
    this.db.prepare(`
      INSERT INTO code_memory_facts
        (project_id, fact_id, kind, title, content, source, source_ref, status, confidence,
         valid_from, valid_to, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, fact_id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, content = excluded.content,
        source = excluded.source, source_ref = excluded.source_ref, status = excluded.status,
        confidence = excluded.confidence, valid_from = excluded.valid_from,
        valid_to = excluded.valid_to, updated_at = excluded.updated_at
    `).run(
      fact.projectId, fact.factId, fact.kind, fact.title, fact.content, fact.source,
      fact.sourceRef ?? null, fact.status, fact.confidence,
      fact.validFrom ?? null, fact.validTo ?? null, fact.createdAt, fact.updatedAt
    );
  }

  getMemory(projectId: string, factId: string): MemoryFact | null {
    const row = this.db.prepare('SELECT * FROM code_memory_facts WHERE project_id = ? AND fact_id = ?')
      .get(projectId, factId) as Record<string, unknown> | undefined;
    return row ? this.toMemory(row) : null;
  }

  searchMemory(projectId: string, query: string, limit = 20): MemoryFact[] {
    const rows = this.db.prepare(`
      SELECT * FROM code_memory_facts
      WHERE project_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
               updated_at DESC
      LIMIT ?
    `).all(projectId, `%${query}%`, `%${query}%`, limit) as Record<string, unknown>[];
    return rows.map(row => this.toMemory(row));
  }

  listMemory(projectId: string, status?: MemoryStatus, limit = 100): MemoryFact[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM code_memory_facts WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?')
          .all(projectId, status, limit) as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM code_memory_facts WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?')
          .all(projectId, limit) as Record<string, unknown>[];
    return rows.map(row => this.toMemory(row));
  }

  private toMemory(row: Record<string, unknown>): MemoryFact {
    return {
      projectId: String(row.project_id),
      factId: String(row.fact_id),
      kind: String(row.kind) as MemoryFact['kind'],
      title: String(row.title),
      content: String(row.content),
      source: String(row.source),
      ...(typeof row.source_ref === 'string' ? { sourceRef: row.source_ref } : {}),
      status: String(row.status) as MemoryStatus,
      confidence: Number(row.confidence),
      ...(typeof row.valid_from === 'number' ? { validFrom: row.valid_from } : {}),
      ...(typeof row.valid_to === 'number' ? { validTo: row.valid_to } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  // --- code-memory link ---------------------------------------------------

  upsertLink(link: CodeMemoryLink): void {
    this.db.prepare(`
      INSERT INTO code_memory_link
        (id, project_id, symbol_key, symbol_locator, symbol_fingerprint, memory_entity_id,
         link_type, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, symbol_key, memory_entity_id) DO UPDATE SET
        symbol_locator = excluded.symbol_locator,
        symbol_fingerprint = excluded.symbol_fingerprint,
        link_type = excluded.link_type,
        confidence = excluded.confidence,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      link.id, link.projectId, link.symbolKey, link.symbolLocator, link.symbolFingerprint,
      link.memoryEntityId, link.linkType, link.confidence, link.status,
      link.createdAt, link.updatedAt
    );
  }

  linksForMemory(projectId: string, memoryEntityId: string): CodeMemoryLink[] {
    const rows = this.db.prepare(`
      SELECT * FROM code_memory_link WHERE project_id = ? AND memory_entity_id = ?
    `).all(projectId, memoryEntityId) as Record<string, unknown>[];
    return rows.map(row => this.toLink(row));
  }

  linksForSymbol(projectId: string, symbolKey: string): CodeMemoryLink[] {
    const rows = this.db.prepare(`
      SELECT * FROM code_memory_link WHERE project_id = ? AND symbol_key = ?
    `).all(projectId, symbolKey) as Record<string, unknown>[];
    return rows.map(row => this.toLink(row));
  }

  setLinkStatus(projectId: string, id: string, status: LinkStatus): void {
    this.db.prepare('UPDATE code_memory_link SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?')
      .run(status, now(), projectId, id);
  }

  private toLink(row: Record<string, unknown>): CodeMemoryLink {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      symbolKey: String(row.symbol_key),
      symbolLocator: String(row.symbol_locator),
      symbolFingerprint: String(row.symbol_fingerprint),
      memoryEntityId: String(row.memory_entity_id),
      linkType: String(row.link_type),
      confidence: Number(row.confidence),
      status: String(row.status) as LinkStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }
}

/** 把用户查询变成 FTS5 的安全 phrase；失败时由调用方回退 LIKE。 */
export function buildFtsQuery(raw: string): string | null {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/["']/g, '').trim())
    .filter(token => token.length > 0);
  if (tokens.length === 0) return null;
  // 每个 token 用双引号包住；这里已经去掉了双引号，避免注入 MATCH 语法。
  return tokens.map(token => `"${token}"`).join(' AND ');
}

/** 稳定 node/edge id：不含行号，行号变化不影响同一符号的身份。 */
export function codeNodeId(projectId: string, language: string, filePath: string, qualifiedName: string, kind: string): string {
  return `n_${hash(`${projectId}|${language}|${filePath}|${qualifiedName}|${kind}`)}`;
}

export function codeEdgeId(projectId: string, source: string, target: string, relation: string): string {
  return `e_${hash(`${projectId}|${source}|${target}|${relation}`)}`;
}
