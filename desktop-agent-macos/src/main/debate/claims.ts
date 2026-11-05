import type { ClaimKind } from '../../shared/fusion';
import { jaccard, features } from '../../shared/synthesizer';
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

  // 定义差异是另一条判据：它不表现为「两句相反」，所以关系检测永远不会
  // 把它找出来。同一对句子已经按事实冲突报过时，不再重复报一条定义差异——
  // 同一个分歧只该有一个类型，否则挑战会问两遍。
  const reported = new Set(disputes.map(dispute => pairKey(dispute.claimIds)));
  for (const dispute of definitionDisputes(claims, roundIndex)) {
    const key = pairKey(dispute.claimIds);
    if (reported.has(key)) continue;
    reported.add(key);
    disputes.push(dispute);
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
 * 定义句式（AC-04 的「定义差异」）。
 *
 * 两组：`X 是指 Y` / `X 指的是 Y`，以及 `「X」在这里指 Y`。
 * **只认显式定义**。「X 是 Y」这种普通判断不认——否则任何一句「连接池是一种
 * 缓存」都会被当成定义，跟他人的说法一比对就报定义差异，噪音比信号多。
 */
const DEFINITIONS: RegExp[] = [
  /(?:所谓\s*)?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.+-]{0,14})\s*[，,]?\s*(?:是指|指的是|被定义为|定义为|指的就是)\s*([^。；;，,\n]{2,60})/g,
  /[「“]([^」”]{2,16})[」”]\s*[，,]?\s*(?:在这里|此处|在这个问题里)?\s*[，,]?\s*(?:是指|指的是|指)\s*([^。；;，,\n]{2,60})/g
];

export interface TermDefinition {
  /** 归一之后的术语：去掉引号与空白，比较用。 */
  term: string;
  /** 这个术语被定义成什么。 */
  definition: string;
}

export function definitionsOf(text: string): TermDefinition[] {
  const found: TermDefinition[] = [];
  for (const pattern of DEFINITIONS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const term = normalizeTerm(match[1] ?? '');
      const definition = (match[2] ?? '').trim();
      if (term.length < 2 || definition.length < 2) continue;
      if (found.some(item => item.term === term)) continue;
      found.push({ term, definition });
    }
  }
  return found;
}

function normalizeTerm(raw: string): string {
  return raw.replace(/[\s「」“”"'《》]/g, '').replace(/的$/, '');
}

/**
 * 同一个词，被两个参与者定义成两件事。
 *
 * 判据是「术语相同」+「定义不同」，缺一不可：同一个词被定义成同一件事
 * （换了个说法）不是分歧。
 *
 * 这类争议**不连主张之间的 contradicts 边**（见 `argument-graph.ts`）：
 * 这两句本身不相反，是同一个词各指一个东西。连一条「互相否定」会让人
 * 读出一个并不存在的对立。
 */
function definitionDisputes(claims: ExtractedClaim[], roundIndex: number): DebateDispute[] {
  const parsed = claims
    .map(claim => ({ claim, definitions: definitionsOf(claim.text) }))
    .filter(item => item.definitions.length > 0);

  const found: DebateDispute[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const left = parsed[i];
      const right = parsed[j];
      if (left.claim.channelId === right.claim.channelId) continue;
      for (const a of left.definitions) {
        const b = right.definitions.find(item => item.term === a.term);
        if (!b) continue;
        if (sameDefinition(a.definition, b.definition)) continue;
        found.push({
          disputeId: `${left.claim.id}~${right.claim.id}#definition`,
          roundIndex,
          claimIds: [left.claim.id, right.claim.id],
          agents: [left.claim.channelId, right.claim.channelId],
          type: 'definitional',
          priority: 0.82,
          reason: `同一个词「${a.term}」被定义成两件事：「${a.definition}」/「${b.definition}」`,
          status: 'open'
        });
        break;
      }
    }
  }
  return found;
}

/** 两种定义是不是同一个意思：互相包含，或措辞高度重合。 */
function sameDefinition(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true;
  return jaccard(features(a), features(b)) >= 0.5;
}

/** 同一对句子只报一条争议。顺序无关。 */
function pairKey(claimIds: readonly [string, string] | readonly string[]): string {
  return [...claimIds].sort().join('~');
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
    } else if (dispute.type === 'definitional') {
      lines.push(
        `- 同一个词指的不是一回事：${head}。请先说明你们各自的定义指什么，再判断哪一句成立。`
      );
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
