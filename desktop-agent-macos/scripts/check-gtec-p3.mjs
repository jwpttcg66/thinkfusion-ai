/**
 * GTEC P3：ECO 请求履行、失效、事实升格禁令。
 * Run: npm run test:gtec-p3
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFactClassPromotion,
  buildEngineeringContextPackage,
  fulfillContextRequest,
  invalidateContextPackage,
  projectEcoFromEvents
} from '../out-test/shared/eco.js';

test('P3：fulfillContextRequest 合并资源并抬升 version，充分度可改善', () => {
  const base = buildEngineeringContextPackage({
    workId: 'w1',
    stage: 'design',
    role: 'architect',
    architectureSummary: '空',
    resources: [],
    unknowns: ['缺少 src/a.ts'],
    now: 1,
    version: 1
  });
  assert.equal(base.sufficiency, 'insufficient');
  const next = fulfillContextRequest(base, {
    requestId: 'req1',
    workId: 'w1',
    reason: '需要读 a.ts',
    requiredFor: 'design',
    priority: 'high',
    requestedPaths: ['src/a.ts']
  }, [{
    resourceId: 'file:src/a.ts',
    kind: 'file',
    pathOrLabel: 'src/a.ts',
    verified: true,
    factClass: 'verified_fact'
  }]);
  assert.equal(next.contextVersion, 2);
  assert.equal(next.sufficiency, 'sufficient');
  assert.ok(!next.unknowns.includes('缺少 src/a.ts'));
});

test('P3：invalidateContextPackage → stale', () => {
  const base = buildEngineeringContextPackage({
    workId: 'w1',
    stage: 'design',
    role: 'planner',
    architectureSummary: 'x',
    resources: [{
      resourceId: 'f', kind: 'file', pathOrLabel: 'a.ts',
      verified: true, factClass: 'verified_fact'
    }],
    now: 1
  });
  const stale = invalidateContextPackage(base, 'commit 已前进');
  assert.equal(stale.sufficiency, 'stale');
  assert.ok(stale.missingCritical.some(item => /commit|前进/.test(item)));
  assert.equal(stale.contextVersion, base.contextVersion + 1);
});

test('P3：禁止 inference 升格为 verified_fact', () => {
  assert.throws(() => assertFactClassPromotion('inference', 'verified_fact'));
  assert.throws(() => assertFactClassPromotion('general_knowledge', 'verified_fact'));
  assert.doesNotThrow(() => assertFactClassPromotion('verified_fact', 'verified_fact'));
  assert.doesNotThrow(() => assertFactClassPromotion('provided_context', 'inference'));
});

test('P3：构建时伪 verified+inference 被降级', () => {
  const pkg = buildEngineeringContextPackage({
    workId: 'w1',
    stage: 'review',
    role: 'reviewer',
    architectureSummary: 'x',
    resources: [{
      resourceId: 'bad',
      kind: 'other',
      pathOrLabel: '猜测',
      verified: true,
      factClass: 'inference'
    }],
    now: 2
  });
  const bad = pkg.resources.find(item => item.resourceId === 'bad');
  assert.equal(bad?.verified, false);
  assert.ok(pkg.unknowns.some(item => /降级|inference|猜测/.test(item)));
});

test('P3：事件投影仍可读 prepared', () => {
  const pkg = buildEngineeringContextPackage({
    workId: 'w1', stage: 'planning', role: 'planner',
    architectureSummary: 's',
    resources: [{
      resourceId: 'p', kind: 'decision', pathOrLabel: 'plan',
      verified: true, factClass: 'verified_fact'
    }],
    now: 9
  });
  const view = projectEcoFromEvents({
    workId: 'w1',
    events: [{ type: 'eco.context.prepared', taskId: 'w1', at: 9, package: pkg }]
  });
  assert.equal(view.package?.contextPackageId, pkg.contextPackageId);
});
