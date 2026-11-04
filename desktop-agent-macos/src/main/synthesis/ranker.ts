import type { ArgumentRelation, Evidence } from '../../shared/fusion';
import type { ExtractedClaim } from './claim-extractor';
import { incomingOf } from './relations';
import { meanEvidenceScore } from './evidence';

/**
 * 排序：只回答「先讲哪个」，绝不回答「哪个是真的」（架构文档 11.8）。
 *
 * 借鉴 LLM-Blender 的成对比较思路：不把七个证据维度压成一个绝对分再排序，
 * 而是每次比较两条观点，输出 `-1 / 0 / 1` **加一句理由**。权威性 0.7 和
 * 相关性 0.7 本来不可比，压成同一个数就是假精度；成对比较能说清「这一轮
 * 为什么它排前面」。K 很小，插入排序足够，不上模型。
 */
export interface RankContext {
  claim: ExtractedClaim;
  /** 独立通道数，同一通道重复仍算 1。 */
  support: number;
  evidenceScore: number;
  /** 未解决的反驳数，是减项。 */
  unresolvedAttacks: number;
  /** 被多少条 supports 边指向。 */
  supportedBy: number;
}

export interface Comparison {
  winner: -1 | 0 | 1;
  reason: string;
}

export function compare(a: RankContext, b: RankContext): Comparison {
  // 先比「有没有没被回答的反驳」：一条挂着硬反驳的观点不该排在最前面，
  // 即使它人多。注意这只是排序，不是判定它错。
  if (a.unresolvedAttacks !== b.unresolvedAttacks) {
    const winner = a.unresolvedAttacks < b.unresolvedAttacks ? -1 : 1;
    return {
      winner,
      reason: winner === -1
        ? '未经回应的反驳更少'
        : '对方未经回应的反驳更少'
    };
  }

  const score = (item: RankContext) =>
    item.evidenceScore * 0.4 + item.support * 0.3 + item.supportedBy * 0.15 - item.unresolvedAttacks * 0.15;
  const delta = score(a) - score(b);
  if (Math.abs(delta) < 0.05) return { winner: 0, reason: '证据、独立通道数与反驳情况相当' };
  return {
    winner: delta > 0 ? -1 : 1,
    reason: delta > 0 ? '证据线索与独立支持更强' : '对方证据线索与独立支持更强'
  };
}

/**
 * 返回 claimId → 0..1 的展示权重。分数只决定先讲哪个。
 * 平手时按 id 排，保证同样的输入每次报告长得一样。
 */
export function rankClaims(
  claims: ExtractedClaim[],
  relations: ArgumentRelation[],
  evidence: Evidence[],
  supports: Map<string, number>
): Map<string, number> {
  const contexts = claims.map(claim => {
    const incoming = incomingOf(relations, claim.id);
    return {
      claim,
      support: supports.get(claim.id) ?? 1,
      evidenceScore: meanEvidenceScore(evidence, claim.id),
      unresolvedAttacks: incoming.filter(edge => edge.kind === 'attacks' || edge.kind === 'contradicts').length,
      supportedBy: incoming.filter(edge => edge.kind === 'supports').length
    } satisfies RankContext;
  });

  // 插入排序：观点通常几十条，且每次比较都能留下理由。
  const ordered: RankContext[] = [];
  for (const item of contexts) {
    let position = ordered.length;
    while (position > 0 && compare(item, ordered[position - 1]).winner === -1) position -= 1;
    ordered.splice(position, 0, item);
  }

  const ranks = new Map<string, number>();
  ordered.forEach((item, index) => {
    ranks.set(item.claim.id, ordered.length <= 1 ? 1 : 1 - index / (ordered.length - 1));
  });
  return ranks;
}
