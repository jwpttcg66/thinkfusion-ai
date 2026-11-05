import { randomUUID } from 'node:crypto';
import { features, jaccard } from '../../shared/synthesizer';
import type { DebateClaim, DebateRound, DebateRevision, RevisionDecision } from './types';

/**
 * 回应阶段：参与者对质疑作出的决策（任务书 AC-06 / 6.1 的「修订回应」）。
 *
 * 决策有三种来源，按可信度排序，全部记在 `DebateRevision.source` 里：
 *
 * - `stated`：模型自己在回答里写了「决策：revise」。这是我们唯一真正能确定
 *   的，所以提示词要求它写在第一行。
 * - `inferred`：没写决策行时，按措辞（「撤回」「接受」「无法判断」）或与上一轮
 *   发言的相似度推出来。规则推的，可能推错，所以标出来。
 * - `unknown`：既没写、规则也推不出。`decision` 记 null，不替它挑一个。
 *
 * 原话一个字都不动：`before` / `after` 都是原文，本模块只补「改没改、为什么」。
 */

/** 提示词里约定的那一行。允许「决策:」「【决策】」「决策是」。 */
const STATED = /^[\s>*#-]*(?:【决策】|决策)\s*(?:是|为)?\s*[:：]?\s*(.+)$/m;

/**
 * 决策词。中英都认：模型可能照抄枚举名，也可能写成中文。
 * 顺序有意义——「不接受」里也有「接受」，所以否定说法先挡掉。
 */
const NEGATED: Array<[RegExp, RevisionDecision]> = [
  [/不接受|无法接受/, 'defend'],
  [/不撤回|不收回/, 'defend']
];

const WORDS: Array<[RegExp, RevisionDecision]> = [
  [/^(accept|接受)/i, 'accept'],
  [/^(defend|坚持|辩护|维持)/i, 'defend'],
  [/^(revise|修正|修订|部分修正)/i, 'revise'],
  [/^(withdraw|撤回|收回)/i, 'withdraw'],
  [/^(inconclusive|无法判断|不确定|不能确定|信息不足)/i, 'inconclusive']
];

/** 没写决策行时的措辞线索。只认非常明确的说法，含糊的不猜。 */
const CUES: Array<[RegExp, RevisionDecision]> = [
  [/撤回(这个|我的|上述)?(说法|观点|判断|结论)?/, 'withdraw'],
  [/接受(你的|这个)?(质疑|说法|观点)|你说得对|同意你的质疑/, 'accept'],
  [/无法判断|不能确定|信息不足|需要更多(信息|证据)/, 'inconclusive']
];

/**
 * 「和上一轮基本一样」的门槛。与编排器判断收敛用的是同一个数：
 * 两处都表示「这段话没改」，不一致会让同一件事有两个结论。
 */
const SAME_AS_BEFORE = 0.9;

export interface RevisionDecisionResult {
  decision: RevisionDecision | null;
  source: 'stated' | 'inferred' | 'unknown';
  reason: string;
}

export function decideRevision(text: string, before: string): RevisionDecisionResult {
  const stated = parseStated(text);
  if (stated) return { decision: stated.decision, source: 'stated', reason: stated.reason };

  const tabled = [...NEGATED, ...CUES].find(([pattern]) => pattern.test(text));
  if (tabled) {
    const [pattern, decision] = tabled;
    return { decision, source: 'inferred', reason: `措辞里有「${text.match(pattern)?.[0] ?? pattern.source}」` };
  }

  if (before.trim()) {
    const similarity = jaccard(features(before), features(text));
    if (similarity >= SAME_AS_BEFORE) {
      return { decision: 'defend', source: 'inferred', reason: `与上一轮发言相似度 ${similarity.toFixed(2)}，没有改动` };
    }
  }

  return { decision: null, source: 'unknown', reason: '没有写决策行，措辞与相似度也判不出来' };
}

function parseStated(text: string): { decision: RevisionDecision; reason: string } | null {
  const match = text.match(STATED);
  if (!match) return null;
  const value = match[1].trim();
  for (const [pattern, decision] of [...NEGATED, ...WORDS]) {
    if (pattern.test(value)) {
      return { decision, reason: value.slice(0, 120) };
    }
  }
  return null;
}

/**
 * 把决策写回主张状态（任务书 5.1 的 ClaimStatus）。
 *
 * 只改「这位自己说过、而且被质疑过」的那几句：别的参与者的主张、以及没被
 * 挑战过的主张，不该因为另一个人改了口而跟着变。
 *
 * 坚持（defend）不在表里：它仍然是有争议的，状态留在 `challenged`，
 * 不升成 supported——那是裁判的事（Phase 3）。
 */
const STATUS_AFTER: Partial<Record<RevisionDecision, 'revised' | 'withdrawn' | 'unresolved'>> = {
  accept: 'revised',
  revise: 'revised',
  withdraw: 'withdrawn',
  inconclusive: 'unresolved'
};

export function applyDecisions(rounds: readonly DebateRound[], revisions: readonly DebateRevision[]): void {
  const byId = new Map<string, DebateClaim>();
  for (const round of rounds) for (const claim of round.claims ?? []) byId.set(claim.claimId, claim);
  for (const revision of revisions) {
    if (!revision.decision) continue;
    const status = STATUS_AFTER[revision.decision];
    if (!status) continue;
    for (const claimId of revision.targetClaimIds) {
      const claim = byId.get(claimId);
      // 只认「自己说过的那几句」：同一条 id 出现在争议里两次时，也不该因为
      // 别人的决策改掉自己的状态。
      if (!claim || claim.agentId !== revision.agentId) continue;
      claim.status = status;
    }
  }
}

/**
 * 一次回应 → 一条修订记录。
 *
 * `targetClaimIds` 是这位自己说过、且被上一轮争议点到的句子；一句都没有时
 * 仍然记一条（decision 可能为 null），因为「他说了话但没改」本身是事实。
 */
export function revisionOf(input: {
  messageId: string;
  agentId: string;
  roundIndex: number;
  before: string;
  after: string;
  targetClaimIds: string[];
  now: number;
}): DebateRevision {
  const { decision, source, reason } = decideRevision(input.after, input.before);
  return {
    revisionId: randomUUID(),
    messageId: input.messageId,
    agentId: input.agentId,
    roundIndex: input.roundIndex,
    decision,
    source,
    reason,
    before: input.before,
    after: input.after,
    targetClaimIds: input.targetClaimIds,
    createdAt: input.now
  };
}
