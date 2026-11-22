/**
 * 规则抽取：从一条消息里找出"值得长期记住"的内容，生成**候选**。
 *
 * 五条边界（`GLOBAL_MEMORY.md` §4.1）：
 * 1. 没有 messageId 不生成——候选必须能回溯到真实消息。
 * 2. 工具/网页返回的数据不生成（那是数据，不是用户的长期约束）。
 * 3. 助手自己的推断只进待确认，`confidence<0.5` 直接拒，且不得写成"用户偏好"。
 * 4. 含密钥/凭据的直接丢弃并留痕（`dropped-secret`）。
 * 5. 临时任务状态不进 GLOBAL；需要时由任务报告显式调用，走 WORKSPACE。
 *
 * 这一层不碰数据库，只产出 `CandidateInput`，由 service 落库。
 */

import type { MemoryKind, MemoryScope, MemorySettings } from '../../shared/memory';
import type { CandidateInput } from './types';
import {
  containsSensitive,
  dedupeKeyOf,
  prepareCandidateText,
  type CandidateReason,
  type RawCandidate
} from './policy';
import { normalizeKey } from './store';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ExtractMessageInput {
  conversationId: string;
  messageId: string;
  text: string;
  role: MessageRole;
  projectId?: string;
  projectRoot?: string;
  workspaceId?: string;
  sourceTaskId?: string;
}

export interface ExtractResult {
  candidates: CandidateInput[];
  dropped: Array<{ reason: string; quote: string }>;
}

const EXPLICIT = /^(?:请)?(?:帮我)?(?:记住|记一下|记录一下|remember)\s*[:：,，]?\s*/i;
const PREFERENCE = /(以后都|以后一直|往后都|长期(?:采用|使用|坚持)?|一律|从现在开始|统一用|习惯用)/;
const CONSTRAINT = /(不要再|不许|禁止|只能|必须|不允许|不能再|别再)/;
const DECISION = /(决定|结论|采用|选定|定为|不再使用)/;

/** 取第一句/前 N 字做标题，避免把整段当标题。 */
function titleOf(text: string, limit = 28): string {
  const first = text.split(/[。！？\n；;]/).map(part => part.trim()).find(Boolean) ?? text;
  return first.length > limit ? `${first.slice(0, limit)}…` : first;
}

function kindOf(text: string, reason: CandidateReason): MemoryKind {
  if (reason === 'stable-constraint') return 'constraint';
  if (reason === 'stable-preference') return 'preference';
  if (reason === 'task-decision' || reason === 'verified-solution') return 'decision';
  if (CONSTRAINT.test(text)) return 'constraint';
  if (PREFERENCE.test(text)) return 'preference';
  if (DECISION.test(text)) return 'decision';
  return 'fact';
}

function scopeOf(input: ExtractMessageInput): { scope: MemoryScope; scopeId: string } {
  if (input.projectId) return { scope: 'PROJECT', scopeId: input.projectId };
  if (input.workspaceId) return { scope: 'WORKSPACE', scopeId: input.workspaceId };
  return { scope: 'GLOBAL', scopeId: '' };
}

function toCandidate(input: ExtractMessageInput, raw: RawCandidate): CandidateInput {
  const { content, quote } = prepareCandidateText(raw.text);
  const normalizedKey = normalizeKey(titleOf(content));
  return {
    sourceConversationId: input.conversationId,
    sourceMessageIds: raw.sourceMessageIds,
    ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    proposedKind: raw.kind,
    proposedScope: raw.scope,
    proposedScopeId: raw.scopeId,
    proposedTitle: titleOf(content),
    proposedContent: content,
    quote,
    sourceRefs: [`conversation:${input.conversationId}`, `message:${input.messageId}`],
    confidence: raw.confidence,
    riskLevel: raw.riskLevel,
    reason: raw.reason,
    requiresConfirmation: raw.requiresConfirmation,
    dedupeKey: dedupeKeyOf({ scope: raw.scope, scopeId: raw.scopeId, normalizedKey })
  };
}

/**
 * 一条消息 → 至多一条候选。
 *
 * 只出一条是刻意的：一段话里抽出五条"记忆"，用户要在确认队列里点五次，
 * 实际体验是没人会点，于是候选队列烂掉。一句话一个意思，够了。
 */
export function extractFromMessage(input: ExtractMessageInput, settings: MemorySettings): ExtractResult {
  const dropped: ExtractResult['dropped'] = [];
  if (settings.writeMode === 'off' || !settings.enabled) return { candidates: [], dropped };
  if (!input.messageId) return { candidates: [], dropped: [{ reason: 'no-message-id', quote: '' }] };
  if (input.role === 'tool') return { candidates: [], dropped: [{ reason: 'tool-data', quote: '' }] };
  if (input.role === 'system') return { candidates: [], dropped };

  const text = input.text.trim();
  if (text.length < 6) return { candidates: [], dropped };

  if (containsSensitive(text)) {
    dropped.push({ reason: 'dropped-secret', quote: prepareCandidateText(text).quote });
    return { candidates: [], dropped };
  }

  const scope = scopeOf(input);
  const explicit = EXPLICIT.test(text);
  // 显式「记住」把冒号后的内容当记忆；否则整句（截断）。
  const body = explicit ? text.replace(EXPLICIT, '').trim() || text : text;

  let reason: CandidateReason | null = null;
  let confidence = 0.5;

  if (explicit) {
    reason = 'explicit-remember';
    confidence = 0.8;
  } else if (input.role === 'user' && CONSTRAINT.test(text)) {
    reason = 'stable-constraint';
    confidence = 0.7;
  } else if (input.role === 'user' && PREFERENCE.test(text)) {
    reason = 'stable-preference';
    confidence = 0.7;
  } else if (input.role === 'assistant' && DECISION.test(text)) {
    // 助手推断：只能是待确认，且不得伪装成用户偏好。
    reason = 'assistant-inference';
    confidence = 0.4;
  }

  if (!reason) return { candidates: [], dropped };

  // GLOBAL 只允许用户显式记住，且必须经用户确认。
  if (scope.scope === 'GLOBAL' && reason !== 'explicit-remember') {
    return { candidates: [], dropped: [{ reason: 'global-needs-explicit', quote: '' }] };
  }

  const kind = kindOf(body, reason);
  const raw: RawCandidate = {
    text: body,
    quote: prepareCandidateText(body).quote,
    kind,
    scope: scope.scope,
    scopeId: scope.scopeId,
    confidence,
    reason,
    requiresConfirmation: true,
    sourceMessageIds: [input.messageId],
    riskLevel: reason === 'assistant-inference' ? 'high' : 'low'
  };

  return { candidates: [toCandidate(input, raw)], dropped };
}

export interface TaskReportInput {
  taskId: string;
  conversationId: string;
  summary: string;
  /** 报告里明确写出的决策；最多取 3 条。 */
  decisions?: string[];
  projectId?: string;
  projectRoot?: string;
  /** 任务报告对应的用户消息 id；没有就不生成（MEM-06）。 */
  sourceMessageIds: string[];
}

/**
 * 任务完成报告的钩子：只取明确写出来的决策/约束，≤3 条。
 *
 * 不做"对整份报告做总结"——那是模型通道的事（默认关）。这里只认
 * `/决定|结论|约束/` 这类明确措辞。
 */
export function extractFromTaskReport(input: TaskReportInput): ExtractResult {
  const dropped: ExtractResult['dropped'] = [];
  if (input.sourceMessageIds.length === 0) return { candidates: [], dropped: [{ reason: 'no-source-message', quote: '' }] };
  if (!input.projectId) return { candidates: [], dropped: [{ reason: 'no-project-scope', quote: '' }] };

  const lines = (input.decisions ?? [])
    .map(line => line.trim())
    .filter(line => line.length >= 6 && DECISION.test(line))
    .slice(0, 3);

  const candidates: CandidateInput[] = [];
  for (const line of lines) {
    if (containsSensitive(line)) {
      dropped.push({ reason: 'dropped-secret', quote: prepareCandidateText(line).quote });
      continue;
    }
    const { content, quote } = prepareCandidateText(line);
    const normalizedKey = normalizeKey(titleOf(content));
    candidates.push({
      sourceConversationId: input.conversationId,
      sourceMessageIds: input.sourceMessageIds,
      sourceTaskId: input.taskId,
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      proposedKind: 'decision',
      proposedScope: 'PROJECT',
      proposedScopeId: input.projectId,
      proposedTitle: titleOf(content),
      proposedContent: content,
      quote,
      sourceRefs: [`task:${input.taskId}`],
      confidence: 0.65,
      riskLevel: 'low',
      reason: 'task-decision',
      requiresConfirmation: true,
      dedupeKey: dedupeKeyOf({ scope: 'PROJECT', scopeId: input.projectId, normalizedKey })
    });
  }
  return { candidates, dropped };
}
