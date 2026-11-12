/**
 * 可选外部适配器：CGC（代码图）与 Graphiti（工程记忆）。
 *
 * 只读、只走 Neo4j HTTP 事务端点。没有配置 URL 时不启用；启用后请求失败
 * 只返回空结果 + 警告，不影响本地 SQLite/FTS/Vector 回退。
 */

import type { Neo4jHttpClient } from './neo4j-http';

export interface ExternalHit {
  source: 'CGC' | 'Graphiti';
  title: string;
  content: string;
  confidence: number;
  path?: string;
  line?: number;
}

export class CgcAdapter {
  constructor(private readonly client: Neo4jHttpClient) {}

  async search(query: string, limit = 10): Promise<ExternalHit[]> {
    const rows = await this.client.query<Record<string, unknown>>(
      `MATCH (n)
       WHERE (n:Function OR n:Class OR n:Interface OR n:File OR n:Method)
         AND toLower(coalesce(n.name, '')) CONTAINS toLower($query)
       RETURN labels(n)[0] AS kind, n.name AS name, n.path AS path
       LIMIT $limit`,
      { query, limit }
    );
    return rows.map(row => ({
      source: 'CGC' as const,
      title: String(row.c1 ?? ''),
      content: `${String(row.c0 ?? '')} ${String(row.c2 ?? '')}`.trim(),
      confidence: 0.9,
      path: String(row.c2 ?? '')
    }));
  }

  async callers(name: string, limit = 20): Promise<ExternalHit[]> {
    const rows = await this.client.query<Record<string, unknown>>(
      `MATCH (caller)-[r:CALLS|HEURISTIC_CALLS]->(fn)
       WHERE fn.name = $name
       RETURN caller.name AS caller, caller.path AS path, type(r) AS relation
       LIMIT $limit`,
      { name, limit }
    );
    return rows.map(row => ({
      source: 'CGC' as const,
      title: String(row.c0 ?? ''),
      content: `${String(row.c2 ?? 'CALLS')} -> ${name} (${String(row.c1 ?? '')})`,
      confidence: row.c2 === 'CALLS' ? 0.95 : 0.6,
      path: String(row.c1 ?? '')
    }));
  }
}

export class GraphitiAdapter {
  constructor(private readonly client: Neo4jHttpClient) {}

  async search(query: string, limit = 10): Promise<ExternalHit[]> {
    const rows = await this.client.query<Record<string, unknown>>(
      `CALL db.index.fulltext.queryRelationships('edge_name_and_fact', $query, {limit: $limit})
       YIELD relationship AS rel, score
       MATCH (a)-[rel]->(b)
       RETURN rel.fact AS fact, rel.valid_at AS validAt, a.name AS source, b.name AS target, score
       LIMIT $limit`,
      { query, limit }
    );
    return rows.map(row => ({
      source: 'Graphiti' as const,
      title: `${String(row.c2 ?? '')} → ${String(row.c3 ?? '')}`,
      content: String(row.c0 ?? ''),
      confidence: Math.min(0.95, Math.max(0.4, Number(row.c4 ?? 0.6))),
    }));
  }
}
