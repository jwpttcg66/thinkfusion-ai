/** P4-03：质量指标与门槛。 */
import type { Claim, EvidenceRef, Verdict } from './domain/types';

export interface QualityMetrics {
  claims: number;
  verified: number;
  unverified: number;
  context: number;
  contradicts: number;
  evidenceCoverage: number;
  trust: { verified: number; unverified: number; degraded: number };
}

export function qualityMetrics(
  claims: readonly Claim[],
  verdicts: readonly Verdict[],
  evidence: readonly EvidenceRef[]
): QualityMetrics {
  const count = (relation: Verdict['relation']): number =>
    verdicts.filter(item => item.relation === relation).length;
  return {
    claims: claims.length,
    verified: count('supports'),
    unverified: count('unverified'),
    context: count('context'),
    contradicts: count('contradicts'),
    evidenceCoverage: claims.length === 0 ? 1 : count('supports') / claims.length,
    trust: {
      verified: evidence.filter(item => item.trust === 'verified').length,
      unverified: evidence.filter(item => item.trust === 'unverified').length,
      degraded: evidence.filter(item => item.trust === 'degraded').length
    }
  };
}

export interface QualityThresholds {
  minCoverage: number;
  maxUnverified: number;
}

export function passesQualityGate(metrics: QualityMetrics, thresholds: QualityThresholds): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (metrics.evidenceCoverage < thresholds.minCoverage) reasons.push('证据覆盖率不足');
  if (metrics.unverified > thresholds.maxUnverified) reasons.push('未核验结论过多');
  if (metrics.contradicts > 0) reasons.push('存在被证据反驳的结论');
  return { ok: reasons.length === 0, reasons };
}
