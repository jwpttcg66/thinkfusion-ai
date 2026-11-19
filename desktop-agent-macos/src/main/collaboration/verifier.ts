/**
 * P4-02：统一验证器。只依据 EvidenceRef / 执行断言，不靠模型“觉得对”。
 */
import type { Claim, EvidenceRef, Verdict } from './domain/types';
import type { ExecutionClaim } from '../engineering/attestation';
import { isVerifiedExecution } from '../engineering/attestation';

export interface VerificationInput {
  claim: Claim;
  evidence: readonly EvidenceRef[];
  executions?: readonly (ExecutionClaim & { claimId?: string })[];
}

export function verifyClaim(input: VerificationInput): Verdict {
  const executions = (input.executions ?? []).filter(item => item.claimId === input.claim.claimId);
  if (executions.some(item => isVerifiedExecution(item) && item.exitCode === 0)) {
    return {
      claimId: input.claim.claimId,
      relation: 'supports',
      confidence: 'high',
      limitations: [],
      evidenceRefs: executions.map(item => item.command)
    };
  }
  const refs = input.evidence.filter(item =>
    item.scope.taskId === input.claim.taskId || item.evidenceId === input.claim.source.evidenceId
  );
  if (refs.length === 0) {
    return {
      claimId: input.claim.claimId,
      relation: 'unverified',
      confidence: 'low',
      limitations: ['没有证据引用'],
      evidenceRefs: []
    };
  }
  if (refs.every(item => item.trust === 'degraded')) {
    return {
      claimId: input.claim.claimId,
      relation: 'context',
      confidence: 'low',
      limitations: ['证据降级'],
      evidenceRefs: refs.map(item => item.evidenceId)
    };
  }
  if (refs.some(item => item.trust === 'verified')) {
    return {
      claimId: input.claim.claimId,
      relation: 'supports',
      confidence: 'high',
      limitations: [],
      evidenceRefs: refs.map(item => item.evidenceId)
    };
  }
  return {
    claimId: input.claim.claimId,
    relation: 'unverified',
    confidence: 'medium',
    limitations: ['证据未核验'],
    evidenceRefs: refs.map(item => item.evidenceId)
  };
}

export function verifyAll(
  claims: readonly Claim[],
  evidence: readonly EvidenceRef[],
  executions: readonly (ExecutionClaim & { claimId?: string })[] = []
): Verdict[] {
  return claims.map(claim => verifyClaim({ claim, evidence, executions }));
}
