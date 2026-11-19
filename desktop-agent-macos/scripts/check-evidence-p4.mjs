/** P4-01/02/03：Pack→EvidenceRef、验证四态、质量指标。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePackOwner, toEvidenceRef } from '../out-test/main/collaboration/evidence.js';
import { verifyClaim } from '../out-test/main/collaboration/verifier.js';
import { passesQualityGate, qualityMetrics } from '../out-test/main/collaboration/metrics.js';

const item = {
  itemId: 'i1', kind: 'source-file',
  source: { commit: 'abc', path: 'src/a.ts' },
  locator: { path: 'src/a.ts', startLine: 1, endLine: 2 },
  contentHash: 'hash', meta: { tool: 'read', capturedAt: 10 }
};
const ref = toEvidenceRef({ packId: 'p1', goalId: 'g1', taskId: 't1', item });
const claim = {
  claimId: 'c1', goalId: 'g1', taskId: 't1', text: '结论', kind: 'fact',
  source: { evidenceId: ref.evidenceId }, createdAt: 1
};

test('Pack → EvidenceRef：kind/trust/legacy；旧归属兼容', () => {
  assert.equal(ref.kind, 'code');
  assert.equal(ref.trust, 'unverified');
  assert.equal(ref.legacy.packId, 'p1');
  assert.deepEqual(normalizePackOwner({ debateId: 'd1' }), { ownerType: 'debate', ownerId: 'd1' });
  assert.deepEqual(normalizePackOwner({ ownerType: 'task', ownerId: 't1' }), { ownerType: 'task', ownerId: 't1' });
});

test('验证：无证据 unverified；verified supports；degraded context', () => {
  assert.equal(verifyClaim({ claim, evidence: [] }).relation, 'unverified');
  assert.equal(verifyClaim({ claim, evidence: [{ ...ref, trust: 'verified' }] }).relation, 'supports');
  assert.equal(verifyClaim({ claim, evidence: [{ ...ref, trust: 'degraded' }] }).relation, 'context');
});

test('执行断言带 attestation 时 supports', () => {
  const verdict = verifyClaim({
    claim,
    evidence: [],
    executions: [{ claimId: 'c1', command: 'npm test', exitCode: 0, outputHash: 'h', attestationId: 'a', at: 1 }]
  });
  assert.equal(verdict.relation, 'supports');
});

test('指标与门槛：覆盖不足被拒；全覆盖通过', () => {
  const low = qualityMetrics([claim], [verifyClaim({ claim, evidence: [] })], []);
  assert.equal(passesQualityGate(low, { minCoverage: 0.8, maxUnverified: 0 }).ok, false);
  const high = qualityMetrics([claim], [verifyClaim({ claim, evidence: [{ ...ref, trust: 'verified' }] })], [{ ...ref, trust: 'verified' }]);
  assert.equal(passesQualityGate(high, { minCoverage: 0.8, maxUnverified: 0 }).ok, true);
});
