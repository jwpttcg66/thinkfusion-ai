/**
 * 主张与证据的关联写入器（V4.1 P1-B）。
 *
 * 关联只表达「谁在什么位置引用了哪条证据」，不替裁判判断真假：
 * - `author`：页面/原文把一条来源归到了某句主张上。原文没有写方向，
 *   所以只能是 `context`，不能猜成 supports。
 * - `judge`：裁判在证据/反例维度实际引用了这条证据。方向由该主张的
 *   五档结论派生：supported/partially_supported → supports，
 *   unsupported/contradicted → contradicts，其余 → context。
 *
 * 同一个 (claim, evidence) 上，裁判方向优先于作者的 context：作者说
 * 「这句话引用了它」，裁判才能说「它支持/反驳了这句话」。
 *
 * 关联没有独立的存储：随 `DebateState.claimEvidenceLinks` 一起落盘，
 * 重建时从当前 claims / evidence / judgments 重新生成，因此不会留下
 * 指向已删除对象的悬空引用。
 */
import type {
  ClaimEvidenceLink,
  ClaimJudgment,
  DebateState,
  DimensionJudgment,
  Verdict
} from './types';

export interface LinkValidation {
  valid: ClaimEvidenceLink[];
  errors: string[];
}

export function buildClaimEvidenceLinks(state: DebateState): ClaimEvidenceLink[] {
  const claims = state.rounds.flatMap(round => round.claims ?? []);
  const claimIds = new Set(claims.map(claim => claim.claimId));
  const evidenceById = new Map((state.evidence ?? []).map(item => [item.evidenceId, item]));
  const links: ClaimEvidenceLink[] = [];
  const judgePairs = new Set<string>();

  for (const judgment of state.judgments ?? []) {
    if (!claimIds.has(judgment.claimId)) continue;
    for (const dimension of judgment.dimensions) {
      if (dimension.dimension !== 'evidence' && dimension.dimension !== 'counterexample') continue;
      for (const evidenceId of dimension.evidenceIds) {
        if (!evidenceById.has(evidenceId)) continue;
        const relation = relationOf(judgment, dimension);
        judgePairs.add(pairKey(judgment.claimId, evidenceId));
        links.push({
          debateId: state.debateId,
          claimId: judgment.claimId,
          evidenceId,
          relation,
          source: 'judge',
          reason: reasonOf(judgment, dimension, relation)
        });
      }
    }
  }

  for (const evidence of state.evidence ?? []) {
    for (const claimId of evidence.claimIds) {
      if (!claimIds.has(claimId)) continue;
      if (judgePairs.has(pairKey(claimId, evidence.evidenceId))) continue;
      links.push({
        debateId: state.debateId,
        claimId,
        evidenceId: evidence.evidenceId,
        relation: 'context',
        source: 'author',
        reason: '页面或原文把这条来源归到该主张；作者没有标明支持或反驳'
      });
    }
  }

  return dedupe(links);
}

/**
 * 校验关联：未知 claim/evidence、debateId 不一致、重复项都要报出来。
 * 返回的 `valid` 只含可安全消费的关联；`errors` 不会被静默吞掉。
 */
export function validateClaimEvidenceLinks(
  state: DebateState,
  links: readonly ClaimEvidenceLink[]
): LinkValidation {
  const claimIds = new Set(state.rounds.flatMap(round => round.claims ?? []).map(claim => claim.claimId));
  const evidenceIds = new Set((state.evidence ?? []).map(item => item.evidenceId));
  const errors: string[] = [];
  const seen = new Set<string>();
  const valid: ClaimEvidenceLink[] = [];

  for (const link of links) {
    if (link.debateId !== state.debateId) {
      errors.push(`debateId 不一致：${link.debateId}`);
      continue;
    }
    if (!claimIds.has(link.claimId)) {
      errors.push(`未知主张：${link.claimId}`);
      continue;
    }
    if (!evidenceIds.has(link.evidenceId)) {
      errors.push(`未知证据：${link.evidenceId}`);
      continue;
    }
    const key = `${link.claimId}\0${link.evidenceId}\0${link.relation}\0${link.source}`;
    if (seen.has(key)) {
      errors.push(`重复关联：${link.claimId} / ${link.evidenceId} / ${link.relation} / ${link.source}`);
      continue;
    }
    seen.add(key);
    valid.push({ ...link });
  }

  return { valid, errors };
}

/** 同一个 (claim, evidence) 只保留一条；裁判已经给方向时不再重复。 */
function dedupe(links: readonly ClaimEvidenceLink[]): ClaimEvidenceLink[] {
  const seen = new Set<string>();
  const out: ClaimEvidenceLink[] = [];
  for (const link of links) {
    const key = pairKey(link.claimId, link.evidenceId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out.sort((a, b) =>
    a.claimId.localeCompare(b.claimId) || a.evidenceId.localeCompare(b.evidenceId)
  );
}

function pairKey(claimId: string, evidenceId: string): string {
  return `${claimId}\0${evidenceId}`;
}

function relationOf(
  judgment: ClaimJudgment,
  dimension: DimensionJudgment
): ClaimEvidenceLink['relation'] {
  if (dimension.outcome === 'conflicting') return 'context';
  if (dimension.dimension === 'counterexample' && dimension.outcome === 'refuted') return 'contradicts';
  return relationOfVerdict(judgment.verdict);
}

function relationOfVerdict(verdict: Verdict): ClaimEvidenceLink['relation'] {
  if (verdict === 'supported' || verdict === 'partially_supported') return 'supports';
  if (verdict === 'unsupported' || verdict === 'contradicted') return 'contradicts';
  return 'context';
}

function reasonOf(
  judgment: ClaimJudgment,
  dimension: DimensionJudgment,
  relation: ClaimEvidenceLink['relation']
): string {
  const where = dimension.dimension === 'evidence' ? '证据维度' : '反例维度';
  const direction = relation === 'supports'
    ? '支持'
    : relation === 'contradicts'
      ? '反驳'
      : '作为背景引用';
  return `裁判在${where}（${dimension.outcome}）引用该证据，按主张结论 ${judgment.verdict} 记为${direction}`;
}

/** 测试与外部校验用：这条证据是否被当成「支持」以外的关系。 */
export function isSupportLink(link: ClaimEvidenceLink): boolean {
  return link.relation === 'supports';
}
