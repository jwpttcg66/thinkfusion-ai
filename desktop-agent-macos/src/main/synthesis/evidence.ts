import type { ArgumentRelation, Evidence, EvidenceKind, EvidenceScores } from '../../shared/fusion';
import type { ExtractedClaim } from './claim-extractor';

/**
 * 证据评分（架构文档 11.4）。
 *
 * 七个维度分别打，不压成一个数。`timeliness` 本地判不了就写 `null`——不联网
 * 就不知道材料什么时候发布，写 0 或 1 都是编。`independence` 只回答「是不是
 * 另一个通道也给了同样的材料」，不做来源谱系，也不冒充事实核查。
 */
const AUTHORITY: Record<EvidenceKind, number> = {
  'official-doc': 0.9,
  'source-code': 0.8,
  paper: 0.85,
  benchmark: 0.75,
  blog: 0.4,
  'model-claim': 0.3
};

const VERIFIABILITY: Record<EvidenceKind, number> = {
  'official-doc': 0.8,
  'source-code': 0.9,
  paper: 0.7,
  benchmark: 0.85,
  blog: 0.3,
  'model-claim': 0.2
};

export function buildEvidence(
  claims: ExtractedClaim[],
  relations: ArgumentRelation[]
): Evidence[] {
  // 同一段原话在别的通道出现过 → 是「被复核过」，不是「被证实」。
  const excerpts = new Map<string, Set<string>>();
  for (const claim of claims) {
    for (const draft of claim.evidence) {
      const key = draft.excerpt.replace(/\s+/g, '');
      const channels = excerpts.get(key) ?? new Set<string>();
      channels.add(claim.channelId);
      excerpts.set(key, channels);
    }
  }

  const conflicts = new Set<string>();
  for (const relation of relations) {
    if (relation.kind === 'contradicts' || relation.kind === 'attacks') {
      conflicts.add(relation.from);
      conflicts.add(relation.to);
    }
  }

  const found: Evidence[] = [];
  for (const claim of claims) {
    for (const [index, draft] of claim.evidence.entries()) {
      const key = draft.excerpt.replace(/\s+/g, '');
      const channels = excerpts.get(key)?.size ?? 1;
      const scores: EvidenceScores = {
        authority: AUTHORITY[draft.kind],
        relevance: clamp(0.5 + Math.min(0.3, draft.cue.length * 0.02)),
        verifiability: VERIFIABILITY[draft.kind],
        directness: clamp(0.4 + (draft.excerpt.length >= 8 ? 0.3 : 0)),
        // 只区分「有第二个通道」还是「同一条回答自己转述」。
        independence: channels >= 2 ? 0.8 : 0.3,
        timeliness: null,
        consistency: conflicts.has(claim.id) ? 0.2 : 0.6
      };
      found.push({
        id: `${claim.id}-e${index + 1}`,
        kind: draft.kind,
        excerpt: draft.excerpt,
        channelId: claim.channelId,
        messageId: claim.messageId,
        span: { messageId: claim.messageId, start: draft.start, end: draft.end },
        claims: [claim.id],
        scores,
        verified: conflicts.has(claim.id)
          ? 'conflicted'
          : channels >= 2
            ? 'corroborated'
            : 'unverified'
      });
    }
  }
  return found;
}

export function meanEvidenceScore(evidence: Evidence[], claimId: string): number {
  const mine = evidence.filter(item => item.claims.includes(claimId));
  if (mine.length === 0) return 0;
  const total = mine.reduce((sum, item) => {
    const scores = item.scores;
    // timeliness 是 null，不参与平均；把「不知道」当 0 会系统性压低分数。
    const values = [
      scores.authority, scores.relevance, scores.verifiability,
      scores.directness, scores.independence, scores.consistency
    ];
    return sum + values.reduce((a, b) => a + b, 0) / values.length;
  }, 0);
  return total / mine.length;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
