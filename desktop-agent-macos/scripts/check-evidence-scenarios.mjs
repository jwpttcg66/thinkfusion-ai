/** P4-04/05/07：6 个场景 + 回放确定性。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_FIXTURES, replayScenario, runScenario } from '../out-test/main/collaboration/scenarios.js';

test('6 个固定场景关系符合预期', () => {
  const byName = Object.fromEntries(EVIDENCE_FIXTURES.map(item => [item.name, runScenario(item)]));
  assert.equal(byName['all-verified'].relations.c1, 'supports');
  assert.equal(byName['no-evidence'].relations.c1, 'unverified');
  assert.equal(byName['degraded'].relations.c1, 'context');
  assert.equal(byName['execution-pass'].relations.c1, 'supports');
  assert.equal(byName['execution-fail'].relations.c1, 'contradicts');
  assert.equal(byName.mixed.relations.c2, 'unverified');
});

test('回放两次结果一致', () => {
  const [a, b] = replayScenario('all-verified');
  assert.deepEqual(a.relations, b.relations);
  assert.deepEqual(a.metrics, b.metrics);
  assert.deepEqual(a.gate, b.gate);
});
