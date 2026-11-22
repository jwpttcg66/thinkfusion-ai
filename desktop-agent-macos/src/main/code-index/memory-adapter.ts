/**
 * CodeIndex 的 `MemoryFact` 视图 ↔ 全局记忆的 `MemoryRecord` 之间的**唯一**映射出口。
 *
 * 为什么要有这一层：`CodeIndexPanel` 与 `code-index:remember/list-memories`
 * 的返回形状是旧的 `MemoryFact`（`factId` / `status: confirmed` / `kind: issue`），
 * 而真实存储在 `memory.sqlite`（`memoryId` / `active` / `open_question`）。
 * 如果让 IPC、UI、测试各写一份映射，三处一定会漂移；所以只允许这里的两个函数
 * 做转换，别处不许再写 if/switch。
 *
 * 旧表 `code_memory_facts` 不再被业务写入，只作为迁移来源与只读历史。
 */

import type { MemoryKind, MemoryRecord, MemoryStatus as MemoryRecordStatus } from '../../shared/memory';
import type { MemoryFact, MemoryStatus } from './types';

/** 旧 kind → 新 kind（`debate` 额外打 tag，因为新枚举里没有单独的 debate）。 */
const KIND_TO_RECORD: Record<MemoryFact['kind'], { kind: MemoryKind; tag?: string }> = {
  fact: { kind: 'fact' },
  decision: { kind: 'decision' },
  constraint: { kind: 'constraint' },
  issue: { kind: 'open_question' },
  solution: { kind: 'problem_solution' },
  debate: { kind: 'decision', tag: 'debate' }
};

/** 新 kind → 旧 kind。`preference` / `procedure` 在旧枚举里只能落到 `fact`。 */
export function kindToFactKind(record: Pick<MemoryRecord, 'kind' | 'tags'>): MemoryFact['kind'] {
  if (record.kind === 'open_question') return 'issue';
  if (record.kind === 'problem_solution') return 'solution';
  if (record.kind === 'decision' && record.tags.includes('debate')) return 'debate';
  if (record.kind === 'decision') return 'decision';
  if (record.kind === 'constraint') return 'constraint';
  return 'fact';
}

export function kindToRecordKind(kind: MemoryFact['kind']): { kind: MemoryKind; tag?: string } {
  return KIND_TO_RECORD[kind] ?? { kind: 'fact' };
}

/** 旧状态 → 新状态。 */
export function statusToRecordStatus(status: MemoryStatus | undefined): MemoryRecordStatus {
  if (status === 'confirmed') return 'active';
  if (status === 'deprecated') return 'archived';
  return 'candidate';
}

/** 新状态 → 旧状态。非 active/candidate 一律显示 deprecated（旧枚举没有更细的状态）。 */
export function statusToFactStatus(status: MemoryRecordStatus): MemoryStatus {
  if (status === 'active') return 'confirmed';
  if (status === 'candidate') return 'candidate';
  return 'deprecated';
}

/**
 * `MemoryRecord` → `MemoryFact`。
 *
 * `source` / `sourceRef` 从 `sourceRefs` 顺序还原：写入时是 `[source, sourceRef?]`，
 * 迁移时是旧库的 `[source, source_ref?]`，两边顺序一致，所以这里不需要额外标记。
 */
export function memoryRecordToFact(record: MemoryRecord): MemoryFact {
  const [source, sourceRef] = record.sourceRefs;
  return {
    projectId: record.scopeId,
    factId: record.memoryId,
    kind: kindToFactKind(record),
    title: record.title,
    content: record.content,
    source: source ?? 'memory',
    ...(sourceRef ? { sourceRef } : {}),
    status: statusToFactStatus(record.status),
    confidence: record.confidence,
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.expiresAt === undefined ? {} : { validTo: record.expiresAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export interface FactWriteInput {
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

/** `MemoryFact` 写入入参 → 新记录入参（`scope`/`scopeId` 由调用方补）。 */
export function factInputToRecordInput(input: FactWriteInput): {
  kind: MemoryKind;
  title: string;
  content: string;
  sourceRefs: string[];
  status: MemoryRecordStatus;
  confidence: number;
  tags: string[];
  validFrom?: number;
  expiresAt?: number;
} {
  if (!input.source.trim()) throw new Error('MEMORY_SOURCE_REQUIRED：记忆必须带来源');
  const mapped = kindToRecordKind(input.kind);
  const sourceRefs = [input.source.trim(), input.sourceRef?.trim() ?? ''].filter(Boolean);
  return {
    kind: mapped.kind,
    title: input.title,
    content: input.content,
    sourceRefs,
    status: statusToRecordStatus(input.status),
    confidence: Math.min(Math.max(input.confidence ?? (input.status === 'confirmed' ? 0.9 : 0.5), 0), 1),
    tags: mapped.tag ? [mapped.tag] : [],
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { expiresAt: input.validTo })
  };
}
