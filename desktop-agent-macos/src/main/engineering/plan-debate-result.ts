/**
 * 把完整 DebateState 压成 PlanDebate 事件可携带的结构化切片。
 *
 * 主活动区需要主张 / 争议 / 交锋 / 裁决；完整图、证据包、论证边仍留在
 * 辩论存档，不塞进 AgentEvent。没有争议时 disputes 为空——不要用参与者
 * 列表伪造「正反双方」。
 */

import type { PlanDebateResultSlice } from '../../shared/contracts';
import type { DebateState } from '../debate/types';

const TEXT_LIMIT = 600;
const MAX_CLAIMS = 24;
const MAX_DISPUTES = 16;
const MAX_EXCHANGES = 40;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= TEXT_LIMIT ? trimmed : `${trimmed.slice(0, TEXT_LIMIT)}…`;
}

export function compactPlanDebateResult(state: DebateState): PlanDebateResultSlice {
  const claims: PlanDebateResultSlice['claims'] = (state.judgments ?? [])
    .slice(0, MAX_CLAIMS)
    .map(item => ({
      claimId: item.claimId,
      author: item.agentId,
      text: clip(item.claimText),
      kind: item.verdict
    }));

  // 没有 judgments 时，从各轮发言抽一条立场（仍不是伪造争议）。
  if (claims.length === 0) {
    for (const round of state.rounds) {
      for (const message of round.messages) {
        if (!message.text.trim()) continue;
        if (claims.length >= MAX_CLAIMS) break;
        claims.push({
          claimId: message.messageId,
          author: message.agentId,
          text: clip(message.text),
          kind: message.kind
        });
      }
    }
  }

  const disputes = (state.disputes ?? []).slice(0, MAX_DISPUTES).map(item => ({
    disputeId: item.disputeId,
    type: item.type,
    reason: clip(item.reason),
    claimIds: item.claimIds,
    agents: item.agents
  }));

  const exchanges = state.rounds
    .flatMap(round =>
      round.messages
        .filter(message => message.text.trim())
        .map(message => ({
          author: message.agentId,
          kind: message.kind,
          text: clip(message.text),
          roundIndex: round.index,
          ...(round.phase ? { phase: round.phase } : {})
        })))
    .slice(0, MAX_EXCHANGES);

  const verdict = state.verdict
    ? {
        verdict: state.verdict.verdict,
        conclusion: state.verdict.conclusion,
        rationale: clip(state.verdict.rationale),
        unresolved: state.verdict.unresolved.slice(0, 12),
        backend: state.verdict.backend
      }
    : undefined;

  return { claims, disputes, exchanges, ...(verdict ? { verdict } : {}) };
}
