/**
 * 记忆策略：什么能成为记忆、什么必须确认、什么直接拒。
 *
 * "规则抽取默认开启"**不等于**自动批准。审批流固定（`GLOBAL_MEMORY.md` §4.1）：
 *
 *   消息 → 规则抽取 → MemoryCandidate → MemoryPolicy → 自动批准/等待确认/拒绝 → MemoryStore
 *
 * 自动批准只有一种情形：用户显式「记住」+ 偏好/约束 + PROJECT/WORKSPACE +
 * 无敏感信息 + 用户自己打开了 `autoApproveExplicit`。其余一律 pending。
 */

import { containsSecret, redactSecrets } from '../../shared/redact';
import type { MemoryCandidate, MemoryKind, MemoryScope, MemorySettings } from '../../shared/memory';
import { normalizeKey } from './store';

/** 只有这些理由能生成候选；`tool-data` / `page-data` 永远不生成。 */
export type CandidateReason =
  | 'explicit-remember'
  | 'stable-preference'
  | 'stable-constraint'
  | 'task-decision'
  | 'verified-solution'
  | 'assistant-inference';

export interface RawCandidate {
  text: string;
  quote: string;
  kind: MemoryKind;
  scope: MemoryScope;
  scopeId: string;
  confidence: number;
  reason: CandidateReason;
  requiresConfirmation: boolean;
  sourceMessageIds: string[];
  riskLevel: MemoryCandidate['riskLevel'];
}

export interface PolicyDecision {
  action: 'auto-approve' | 'pending' | 'reject';
  reason: string;
  riskLevel: MemoryCandidate['riskLevel'];
}

/** 敏感内容一律不写入；这里用同一套 redact 规则，不另造关键词表。 */
export function containsSensitive(text: string): boolean {
  return containsSecret(text) || /\b(password|passwd|口令|密钥|私钥)\s*[:=：]\s*\S{4,}/i.test(text);
}

export function sanitizeForMemory(text: string): string {
  return redactSecrets(text).replace(/\s+/g, ' ').trim();
}

/** 去重键：同 scope 同 key 视为同一条（跨 scope 不合并）。 */
export function dedupeKeyOf(input: {
  scope: MemoryScope;
  scopeId?: string;
  normalizedKey: string;
}): string {
  return `${input.scope}|${input.scopeId ?? ''}|${input.normalizedKey}`;
}

export interface DecideInput {
  reason: CandidateReason;
  kind: MemoryKind;
  scope: MemoryScope;
  confidence: number;
  sourceMessageIds: string[];
  text: string;
  settings: MemorySettings;
}

/**
 * 唯一策略入口。
 *
 * 拒绝优先于批准：先看有没有 messageId、有没有密钥、是不是低置信推断。
 * 顺序错了会出现"带密钥但被显式批准"的记录。
 */
export function decideCandidate(input: DecideInput): PolicyDecision {
  if (input.sourceMessageIds.length === 0) {
    return { action: 'reject', reason: 'no-source-message', riskLevel: 'high' };
  }
  if (containsSensitive(input.text)) {
    return { action: 'reject', reason: 'dropped-secret', riskLevel: 'high' };
  }
  if (input.reason === 'assistant-inference' && input.confidence < 0.5) {
    return { action: 'reject', reason: 'low-confidence-inference', riskLevel: 'high' };
  }

  const riskLevel: MemoryCandidate['riskLevel'] =
    input.reason === 'assistant-inference' ? 'high' : input.confidence < 0.6 ? 'medium' : 'low';

  const autoEligible =
    input.reason === 'explicit-remember' &&
    (input.kind === 'preference' || input.kind === 'constraint') &&
    (input.scope === 'PROJECT' || input.scope === 'WORKSPACE') &&
    input.settings.autoApproveExplicit;

  if (autoEligible) {
    return { action: 'auto-approve', reason: 'explicit-remember-auto', riskLevel };
  }
  if (input.reason === 'assistant-inference') {
    return { action: 'pending', reason: 'inference-needs-confirmation', riskLevel: 'high' };
  }
  return {
    action: 'pending',
    reason:
      input.reason === 'explicit-remember'
        ? 'explicit-needs-confirmation'
        : input.confidence < 0.6
          ? 'low-confidence'
          : 'policy-pending',
    riskLevel
  };
}

/** 候选内容归一化：截断、脱敏、去换行。 */
export function prepareCandidateText(text: string): { content: string; quote: string } {
  const clean = sanitizeForMemory(text);
  return {
    content: clean.slice(0, 600),
    quote: clean.slice(0, 200)
  };
}

/**
 * 候选 → 记录字段（确认时用）。
 *
 * 工程记忆带 `projectRoot` 与 `codeRefs` 时，`scopeId` 必须是 projectId；
 * 这里不重新算 id，调用方给什么用什么，避免两处算法漂移。
 */
export function candidateToRecordInput(
  candidate: MemoryCandidate
): {
  kind: MemoryKind;
  scope: MemoryScope;
  scopeId: string;
  title: string;
  content: string;
  normalizedKey: string;
  sourceRefs: string[];
  confidence: number;
  riskLevel: MemoryCandidate['riskLevel'];
  tags: string[];
} {
  return {
    kind: candidate.proposedKind,
    scope: candidate.proposedScope,
    scopeId: candidate.proposedScopeId,
    title: candidate.proposedTitle,
    content: candidate.proposedContent,
    normalizedKey: normalizeKey(candidate.proposedTitle),
    sourceRefs: candidate.sourceRefs,
    confidence: candidate.confidence,
    riskLevel: candidate.riskLevel,
    tags: []
  };
}
