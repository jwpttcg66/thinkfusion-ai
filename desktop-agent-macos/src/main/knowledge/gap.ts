/**
 * P2-04：把知识缺口变成研究任务；复用 Replanner 的护栏。
 */
import type { Claim, CollaborationState, Conflict, Dispute, TaskSpec } from '../collaboration/domain/types';
import { applyReplan } from '../collaboration/adapt/replanner';
import { evaluateFreshness } from './freshness';
import type { KnowledgeCard } from './types';

export type GapKind = 'unanswered' | 'stale' | 'disputed';

export interface KnowledgeGap {
  kind: GapKind;
  text: string;
  claimId?: string;
  cardId?: string;
  disputeId?: string;
}

export interface GapInput {
  question: string;
  cards: readonly KnowledgeCard[];
  claims: readonly Claim[];
  disputes: readonly Dispute[];
  conflicts: readonly Conflict[];
  now?: number;
}

export function findKnowledgeGaps(input: GapInput): KnowledgeGap[] {
  const now = input.now ?? Date.now();
  const covered = new Set(input.cards.flatMap(card => card.claimIds));
  const gaps: KnowledgeGap[] = [];

  for (const claim of input.claims) {
    if (!covered.has(claim.claimId)) {
      gaps.push({ kind: 'unanswered', text: claim.text, claimId: claim.claimId });
    }
  }
  for (const card of input.cards) {
    const freshness = evaluateFreshness(card, now);
    if (freshness.state === 'stale') {
      gaps.push({ kind: 'stale', text: card.statement, cardId: card.cardId });
    }
  }
  const conflictById = new Map(input.conflicts.map(item => [item.conflictId, item]));
  for (const dispute of input.disputes) {
    if (dispute.status !== 'open') continue;
    const conflict = conflictById.get(dispute.conflictId);
    if (!conflict?.matters) continue;
    gaps.push({ kind: 'disputed', text: `${conflict.claimA} ↔ ${conflict.claimB}`, disputeId: dispute.disputeId });
  }
  return gaps;
}

/** 缺口 → 研究任务；已有同 id 任务由调用方去重。 */
export function gapTasks(goalId: string, gaps: readonly KnowledgeGap[]): TaskSpec[] {
  return gaps.map((gap, index) => ({
    taskId: `t-gap-${String(index)}`,
    goalId,
    kind: 'research',
    envelope: {
      question: `补研究：${gap.text}`,
      acceptance: ['给出可核验的证据'],
      evidenceRequired: true
    },
    dependsOn: [],
    requiredCapabilities: ['knowledge'],
    context: { gapKind: gap.kind }
  }));
}

/** 无新增信息就停：有缺口但本轮没有新任务。 */
export function shouldContinueResearch(gaps: readonly KnowledgeGap[], addedTasks: number): boolean {
  return gaps.length > 0 && addedTasks > 0;
}


/** P2-04：缺口 → Replanner 新 Plan；没有缺口就不动。 */
export function replanForGaps(
  state: CollaborationState,
  gaps: readonly KnowledgeGap[]
): { applied: boolean; state: CollaborationState } {
  const tasks = gapTasks(state.goal.goalId, gaps);
  if (tasks.length === 0) return { applied: false, state };
  return { applied: true, state: applyReplan(state, tasks, 'acceptance_gap') };
}
