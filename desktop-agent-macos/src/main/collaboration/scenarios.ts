/**
 * P4-04/P4-05/P4-07：证据场景夹具与回放。
 * 同一输入重复执行必须得到同一结论。
 */
import type { Claim, EvidenceRef, Verdict } from './domain/types';
import type { ExecutionClaim } from '../engineering/attestation';
import { verifyAll } from './verifier';
import { passesQualityGate, qualityMetrics, type QualityMetrics } from './metrics';

export interface EvidenceScenario {
  name: string;
  claims: Claim[];
  evidence: EvidenceRef[];
  executions: Array<ExecutionClaim & { claimId?: string }>;
  expectCoverage: number;
}

export interface ScenarioResult {
  relations: Record<string, Verdict['relation']>;
  metrics: QualityMetrics;
  gate: { ok: boolean; reasons: string[] };
}

export function runScenario(scenario: EvidenceScenario): ScenarioResult {
  const verdicts = verifyAll(scenario.claims, scenario.evidence, scenario.executions);
  const metrics = qualityMetrics(scenario.claims, verdicts, scenario.evidence);
  return {
    relations: Object.fromEntries(verdicts.map(item => [item.claimId, item.relation])),
    metrics,
    gate: passesQualityGate(metrics, { minCoverage: scenario.expectCoverage, maxUnverified: 0 })
  };
}

const claim = (id: string, evidenceId?: string): Claim => ({
  claimId: id, goalId: 'g', taskId: 't', text: id, kind: 'fact',
  source: evidenceId ? { evidenceId } : {}, createdAt: 1
});
const ref = (id: string, trust: EvidenceRef['trust']): EvidenceRef => ({
  evidenceId: id, kind: 'code', scope: { goalId: 'g', taskId: 't' },
  source: { commit: 'c', capturedAt: 1 }, hash: 'h', trust, summary: id
});

export const EVIDENCE_FIXTURES: EvidenceScenario[] = [
  { name: 'all-verified', claims: [claim('c1', 'e1')], evidence: [ref('e1', 'verified')], executions: [], expectCoverage: 0.9 },
  { name: 'no-evidence', claims: [claim('c1')], evidence: [], executions: [], expectCoverage: 0.9 },
  { name: 'degraded', claims: [claim('c1', 'e1')], evidence: [ref('e1', 'degraded')], executions: [], expectCoverage: 0.9 },
  { name: 'execution-pass', claims: [claim('c1')], evidence: [], executions: [{ claimId: 'c1', command: 'npm test', exitCode: 0, outputHash: 'h', attestationId: 'a', at: 1 }], expectCoverage: 0.9 },
  { name: 'execution-fail', claims: [claim('c1')], evidence: [], executions: [{ claimId: 'c1', command: 'npm test', exitCode: 1, outputHash: 'h', attestationId: 'a', at: 1 }], expectCoverage: 0.9 },
  { name: 'mixed', claims: [claim('c1', 'e1'), claim('c2')], evidence: [ref('e1', 'verified')], executions: [], expectCoverage: 0.5 }
];

/** 回放：不重新调用模型，只按同一输入重算。 */
export function replayScenario(name: string): ScenarioResult[] {
  const scenario = EVIDENCE_FIXTURES.find(item => item.name === name);
  if (!scenario) throw new Error(`未知场景：${name}`);
  return [runScenario(scenario), runScenario(scenario)];
}
