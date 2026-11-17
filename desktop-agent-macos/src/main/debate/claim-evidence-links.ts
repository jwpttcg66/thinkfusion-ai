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
import type { JudgeVerdict } from '../judge/types';

export interface LinkValidation {
  valid: ClaimEvidenceLink[];
  errors: string[];
}

export interface LinkRefresh {
  links: ClaimEvidenceLink[];
  errors: string[];
  writer: 'rules-judge' | 'model-judge';
}

/**
 * 唯一写入入口。规则裁判收尾时调用；模型裁决不经过这里，也不直接改
 * `claimEvidenceLinks`——`JudgeVerdict.evidence` 是消息级，没有 evidenceId，
 * 强写只能猜。需要模型关联时必须先给裁决增加 claim/evidence 引用契约（P3）。
 */
export function refreshClaimEvidenceLinks(
  state: DebateState,
  writer: 'rules-judge' | 'model-judge' = 'rules-judge'
): LinkRefresh {
  const built = buildClaimEvidenceLinks(state);
  const validation = validateClaimEvidenceLinks(state, built);
  state.claimEvidenceLinks = validation.valid;
  state.claimEvidenceLinksSource = writer;
  return { links: validation.valid, errors: validation.errors, writer };
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

  // 模型裁判明确给出的方向优先；没有判断时退回 pack context。
  for (const link of state.judgePackEvidenceLinks ?? []) {
    if (!claimIds.has(link.claimId)) continue;
    if (!evidenceById.has(link.evidenceId)) continue;
    links.push({ ...link, debateId: state.debateId });
  }

  // Pack 来源只写 context：引用代码不等于代码支持主张。若同一对证据
  // 裁判给了 supports/contradicts，dedupe 会按方向优先级覆盖 context。
  for (const link of state.packEvidenceLinks ?? []) {
    if (!claimIds.has(link.claimId)) continue;
    if (!evidenceById.has(link.evidenceId)) continue;
    links.push({ ...link, debateId: state.debateId, source: 'pack', relation: 'context' });
  }

  for (const evidence of state.evidence ?? []) {
    // Pack 证据的关联由 P2 显式输入；这里自动写会把 repo-snapshot 误标成
    // 作者引用。快照只证明「代码/命令存在」，不证明作者引用了它。
    if (evidence.origin === 'repo-snapshot') continue;
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
    // 同一对 (claim, evidence) 只能有一条关联；方向不同不是「两条记录」，
    // 而是语义冲突，必须报出来，不能让消费方按数组顺序挑一个。
    const key = pairKey(link.claimId, link.evidenceId);
    if (seen.has(key)) {
      errors.push(`同一对证据出现多条关联：${link.claimId} / ${link.evidenceId}`);
      continue;
    }
    seen.add(key);
    valid.push({ ...link });
  }

  return { valid, errors };
}

/**
 * 同一个 (claim, evidence) 只保留一条。
 *
 * 方向冲突时按 contradicts > supports > context 处理：反例/反驳比支持更强，
 * 不能让「证据维度先被 push」决定最终方向。同方向时裁判优先于作者。
 */
function dedupe(links: readonly ClaimEvidenceLink[]): ClaimEvidenceLink[] {
  const best = new Map<string, ClaimEvidenceLink>();
  for (const link of links) {
    const key = pairKey(link.claimId, link.evidenceId);
    const current = best.get(key);
    if (!current || stronger(link, current)) best.set(key, link);
  }
  return [...best.values()].sort((a, b) =>
    a.claimId.localeCompare(b.claimId) || a.evidenceId.localeCompare(b.evidenceId)
  );
}

const RELATION_RANK: Record<ClaimEvidenceLink['relation'], number> = {
  contradicts: 3,
  supports: 2,
  context: 1
};

const SOURCE_RANK: Record<ClaimEvidenceLink['source'], number> = {
  judge: 4,
  pack: 3,
  reviewer: 2,
  author: 1
};

function stronger(candidate: ClaimEvidenceLink, current: ClaimEvidenceLink): boolean {
  const relation = RELATION_RANK[candidate.relation] - RELATION_RANK[current.relation];
  if (relation !== 0) return relation > 0;
  return SOURCE_RANK[candidate.source] > SOURCE_RANK[current.source];
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
  return `规则裁判在${where}（${dimension.outcome}）引用该证据，按主张结论 ${judgment.verdict} 记为${direction}`;
}

/**
 * 把模型裁判对 Pack 证据的判断写成关联。只接受已经存在的 evidenceId；
 * 关系来自 Verdict 的显式输出，不从引用自动推导。
 */
export function applyJudgePackEvidence(state: DebateState, verdict: JudgeVerdict): ClaimEvidenceLink[] {
  const evidenceIds = new Set((state.packEvidence ?? []).map(item => item.evidenceId));
  const links: ClaimEvidenceLink[] = [];
  for (const item of verdict.packEvidence ?? []) {
    if (!evidenceIds.has(item.evidenceId)) continue;
    links.push({
      debateId: state.debateId,
      claimId: item.claimId,
      evidenceId: item.evidenceId,
      relation: item.relation,
      source: 'judge',
      reason: `${item.reason}（confidence=${item.confidence}；snapshot=${item.sourceSnapshot.packId}@${item.sourceSnapshot.commit.slice(0, 12)}）`
    });
  }
  state.judgePackEvidenceLinks = links;
  return links;
}

/** 测试与外部校验用：这条证据是否被当成「支持」以外的关系。 */
export function isSupportLink(link: ClaimEvidenceLink): boolean {
  return link.relation === 'supports';
}
