import type { ClaimKind } from '../../shared/fusion';
import { extractClaims, type ExtractedClaim } from '../synthesis/claim-extractor';
import { detectRelations } from '../synthesis/relations';
import type { ArgumentRelation } from '../../shared/fusion';
import type { DebateClaim, DebateDispute, DebateMessage, DisputeType } from './types';

/**
 * 辩论里的结构化主张与争议（任务书 Phase 1）。
 *
 * 这一层不新增判据，只把已经存在的两条链接起来：
 * `synthesis/claim-extractor.ts` 把一段话切成可单独判断真假的句子，
 * `synthesis/relations.ts` 判出哪两句互不相容。两者原本只服务网页回答的
 * 综合，现在辩论的每条发言也走一遍，产物落在 `DebateRound.claims` 与
 * `DebateState.disputes` 上，下一轮的挑战就能指着具体哪一句说话。
 *
 * 三条边界：
 *
 * 1. **只认跨参与者**。同一个模型前后两句相反，那是它自己的论证结构，不是
 *    两个人对不上——按争议报出去，读的人会以为有两个立场。
 * 2. **不判谁对**。这里产出的是「哪两句对不上、为什么」，`priority` 只用来
 *    决定先处理哪一条，不是「谁更可能正确」的概率。
 * 3. **判不了就说判不了**。「定义差异」（两边用同一个词指不同的东西）规则版
 *    没有判据，类型里就不给这个值，而不是塞进 factual 里冒充。
 */

/** 单条发言最多留多少句。长回答能切出几十句，全存进去只会让辩论文件变大。 */
const MAX_CLAIMS_PER_MESSAGE = 40;

/** 一轮最多报多少条争议。按优先级取前几条，其余仍留在关系里但不进挑战。 */
const MAX_DISPUTES = 12;

/** 交给下一轮的最多几条。挑战一多，模型就只会挑好答的回。 */
export const MAX_CHALLENGES = 3;

/**
 * 主张类型对「结论会不会因此改变」的粗分。
 *
 * 事实句错了，结论就得改；问句本身不构成主张。这是排序用的常量，不是置信度。
 */
const KIND_IMPACT: Record<ClaimKind, number> = {
  fact: 1,
  inference: 0.9,
  recommendation: 0.85,
  prediction: 0.8,
  assumption: 0.7,
  question: 0.5
};

export interface RoundAnalysis {
  claims: DebateClaim[];
  disputes: DebateDispute[];
}

export function analyseRound(messages: readonly DebateMessage[], roundIndex: number): RoundAnalysis {
  const extracted: ExtractedClaim[] = [];
  for (const message of messages) {
    const found = extractClaims({
      channelId: message.agentId,
      messageId: message.messageId,
      text: message.text
    });
    extracted.push(...found.slice(0, MAX_CLAIMS_PER_MESSAGE));
  }

  const disputes = extracted.length < 2 ? [] : detectDisputes(extracted, roundIndex);
  const disputed = new Set(disputes.flatMap(dispute => dispute.claimIds));

  const claims: DebateClaim[] = extracted.map(claim => ({
    claimId: claim.id,
    messageId: claim.messageId,
    agentId: claim.channelId,
    roundIndex,
    text: claim.text,
    kind: claim.kind,
    kindCue: claim.kindCue,
    span: claim.span,
    assumptions: claim.assumptions,
    // 这一句提到的出处与数字原样留下：Phase 3 的证据评价读的是它们，
    // 而不是回头再切一遍句子（切法一变，位置就对不上了）。
    evidenceDrafts: claim.evidence,
    // 「被质疑过」是这一轮的事实：它出现在一条争议里。判没判过是后面的事。
    status: disputed.has(claim.id) ? 'challenged' : 'proposed'
  }));

  return { claims, disputes };
}

function detectDisputes(claims: ExtractedClaim[], roundIndex: number): DebateDispute[] {
  const byId = new Map(claims.map(claim => [claim.id, claim]));
  const relations = detectRelations(claims).filter(relation => {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    return Boolean(from && to && from.channelId !== to.channelId);
  });

  const disputes: DebateDispute[] = [];
  for (const relation of relations) {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    if (!from || !to) continue;
    const type = disputeTypeOf(relation, from, to);
    if (!type) continue;
    disputes.push({
      disputeId: `${relation.from}~${relation.to}`,
      roundIndex,
      claimIds: [from.id, to.id],
      agents: [from.channelId, to.channelId],
      type,
      priority: priorityOf(relation, from, to),
      reason: relation.reason,
      status: 'open'
    });
  }

  return disputes
    .sort((a, b) => b.priority - a.priority || a.disputeId.localeCompare(b.disputeId))
    .slice(0, MAX_DISPUTES);
}

/**
 * 关系 → 争议类型。
 *
 * 只认四类里能被规则判出来的三档：极性/数字矛盾是 `factual`，两边都给数字
 * 且对不上是 `evidence_conflict`，一边带条件一边是绝对表述是 `scope`。
 * `logical` 留给「有转向词且指向同一件事」——这条判据很弱，只作提示。
 */
function disputeTypeOf(relation: ArgumentRelation, from: ExtractedClaim, to: ExtractedClaim): DisputeType | null {
  if (relation.kind === 'contradicts') {
    const bothFigured = from.figures.length > 0 && to.figures.length > 0;
    const shared = from.figures.some(figure => to.figures.includes(figure));
    return bothFigured && !shared ? 'evidence_conflict' : 'factual';
  }
  if (relation.kind === 'qualifies') return 'scope';
  if (relation.kind === 'attacks') return 'logical';
  return null;
}

/**
 * 排序分：这条争议有多值得先处理。
 *
 * `impact` 看主张类型（事实句比问句更影响结论），`confidence` 是规则判出这条
 * 冲突的把握。两者都是粗分，只保证「稳定的先后顺序」，不解释成真伪概率。
 */
function priorityOf(relation: ArgumentRelation, from: ExtractedClaim, to: ExtractedClaim): number {
  const impact = Math.max(KIND_IMPACT[from.kind] ?? 0.5, KIND_IMPACT[to.kind] ?? 0.5);
  const raw = impact * (0.55 + 0.45 * relation.confidence);
  return Math.round(raw * 100) / 100;
}

/**
 * 把争议变成下一轮的具体挑战。
 *
 * 任务书 AC-05 要的是「针对具体 Claim 的挑战，而不是泛泛要求再想一想」，
 * 所以每一条都带上两句原话和冲突性质；模型要做的不是重新想一遍，而是回答
 * 「这两句里哪一句站不住」。
 */
export function challengesFor(
  disputes: readonly DebateDispute[],
  claims: readonly DebateClaim[],
  limit = MAX_CHALLENGES
): string[] {
  const byId = new Map(claims.map(claim => [claim.claimId, claim]));
  const lines: string[] = [];
  for (const dispute of disputes) {
    if (lines.length >= limit) break;
    const [firstId, secondId] = dispute.claimIds;
    const first = byId.get(firstId);
    const second = byId.get(secondId);
    if (!first || !second) continue;
    const head = `${quote(first.text)} 对 ${quote(second.text)}`;
    if (dispute.type === 'evidence_conflict') {
      lines.push(`- 两边给的数字对不上：${head}。请指出哪个数字适用于这个问题，另一个错在哪。`);
    } else if (dispute.type === 'scope') {
      const condition = first.assumptions[0] ?? second.assumptions[0] ?? '';
      lines.push(
        `- 适用范围不同：${head}${condition ? `（其中一句带着「${condition}」）` : ''}。请说明各自在什么范围内成立。`
      );
    } else if (dispute.type === 'logical') {
      lines.push(`- 有一句在反驳另一句，但没说明凭什么：${head}。请补上理由，或撤回其中一句。`);
    } else {
      lines.push(`- 直接矛盾：${head}。请指出哪一句不成立，并给出能区分二者的证据。`);
    }
  }
  return lines;
}

/** 原话太长时截断——挑战里要的是能认出是哪一句，不是全文。 */
function quote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 60 ? `「${trimmed.slice(0, 60)}…」` : `「${trimmed}」`;
}
