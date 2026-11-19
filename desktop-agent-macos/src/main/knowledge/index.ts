/**
 * P2-02：知识召回。规则匹配，不做向量库；结果带 asOf/status。
 */
import type { KnowledgeCard } from './types';

export interface RecallHit {
  card: KnowledgeCard;
  score: number;
  matchedBy: string[];
}

export interface RecallOptions {
  topicId?: string;
  limit?: number;
}

function scoreOne(card: KnowledgeCard, query: string): RecallHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const matchedBy: string[] = [];
  let score = 0;
  if (card.statement.toLowerCase().includes(q)) {
    score += 2;
    matchedBy.push('statement');
  }
  if (card.claimIds.some(id => id.toLowerCase() === q)) {
    score += 3;
    matchedBy.push('claim');
  }
  if (card.evidenceRefs.some(id => id.toLowerCase() === q)) {
    score += 3;
    matchedBy.push('evidence');
  }
  return score > 0 ? { card, score, matchedBy } : null;
}

export class KnowledgeIndex {
  constructor(private readonly cards: readonly KnowledgeCard[]) {}

  recall(query: string, options: RecallOptions = {}): RecallHit[] {
    const limit = options.limit ?? 10;
    return this.cards
      .filter(card => (options.topicId ? card.topicId === options.topicId : true))
      .map(card => scoreOne(card, query))
      .filter((hit): hit is RecallHit => hit !== null)
      .sort((left, right) => right.score - left.score || right.card.updatedAt - left.card.updatedAt)
      .slice(0, limit);
  }

  byClaim(claimId: string): KnowledgeCard[] {
    return this.cards.filter(card => card.claimIds.includes(claimId));
  }

  byEvidence(evidenceId: string): KnowledgeCard[] {
    return this.cards.filter(card => card.evidenceRefs.includes(evidenceId));
  }
}
