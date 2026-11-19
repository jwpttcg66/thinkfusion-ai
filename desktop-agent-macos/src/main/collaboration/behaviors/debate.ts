/**
 * P1-12 DebateBehavior：只为 matters && open 的 Dispute 生成辩论请求。
 * 不建基线、不收提示词、不在这里调用模型。
 */
import type { CollaborationState, Dispute, Verdict } from '../domain/types';

export interface DebateRequest {
  disputeId: string;
  claimA: string;
  claimB: string;
  evidenceRefs: string[];
}

export function selectDebates(state: CollaborationState): DebateRequest[] {
  const conflicts = new Map(state.conflicts.map(item => [item.conflictId, item]));
  return state.disputes
    .filter(dispute => dispute.status === 'open')
    .filter(dispute => conflicts.get(dispute.conflictId)?.matters === true)
    .map(dispute => {
      const conflict = conflicts.get(dispute.conflictId);
      return {
        disputeId: dispute.disputeId,
        claimA: conflict?.claimA ?? '',
        claimB: conflict?.claimB ?? '',
        evidenceRefs: conflict?.evidenceRefs ?? []
      };
    });
}

export function resolveDispute(state: CollaborationState, disputeId: string, verdict: Verdict): CollaborationState {
  const disputes: Dispute[] = state.disputes.map(dispute => {
    if (dispute.disputeId !== disputeId) return dispute;
    return {
      ...dispute,
      status: verdict.relation === 'unverified' ? 'unresolved' : 'resolved',
      resolvedAt: Date.now(),
      resolution: { relation: verdict.relation, evidenceRefs: verdict.evidenceRefs }
    };
  });
  return { ...state, disputes, updatedAt: Date.now() };
}
