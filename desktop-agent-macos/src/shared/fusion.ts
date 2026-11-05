import type { Claim, Dispute, Gap, Synthesis } from './conversation';

/**
 * 观点融合的协议。
 *
 * 这里是 `docs/ARCHITECTURE.md` 第 11.3 节那份协议的落地版本，只落地了能被本地
 * 算法算出来的部分：抽取（含类型与原文位置）、聚类、关系、证据分维度。
 *
 * 与 `conversation.ts` 里那份 `Claim` 的关系是「长大」而不是「替换」：
 * `FusedClaim` 结构上满足 `Claim`（text / sources / evidence 三个字段不变），
 * 多出来的字段是这一层自己的。这样今天落库、明天上线都读得出来，不需要一次
 * 数据迁移。
 */

/** 一条观点的类型。一条句子里事实、推断、建议的地位不一样，不能同等计票。 */
export type ClaimKind = 'fact' | 'inference' | 'assumption' | 'recommendation' | 'prediction' | 'question';

/**
 * 原话在哪：哪条消息、第几个字符到第几个字符。
 *
 * 三个字段缺一个，「有出处」就只是装饰——只有 messageId 能跳回整段回答，
 * 找不到具体那一句。
 */
export interface ClaimSpan {
  messageId: string;
  start: number;
  end: number;
}

/**
 * 七种关系，够了。再加就会开始争论「这条算 supports 还是 refines」。
 *
 * 刻意没有 `unrelated`：边表里没有就是没关系。给它一个类型，代价是每条边表
 * 多一半零信息行。
 */
export type RelationKind =
  | 'supports'
  | 'attacks'
  | 'contradicts'
  | 'refines'
  | 'qualifies'
  | 'depends_on'
  | 'evidenced_by';

export interface ArgumentRelation {
  /** 起点：claim id。 */
  from: string;
  /** 终点：claim id；`evidenced_by` 时指向 evidence id。 */
  to: string;
  kind: RelationKind;
  /** 0–1。低置信度的边留在图里，但排序时不该当它和 0.9 的边一样重。 */
  confidence: number;
  /** 凭什么判成这个关系。没有这一句，图就是一张凭感觉画的图。 */
  reason: string;
}

export type EvidenceKind = 'official-doc' | 'source-code' | 'paper' | 'benchmark' | 'blog' | 'model-claim';

/**
 * 证据的七个维度，**不压成一个分数**。
 *
 * 官方文档权威性高，但证明不了生产性能；一篇转载文章独立性是 0，权威性却可能
 * 很高。压成一个数，这两件事就再也分不开了。加权只发生在排序时。
 */
export interface EvidenceScores {
  authority: number;
  relevance: number;
  verifiability: number;
  directness: number;
  independence: number;
  /** `null` = 本地判不了。不联网就不知道这份材料什么时候发布，写 0 或 1 都是编。 */
  timeliness: number | null;
  consistency: number;
}

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  /** 原话里的那一小段，不是整句。 */
  excerpt: string;
  channelId: string;
  messageId: string;
  span: ClaimSpan;
  /** 这份证据支持或反驳哪些 Claim。 */
  claims: string[];
  scores: EvidenceScores;
  /**
   * 本地能判断的只有「有没有第二个通道说同一件事」，不是真伪。
   * `corroborated` = 被另一个独立通道复核过；`conflicted` = 有通道给出相反说法。
   */
  verified: 'unverified' | 'corroborated' | 'conflicted';
}

/** 一条被抽出来的观点。结构上满足 `Claim`，多出来的字段见注释。 */
export interface FusedClaim {
  id: string;
  text: string;
  kind: ClaimKind;
  sources: Array<{ channelId: string; messageId: string }>;
  span?: ClaimSpan;
  /** 原话里的依据片段；空数组表示这是一句断言，没有依据。 */
  evidence: string[];
  evidenceIds: string[];
  /** 依赖的前提。条件必须成为一条记录，否则它会被写进正文里当形容词。 */
  assumptions: string[];
  /** 支持这条观点的**独立通道**数。同一通道重复说三遍仍然算 1。 */
  support: number;
  /** 只用来决定先讲哪个，不用来声明哪个是真的。 */
  rank: number;
}

export interface FusionInput {
  channelId: string;
  messageId: string;
  text: string;
}

export interface FusionReport {
  /**
   * 哪个实现算的。本地是不联网的规则/算法；本地模型是 Ollama 归纳；远程是
   * 调用大模型 API；网页是一位网页通道当主导，读完各家回答后给的评判。
   * 四种方式必须能从产物上看出来，否则「这条结论是模型说的还是规则说的」
   * 就永远说不清。
   */
  backend: 'local' | 'local-model' | 'remote' | 'web';
  claims: FusedClaim[];
  evidence: Evidence[];
  relations: ArgumentRelation[];
  consensus: FusedClaim[];
  disputed: FusedClaim[];
  unique: FusedClaim[];
  gaps: Gap[];
  overlap: string[];
  recommendation: string;
  /**
   * 抽取失败、或没有任何一条观点被两个通道共同支持。
   * 界面上必须说出来，而不是把它当成一次成功的综合。
   */
  degraded: boolean;
  /** 这一版本地算法明确做不到的事，如实写出来，不假装。 */
  limits: string[];
  /** Phase H 裁决接进来后才有；没有时是「未经裁决」，不是「已确认」。 */
  finalDecision?: string | null;
  undetermined?: boolean;
  confidence?: { level: 'low' | 'medium' | 'high'; why: string };
  rejected?: Array<{ text: string; why: string }>;
  unresolvedQuestions?: Array<{ question: string; why: string }>;
  debateId?: string;
  /**
   * 这一轮由谁主导辩论/裁决。自动选择时 `leadAuto` 为真，配合 `leadReason`
   * 说明为什么选它（例如「本地模型判定其回答最完整」）。手动指定时 `leadAuto`
   * 为假、`leadReason` 为空——用户自己拍板，不需要理由。
   */
  leadAgentId?: string;
  leadReason?: string;
  leadAuto?: boolean;
}

/**
 * 融合结果 → 界面上那张综合卡。
 *
 * 这是一层转接，不是第二套结论：`Synthesis` 是已经上线的 UI 契约，改造它要动
 * 事件流和渲染层。先让两份结构并存，等界面要显示关系图时再一起换。
 */
export function toSynthesis(report: FusionReport): Synthesis {
  const claim = (item: FusedClaim): Claim => ({
    text: item.text,
    sources: item.sources,
    evidence: item.evidence
  });

  // 分歧从 contradicts / attacks 边反推，而不是另存一份：同一件事存两处，
  // 迟早会有一处没更新。
  const byId = new Map(report.claims.map(item => [item.id, item]));
  const disputed: Dispute[] = [];
  for (const relation of report.relations) {
    if (relation.kind !== 'contradicts' && relation.kind !== 'attacks') continue;
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    if (!from || !to) continue;
    // 「分歧」是各家的说法不一样。同一条回答里的两句话互相反驳，那是这段话
    // 自己的论证结构，不是两个来源对不上——按分歧展示会读成
    // 「ChatGPT 说 A ／ ChatGPT 说 B」。
    if (from.sources[0]?.channelId === to.sources[0]?.channelId) continue;
    if (disputed.some(item => item.topic === from.text.slice(0, 40))) continue;
    disputed.push({
      topic: from.text.slice(0, 40),
      positions: [
        { channelId: from.sources[0]?.channelId ?? '', stance: from.text },
        { channelId: to.sources[0]?.channelId ?? '', stance: to.text }
      ],
      pivot: relation.reason
    });
  }

  return {
    consensus: report.consensus.map(claim),
    disputed,
    unique: report.unique.map(claim),
    gaps: report.gaps,
    overlap: report.overlap,
    recommendation: report.recommendation,
    degraded: report.degraded,
    fusion: {
      backend: report.backend,
      finalDecision: report.finalDecision ?? null,
      undetermined: report.undetermined ?? true,
      confidence: report.confidence ?? {
        level: 'low',
        why: '本地规则只比较文本，不验证外部事实；未经独立裁决'
      },
      rejected: report.rejected ?? [],
      unresolvedQuestions: report.unresolvedQuestions ?? [],
      evidenceCount: report.evidence.length,
      relationCount: report.relations.length,
      debateId: report.debateId,
      leadAgentId: report.leadAgentId,
      leadReason: report.leadReason,
      leadAuto: report.leadAuto,
      limits: report.limits
    }
  };
}
