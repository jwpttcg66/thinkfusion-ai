/**
 * ECO + TDL V2 进度：充分度门禁、事实分类、四级树进度。
 * Run: npm run test:eco
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessContextSufficiency,
  buildEngineeringContextPackage,
  canAssumeRole,
  classifyClaim,
  projectEcoFromEvents
} from '../out-test/shared/eco.js';
import {
  progressRatioFromRows,
  projectWorkBreakdownFromEvents,
  seedWorkEventsFromPlan
} from '../out-test/shared/task-decomposition.js';

test('无核验资源时架构师不足；有核验资源可充分', () => {
  const empty = assessContextSufficiency({ role: 'architect', resources: [] });
  assert.equal(empty.sufficiency, 'insufficient');
  const ok = assessContextSufficiency({
    role: 'architect',
    resources: [{
      resourceId: 'f1', kind: 'file', pathOrLabel: 'src/a.ts',
      verified: true, factClass: 'verified_fact'
    }]
  });
  assert.equal(ok.sufficiency, 'sufficient');
  assert.equal(canAssumeRole('insufficient', 'architect').ok, false);
  assert.equal(canAssumeRole('sufficient', 'architect').ok, true);
});

test('版本变化标记 stale', () => {
  const stale = assessContextSufficiency({
    role: 'reviewer',
    resources: [{
      resourceId: 'f1', kind: 'file', pathOrLabel: 'a.ts',
      verified: true, factClass: 'verified_fact'
    }],
    codeVersionChanged: true
  });
  assert.equal(stale.sufficiency, 'stale');
});

test('事实分类与上下文包投影', () => {
  assert.equal(classifyClaim('我认为可以', false), 'inference');
  assert.equal(classifyClaim('文件内容', true), 'verified_fact');
  const pkg = buildEngineeringContextPackage({
    workId: 'w1',
    stage: 'design',
    role: 'challenger',
    architectureSummary: '摘要',
    resources: [],
    now: 100
  });
  assert.equal(pkg.sufficiency, 'partial');
  const view = projectEcoFromEvents({
    workId: 'w1',
    events: [{ type: 'eco.context.prepared', taskId: 'w1', at: 100, package: pkg }]
  });
  assert.ok(view.package);
  assert.equal(view.package.contextPackageId, pkg.contextPackageId);
});

test('种子事件含 L1 组与 L3 步骤；进度不计 group 分母造假', () => {
  const events = seedWorkEventsFromPlan({
    workId: 'w1',
    title: 'demo',
    plan: {
      planId: 'p1',
      title: 'demo',
      steps: [
        { id: 's1', tool: 'fs.list', args: {}, description: '列目录' },
        { id: 's2', tool: 'fs.readFile', args: {}, description: '读文件' }
      ]
    },
    at: 1
  });
  const view = projectWorkBreakdownFromEvents({ workId: 'w1', events, title: 'demo' });
  assert.ok(view.tasks.some(t => t.level === 1));
  assert.ok(view.tasks.filter(t => t.level === 3).length >= 2);
  assert.equal(view.summary.total, 2);
  assert.equal(view.summary.ratio, 0);
  const mid = progressRatioFromRows([
    { workTaskId: 'g', title: 'g', status: 'ready', dependsOn: [], acceptanceMet: false, artifactCount: 0, level: 1, depth: 0, source: 'work-events' },
    { workTaskId: 'a', title: 'a', status: 'completed', dependsOn: [], acceptanceMet: true, artifactCount: 0, level: 3, depth: 2, source: 'work-events' },
    { workTaskId: 'b', title: 'b', status: 'blocked', dependsOn: [], acceptanceMet: false, artifactCount: 0, level: 3, depth: 2, source: 'work-events' }
  ]);
  assert.equal(mid, 0.5);
});
