/**
 * GTEC P5：DMOCA × ECO 硬门禁。
 * Run: npm run test:gtec-p5
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEcoGateToDecision,
  decideParticipation
} from '../out-test/shared/dmoca.js';

function baseDecision(overrides = {}) {
  return decideParticipation({
    workId: 'w1',
    stage: 'design',
    risk: 'L2',
    candidates: [
      { id: 'a', available: true },
      { id: 'b', available: true },
      { id: 'c', available: true }
    ],
    now: 1,
    ...overrides
  });
}

test('P5：sufficient 不阻断正式职责', () => {
  const gated = applyEcoGateToDecision(baseDecision(), 'sufficient');
  assert.equal(gated.ecoGate?.formalRolesBlocked, false);
  assert.ok(gated.participants.length >= 1);
});

test('P5：insufficient 非 pinned → 截断 1 人且 blocked', () => {
  const gated = applyEcoGateToDecision(baseDecision(), 'insufficient');
  assert.equal(gated.ecoGate?.formalRolesBlocked, true);
  assert.equal(gated.participants.length, 1);
  assert.equal(gated.participants[0].roles[0], 'lead');
});

test('P5：stale + pinned → 保留人选但 blocked', () => {
  const gated = applyEcoGateToDecision(baseDecision({
    selectedIds: ['a', 'b'],
    userPinned: true
  }), 'stale');
  assert.equal(gated.ecoGate?.formalRolesBlocked, true);
  assert.ok(gated.participants.length >= 1);
  assert.ok(gated.participants.every(p => /stale|过期|阻断/.test(p.reason)));
});

test('P5：partial → 警告但不 blocked', () => {
  const gated = applyEcoGateToDecision(baseDecision(), 'partial');
  assert.equal(gated.ecoGate?.formalRolesBlocked, false);
  assert.ok(gated.reasons.some(r => /partial/.test(r)));
});
