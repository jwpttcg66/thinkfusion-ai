/**
 * GTEC P6：检查点 ECO 版本引用。
 * Run: npm run test:gtec-p6
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEcoCheckpointRef,
  buildEngineeringContextPackage,
  isEcoRefCompatible,
  parseEcoEvidenceRef,
  toEcoEvidenceRef
} from '../out-test/shared/eco.js';

test('P6：evidenceRef round-trip', () => {
  const pkg = buildEngineeringContextPackage({
    workId: 'w1', stage: 'planning', role: 'planner',
    architectureSummary: 's',
    resources: [{ resourceId: 'r', kind: 'file', pathOrLabel: 'a.ts', verified: true, factClass: 'verified_fact' }],
    goalVersion: 2,
    now: 5,
    version: 3
  });
  const ref = buildEcoCheckpointRef(pkg);
  const encoded = toEcoEvidenceRef(ref);
  const parsed = parseEcoEvidenceRef(encoded);
  assert.deepEqual(parsed, ref);
});

test('P6：stale 或版本回退 → incompatible', () => {
  const saved = {
    contextPackageId: 'eco:w1:planning:5',
    contextVersion: 3,
    sufficiency: 'sufficient',
    goalVersion: 2
  };
  const stale = buildEngineeringContextPackage({
    workId: 'w1', stage: 'planning', role: 'planner',
    architectureSummary: 's',
    resources: [{ resourceId: 'r', kind: 'file', pathOrLabel: 'a.ts', verified: true, factClass: 'verified_fact' }],
    codeVersionChanged: true,
    goalVersion: 2,
    now: 5,
    version: 4
  });
  assert.equal(isEcoRefCompatible(saved, stale), false);

  const older = buildEngineeringContextPackage({
    workId: 'w1', stage: 'planning', role: 'planner',
    architectureSummary: 's',
    resources: [{ resourceId: 'r', kind: 'file', pathOrLabel: 'a.ts', verified: true, factClass: 'verified_fact' }],
    goalVersion: 2,
    now: 5,
    version: 2
  });
  assert.equal(isEcoRefCompatible(saved, older), false);
});

test('P6：同 work 更高 version 且非 stale → compatible', () => {
  const saved = {
    contextPackageId: 'eco:w1:planning:5',
    contextVersion: 3,
    sufficiency: 'sufficient',
    goalVersion: 2
  };
  const current = buildEngineeringContextPackage({
    workId: 'w1', stage: 'planning', role: 'planner',
    architectureSummary: 's',
    resources: [{ resourceId: 'r', kind: 'file', pathOrLabel: 'a.ts', verified: true, factClass: 'verified_fact' }],
    goalVersion: 2,
    now: 9,
    version: 5
  });
  assert.equal(isEcoRefCompatible(saved, current), true);
});
