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
import { projectIdFor } from '../../shared/project-id';
import { CodeIndexStore } from './store';
import { DEFAULT_MAX_FILES, indexProject, scanSourceFilesDetailed, type IndexProjectOptions, type IndexProjectResult } from './indexer';
import {
  assembleContext,
  linkSymbolToMemory,
  retrieve,
  routeMode,
  type KnowledgeMode,
  type LinkInput,
  type RememberInput
} from './retrieval';
import type { MemoryFact, RetrievalItem, RetrievalResult } from './types';
import { MemoryService } from '../memory/service';
import { factInputToRecordInput, memoryRecordToFact } from './memory-adapter';
import type { CgcAdapter, GraphitiAdapter } from './external';

// projectId 的算法只允许有一个实现：记忆库的 scopeId 与代码索引的 projectId
// 必须逐字相同，否则迁移后的链接解析不上（`shared/project-id.ts`）。

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
  /** PROJECT 范围的记忆条数（以 `memory.sqlite` 为准；旧表切换后恒为 0）。 */
  memory?: number;
}

export interface CodeIndexEmbedder {
  embed(texts: string[]): Promise<{ model: string; vectors: number[][] }>;
}

export interface CodeIndexServiceDeps {
  /** 可选：本地 Ollama / 云端 embedding；不给就只做图 + FTS。 */
  embedder?: CodeIndexEmbedder;
  /** 可选：CGC / Graphiti 的外部只读 Adapter；失败只降级。 */
  external?: { cgc?: CgcAdapter; graphiti?: GraphitiAdapter };
  /**
   * 全局记忆服务（主进程单例）。
   *
   * 不传时按同目录 `memory.sqlite` 惰性建一个，仅用于测试/独立使用；
   * 主进程必须传同一个单例，否则两个实例会各自持有一份 settings 并互相覆盖。
   */
  memory?: MemoryService;
}

export class CodeIndexService {
  private readonly store: CodeIndexStore;
  private readonly memoryService: MemoryService;
  /** 自己建的才由自己关；主进程传进来的单例由主进程关。 */
  private readonly ownsMemory: boolean;
  private readonly indexing = new Map<string, Promise<IndexProjectResult>>();
  private readonly watchers = new Map<string, { watcher: FSWatcher; timer: NodeJS.Timeout | null }>();

  private external: CodeIndexServiceDeps['external'];

  constructor(dbFile: string, private readonly deps: CodeIndexServiceDeps = {}) {
    this.store = new CodeIndexStore(dbFile);
    this.external = deps.external;
    if (deps.memory) {
      this.memoryService = deps.memory;
      this.ownsMemory = false;
    } else {
      // 独立使用（测试 / 单模块脚本）：同目录建一个，legacy 指向本索引库，
      // 迁移逻辑会顺手把旧 `code_memory_facts` 搬进来。
      // 按 db 文件名派生命中，不按目录：同目录可能有多个索引库（测试里就是），
      // 共用一份 `memory.sqlite` 会让它们互相看见对方的记忆。
      this.memoryService = new MemoryService({
        file: `${dbFile}.memory.sqlite`,
        legacyFile: dbFile,
        settingsFile: `${dbFile}.memory-settings.json`
      });
      this.ownsMemory = true;
    }
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
    if (this.ownsMemory) this.memoryService.close();
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
    // 与 indexProject 使用同一个上限；否则 500/1000 不一致会让大工程每次检索都重建。
    const scan = await scanSourceFilesDetailed(root, { maxFiles: DEFAULT_MAX_FILES });
    const current = scan.files;
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

  /** 当前 READY generation；没有索引时为 null。用于搜索任务固定快照。 */
  async generation(rootInput: string): Promise<number | null> {
    const root = await fs.realpath(rootInput);
    return this.store.currentGeneration(projectIdFor(root));
  }

  async summary(rootInput: string): Promise<CodeIndexSummary> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const counts = this.store.count(projectId);
    return {
      projectId,
      generation: this.store.currentGeneration(projectId),
      ...counts,
      // 旧表的 memory 计数在切换后恒为 0（不再写入），界面会以为「没有记忆」。
      // 记忆数以新库为准，这是 M3 里最容易漏的一处。
      memory: this.memoryService.listRecords({ scope: 'PROJECT', scopeId: projectId, limit: 1000 }).length,
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
    // MEMORY 分支的数据源换成新库；`retrieval.ts` 仍是纯函数，不 import 记忆服务。
    const result = retrieve(this.store, projectId, query, {
      ...options,
      memoryFacts: this.factsFor(projectId, query, Math.min(Math.max(options.limit ?? 12, 1), 50))
    });
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

  /**
   * 写记忆：路由到全局记忆库（`memory.sqlite`），**不再写** `code_memory_facts`。
   *
   * 返回形状仍是旧的 `MemoryFact`，所以 `CodeIndexPanel` 不用改；映射集中在
   * `memory-adapter.ts` 一处。记忆关闭时明确报错，不静默回落旧表——
   * 回落等于又变回两套写入。
   */
  async remember(rootInput: string, input: Omit<RememberInput, 'projectId'>): Promise<MemoryFact> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const recordInput = factInputToRecordInput({
      kind: input.kind,
      title: input.title,
      content: input.content,
      source: input.source,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validTo === undefined ? {} : { validTo: input.validTo })
    });
    const record = this.memoryService.remember({
      ...recordInput,
      scope: 'PROJECT',
      scopeId: projectId,
      projectRoot: root
    });
    if (!record) throw new Error('记忆已关闭或记忆库不可用：去「设置 · 全局记忆」里打开');
    return memoryRecordToFact(record);
  }

  /** 新库的 PROJECT 记忆 → 旧视图；`contains` 走结构化筛选，不用 LIKE。 */
  private factsFor(projectId: string, query: string | undefined, limit: number): MemoryFact[] {
    const records = this.memoryService.listRecords({
      scope: 'PROJECT',
      scopeId: projectId,
      ...(query && query.trim() ? { contains: query.trim() } : {}),
      limit
    });
    return records.map(memoryRecordToFact);
  }

  async link(rootInput: string, input: Omit<LinkInput, 'projectId'>): Promise<ReturnType<typeof linkSymbolToMemory>> {
    const root = await fs.realpath(rootInput);
    return linkSymbolToMemory(this.store, { ...input, projectId: projectIdFor(root) });
  }

  /** 删除工程的本地索引/记忆/关联/向量；外部 CGC 只在显式要求时按路径清。 */
  async deleteProject(rootInput: string, options: { external?: boolean } = {}): Promise<{
    local: ReturnType<CodeIndexStore['deleteProject']>;
    external: number;
    warnings: string[];
  }> {
    const root = await fs.realpath(rootInput);
    const projectId = projectIdFor(root);
    const local = this.store.deleteProject(projectId);
    let external = 0;
    const warnings: string[] = [];
    if (options.external && this.external?.cgc) {
      try {
        const prefix = process.env.THINKFUSION_CGC_PROJECT_PATH ?? root;
        external = await this.external.cgc.deleteByPath(prefix);
      } catch (error) {
        warnings.push(`CGC 清理失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.external && this.external?.graphiti) {
      warnings.push('Graphiti 外部数据未删除：当前未按 project group_id 建立映射，不能安全猜测删除范围');
    }
    return { local, external, warnings };
  }

  async memory(rootInput: string, query: string, limit = 20): Promise<MemoryFact[]> {
    const root = await fs.realpath(rootInput);
    return this.factsFor(projectIdFor(root), query, limit);
  }

  async memories(rootInput: string, limit = 50): Promise<MemoryFact[]> {
    const root = await fs.realpath(rootInput);
    return this.factsFor(projectIdFor(root), undefined, limit);
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
