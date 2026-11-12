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
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CodeIndexStore } from './store';
import { indexProject, scanSourceFiles, type IndexProjectOptions, type IndexProjectResult } from './indexer';
import {
  assembleContext,
  linkSymbolToMemory,
  remember,
  retrieve,
  routeMode,
  type KnowledgeMode,
  type LinkInput,
  type RememberInput
} from './retrieval';
import type { RetrievalItem, RetrievalResult } from './types';
import type { CgcAdapter, GraphitiAdapter } from './external';

function projectIdFor(root: string): string {
  return `p_${createHash('sha256').update(root).digest('hex').slice(0, 24)}`;
}

function cosine(a: readonly number[], b: Float32Array | readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface CodeIndexSummary {
  projectId: string;
  generation: number | null;
  files: number;
  nodes: number;
  edges: number;
  docs: number;
  vectors: number;
}

export interface CodeIndexEmbedder {
  embed(texts: string[]): Promise<{ model: string; vectors: number[][] }>;
}

export interface CodeIndexServiceDeps {
  /** 可选：本地 Ollama / 云端 embedding；不给就只做图 + FTS。 */
  embedder?: CodeIndexEmbedder;
  /** 可选：CGC / Graphiti 的外部只读 Adapter；失败只降级。 */
  external?: { cgc?: CgcAdapter; graphiti?: GraphitiAdapter };
}

export class CodeIndexService {
  private readonly store: CodeIndexStore;
  private readonly indexing = new Map<string, Promise<IndexProjectResult>>();
  private readonly watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>();

  private external: CodeIndexServiceDeps['external'];

  constructor(dbFile: string, private readonly deps: CodeIndexServiceDeps = {}) {
    this.store = new CodeIndexStore(dbFile);
    this.external = deps.external;
  }

  /** 设置页切换外部服务后热更新，不需要重启应用。 */
  setExternal(external: CodeIndexServiceDeps['external']): void {
    this.external = external;
  }

  close(): void {
    for (const entry of this.watchers.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.close();
    }
    this.watchers.clear();
    this.store.close();
  }

  /** 文件变化后自动重建索引；只监听源码扩展名，忽略 node_modules/out/.git。 */
  watch(rootInput: string): boolean {
    const root = rootInput;
    if (this.watchers.has(root)) return true;
    try {
      const entry = { watcher: watch(root, { recursive: true }, (_event, filename) => {
        const rel = String(filename ?? '');
        if (!rel || /(^|\/)(node_modules|out|out-test|dist|build|\.git)(\/|$)/.test(rel)) return;
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|java)$/i.test(rel)) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void this.index(root).catch(() => undefined);
        }, 700);
      }), timer: null as NodeJS.Timeout | null };
      this.watchers.set(root, entry);
      return true;
    } catch {
      return false;
    }
  }

  unwatch(rootInput: string): void {
    const entry = this.watchers.get(rootInput);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    this.watchers.delete(rootInput);
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

  /** 编辑/新增/删除文件后，下一次检索前用轻量 stat 扫描判断是否要重建。 */
  async ensureFresh(rootInput: string): Promise<void> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    if (this.store.currentGeneration(projectId) === null) {
      await this.index(root);
      return;
    }
    const previous = new Map(this.store.listFiles(projectId).map(file => [file.filePath, file]));
    const current = await scanSourceFiles(root, { maxFiles: 1000 });
    if (current.length !== previous.size) {
      await this.index(root);
      return;
    }
    for (const file of current) {
      const old = previous.get(file.rel);
      if (!old) {
        await this.index(root);
        return;
      }
      if (old.size !== file.size || Math.abs(old.mtimeMs - file.mtimeMs) > 1) {
        await this.index(root);
        return;
      }
    }
  }

  async summary(rootInput: string): Promise<CodeIndexSummary> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const counts = this.store.count(projectId);
    return {
      projectId,
      generation: this.store.currentGeneration(projectId),
      ...counts,
      vectors: this.store.countVectors(projectId)
    };
  }

  /** 为文件/符号文档建向量；分批调用 embedding provider，失败不落半成品。 */
  async buildVectors(rootInput: string, maxDocs = 500): Promise<{ count: number; model: string }> {
    if (!this.deps.embedder) throw new Error('EMBEDDING_UNAVAILABLE：没有配置 embedding provider');
    const root = await fs.realpath(rootInput);
    await this.ensureFresh(root);
    const projectId = projectIdFor(root);
    const docs = this.store.listDocs(projectId, maxDocs);
    if (docs.length === 0) throw new Error('没有可建向量的文档；先建立代码索引');

    const items: Array<{
      chunkId: string;
      docId: string;
      filePath: string;
      nodeId?: string;
      contentHash: string;
      model: string;
      vector: number[];
      content: string;
    }> = [];
    let model = '';
    for (let offset = 0; offset < docs.length; offset += 32) {
      const batch = docs.slice(offset, offset + 32);
      const texts = batch.map(doc => `${doc.name}\n${doc.content}`.slice(0, 4000));
      const embedded = await this.deps.embedder.embed(texts);
      model = embedded.model;
      if (embedded.vectors.length !== batch.length) throw new Error('embedding 返回数量与输入不一致');
      batch.forEach((doc, index) => {
        const content = texts[index];
        items.push({
          chunkId: `v_${createHash('sha256').update(`${projectId}|${doc.docId}|${embedded.model}`).digest('hex').slice(0, 24)}`,
          docId: doc.docId,
          filePath: doc.filePath,
          ...(doc.nodeId ? { nodeId: doc.nodeId } : {}),
          contentHash: createHash('sha256').update(content).digest('hex'),
          model: embedded.model,
          vector: embedded.vectors[index],
          content
        });
      });
    }
    this.store.replaceVectors(projectId, items);
    return { count: items.length, model };
  }

  async retrieve(
    rootInput: string,
    query: string,
    options: { mode?: KnowledgeMode; limit?: number } = {}
  ): Promise<RetrievalResult> {
    const root = await fs.realpath(rootInput);
    await this.ensureFresh(root);
    const projectId = projectIdFor(root);
    const result = retrieve(this.store, projectId, query, options);
    const mode = routeMode(query, options.mode);
    if ((options.mode === undefined || options.mode === 'CODE' || options.mode === 'HYBRID') &&
        this.deps.embedder && this.store.countVectors(projectId) > 0) {
      try {
        const queryVector = (await this.deps.embedder.embed([query])).vectors[0] ?? [];
        if (queryVector.length > 0) {
          const limit = Math.min(Math.max(options.limit ?? 12, 1), 50);
          const scored = this.store.listVectors(projectId, 5000)
            .map(item => ({ item, score: cosine(queryVector, item.vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .filter(entry => entry.score > 0.2);
          const extra: RetrievalItem[] = scored.map(({ item, score }) => ({
            kind: 'code' as const,
            id: item.docId,
            title: item.content.split('\n')[0] || item.docId,
            content: item.content,
            source: 'Vector',
            confidence: Math.max(0.3, Math.min(0.95, score)),
            filePath: item.filePath
          }));
          if (extra.length > 0) {
            result.items.push(...extra);
            result.sources.vector = true;
          }
        }
      } catch (error) {
        result.warnings.push(`向量检索不可用：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 可选外部通道：CGC 代码图 / Graphiti 工程记忆；失败只记警告。
    if (mode === 'CODE' || mode === 'HYBRID') {
      const cgc = this.external?.cgc;
      if (cgc) {
        try {
          const hits = await cgc.search(query, Math.min(options.limit ?? 8, 20));
          if (hits.length > 0) result.sources.graph = true;
          for (const hit of hits) {
            result.items.push({
              kind: 'code',
              id: `cgc:${hit.path ?? ''}:${hit.title}`,
              title: hit.title,
              content: hit.content,
              source: 'CGC',
              confidence: hit.confidence,
              ...(hit.path ? { filePath: hit.path } : {}),
              ...(hit.line ? { line: hit.line } : {})
            });
          }
        } catch (error) {
          result.warnings.push(`CGC 不可用：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (mode === 'MEMORY' || mode === 'HYBRID') {
      const graphiti = this.external?.graphiti;
      if (graphiti) {
        try {
          const hits = await graphiti.search(query, Math.min(options.limit ?? 8, 20));
          if (hits.length > 0) result.sources.memory = true;
          for (const hit of hits) {
            result.items.push({
              kind: 'memory',
              id: `graphiti:${hit.title}`,
              title: hit.title,
              content: hit.content,
              source: 'Graphiti',
              confidence: hit.confidence
            });
          }
        } catch (error) {
          result.warnings.push(`Graphiti 不可用：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (result.items.length > 0) {
      result.warnings = result.warnings.filter(warning => !warning.startsWith('没有检索到'));
    }
    return result;
  }

  async context(
    rootInput: string,
    query: string,
    budgetChars = 6000
  ): Promise<{
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
    await this.ensureFresh(root);
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

  async memories(rootInput: string, limit = 50): Promise<ReturnType<CodeIndexStore['listMemory']>> {
    const root = await fs.realpath(rootInput);
    return this.store.listMemory(projectIdFor(root), undefined, limit);
  }

  async linkMemory(
    rootInput: string,
    input: { filePath: string; line: number; memoryEntityId: string; linkType?: string }
  ): Promise<ReturnType<typeof linkSymbolToMemory>> {
    const root = await fs.realpath(rootInput);
    await this.ensureFresh(root);
    const projectId = projectIdFor(root);
    const node = this.store.nodeAt(projectId, input.filePath, input.line);
    if (!node) throw new Error(`这条结果没有对应的代码符号：${input.filePath}:${String(input.line)}`);
    return linkSymbolToMemory(this.store, {
      projectId,
      language: node.language,
      filePath: node.filePath,
      qualifiedName: node.qualifiedName,
      kind: node.nodeType,
      startLine: node.startLine,
      endLine: node.endLine,
      fingerprint: `${node.nodeType}:${node.qualifiedName}`,
      memoryEntityId: input.memoryEntityId,
      linkType: input.linkType ?? 'HISTORY_EXPLAINS_CODE',
      confidence: 0.9
    });
  }

  async links(rootInput: string, symbolKey: string): Promise<ReturnType<CodeIndexStore['linksForSymbol']>> {
    const root = await fs.realpath(rootInput);
    return this.store.linksForSymbol(projectIdFor(root), symbolKey);
  }

}
