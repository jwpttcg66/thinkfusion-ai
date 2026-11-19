/** P1-14：Active 门禁指标。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateActiveGate } from '../out-test/main/collaboration/gate.js';

test('达标通过', () => {
  assert.equal(evaluateActiveGate({ questions: 20, planned: 20, covered: 19, maxTasksSimple: 2 }).ok, true);
});

test('问题数/覆盖率/简单任务数不达标都拒绝', () => {
  assert.equal(evaluateActiveGate({ questions: 10, planned: 10, covered: 10, maxTasksSimple: 1 }).ok, false);
  assert.equal(evaluateActiveGate({ questions: 20, planned: 20, covered: 17, maxTasksSimple: 1 }).ok, false);
  assert.equal(evaluateActiveGate({ questions: 20, planned: 20, covered: 20, maxTasksSimple: 3 }).ok, false);
});
