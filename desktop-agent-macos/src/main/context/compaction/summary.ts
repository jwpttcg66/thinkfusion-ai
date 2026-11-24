/**
 * 结构化摘要校验（LT-P3-01）。
 *
 * 摘要可以包含模型判断，但“已完成/已验证”必须有事件依据；
 * 证据引用必须能在本轮 EvidenceRef 集合里找到。
 */

import { createHash } from 'node:crypto';
import type { ContextSummary } from '../../../shared/context';

export interface SummaryValidationContext {
  eventIds: ReadonlySet<string>;
  evidenceRefs: ReadonlySet<string>;
}

export interface SummaryValidationResult {
  ok: boolean;
  reasons: string[];
}

function missingEvents(eventIds: readonly string[], context: SummaryValidationContext): string[] {
  return eventIds.filter(id => !context.eventIds.has(id));
}

/**
 * 校验摘要。空 reasons 表示通过。
 *
 * 规则：
 * - goal 必须非空；
 * - completed 每条必须有 eventIds，且事件存在；
 * - completed.certainty=verified 必须有事件依据（与上一条共同保证）；
 * - decisions 每条必须有 eventIds；superseded 必须写 supersededBy；
 * - evidence.ref 必须存在；eventIds 若给出必须存在；
 * - nextActions/risks/constraints 不做语义判断，只要求类型由 TS 保证。
 */
export function validateContextSummary(
  summary: ContextSummary,
  context: SummaryValidationContext
): SummaryValidationResult {
  const reasons: string[] = [];
  if (!summary.goal.trim()) reasons.push('goal 为空');

  for (const [index, item] of summary.completed.entries()) {
    if (!item.text.trim()) reasons.push(`completed[${String(index)}] 文本为空`);
    if (item.eventIds.length === 0) reasons.push(`completed[${String(index)}] 没有事件依据`);
    const missing = missingEvents(item.eventIds, context);
    if (missing.length > 0) reasons.push(`completed[${String(index)}] 引用不存在事件：${missing.join('、')}`);
    if (item.certainty === 'verified' && item.eventIds.length === 0) {
      reasons.push(`completed[${String(index)}] 声称已验证但没有事件依据`);
    }
  }

  for (const [index, decision] of summary.decisions.entries()) {
    if (!decision.text.trim()) reasons.push(`decisions[${String(index)}] 文本为空`);
    if (decision.eventIds.length === 0) reasons.push(`decisions[${String(index)}] 没有事件依据`);
    const missing = missingEvents(decision.eventIds, context);
    if (missing.length > 0) reasons.push(`decisions[${String(index)}] 引用不存在事件：${missing.join('、')}`);
    if (decision.status === 'superseded' && !decision.supersededBy?.trim()) {
      reasons.push(`decisions[${String(index)}] 标为 superseded 但没有 supersededBy`);
    }
  }

  for (const [index, evidence] of summary.evidence.entries()) {
    if (!evidence.ref.trim()) {
      reasons.push(`evidence[${String(index)}] ref 为空`);
    } else if (!context.evidenceRefs.has(evidence.ref)) {
      reasons.push(`evidence[${String(index)}] 引用不存在证据：${evidence.ref}`);
    }
    const missing = missingEvents(evidence.eventIds, context);
    if (missing.length > 0) reasons.push(`evidence[${String(index)}] 引用不存在事件：${missing.join('、')}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** 稳定摘要 hash；用于检查点 summaryHash。 */
export function hashContextSummary(summary: ContextSummary): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(summary)).digest('hex')}`;
}
