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
  contextRequestForGaps,
  fulfillContextRequest,
  isEngineeringEvidence,
  projectEcoFromEvents
} from '../out-test/shared/eco.js';
import { planEvidencePaths, readEngineeringEvidence } from '../out-test/main/engineering/eco-evidence.js';
import { buildPlanReviewLeadAsk, formatEcoEvidence } from '../out-test/main/engineering/plan-review.js';
import {
  progressRatioFromRows,
  projectWorkBreakdownFromEvents,
  seedWorkEventsFromPlan
} from '../out-test/shared/task-decomposition.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIGEST = 'a'.repeat(64);

test('无核验资源时架构师不足；带摘要的文件证据才可充分', () => {
  const empty = assessContextSufficiency({ role: 'architect', resources: [] });
  assert.equal(empty.sufficiency, 'insufficient');
  const ok = assessContextSufficiency({
    role: 'architect',
    resources: [{
      resourceId: 'f1', kind: 'file', pathOrLabel: 'src/a.ts',
      verified: true, factClass: 'verified_fact', digest: DIGEST
    }]
  });
  assert.equal(ok.sufficiency, 'sufficient');
  assert.equal(canAssumeRole('insufficient', 'architect').ok, false);
  assert.equal(canAssumeRole('sufficient', 'architect').ok, true);
});

test('没有内容摘要的「已核验」不算读过工程', () => {
  const noDigest = assessContextSufficiency({
    role: 'reviewer',
    resources: [{
      resourceId: 'f1', kind: 'file', pathOrLabel: 'src/a.ts',
      verified: true, factClass: 'verified_fact'
    }]
  });
  assert.equal(noDigest.sufficiency, 'insufficient');
  assert.match(noDigest.missingCritical.join(), /工程代码证据/);
  assert.equal(isEngineeringEvidence({
    resourceId: 'f1', kind: 'file', pathOrLabel: 'a.ts',
    verified: true, factClass: 'verified_fact'
  }), false);
});

test('计划与工作区路径不能冒充工程事实', () => {
  const packageWithPlanOnly = assessContextSufficiency({
    role: 'architect',
    resources: [
      { resourceId: 'plan:p1', kind: 'decision', pathOrLabel: 'plan:p1', verified: true, factClass: 'verified_fact' },
      { resourceId: 'ws:/repo', kind: 'other', pathOrLabel: '/repo', verified: true, factClass: 'verified_fact' }
    ]
  });
  assert.equal(packageWithPlanOnly.sufficiency, 'insufficient');
  assert.match(packageWithPlanOnly.reasons.join(), /不等于「读过工程」/);
  // 非正式职责可以带着不完整上下文继续，但同样拿不到 sufficient
  const planner = assessContextSufficiency({
    role: 'planner',
    resources: [{ resourceId: 'ws:/repo', kind: 'other', pathOrLabel: '/repo', verified: true, factClass: 'verified_fact' }]
  });
  assert.equal(planner.sufficiency, 'partial');
});

test('补充请求 → 真读文件 → 抬版本后充分', () => {
  const base = buildEngineeringContextPackage({
    workId: 'w1',
    stage: 'planning',
    role: 'architect',
    architectureSummary: '计划',
    resources: [{ resourceId: 'plan:p1', kind: 'decision', pathOrLabel: 'plan:p1', verified: false, factClass: 'provided_context' }],
    now: 100
  });
  assert.equal(base.sufficiency, 'insufficient');
  const request = contextRequestForGaps(base, { requestedPaths: ['src/a.ts'], now: 101 });
  assert.ok(request);
  assert.deepEqual(request.requestedPaths, ['src/a.ts']);
  const filled = fulfillContextRequest(base, request, [{
    resourceId: 'file:src/a.ts', kind: 'file', pathOrLabel: 'src/a.ts',
    verified: true, factClass: 'verified_fact', digest: DIGEST, size: 12, verifiedAt: 102
  }]);
  assert.equal(filled.sufficiency, 'sufficient');
  assert.equal(filled.contextVersion, base.contextVersion + 1);
  assert.deepEqual(filled.verifiedFacts, ['src/a.ts']);
  assert.equal(contextRequestForGaps(filled), null);
});

test('证据读取：真实算摘要、拒绝越界路径、读不到的如实跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-evidence-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const paths = planEvidencePaths([
    { tool: 'fs.readFile', args: { path: './src/a.ts' } },
    { tool: 'fs.readFile', args: { path: 'src/a.ts' } },
    { tool: 'fs.readFile', args: { path: '../outside.txt' } },
    { tool: 'shell.run', args: { command: 'ls' } }
  ]);
  assert.deepEqual(paths, ['src/a.ts']);
  const read = readEngineeringEvidence({ workspaceRoot: root, paths: ['src/a.ts', 'missing.ts', '../x.ts'], now: 5 });
  assert.equal(read.resources.length, 1);
  assert.equal(read.resources[0].digest, createHash('sha256').update('export const a = 1;\n').digest('hex'));
  assert.equal(read.resources[0].size, 20);
  assert.equal(read.skipped.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
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

test('已核验证据以材料身份进入评审，不写成指令', () => {
  const evidence = [{ path: 'src/a.ts', digest: 'abcdef0123456789'.repeat(4), size: 20 }];
  const block = formatEcoEvidence(evidence);
  assert.match(block, /src\/a\.ts/);
  assert.match(block, /sha256:abcdef012345/);
  assert.match(block, /20B/);
  assert.doesNotMatch(block, /你的职责|请指出|必须/);
  const ask = buildPlanReviewLeadAsk(
    {
      protocol: 'desktop-agent/v1',
      type: 'plan',
      taskId: 't1',
      roundId: 'r1',
      title: '演示',
      description: '说明',
      kind: 'implementation',
      steps: [{ id: 's1', tool: 'fs.readFile', args: { path: 'src/a.ts' } }],
      completion: { condition: '读到文件' }
    },
    '评审这份计划',
    evidence
  );
  assert.match(ask.question, /src\/a\.ts/);
  assert.match(ask.question, /已由系统从工作区实际读取并核验/);
});
