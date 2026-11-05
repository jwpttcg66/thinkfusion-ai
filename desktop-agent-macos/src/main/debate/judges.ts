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

/**
 * 绝对化措辞分两类，别混在一起判。
 *
 * - `CERTAINTY` 是**认识性强断言**（绝对、肯定、从来……）：说话人声称确定无疑，
 *   没有成立条件时确实该提示「推理不够严谨」。
 * - `UNIVERSAL` 是**全称量词**（所有、任何）：中文里它经常只是合法的量化范围，
 *   例如「所有 HTTP/1.1 请求都必须带 Host 头」是协议规范陈述，不是过度概括。
 *   真机跑出来过一个更隐蔽的误伤：「任何情况下都不应该关闭校验」被判 questionable。
 *   所以规范/定义/义务句里的全称量词豁免，其余（「任何版本都可以」）照旧标记。
 */
const CERTAINTY = /(一定|必然|绝对|肯定|毫无疑问|显然|从来|永远)/;
const UNIVERSAL = /(所有|任何|全部|每一个)/;
/** 规范、定义、义务、要求：这类句子里的「所有/任何」是在划定适用范围。 */
const NORMATIVE = /(必须|应当|应该|不得|不允许|规定|标准|规范|定义为|是指|指的是|一律|均需|都要求|按要求)/;
/**
 * 含「一定」但不是强断言的固定搭配。真机跑出来「WAL 模式在一定程度上提高
 * 并发读取性能」被判 questionable——「一定」来自「在一定程度上」，恰恰是
 * 在**限定**程度，与绝对化的意思相反。判强断言前先剔除这些短语。
 */
const NOT_CERTAINTY = /(在一定程度上|一定程度|一定条件|一定范围|一定程度上)/g;
const REASONING = /(因为|由于|所以|因此|据此|由此可见|说明|意味着|得出|由此)/;
const CONDITION = /(如果|假如|若|当|仅在|只有在|取决于|前提|条件是|适用范围)/;

/**
 * 空洞推理：有连接词不等于有依据。
 *
 * 原来 `REASONING` 一命中就认为「推理链有依据」，于是「因为大家都这么说」
 * 「因为它是可靠的」这类句子全部判 valid。规则读不懂推理，但**读得出空话**：
 * 诉诸众人有固定说法，循环论证则是把结论换个说法当理由。
 */
const APPEAL = /(大家都|众所周知|人人都|普遍认为|一般来说|一般认为|据说|听说|按理说|向来如此|一直如此|反正)/;

/**
 * 版本线索：只认**明确标注为版本**的数字。
 *
 * 吃过一次假阳性：主张「所有 HTTP/1.1 请求都必须带 Host 头」里的 1.1 是协议
 * 版本，来源标题「RFC 7230 Section 5.4」里的 5.4 是章节号，两边比对后被判成
 * 「版本对不上」。裸小数一律不算；要有 `v` 前缀、`版本/version` 字样，或中文
 * 版本语境（在 7.0 里 / 6.0 之前）才认。
 */
const VERSION_TOKEN =
  /(?:^|[^A-Za-z0-9.])(?:v|V|版本\s*|version\s*)(\d+\.\d+(?:\.\d+)?)|(?:在|自|从)\s*(\d+\.\d+(?:\.\d+)?)\s*(?:里|中|之前|之后|起|开始|版本)|(?:^|[^\d.])(\d+\.\d+(?:\.\d+)?)\s*(?:之前|之后|以前|以后)/gu;
/** 标题里明说这是旧材料。注意不能用 fetchedAt：那是抓取时间，不是发布时间。 */
const STALE_TITLE = /(归档|存档|旧版|历史版本|已废弃|已过时|deprecated|legacy|archived)/i;
const CURRENT_WORDING = /(当前|最新|现在|目前|现版本)/;

/**
 * 判「前后矛盾」的阈值：去掉否定词后两句话的相似度。
 *
 * 0.45 是实测出来的分界：真改口（「支持并发写入，可以放心用」对「不支持并发
 * 写入，会丢数据」）去掉否定词后约 0.47，不同范围的两句（「不适合高并发」对
 * 「适合读多写少」）只有约 0.06。真正防误判的是「写了适用范围就不算改口」
 * 那条规则，阈值只负责挡掉话题都不一样的句子。
 */
const FLIP_FLOP = 0.45;

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

  const hollow = hollowReason(claim.text);
  // 「在一定程度上」里的「一定」不是强断言，判措辞前先剔除固定搭配。
  const wording = claim.text.replace(NOT_CERTAINTY, '');
  if (claim.kind === 'inference' && claim.assumptions.length === 0 && !REASONING.test(claim.text)) {
    signals.push('推断句没有给出依据');
  }
  // 连接词只是「看起来像在推理」。理由本身是诉诸众人或同义反复时，照样算没有依据。
  if (hollow) signals.push(hollow);
  const overclaim =
    CERTAINTY.test(wording) ||
    (UNIVERSAL.test(wording) && !NORMATIVE.test(wording));
  if (overclaim && claim.assumptions.length === 0 && !CONDITION.test(claim.text)) {
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
  const scopeMismatch = evidenceScopeMismatch(claim, links);
  if (scopeMismatch) {
    return {
      dimension: 'evidence',
      outcome: 'partial',
      rationale: scopeMismatch,
      signals: [...signals, scopeMismatch],
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
      // 范围限制落在「没写范围的那句」上。已经写明「在 6.0 之前」的主张，
      // 对方再给一个不同范围，不构成对它的限制——否则自带条件的一方永远
      // 只能拿到 partially_supported，而它恰恰是把边界说清楚的那一句。
      const qualified = claim.assumptions.length > 0 || CONDITION.test(claim.text);
      scored.push(
        qualified
          ? {
              outcome: 'none',
              why: '对方给了不同的适用范围，但这句已经写明了自己的范围',
              ids: []
            }
          : {
              outcome: 'limited',
              why: '对方指出这句话的适用范围不对，结论需要加条件',
              ids: []
            }
      );
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
  const insufficient = withMinority.filter(item => item.verdict === 'insufficient_evidence');
  /**
   * 什么时候整场才算「不成立」。
   *
   * 只有**每一条**被判过的主张都推理不成立时才这么判。以前是「只要有一条
   * unsupported 就算」——真机跑一场 62 条主张里 2 条自相矛盾、60 条只是没有
   * 来源，结论就被写成「不成立」。那等于把「判不了」也算成「错」，正好违背
   * AC-13 要求分清的两件事。
   */
  const allUnsupported = unsupported.length > 0 && insufficient.length === 0;
  const verdict: Verdict = supported.length > 0
    ? 'supported'
    : partial.length > 0
      ? 'partially_supported'
      : contradicted.length > 0
        ? 'contradicted'
        : allUnsupported
          ? 'unsupported'
          : 'insufficient_evidence';

  const chosen = pick ?? contradicted[0] ??
    (verdict === 'unsupported' ? unsupported[0] : insufficient[0] ?? unsupported[0] ?? withMinority[0]);
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
          : unsupported.length > 0
            ? `有 ${String(unsupported.length)} 条主张推理不成立，其余 ${String(insufficient.length)} 条证据不足；整体判不了`
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
 * 判据刻意收紧过一次：真机跑出来发现「SQLite 不适合高并发」和「SQLite 适合
 * 读多写少的场景」被判成前后矛盾，于是整场结论从「证据不足」变成「不成立」。
 * 两句说的是不同范围，不是改口。
 *
 * 现在要同时满足三条：
 *
 * 1. 否定词数量不同；
 * 2. **两句都没有写适用范围**——写了 `在 6.0 之前` 这类条件，就说明差异来自
 *    范围，不是来自改口；
 * 3. 把否定词去掉之后两句话几乎一样（bigram 相似度 ≥ 0.7）。这样「支持并发
 *    写入」与「不支持并发写入」会命中，「不适合高并发」与「适合读多写少」
 *    不会。
 *
 * 仍然是弱判据，只用来标「这句推理不成立」，不用来定谁对。
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
        // 同一条发言里的两句不算「前后」矛盾：质疑者会把对方的说法和自己的
        // 判断写在同一条里（「你说支持，但它其实不适合」），照字面比会把它
        // 判成改口。前后矛盾的前提是「先说过一句，后来又说反了」。
        if (left.messageId === right.messageId) continue;
        if (negationCount(left.text) === negationCount(right.text)) continue;
        // 写了范围就说明两句不是同一条件下的判断。
        if (left.assumptions.length > 0 || right.assumptions.length > 0) continue;
        const polarityFree = jaccard(features(stripNegation(left.text)), features(stripNegation(right.text)));
        if (polarityFree < FLIP_FLOP) continue;
        found.add(left.claimId);
        found.add(right.claimId);
      }
    }
  }
  return found;
}

/** 去掉否定词，剩下的部分越像，越可能只是立场反了。 */
function stripNegation(text: string): string {
  return text.replace(/[不没未无非别]/g, '');
}

/**
 * 「因为」后面那一截是不是空话。
 *
 * 只认两类能指着字面复核的：
 *
 * 1. 诉诸众人（大家都这么说 / 众所周知 / 据说）——理由是别人的意见，不是依据；
 * 2. 循环论证——把结论换个说法当理由。判据是连接词两边**用字**重合度 ≥ 0.45
 *    且理由不比结论长多少。bigram 在这里不管用：「它很可靠」与「它是可靠的」
 *    只共享一个 bigram（0.167），但谁都看得出那是同义反复。
 *    「因为命令执行是单线程的，所以并发写入会互相阻塞」用字重合约 0.1，放行。
 *
 * 读不懂的推理一律放行：规则版宁可漏判，也不凭一个「因为」就宣布推理成立
 * 或倒过来随便扣分。
 */
function hollowReason(text: string): string | null {
  const match = text.match(/^(.{2,}?)(?:因为|由于|所以|因此|据此|由此可见)(.{2,}?)[。！？!?]?$/u);
  if (!match) return null;
  const [, head, tail] = match;
  if (APPEAL.test(tail) || APPEAL.test(head)) return '理由只是「大家都这么说」一类说法，没有给出依据';
  const a = stripNegation(head).replace(/[，,。；;：:、\s]/gu, '');
  const b = stripNegation(tail).replace(/[，,。；;：:、\s]/gu, '');
  if (a.length < 4 || b.length < 4 || b.length > a.length + 4) return null;
  if (characterOverlap(a, b) >= 0.45) return '理由只是把结论换个说法（循环论证），没有给出依据';
  return null;
}

/** 两段中文用字的 Jaccard 重合度（去重后比集合，词序不敏感）。 */
function characterOverlap(a: string, b: string): number {
  const left = new Set([...a]);
  const right = new Set([...b]);
  let shared = 0;
  for (const char of left) if (right.has(char)) shared += 1;
  const union = left.size + right.size - shared;
  return union > 0 ? shared / union : 0;
}

/**
 * 版本/时效性冲突（任务书 7.3）。
 *
 * 只在**两边都写明了版本**且对不上时才提示：主张说「在 7.0 里」，来源标题是
 * 「v1.0 手册（已归档）」，这条材料不能直接支撑这句结论。没写版本就不猜——
 * `fetchedAt` 是我们读到的时间，不是文档的发布时间，拿它判断「过期」是编的。
 *
 * 返回人话理由，供证据维度写进 rationale；没有冲突返回 null。
 */
function evidenceScopeMismatch(claim: DebateClaim, links: readonly DebateEvidence[]): string | null {
  const scope = `${claim.text} ${(claim.assumptions ?? []).join(' ')}`;
  const claimVersions = versionsIn(scope);
  for (const item of links) {
    const title = item.pageTitle ?? '';
    // 只认标题里写明的版本。引文片段里提到「6.0 之前」不代表这份材料是 6.0
    // 的文档——把 excerpt 也算进来会让「引文里恰好有主张版本」抵消掉真冲突。
    const sourceVersions = versionsIn(title);
    if (
      claimVersions.length > 0 && sourceVersions.length > 0 &&
      !claimVersions.some(version => sourceVersions.includes(version))
    ) {
      return `主张讨论的是 ${claimVersions.join('、')}，来源标注的却是 ${sourceVersions.join('、')}：版本对不上，需要同版本材料`;
    }
    if (STALE_TITLE.test(title) && CURRENT_WORDING.test(scope)) {
      return '来源标题写明是归档/旧版材料，主张问的是当前版本，时效性不足';
    }
  }
  return null;
}

/** 抽出文本里明确写成的版本号：`v7.0` / `版本 4.1.50` / `在 6.0 之前`。 */
function versionsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(VERSION_TOKEN)) {
    const version = match[1] ?? match[2] ?? match[3];
    if (version) found.push(version);
  }
  return [...new Set(found)];
}

/**
 * 证据与主张的相关性：引用片段出现在这句话里就是直接相关。
 *
 * 例外是页面气泡里 1:1 唯一关联的引用（`soleAttribution`）。网页引用常画成
 * 上标或 chip，锚文字（「RFC 7230」「参考」）不会原文出现在主张里；这时关联
 * 是页面给出的，再用字面重合否掉它，等于把网页通道的引用全判成不相关。
 * 内容是否真的支持该句仍需人读——`assessment` 里写明了。
 */
function relevanceOf(evidence: DebateEvidence, claimText: string): number {
  if (evidence.soleAttribution) return 1;
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
