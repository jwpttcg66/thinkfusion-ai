import {
  toSynthesis,
  type Evidence,
  type FusedClaim,
  type FusionInput,
  type FusionReport
} from '../../shared/fusion';
import type { Gap, Synthesis } from '../../shared/conversation';
import type { JudgeVerdict } from '../judge/types';
import { extractClaims } from './claim-extractor';
import { clusterClaims } from './clusterer';
import { detectRelations } from './relations';
import { buildEvidence } from './evidence';
import { rankClaims } from './ranker';

/**
 * 本地观点融合引擎（架构文档 11.2 的阶段 8）。
 *
 * 五个阶段串成一条链：抽取 → 聚类 → 关系 → 证据 → 排序 → 合成。
 * 每一步都只用它前面那一步的产物，没有跨阶段的隐含状态。
 *
 * 两条不可越过的线：
 *
 * - **没有跨通道共识必须 `degraded: true`**，不能把两份平行回答包装成一致。
 * - 排序分数只决定先讲哪个，不声明哪个是真的；`support` 是独立通道数，
 *   同一通道重复说三遍仍然算 1。
 */
export interface FusionOptions {
  /** Phase H 的裁决。没有时综合报告会明写「未经裁决」。 */
  verdict?: JudgeVerdict;
}

const LIMITS = [
  '本地规则只比较文本，不验证外部事实',
  'timeliness 判不了：没有联网，不知道材料什么时候发布',
  '没有 NLI，字面相似不等于逻辑等价，否定句靠极性判据粗判',
  '证据的「被复核」只表示另一个通道说过同样的话，不表示已证实',
  '排序只决定先讲哪个，不声明哪个是真的'
];

export function fuse(inputs: FusionInput[], options: FusionOptions = {}): FusionReport {
  const extracted = inputs.flatMap(input => extractClaims(input));
  if (extracted.length === 0) {
    return emptyReport('没有从回答里抽出可独立判断的观点');
  }

  const clusters = clusterClaims(extracted);
  const relations = detectRelations(extracted);
  const evidence: Evidence[] = buildEvidence(extracted, relations);

  const supports = new Map<string, number>();
  const clusterOf = new Map<string, string>();
  clusters.forEach((cluster, index) => {
    for (const claim of cluster.claims) {
      supports.set(claim.id, cluster.channels.size);
      clusterOf.set(claim.id, `cluster-${index}`);
    }
  });

  const ranks = rankClaims(extracted, relations, evidence, supports);
  const fused: FusedClaim[] = extracted.map(claim => ({
    id: claim.id,
    text: claim.text,
    kind: claim.kind,
    sources: [{ channelId: claim.channelId, messageId: claim.messageId }],
    span: claim.span,
    evidence: claim.evidence.map(draft => draft.excerpt),
    evidenceIds: evidence.filter(item => item.claims.includes(claim.id)).map(item => item.id),
    assumptions: claim.assumptions,
    support: supports.get(claim.id) ?? 1,
    rank: ranks.get(claim.id) ?? 0
  }));
  const byId = new Map(fused.map(claim => [claim.id, claim]));

  const consensus = clusters
    .filter(cluster => cluster.channels.size >= 2)
    .map(cluster => byId.get(cluster.representative.id))
    .filter((claim): claim is FusedClaim => Boolean(claim));
  const unique = clusters
    .filter(cluster => cluster.channels.size === 1)
    .map(cluster => byId.get(cluster.representative.id))
    .filter((claim): claim is FusedClaim => Boolean(claim));

  const disputes = relations.filter(edge => edge.kind === 'contradicts' || edge.kind === 'attacks');
  const disputed = [...new Set(disputes.flatMap(edge => [edge.from, edge.to]))]
    .map(id => byId.get(id))
    .filter((claim): claim is FusedClaim => Boolean(claim));

  // 「被否定观点」保留原文，只是标出来。删掉它们才是真的丢证据。
  const rejected = disputes
    .map(edge => ({ edge, claim: byId.get(edge.to) }))
    .filter((item): item is { edge: typeof disputes[number]; claim: FusedClaim } => Boolean(item.claim))
    .map(({ edge, claim }) => ({
      text: claim.text,
      why: `与另一条观点冲突（${edge.kind}）：${edge.reason}`
    }));

  const gaps: Gap[] = fused
    .filter(claim => claim.evidence.length === 0)
    .slice(0, 4)
    .map(claim => ({
      topic: claim.text.slice(0, 30),
      why: '这条观点没有附带可核查的依据片段'
    }));
  for (const item of options.verdict?.unresolved ?? []) {
    gaps.push({ topic: item.question.slice(0, 30), why: item.why });
  }

  const verdict = options.verdict;
  const rankedConsensus = [...consensus].sort((a, b) => b.rank - a.rank);
  // 共识门槛是「至少两个通道」（见上面的 cluster.channels.size >= 2），
  // 不是「所有通道」。四个通道里两个都提到一句，也照样算共识——所以这句
  // 必须带上几分之几：写成「多通道共同提到的」，读起来像全体一致。
  const channelsOf = new Map<string, number>();
  for (const cluster of clusters) channelsOf.set(cluster.representative.id, cluster.channels.size);
  // 分母是「这一轮有几份回答」，不是「抽出过观点的通道数」：某份回答没抽出
  // 可判的句子，不代表它没回答过这个问题。
  const totalChannels = new Set(inputs.map(item => item.channelId)).size;
  let recommendation: string;
  if (verdict && !verdict.undetermined && verdict.conclusion) {
    recommendation = verdict.conclusion;
  } else if (rankedConsensus.length > 0) {
    const top = rankedConsensus[0];
    const agreed = channelsOf.get(top.id) ?? 0;
    recommendation = agreed >= totalChannels
      ? `所有 ${totalChannels} 个通道都提到：${top.text}`
      : `${agreed}/${totalChannels} 个通道提到：${top.text}`;
  } else {
    recommendation = '没有跨通道共识，下面只是各通道的回答并列，不能当成一致结论。';
  }

  const degraded = consensus.length === 0;
  const report: FusionReport = {
    backend: 'local',
    claims: fused,
    evidence,
    relations,
    consensus,
    disputed,
    unique,
    gaps,
    overlap: clusters.length > 0 ? clusters.map(cluster => cluster.representative.text.slice(0, 30)) : [],
    recommendation,
    degraded,
    limits: [...LIMITS],
    finalDecision: verdict?.conclusion ?? null,
    undetermined: verdict ? verdict.undetermined : true,
    confidence: verdict?.confidence ?? {
      level: 'low',
      why: '本地规则只比较文本，不验证外部事实；未经独立裁决'
    },
    rejected,
    unresolvedQuestions: (verdict?.unresolved ?? []).map(item => ({ question: item.question, why: item.why })),
    debateId: verdict?.debateId
  };
  return report;
}

/** 同一套输入，既能给界面旧的 Synthesis，也能给新的 FusionReport。 */
export function synthesizeWithFusion(inputs: FusionInput[], options: FusionOptions = {}): {
  report: FusionReport;
  synthesis: Synthesis;
} {
  const report = fuse(inputs, options);
  return { report, synthesis: toSynthesis(report) };
}

function emptyReport(why: string): FusionReport {
  return {
    backend: 'local',
    claims: [],
    evidence: [],
    relations: [],
    consensus: [],
    disputed: [],
    unique: [],
    gaps: [{ topic: '抽取', why }],
    overlap: [],
    recommendation: '这次没有可比较的观点，只保留原始回答。',
    degraded: true,
    limits: [...LIMITS, why],
    finalDecision: null,
    undetermined: true,
    confidence: { level: 'low', why },
    rejected: [],
    unresolvedQuestions: []
  };
}

/** 给上层判断「这份证据是不是只来自一条通道」。 */
export function independenceOf(evidence: Evidence[], claimId: string): number {
  const mine = evidence.filter(item => item.claims.includes(claimId));
  if (mine.length === 0) return 0;
  return Math.max(...mine.map(item => item.scores.independence));
}

