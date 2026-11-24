/**
 * 结构化摘要校验（LT-P3-01）。
 *
 * 摘要可以包含模型判断，但“已完成/已验证”必须有事件依据；
 * 证据引用必须能在本轮 EvidenceRef 集合里找到。
 *
 * 模型返回的 JSON 不可信：字段缺失、类型错误都必须变成 reasons，
 * 不能在校验器里抛 `reading 'trim' of undefined` 之类的错误。
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function eventIdsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((item): item is string => typeof item === 'string');
  return ids.length === value.length ? ids : null;
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
  const raw = summary as unknown as Record<string, unknown>;

  if (typeof raw.goal !== 'string' || !raw.goal.trim()) reasons.push('goal 为空');

  const completed = Array.isArray(raw.completed) ? raw.completed : [];
  if (!Array.isArray(raw.completed)) reasons.push('completed 不是数组');
  for (const [index, value] of completed.entries()) {
    const item = (value ?? {}) as Record<string, unknown>;
    const text = stringValue(item.text);
    const ids = eventIdsOf(item.eventIds);
    if (text === null || !text.trim()) reasons.push(`completed[${String(index)}] 文本为空`);
    if (ids === null || ids.length === 0) {
      reasons.push(`completed[${String(index)}] 没有事件依据`);
    } else {
      const missing = missingEvents(ids, context);
      if (missing.length > 0) reasons.push(`completed[${String(index)}] 引用不存在事件：${missing.join('、')}`);
      if (item.certainty === 'verified' && ids.length === 0) {
        reasons.push(`completed[${String(index)}] 声称已验证但没有事件依据`);
      }
    }
  }

  const decisions = Array.isArray(raw.decisions) ? raw.decisions : [];
  if (!Array.isArray(raw.decisions)) reasons.push('decisions 不是数组');
  for (const [index, value] of decisions.entries()) {
    const decision = (value ?? {}) as Record<string, unknown>;
    const text = stringValue(decision.text);
    const ids = eventIdsOf(decision.eventIds);
    if (text === null || !text.trim()) reasons.push(`decisions[${String(index)}] 文本为空`);
    if (ids === null || ids.length === 0) {
      reasons.push(`decisions[${String(index)}] 没有事件依据`);
    } else {
      const missing = missingEvents(ids, context);
      if (missing.length > 0) reasons.push(`decisions[${String(index)}] 引用不存在事件：${missing.join('、')}`);
    }
    if (decision.status === 'superseded' && !stringValue(decision.supersededBy)?.trim()) {
      reasons.push(`decisions[${String(index)}] 标为 superseded 但没有 supersededBy`);
    }
  }

  const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  if (!Array.isArray(raw.evidence)) reasons.push('evidence 不是数组');
  for (const [index, value] of evidence.entries()) {
    const item = (value ?? {}) as Record<string, unknown>;
    const ref = stringValue(item.ref);
    if (ref === null || !ref.trim()) {
      reasons.push(`evidence[${String(index)}] ref 为空`);
    } else if (!context.evidenceRefs.has(ref)) {
      reasons.push(`evidence[${String(index)}] 引用不存在证据：${ref}`);
    }
    const ids = eventIdsOf(item.eventIds);
    if (ids === null) {
      reasons.push(`evidence[${String(index)}] eventIds 不是字符串数组`);
    } else {
      const missing = missingEvents(ids, context);
      if (missing.length > 0) reasons.push(`evidence[${String(index)}] 引用不存在事件：${missing.join('、')}`);
    }
  }

  for (const key of ['constraints', 'openIssues', 'nextActions', 'risks', 'stopConditions']) {
    const value = raw[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      reasons.push(`${key} 不是字符串数组`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** 稳定摘要 hash；用于检查点 summaryHash。 */
export function hashContextSummary(summary: ContextSummary): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(summary)).digest('hex')}`;
}
