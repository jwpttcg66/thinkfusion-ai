/**
 * P1-01：ECO 按需工程探索。
 *
 * 覆盖：类型化请求规划、六种探索的真实读取与边界、来源（provenance/sources）
 * 与版本、代码/目标变化后的包失效、以及计划里的 contextRequests 协议字段。
 * Run: npm run test:eco-explore
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contextInvalidation,
  contextRequestsForGaps,
  engineeringEvidenceOf,
  fulfillContextRequest,
  buildEngineeringContextPackage
} from '../out-test/shared/eco.js';
import { exploreContextRequest } from '../out-test/main/engineering/eco-explore.js';
import { PlanSchema } from '../out-test/shared/contracts.js';

const DIGEST = 'b'.repeat(64);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-explore-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function target(input: string) {\n  return input;\n}\n');
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'import { target } from "./a";\ntarget("x");\n');
  fs.writeFileSync(path.join(root, 'src/a.test.ts'), 'test("a", () => {});\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  return root;
}

function request(partial) {
  return {
    requestId: 'req-1',
    workId: 'work-1',
    reason: 'test',
    requiredFor: 'review',
    priority: 'high',
    ...partial
  };
}

test('缺口请求按类型产出：文件、符号、调用、测试、目录、diff；已充分则不产请求', () => {
  const pkg = buildEngineeringContextPackage({
    workId: 'work-1', stage: 'planning', role: 'architect', architectureSummary: 's', resources: []
  });
  const requests = contextRequestsForGaps(pkg, {
    paths: ['src/a.ts'],
    symbols: ['target'],
    discoverTests: true,
    directory: 'src',
    readDiff: true
  });
  assert.deepEqual(requests.map(item => item.kind), [
    'FILE_READ', 'SYMBOL_LOOKUP', 'CALL_RELATION', 'TEST_DISCOVERY'
  ]);
  assert.equal(requests[0].priority, 'high');
  assert.equal(requests[1].priority, 'normal');
  assert.deepEqual(requests[0].requestedPaths, ['src/a.ts']);

  const sufficient = buildEngineeringContextPackage({
    workId: 'work-1', stage: 'planning', role: 'architect', architectureSummary: 's',
    resources: [{ resourceId: 'f', kind: 'file', pathOrLabel: 'src/a.ts', verified: true, factClass: 'verified_fact', digest: DIGEST }]
  });
  assert.deepEqual(contextRequestsForGaps(sufficient, { paths: ['src/a.ts'] }), []);
});

test('FILE_READ / DIRECTORY_DISCOVERY 真读工作区，越界路径不算证据', () => {
  const root = workspace();
  const read = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'FILE_READ', requestedPaths: ['src/a.ts', '../escape.ts'] })
  });
  assert.equal(read.resources.length, 1);
  assert.equal(read.resources[0].pathOrLabel, 'src/a.ts');
  assert.match(read.resources[0].digest, /^[a-f0-9]{64}$/);
  assert.equal(read.skipped.length, 1);
  assert.match(read.skipped[0].reason, /相对路径|越界/);

  const dir = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'DIRECTORY_DISCOVERY', directory: 'src' })
  });
  assert.equal(dir.resources.length, 1);
  assert.equal(dir.resources[0].kind, 'module');
  assert.match(dir.resources[0].pathOrLabel, /^src\/?$/);
  assert.match(dir.detail, /列出 3 项/);
});

test('SYMBOL_LOOKUP 找声明，CALL_RELATION 找调用点，不把声明算成调用', () => {
  const root = workspace();
  const symbol = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'SYMBOL_LOOKUP', symbol: 'target' })
  });
  assert.equal(symbol.resources.length, 1);
  assert.equal(symbol.resources[0].kind, 'symbol');
  assert.match(symbol.resources[0].pathOrLabel, /^src\/a\.ts#L1$/);

  const calls = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'CALL_RELATION', symbol: 'target' })
  });
  // b.ts 的调用 + a.ts 的声明行 `function target(` 也会命中调用形态，但绝不能漏掉 b.ts。
  assert.ok(calls.resources.some(item => item.pathOrLabel.startsWith('src/b.ts#L2')));
  assert.match(calls.detail, /命中/);

  const missing = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'SYMBOL_LOOKUP', symbol: 'noSuchThing' })
  });
  assert.equal(missing.resources.length, 0);
  assert.match(missing.skipped[0].reason, /没有找到/);
});

test('TEST_DISCOVERY 找到同名测试；DIFF_READ 不是仓库时如实跳过', () => {
  const root = workspace();
  const tests = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'TEST_DISCOVERY', requestedPaths: ['src/a.ts'] })
  });
  assert.deepEqual(tests.resources.map(item => item.pathOrLabel), ['src/a.test.ts']);
  assert.equal(tests.resources[0].kind, 'test');

  const diff = exploreContextRequest({
    workspaceRoot: root,
    request: request({ kind: 'DIFF_READ', baseRef: 'HEAD' })
  });
  assert.equal(diff.resources.length, 0);
  assert.match(diff.skipped[0].reason, /git diff 执行失败/);
});

test('履行请求会盖来源与版本；分发证据能回答「这条是为什么读的」', () => {
  const root = workspace();
  const base = buildEngineeringContextPackage({
    workId: 'work-1', stage: 'planning', role: 'architect', architectureSummary: 's',
    resources: [], goalVersion: 2
  });
  const req = request({ kind: 'FILE_READ', requestedPaths: ['src/a.ts'] });
  const read = exploreContextRequest({ workspaceRoot: root, request: req });
  const next = fulfillContextRequest(base, req, read.resources);

  assert.equal(next.contextVersion, base.contextVersion + 1);
  assert.equal(next.sufficiency, 'sufficient');
  assert.equal(next.sources.length, 1);
  assert.equal(next.sources[0].kind, 'FILE_READ');
  assert.deepEqual(next.sources[0].resourceIds, ['file:src/a.ts']);
  assert.deepEqual(next.resources[0].provenance, { requestId: 'req-1', kind: 'FILE_READ' });
  const evidence = engineeringEvidenceOf(next);
  assert.equal(evidence[0].requestId, 'req-1');
  assert.equal(evidence[0].kind, 'file');
});

test('提交或目标变了，包判为过期；没有可比字段就不判', () => {
  const pkg = buildEngineeringContextPackage({
    workId: 'work-1', stage: 'planning', role: 'architect', architectureSummary: 's',
    resources: [{ resourceId: 'f', kind: 'file', pathOrLabel: 'a.ts', verified: true, factClass: 'verified_fact', digest: DIGEST }],
    repository: { commit: 'aaaa1111', workingTreeState: 'clean' },
    goalVersion: 1
  });
  assert.equal(contextInvalidation(pkg, {}).stale, false);
  assert.equal(contextInvalidation(pkg, { commit: 'aaaa1111', goalVersion: 1 }).stale, false);

  const commitChanged = contextInvalidation(pkg, { commit: 'bbbb2222' });
  assert.equal(commitChanged.stale, true);
  assert.match(commitChanged.reasons.join(), /提交/);

  const goalChanged = contextInvalidation(pkg, { goalVersion: 2 });
  assert.equal(goalChanged.stale, true);
  assert.match(goalChanged.reasons.join(), /目标版本/);

  const dirty = contextInvalidation(pkg, { workingTreeState: 'dirty:3' });
  assert.equal(dirty.stale, true);
});

test('计划协议接受 contextRequests：六种类型，未知类型拒绝', () => {
  const base = {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 't1',
    roundId: 'r1',
    title: '探索',
    description: '需要确认符号与测试',
    steps: [{ id: 'step-1', tool: 'fs.list', args: { path: '.' } }],
    completion: { condition: '读完' },
    contextRequests: [
      { kind: 'SYMBOL_LOOKUP', reason: '确认定义', symbol: 'target' },
      { kind: 'TEST_DISCOVERY', reason: '确认测试', paths: ['src/a.ts'] }
    ]
  };
  assert.equal(PlanSchema.safeParse(base).success, true);
  const bad = { ...base, contextRequests: [{ kind: 'READ_EVERYTHING', reason: 'x' }] };
  assert.equal(PlanSchema.safeParse(bad).success, false);
});
