/**
 * P2-05：知识地图三块（已确认/争议/未回答）+ 出处。
 * 每条都必须能点到证据；没有证据的条目不进入地图。
 */
import type { Claim, Conflict, Dispute } from '../collaboration/domain/types';
import { evaluateFreshness } from './freshness';
import type { KnowledgeCard } from './types';

export interface KnowledgeMapItem {
  statement: string;
  evidenceRefs: string[];
  asOf?: number;
  status?: 'active' | 'superseded' | 'refuted';
  cardId?: string;
  claimId?: string;
}

export interface KnowledgeMap {
  confirmed: KnowledgeMapItem[];
  disputed: KnowledgeMapItem[];
  unanswered: KnowledgeMapItem[];
}

export interface KnowledgeMapInput {
  cards: readonly KnowledgeCard[];
  claims: readonly Claim[];
  disputes: readonly Dispute[];
  conflicts: readonly Conflict[];
  now?: number;
}

export function buildKnowledgeMap(input: KnowledgeMapInput): KnowledgeMap {
  const now = input.now ?? Date.now();
  const confirmed: KnowledgeMapItem[] = [];
  const disputed: KnowledgeMapItem[] = [];
  const unanswered: KnowledgeMapItem[] = [];

  for (const card of input.cards) {
    if (card.evidenceRefs.length === 0) continue;
    const item: KnowledgeMapItem = {
      statement: card.statement,
      evidenceRefs: [...card.evidenceRefs],
      asOf: card.freshness.asOf,
      status: card.status,
      cardId: card.cardId
    };
    if (evaluateFreshness(card, now).state === 'fresh' && card.status === 'active') confirmed.push(item);
    else disputed.push(item);
  }

  const byClaim = new Map(input.claims.map(claim => [claim.claimId, claim]));
  const conflictById = new Map(input.conflicts.map(item => [item.conflictId, item]));
  for (const dispute of input.disputes) {
    if (dispute.status !== 'open') continue;
    const conflict = conflictById.get(dispute.conflictId);
    if (!conflict?.matters) continue;
    for (const [claimId, statement] of [[conflict.claimA, 'A'], [conflict.claimB, 'B']] as const) {
      const claim = byClaim.get(claimId);
      const evidenceRefs = claim?.source.evidenceId ? [claim.source.evidenceId] : [];
      if (evidenceRefs.length === 0) continue;
      disputed.push({ statement: `${statement}：${claim?.text ?? statement}`, evidenceRefs, claimId });
    }
  }

  const covered = new Set(input.cards.flatMap(card => card.claimIds));
  const disputedClaims = new Set(disputed.map(item => item.claimId).filter(Boolean));
  for (const claim of input.claims) {
    if (covered.has(claim.claimId) || disputedClaims.has(claim.claimId)) continue;
    const evidenceRefs = claim.source.evidenceId ? [claim.source.evidenceId] : [];
    if (evidenceRefs.length === 0) continue;
    unanswered.push({ statement: claim.text, evidenceRefs, claimId: claim.claimId });
  }

  return { confirmed, disputed, unanswered };
}
