/**
 * 上下文构建：把召回结果变成一段 system 文本，并算出 **L1** 指纹。
 *
 * 这一层不知道 Provider 存在（`GLOBAL_MEMORY.md` §1.1 第 3 条）：它只产出
 * 文本与指纹。L2 在调用点算、L3 在适配器算，三处互不引用。
 */

import {
  MEMORY_POLICY_VERSION,
  contextHashOf,
  memoryOverrideLine,
  renderMemoryBlock,
  type MemoryContext,
  type MemoryRecord
} from '../../shared/memory';
import type { OmittedMemory } from './types';

export interface BuildContextInput {
  requestId: string;
  conversationId: string;
  workspaceId?: string;
  projectId?: string;
  records: readonly MemoryRecord[];
  omitted: readonly OmittedMemory[];
  budgetChars: number;
  maxRecords: number;
  injectionPoint: string;
}

/**
 * 预算按字符算，**上限不是目标**：装不下就少放，不做"凑满 1200 字"。
 * 被裁掉的进 `omitted(budget)`，界面要能显示"因为预算没注进去"。
 */
export function buildMemoryContext(input: BuildContextInput): MemoryContext {
  const capped = input.records.slice(0, Math.max(0, input.maxRecords));
  const rendered = renderMemoryBlock(capped, { maxChars: input.budgetChars });
  const includedIds = rendered.includedIds;
  const includedSet = new Set(includedIds);
  // 一条都没进（预算为 0 或全被裁）也算 budget；不是"没召回"。
  const budgetOmitted: OmittedMemory[] = input.records
    .filter(record => !includedSet.has(record.memoryId))
    .map(record => ({ memoryId: record.memoryId, reason: 'budget' as const }));
  const omitted = [...input.omitted, ...budgetOmitted].filter(
    (item, index, all) => all.findIndex(other => other.memoryId === item.memoryId) === index
  );

  return {
    requestId: input.requestId,
    conversationId: input.conversationId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    includedMemoryIds: includedIds,
    omittedMemoryIds: omitted.map(item => item.memoryId),
    renderedText: rendered.text,
    tokenOrCharBudget: input.budgetChars,
    contextHash: contextHashOf(rendered.text),
    policyVersion: MEMORY_POLICY_VERSION
  };
}

/**
 * 只把记忆追加到 `system`，`question` 一个字节都不动。
 *
 * `overrideLine` 用于工程/辩论：那边的 system 写着"只依据这些证据回答"，
 * 记忆一注入就会被合法忽略，所以要补一句"记忆不是证据"。
 */
export function attachSystemText(
  system: readonly string[] | undefined,
  renderedText: string,
  options: { overrideLine?: boolean } = {}
): string[] {
  const base = [...(system ?? [])].filter(part => part.trim().length > 0);
  if (!renderedText.trim()) return base;
  // 覆盖句必须在记忆块**之前**：记忆块固定是最后一段，`memoryBlockFromSystem`
  // 才能从「前缀到段末」原样抽回它，L1/L2/L3 才可能是同一个对象。
  const next = options.overrideLine ? [...base, memoryOverrideLine()] : [...base];
  next.push(renderedText);
  return next;
}
