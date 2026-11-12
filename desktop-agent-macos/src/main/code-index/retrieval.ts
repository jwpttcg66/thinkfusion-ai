/**
 * 统一检索与上下文组装（本地回退版）。
 *
 * 不依赖 KnowledgeRouter 的模型分类：先做可解释规则——
 * - 查询里出现「调用/引用/影响/定义/依赖」→ CODE；
 * - 出现「为什么/以前/决策/历史/约束」→ MEMORY；
 * - 两者都有 → HYBRID。
 *
 * 当前源码事实优先于历史记忆；候选记忆不能冒充已确认事实。
 */

import { createHash } from 'node:crypto';
import type { CodeIndexStore } from './store';
import type {
  CodeMemoryLink,
  MemoryFact,
  MemoryStatus,
  RetrievalItem,
  RetrievalResult
} from './types';

export type KnowledgeMode = 'CODE' | 'MEMORY' | 'HYBRID';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function routeMode(query: string, requested?: KnowledgeMode): KnowledgeMode {
  if (requested) return requested;
  const code = /调用|引用|影响|定义|依赖|实现|继承|符号|函数|类|文件|代码/.test(query);
  const memory = /为什么|以前|历史|决策|约束|规则|问题|方案|选型|原因/.test(query);
  if (code && memory) return 'HYBRID';
  if (memory) return 'MEMORY';
  return 'CODE';
}

function memoryItem(fact: MemoryFact): RetrievalItem {
  return {
    kind: 'memory',
    id: fact.factId,
    title: fact.title,
    content: fact.content,
    source: fact.source,
    status: fact.status,
    confidence: fact.confidence,
    ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
    ...(fact.validTo === undefined ? {} : { validTo: fact.validTo })
  };
}

export function retrieve(
  store: CodeIndexStore,
  projectId: string,
  query: string,
  options: { mode?: KnowledgeMode; limit?: number } = {}
): RetrievalResult {
  const mode = routeMode(query, options.mode);
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 50);
  const items: RetrievalItem[] = [];
  const warnings: string[] = [];
  const sources = { graph: false, fullText: false, memory: false };

  if (mode === 'CODE' || mode === 'HYBRID') {
    const hits = store.search(projectId, query, { limit });
    sources.fullText = hits.length > 0;
    for (const hit of hits) {
      items.push({
        kind: 'code',
        id: hit.docId,
        title: hit.name,
        content: hit.content,
        source: hit.source === 'fts' ? 'FTS5' : 'FTS5/LIKE',
        confidence: hit.source === 'fts' ? 0.9 : 0.6,
        filePath: hit.filePath
      });
    }
    for (const token of query.split(/\s+/).filter(Boolean).slice(0, 5)) {
      const symbols = store.findSymbols(projectId, token, 10);
      if (symbols.length > 0) sources.graph = true;
      for (const symbol of symbols) {
        items.push({
          kind: 'code',
          id: symbol.nodeId,
          title: symbol.qualifiedName,
          content: `${symbol.nodeType} ${symbol.filePath}:${String(symbol.startLine)}`,
          source: 'CodeGraph',
          confidence: 0.95,
          filePath: symbol.filePath,
          line: symbol.startLine
        });
      }
    }
  }

  if (mode === 'MEMORY' || mode === 'HYBRID') {
    const facts = store.searchMemory(projectId, query, limit);
    sources.memory = facts.length > 0;
    for (const fact of facts) {
      items.push(memoryItem(fact));
    }
  }

  if (items.length === 0) warnings.push('没有检索到可核对的结果；这不等于事实不存在。');
  const stale = store.currentGeneration(projectId) === null;
  if (stale) warnings.push('这个工程还没有 READY 代索引；结果可能只来自记忆或旧数据。');
  return { items, sources, warnings, stale };
}

/** 按预算组装上下文：代码事实优先，其次已确认记忆，最后候选记忆。 */
export function assembleContext(
  result: RetrievalResult,
  budgetChars = 6000
): { text: string; used: RetrievalItem[]; omitted: number } {
  const rank = (item: RetrievalItem) => {
    if (item.kind === 'code') return 0;
    return item.status === 'confirmed' ? 1 : 2;
  };
  const seen = new Set<string>();
  const sorted = [...result.items].sort((a, b) => rank(a) - rank(b) || b.confidence - a.confidence);
  const used: RetrievalItem[] = [];
  let chars = 0;
  for (const item of sorted) {
    const key = `${item.kind}|${item.filePath ?? ''}|${item.title}`;
    if (seen.has(key)) continue;
    const line = `[${item.kind === 'code' ? '代码' : '记忆'}] ${item.title} (${item.source}, ${item.confidence.toFixed(2)})\n${item.content}\n`;
    if (chars + line.length > budgetChars) continue;
    seen.add(key);
    used.push(item);
    chars += line.length;
  }
  const header = [
    `检索模式：${result.sources.memory && result.sources.graph ? 'HYBRID' : result.sources.memory ? 'MEMORY' : 'CODE'}`,
    `来源：${Object.entries(result.sources).filter(([, value]) => value).map(([key]) => key).join(' / ') || '无'}`,
    ...result.warnings.map(warning => `警告：${warning}`)
  ].join('\n');
  const body = used.map(item => `[${item.kind === 'code' ? '代码' : '记忆'}] ${item.title} (${item.source}, ${item.confidence.toFixed(2)})\n${item.content}`).join('\n\n');
  return { text: `${header}\n\n${body}`.trim(), used, omitted: result.items.length - used.length };
}

export interface RememberInput {
  projectId: string;
  kind: MemoryFact['kind'];
  title: string;
  content: string;
  source: string;
  sourceRef?: string;
  status?: MemoryStatus;
  confidence?: number;
  validFrom?: number;
  validTo?: number;
}

/** 写记忆：candidate 默认；confirmed 必须有来源，不能由模型空口升级。 */
export function remember(store: CodeIndexStore, input: RememberInput): MemoryFact {
  if (!input.source.trim()) throw new Error('MEMORY_SOURCE_REQUIRED：记忆必须带来源');
  const status = input.status ?? 'candidate';
  const fact: MemoryFact = {
    projectId: input.projectId,
    factId: `m_${hash(`${input.projectId}|${input.kind}|${input.title}|${input.sourceRef ?? input.source}`)}`,
    kind: input.kind,
    title: input.title,
    content: input.content,
    source: input.source,
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    status,
    confidence: Math.min(Math.max(input.confidence ?? (status === 'confirmed' ? 0.9 : 0.5), 0), 1),
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.upsertMemory(fact);
  return fact;
}

export interface LinkInput {
  projectId: string;
  language: string;
  filePath: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  fingerprint: string;
  memoryEntityId: string;
  linkType: string;
  confidence: number;
}

/** SymbolKey 不含文件路径；文件路径只进 Locator，移动文件不应换 Key。 */
export function linkSymbolToMemory(store: CodeIndexStore, input: LinkInput): CodeMemoryLink {
  const symbolKey = `${input.projectId}|${input.language}|${input.qualifiedName}|${input.kind}`;
  const link: CodeMemoryLink = {
    id: `l_${hash(`${symbolKey}|${input.memoryEntityId}|${input.linkType}`)}`,
    projectId: input.projectId,
    symbolKey,
    symbolLocator: JSON.stringify({
      filePath: input.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      language: input.language
    }),
    symbolFingerprint: input.fingerprint,
    memoryEntityId: input.memoryEntityId,
    linkType: input.linkType,
    confidence: Math.min(Math.max(input.confidence, 0), 1),
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.upsertLink(link);
  return link;
}
