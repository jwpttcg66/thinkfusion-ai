import { features, jaccard, negationCount } from '../../shared/synthesizer';
import { evidenceForClaim, independentSourceCount, isExternal } from './evidence';
import type {
  ClaimJudgment,
  CounterexampleOutcome,
  DebateClaim,
  DebateDispute,
  DebateEvidence,
  DebateState,
  DebateVerdict,
  DimensionJudgment,
  EvidenceOutcome,
  JudgeDimension,
  LogicOutcome,
  Verdict
} from './types';

/**
 * 三维裁判（任务书 AC-11 / AC-12 / AC-13 / Phase 3）。
 *
 * 三个维度**各自判、各自留理由**，最后只做「按规则合成」，不做加权平均：
 * 逻辑满分掩盖不了证据缺失，证据充足也掩盖不了推理跳步。平均分之所以危险，
 * 就是它把这两种问题压成同一个数字，读的人再也分不出该补证据还是该改推理。
 *
 * **没有投票**。这里从头到尾没有 `supportCount` 这类输入：三票反对一票支持
 * 也好、一票反对三票支持也好，同一句主张得到的结论完全一样。模型数量只在
 * 别的模块里用来描述意见分布，不参与判断。少数派只要证据可核验，一样可以被
 * 判成 `supported`（TF-D-011）。
 *
 * 本地规则能读到的只有「文本里写了什么」。所以：
 *
 * - 页面给了链接 → 这条来源确实存在（可点开复核），但内容真伪仍需人读；
 * - 只有「官方文档说」这句话、没有链接 → 算作者的说法，不算已核验来源；
 * - 什么都没有 → 证据不足。这不是「错」，是「判不了」。
 */

const ABSOLUTE = /(一定|必然|绝对|肯定|毫无疑问|显然|从来|永远|所有|任何|必然)/;
const REASONING = /(因为|由于|所以|因此|据此|由此可见|说明|意味着|得出|由此)/;
const CONDITION = /(如果|假如|若|当|仅在|只有在|取决于|前提|条件是|适用范围)/;

/** 推理被判成「有依据」的最低文本相似度：同一个意思换个说法，不算两句矛盾。 */
const SAME_TOPIC = 0.45;

/** 来源类型里，能单独撑起「证据充足」的几种。博客只能算补充。 */
const STRONG_KINDS = new Set(['official-doc', 'source-code', 'paper', 'benchmark']);

export interface JudgmentRun {
  judgments: ClaimJudgment[];
  verdict: DebateVerdict;
}

/**
 * 对一场辩论里所有主张跑三维裁判，再合成整场结论。
 *
 * 纯函数：同样的辩论状态、同样的证据，跑几次结果都一样（时间戳除外）。
 * 不调用模型，所以不需要预算，也不会因为某位裁判模型不可用而改变结论。
 */
export function judgeDebate(state: DebateState, options: { at?: number } = {}): JudgmentRun {
  const at = options.at ?? Date.now();
  const claims = state.rounds.flatMap(round => round.claims ?? []);
  const evidence = state.evidence ?? [];
  const disputes = state.disputes ?? [];
  const byId = new Map(claims.map(claim => [claim.claimId, claim]));
  const conflicting = conflictingClaims(disputes);
  const contradictions = selfContradictions(claims);

  const judgments = claims.map(claim =>
    judgeClaim({
      claim,
      evidence,
      disputes,
      byId,
      conflicting,
      selfContradictory: contradictions.has(claim.claimId),
      at
    })
  );

  return { judgments, verdict: aggregate(state, judgments, claims, byId, at) };
}

/** 一条主张的三维判断。 */
export function judgeClaim(input: {
  claim: DebateClaim;
  evidence: readonly DebateEvidence[];
  disputes: readonly DebateDispute[];
  byId: ReadonlyMap<string, DebateClaim>;
  /** 卷进「证据互相冲突」这一类争议的主张。 */
  conflicting: ReadonlySet<string>;
  selfContradictory: boolean;
  at: number;
}): ClaimJudgment {
  const { claim } = input;
  const mine = evidenceForClaim(input.evidence, claim.claimId);
  const involved = input.disputes.filter(dispute => dispute.claimIds.includes(claim.claimId));

  const logic = judgeLogic(claim, input.selfContradictory);
  const evidence = judgeEvidence(claim, mine, input.conflicting.has(claim.claimId));
  const counterexample = judgeCounterexample(claim, involved, input.evidence);

  const { verdict, decidedBy, rationale } = combine(claim, logic, evidence, counterexample);

  return {
    // 固定 id：同一句主张重判多少次都是同一条记录，图里不会堆出重复的判断节点。
    judgmentId: `j-${claim.claimId}`,
    claimId: claim.claimId,
    agentId: claim.agentId,
    claimText: claim.text,
    dimensions: [logic, evidence, counterexample],
    verdict,
    decidedBy,
    rationale,
    evidenceIds: mine.map(item => item.evidenceId),
    minority: false,
    createdAt: input.at
  };
}

// ---------------------------------------------------------------------------
// 三个维度
// ---------------------------------------------------------------------------

/**
 * 逻辑裁判：这句话的推理成立吗？
 *
 * 判据只有三类，都很粗，但都能指着原话复核：绝对化措辞、推断句没有依据、
 * 同一位参与者前后自相矛盾。判不了的时候说「说不清」，不硬判对错。
 */
export function judgeLogic(claim: DebateClaim, selfContradictory = false): DimensionJudgment {
  const signals: string[] = [];
  const refs = { claimIds: [claim.claimId], messageIds: [claim.messageId] };

  // 问句不是主张，没有真假可判。
  if (claim.kind === 'question') {
    return {
      dimension: 'logic',
      outcome: 'not_applicable',
      rationale: '这是一句提问，不判真假',
      signals: ['问句'],
      evidenceIds: [],
      sourceRefs: refs
    };
  }

  if (selfContradictory) {
    return {
      dimension: 'logic',
      outcome: 'invalid',
      rationale: '同一位参与者在别处说过意思相反的话，两句不能同时成立',
      signals: ['同一参与者前后矛盾'],
      evidenceIds: [],
      sourceRefs: refs
    };
  }

  if (claim.kind === 'inference' && claim.assumptions.length === 0 && !REASONING.test(claim.text)) {
    signals.push('推断句没有给出依据');
  }
  if (ABSOLUTE.test(claim.text) && claim.assumptions.length === 0 && !CONDITION.test(claim.text)) {
    signals.push('绝对化措辞，没有写出成立条件');
  }
  if (claim.kind === 'prediction') signals.push('对未来结果的预测，当前无法验证');

  if (signals.length >= 2) {
    return {
      dimension: 'logic',
      outcome: 'questionable',
      rationale: `推理有两处以上说不通的地方：${signals.join('、')}`,
      signals,
      evidenceIds: [],
      sourceRefs: refs
    };
  }
  if (signals.length === 1) {
    return {
      dimension: 'logic',
      outcome: 'questionable',
      rationale: `推理有一处不够严谨：${signals[0]}`,
      signals,
      evidenceIds: [],
      sourceRefs: refs
    };
  }
  return {
    dimension: 'logic',
    outcome: 'valid',
    rationale:
      claim.assumptions.length > 0
        ? '写出了成立条件，推理链没有明显跳步'
        : '陈述句，没有出现绝对化断言或缺少依据的推断',
    signals: ['没有发现逻辑问题'],
    evidenceIds: [],
    sourceRefs: refs
  };
}

/**
 * 证据裁判：证据真实、相关、独立、充分吗？
 *
 * 关键区分是 `unverifiable` 与 `absent`：前者是「说了有出处，但没有可核验的
 * 地址」，后者是「连出处都没提」。两者都不能算 `sufficient`，但理由不同，
 * 补的东西也不同（前者补链接，后者补材料）。
 */
export function judgeEvidence(
  claim: DebateClaim,
  mine: readonly DebateEvidence[],
  evidenceConflicted = false
): DimensionJudgment {
  const refs = { claimIds: [claim.claimId], messageIds: [claim.messageId] };
  const ids = mine.map(item => item.evidenceId);

  if (mine.length === 0) {
    return {
      dimension: 'evidence',
      outcome: 'absent',
      rationale: '这句话没有任何来源，既没有链接也没有提到出处',
      signals: ['无来源'],
      evidenceIds: [],
      sourceRefs: refs
    };
  }

  if (evidenceConflicted) {
    return {
      dimension: 'evidence',
      outcome: 'conflicting',
      rationale: '同一件事上存在互相冲突的证据，规则版不替它们排先后',
      signals: ['证据互相冲突'],
      evidenceIds: ids,
      sourceRefs: refs
    };
  }

  const links = mine.filter(item => item.verified === 'page-link');
  const external = mine.filter(isExternal);

  if (links.length === 0) {
    return {
      dimension: 'evidence',
      outcome: 'unverifiable',
      rationale:
        external.length > 0
          ? '主张自称有出处，但页面没有给出可核验的链接——来源无法获取，不算已核验'
          : '只有数字或断言，没有可核验的来源',
      signals: external.map(item => `自称出处：${item.excerpt}`).slice(0, 3),
      evidenceIds: ids,
      sourceRefs: refs
    };
  }

  const relevant = links.filter(item => relevanceOf(item, claim.text) >= 0.5);
  const independent = independentSourceCount(mine, claim.claimId);
  const strong = relevant.filter(item => STRONG_KINDS.has(item.kind));
  const duplicates = mine.filter(item => !item.independent);

  const signals = [
    `可核验链接 ${String(links.length)} 条`,
    `独立来源 ${String(independent)} 个`,
    ...(duplicates.length > 0 ? [`同源重复 ${String(duplicates.length)} 条（不额外计数）`] : []),
    ...(relevant.length < links.length ? ['有链接与这句主张对不上'] : [])
  ];

  if (relevant.length === 0) {
    return {
      dimension: 'evidence',
      outcome: 'partial',
      rationale: '页面给了链接，但没有一条能对上这句话，不能算作这句的证据',
      signals,
      evidenceIds: ids,
      sourceRefs: refs
    };
  }
  if (strong.length === 0) {
    return {
      dimension: 'evidence',
      outcome: 'partial',
      rationale: '有可核验链接，但都是网页/博客一类材料，只能作为线索',
      signals,
      evidenceIds: ids,
      sourceRefs: refs
    };
  }
  if (independent === 0) {
    // 所有链接都同源：一条来源说三遍仍然是一条来源。
    return {
      dimension: 'evidence',
      outcome: 'partial',
      rationale: '链接都指向同一份材料，只能算一个来源，独立性不足',
      signals,
      evidenceIds: ids,
      sourceRefs: refs
    };
  }
  return {
    dimension: 'evidence',
    outcome: 'sufficient',
    rationale: `有 ${String(independent)} 个可核验的独立来源，其中包含官方文档/源码/实测一类材料`,
    signals,
    evidenceIds: ids,
    sourceRefs: refs
  };
}

/**
 * 反例裁判：有没有足以推翻或限制结论的反例？
 *
 * 只有「对方那句自己带着可核验的外部材料」才算 `refuted`；只是有人不同意，
 * 算 `limited`——不同意见是线索，不是反例。
 */
export function judgeCounterexample(
  claim: DebateClaim,
  disputes: readonly DebateDispute[],
  evidence: readonly DebateEvidence[]
): DimensionJudgment {
  const refs = {
    claimIds: [claim.claimId],
    messageIds: [claim.messageId],
    disputeIds: disputes.map(dispute => dispute.disputeId)
  };
  if (disputes.length === 0) {
    return {
      dimension: 'counterexample',
      outcome: 'none',
      rationale: '没有找到针对这句的反例或不同说法',
      signals: [],
      evidenceIds: [],
      sourceRefs: refs
    };
  }

  const scored: Array<{ outcome: CounterexampleOutcome; why: string; ids: string[] }> = [];
  for (const dispute of disputes) {
    const otherId = dispute.claimIds.find(id => id !== claim.claimId);
    const otherEvidence = otherId ? evidenceForClaim(evidence, otherId) : [];
    const verified = otherEvidence.filter(item => item.verified === 'page-link' && item.independent);
    const strong = verified.filter(item => STRONG_KINDS.has(item.kind));
    if (strong.length > 0 && dispute.type === 'factual') {
      scored.push({
        outcome: 'refuted',
        why: `对方给出了可核验的${strong[0].kind === 'source-code' ? '源码' : strong[0].kind === 'official-doc' ? '官方文档' : '材料'}并指向相反结论`,
        ids: strong.map(item => item.evidenceId)
      });
      continue;
    }
    if (dispute.type === 'scope') {
      scored.push({
        outcome: 'limited',
        why: '对方指出这句话的适用范围不对，结论需要加条件',
        ids: []
      });
      continue;
    }
    if (verified.length > 0) {
      // 有链接、但只是网页/博客一类材料：构成限制，够不上反证。
      scored.push({
        outcome: 'limited',
        why: '对方给了可核验的材料，但材料本身不足以直接推翻这句',
        ids: verified.map(item => item.evidenceId)
      });
      continue;
    }
    // 单纯的不同说法不是反例：没有材料，就没有推翻的力量。记在 signals 里
    // 让人看见「有人反对」，但不用它压结论。
    scored.push({
      outcome: 'none',
      why: '对方提出了不同说法，但没有给出可核验的材料',
      ids: []
    });
  }

  const refuted = scored.find(item => item.outcome === 'refuted');
  if (refuted) {
    return {
      dimension: 'counterexample',
      outcome: 'refuted',
      rationale: refuted.why,
      signals: scored.map(item => item.why).slice(0, 3),
      evidenceIds: refuted.ids,
      sourceRefs: refs
    };
  }
  const limited = scored.find(item => item.outcome === 'limited');
  if (limited) {
    return {
      dimension: 'counterexample',
      outcome: 'limited',
      rationale: limited.why,
      signals: scored.map(item => item.why).slice(0, 3),
      evidenceIds: limited.ids,
      sourceRefs: refs
    };
  }
  return {
    dimension: 'counterexample',
    outcome: 'none',
    rationale: scored[0]?.why ?? '没有找到针对这句的反例',
    signals: scored.map(item => item.why).slice(0, 3),
    evidenceIds: [],
    sourceRefs: refs
  };
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

/**
 * 三维 → 五档。**没有分数、没有平均、没有票数**。
 *
 * 顺序就是优先级，读一遍就能复核：
 *
 * 1. 有可核验的反证 → `contradicted`（这是唯一能直接否掉一句的维度）；
 * 2. 证据互相冲突 → `insufficient_evidence`（两边都有材料，规则不替它们排先后）；
 * 3. 逻辑不成立 → 有证据时 `partially_supported`（结论可能对，推理不成立），
 *    没证据时 `unsupported`；
 * 4. 没有可核验证据 → `insufficient_evidence`（**不是** `unsupported`：
 *    「判不了」和「是错的」是两件事）；
 * 5. 证据部分成立 → `partially_supported`；
 * 6. 证据充分但反例只构成限制，或逻辑仍有瑕疵 → `partially_supported`；
 * 7. 以上都没有 → `supported`。
 */
export function combine(
  claim: DebateClaim,
  logic: DimensionJudgment,
  evidence: DimensionJudgment,
  counterexample: DimensionJudgment
): { verdict: Verdict; decidedBy: JudgeDimension[]; rationale: string } {
  const logicOutcome = logic.outcome as LogicOutcome;
  const evidenceOutcome = evidence.outcome as EvidenceOutcome;
  const counterOutcome = counterexample.outcome as CounterexampleOutcome;

  if (logicOutcome === 'not_applicable') {
    return {
      verdict: 'insufficient_evidence',
      decidedBy: ['logic'],
      rationale: '这不是一句可判真假的陈述，没有结论可下'
    };
  }
  if (counterOutcome === 'refuted') {
    return {
      verdict: 'contradicted',
      decidedBy: ['counterexample'],
      rationale: `反例裁判给出了可核验的反证：${counterexample.rationale}`
    };
  }
  if (evidenceOutcome === 'conflicting') {
    return {
      verdict: 'insufficient_evidence',
      decidedBy: ['evidence'],
      rationale: '证据互相冲突，规则版不判定哪一边成立，留给人工复核'
    };
  }
  if (logicOutcome === 'invalid') {
    return evidenceOutcome === 'sufficient'
      ? {
          verdict: 'partially_supported',
          decidedBy: ['logic'],
          rationale: '证据可核验，但这句的推理不成立，只能接受其中被证据直接支持的部分'
        }
      : {
          verdict: 'unsupported',
          decidedBy: ['logic'],
          rationale: `推理不成立（${logic.rationale}），也没有可核验的证据支撑结论`
        };
  }
  if (evidenceOutcome === 'absent' || evidenceOutcome === 'unverifiable') {
    return {
      verdict: 'insufficient_evidence',
      decidedBy: ['evidence'],
      rationale:
        evidenceOutcome === 'absent'
          ? '没有任何可核验的证据，判不了真假——这不是「错」，是「证据不足」'
          : '关键证据无法获取（只有说法、没有可核验地址），判不了真假'
    };
  }
  if (evidenceOutcome === 'partial') {
    return {
      verdict: 'partially_supported',
      decidedBy: ['evidence'],
      rationale: `证据只支持到一部分：${evidence.rationale}`
    };
  }
  // 证据充分。反例只构成限制或逻辑有瑕疵时，降半档而不是直接判成立。
  if (counterOutcome === 'limited') {
    return {
      verdict: 'partially_supported',
      decidedBy: ['counterexample'],
      rationale: '证据可核验，但存在适用范围上的反例，结论需要加条件'
    };
  }
  if (logicOutcome === 'questionable') {
    return {
      verdict: 'partially_supported',
      decidedBy: ['logic'],
      rationale: `证据可核验，但推理仍有瑕疵：${logic.rationale}`
    };
  }
  if (claim.kind === 'assumption' || claim.kind === 'prediction') {
    return {
      verdict: 'partially_supported',
      decidedBy: ['logic'],
      rationale: '这是前提或预测，即使有证据也只能算部分成立'
    };
  }
  return {
    verdict: 'supported',
    decidedBy: ['evidence'],
    rationale: `证据可核验且独立：${evidence.rationale}`
  };
}

/**
 * 整场结论。
 *
 * 不用票数选「哪一方赢」：一条一条主张看谁被判成 `supported`。两边都被支持
 * 且互相矛盾时，整场结论是 `insufficient_evidence`——分歧没有被解决，不挑一个
 * 好看的说法当结论。
 */
function aggregate(
  state: DebateState,
  judgments: ClaimJudgment[],
  claims: readonly DebateClaim[],
  byId: ReadonlyMap<string, DebateClaim>,
  at: number
): DebateVerdict {
  // 老辩论文件没有 minorities 字段也读得动：缺了就是「没记录过少数派」，
  // 不因此让整场裁判崩掉。
  const minorityMessages = new Set((state.minorities ?? []).map(message => message.messageId));
  const judged = judgments.filter(judgment => {
    const logic = judgment.dimensions.find(item => item.dimension === 'logic');
    return logic?.outcome !== 'not_applicable';
  });

  const withMinority = judged.map(judgment => {
    const claim = byId.get(judgment.claimId);
    return {
      ...judgment,
      minority: claim ? minorityMessages.has(claim.messageId) : false
    };
  });

  const supported = withMinority.filter(item => item.verdict === 'supported');
  const partial = withMinority.filter(item => item.verdict === 'partially_supported');
  const contradicted = withMinority.filter(item => item.verdict === 'contradicted');
  const unsupported = withMinority.filter(item => item.verdict === 'unsupported');

  const conflicts = unresolvedConflicts(state, withMinority);
  const unresolved = withMinority
    .filter(item => item.verdict === 'insufficient_evidence' || item.verdict === 'unsupported')
    .map(item => `${item.claimText.slice(0, 40)}：${item.verdict === 'insufficient_evidence' ? '证据不足' : '没有支持'}`)
    .slice(0, 6);

  const base = {
    verdictId: `v-${state.debateId}`,
    debateId: state.debateId,
    createdAt: at,
    claimJudgments: withMinority,
    note: '这份结论来自规则裁判，逐条判断，没有用模型数量或票数；结论可以不收敛'
  };

  if (judged.length === 0) {
    return {
      ...base,
      verdict: 'insufficient_evidence',
      conclusion: null,
      dimensions: [
        {
          dimension: 'logic',
          outcome: 'not_applicable',
          rationale: '这场辩论里没有可判真假的主张',
          signals: [],
          evidenceIds: []
        }
      ],
      rationale: '没有可判真假的主张，无法给出结论',
      minorityWins: false,
      unresolved: ['没有抽出可判真假的主张'],
      backend: 'rules'
    };
  }

  // 两边的主张都被支持、且互相矛盾：这是「分歧没解决」，不是「多数派赢了」。
  if (conflicts.length > 0) {
    return {
      ...base,
      verdict: 'insufficient_evidence',
      conclusion: null,
      dimensions: dimensionsOf(withMinority.find(item => item.verdict === 'insufficient_evidence') ?? withMinority[0]),
      rationale: `有 ${String(conflicts.length)} 处争议的双方都拿到了可核验支持，规则版不替它们定胜负`,
      minorityWins: false,
      unresolved: [...conflicts, ...unresolved],
      backend: 'rules'
    };
  }

  const pick = chooseConclusion(supported, partial);
  const verdict: Verdict = supported.length > 0
    ? 'supported'
    : partial.length > 0
      ? 'partially_supported'
      : contradicted.length > 0
        ? 'contradicted'
        : unsupported.length > 0
          ? 'unsupported'
          : 'insufficient_evidence';

  const chosen = pick ?? contradicted[0] ?? unsupported[0] ?? withMinority[0];
  const minorityWins = Boolean(pick && pick.minority);

  return {
    ...base,
    verdict,
    conclusion: pick ? pick.claimText : null,
    conclusionClaimId: pick?.claimId,
    dimensions: dimensionsOf(chosen),
    rationale: pick
      ? pick.rationale
      : verdict === 'contradicted'
        ? '有主张被可核验的反证推翻'
        : verdict === 'unsupported'
          ? '现有主张都缺少证据支持，且推理存在问题'
          : '现有主张都判不了真假，证据不足',
    minorityWins,
    minorityReason: minorityWins
      ? '被支持的结论来自少数派发言；它靠的是可核验的独立来源，不是人数'
      : undefined,
    unresolved,
    backend: 'rules'
  };
}

/**
 * 选作结论的那一条。
 *
 * 优先 `supported`，其次 `partially_supported`；同一档里优先带可核验链接的，
 * 再按 claimId 排序。**排序里没有任何「多少人说」的输入。**
 */
function chooseConclusion(
  supported: ClaimJudgment[],
  partial: ClaimJudgment[]
): ClaimJudgment | null {
  const rank = (item: ClaimJudgment): number => {
    const evidence = item.dimensions.find(dimension => dimension.dimension === 'evidence');
    const linked = evidence?.outcome === 'sufficient' ? 1 : 0;
    return linked;
  };
  const pickFrom = (list: ClaimJudgment[]): ClaimJudgment | null =>
    [...list].sort((a, b) => rank(b) - rank(a) || a.claimId.localeCompare(b.claimId))[0] ?? null;
  return pickFrom(supported) ?? pickFrom(partial);
}

function dimensionsOf(judgment: ClaimJudgment | undefined): DimensionJudgment[] {
  return judgment ? judgment.dimensions : [];
}

/** 争议两边都被判成「成立/部分成立」的那些——真正的未解决分歧。 */
function unresolvedConflicts(state: DebateState, judgments: readonly ClaimJudgment[]): string[] {
  const verdictOf = new Map(judgments.map(item => [item.claimId, item.verdict]));
  const lines: string[] = [];
  for (const dispute of state.disputes ?? []) {
    const [first, second] = dispute.claimIds;
    const left = verdictOf.get(first);
    const right = verdictOf.get(second);
    const supportedEnough = (value: Verdict | undefined): boolean =>
      value === 'supported' || value === 'partially_supported';
    if (!supportedEnough(left) || !supportedEnough(right)) continue;
    lines.push(`「${short(dispute.reason)}」两边都有支持，尚未裁决`);
  }
  return lines.slice(0, 4);
}

function conflictingClaims(disputes: readonly DebateDispute[]): Set<string> {
  const found = new Set<string>();
  for (const dispute of disputes) {
    if (dispute.type !== 'evidence_conflict') continue;
    for (const claimId of dispute.claimIds) found.add(claimId);
  }
  return found;
}

/**
 * 同一位参与者前后矛盾的那几句。
 *
 * 判据：两句都在，主题高度相似（bigram 相似度 ≥ 0.45），否定词数量不同。
 * 这是弱判据，所以只用来把「推理不成立」标出来，不用来定谁对。
 */
function selfContradictions(claims: readonly DebateClaim[]): Set<string> {
  const found = new Set<string>();
  const byAgent = new Map<string, DebateClaim[]>();
  for (const claim of claims) {
    const list = byAgent.get(claim.agentId) ?? [];
    list.push(claim);
    byAgent.set(claim.agentId, list);
  }
  for (const list of byAgent.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const left = list[i];
        const right = list[j];
        if (negationCount(left.text) === negationCount(right.text)) continue;
        if (jaccard(features(left.text), features(right.text)) < SAME_TOPIC) continue;
        found.add(left.claimId);
        found.add(right.claimId);
      }
    }
  }
  return found;
}

/** 证据与主张的相关性：引用片段出现在这句话里就是直接相关。 */
function relevanceOf(evidence: DebateEvidence, claimText: string): number {
  const excerpt = evidence.excerpt.trim();
  if (!excerpt) return 0;
  if (claimText.includes(excerpt)) return 1;
  if (excerpt.includes(claimText.slice(0, Math.min(12, claimText.length)))) return 0.6;
  const overlap = jaccard(features(excerpt), features(claimText));
  return overlap >= 0.18 ? 0.6 : overlap >= 0.08 ? 0.4 : 0.2;
}

function short(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}
