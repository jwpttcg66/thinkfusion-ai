/**
 * 工程智能服务：把本地 CodeIndexStore 包成主进程可调用的门面。
 *
 * 当前只做本地回退核（AST + SQLite + FTS5 + Project Memory + Link）；
 * CGC / Graphiti / Neo4j / VectorStore 没有运行环境时保持不可用，不冒充。
 *
 * 每个工作区一个 projectId（真实路径的 hash），同一个 DB 里按 project_id
 * 隔离，查询不会跨工程。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodeIndexStore } from './store';
import { indexProject, type IndexProjectOptions, type IndexProjectResult } from './indexer';
import {
  assembleContext,
  linkSymbolToMemory,
  remember,
  retrieve,
  type KnowledgeMode,
  type LinkInput,
  type RememberInput
} from './retrieval';
import type { RetrievalResult } from './types';

function projectIdFor(root: string): string {
  return `p_${createHash('sha256').update(root).digest('hex').slice(0, 24)}`;
}

export interface CodeIndexSummary {
  projectId: string;
  generation: number | null;
  files: number;
  nodes: number;
  edges: number;
  docs: number;
}

export class CodeIndexService {
  private readonly store: CodeIndexStore;
  private readonly indexing = new Map<string, Promise<IndexProjectResult>>();

  constructor(dbFile: string) {
    this.store = new CodeIndexStore(dbFile);
  }

  close(): void {
    this.store.close();
  }

  async projectId(root: string): Promise<string> {
    return projectIdFor(await fs.realpath(root));
  }

  /** 同一工程并发调用时只跑一份索引；后来者等同一份结果。 */
  async index(rootInput: string, options: IndexProjectOptions = {}): Promise<IndexProjectResult> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const running = this.indexing.get(projectId);
    if (running) return running;
    const task = indexProject(this.store, root, projectId, options).finally(() => {
      this.indexing.delete(projectId);
    });
    this.indexing.set(projectId, task);
    return task;
  }

  async summary(rootInput: string): Promise<CodeIndexSummary> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const counts = this.store.count(projectId);
    return {
      projectId,
      generation: this.store.currentGeneration(projectId),
      ...counts
    };
  }

  async retrieve(
    rootInput: string,
    query: string,
    options: { mode?: KnowledgeMode; limit?: number } = {}
  ): Promise<RetrievalResult> {
    const root = await fs.realpath(rootInput);
    return retrieve(this.store, projectIdFor(root), query, options);
  }

  async context(rootInput: string, query: string, budgetChars = 6000): Promise<{
    text: string;
    used: number;
    omitted: number;
    stale: boolean;
    warnings: string[];
  }> {
    const result = await this.retrieve(rootInput, query);
    const assembled = assembleContext(result, budgetChars);
    return {
      text: assembled.text,
      used: assembled.used.length,
      omitted: assembled.omitted,
      stale: result.stale,
      warnings: result.warnings
    };
  }

  async impact(rootInput: string, filePath: string, line: number, depth = 3): Promise<{
    node: string | null;
    nodes: number;
    edges: number;
    names: string[];
    files: string[];
  }> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const node = this.store.nodeAt(projectId, filePath, line);
    if (!node) return { node: null, nodes: 0, edges: 0, names: [], files: [] };
    const impact = this.store.impact(projectId, node.nodeId, depth);
    return {
      node: node.qualifiedName,
      nodes: impact.nodes.length,
      edges: impact.edges.length,
      names: impact.nodes.map(item => item.qualifiedName),
      files: [...new Set(impact.nodes.map(item => item.filePath).filter(Boolean))]
    };
  }

  async remember(rootInput: string, input: Omit<RememberInput, 'projectId'>): Promise<ReturnType<typeof remember>> {
    const root = await fs.realpath(rootInput);
    return remember(this.store, { ...input, projectId: projectIdFor(root) });
  }

  async link(rootInput: string, input: Omit<LinkInput, 'projectId'>): Promise<ReturnType<typeof linkSymbolToMemory>> {
    const root = await fs.realpath(rootInput);
    return linkSymbolToMemory(this.store, { ...input, projectId: projectIdFor(root) });
  }

  async memory(rootInput: string, query: string, limit = 20): Promise<ReturnType<CodeIndexStore['searchMemory']>> {
    const root = await fs.realpath(rootInput);
    return this.store.searchMemory(projectIdFor(root), query, limit);
  }

  async links(rootInput: string, symbolKey: string): Promise<ReturnType<CodeIndexStore['linksForSymbol']>> {
    const root = await fs.realpath(rootInput);
    return this.store.linksForSymbol(projectIdFor(root), symbolKey);
  }

}
