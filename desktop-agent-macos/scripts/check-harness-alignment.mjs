/**
 * harness 两条对齐的回归：spawn 前置沙箱 + 逐次审批。
 *
 * 盯的是「真按这个语义办事」而不是函数存在：
 * - profile 必须把写入限制在授权目录，且允许写的路径真的出现在 allow 规则里；
 * - 沙箱不可用时命令**原样执行**且如实标 `sandboxed:false`，不许假装关进了笼子；
 * - 沙箱可用时 argv 必须是 `sandbox-exec -p <profile> <cmd> …` 的顺序；
 * - `needsApproval` 三档语义：off 不问 / every 全问 / mutating 只问有副作用的；
 * - 审批走的是「每一步」而不是「整份计划」：参数预览截断要留痕。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildSeatbeltProfile,
  probeSandbox,
  resetSandboxProbe,
  sandboxArgv,
  wrapWithSandbox
} from '../out/agent/tools/sandbox.js';
import { needsApproval, previewArgs, riskOf, ARGS_PREVIEW_LIMIT } from '../out/agent/step-approval.js';
import { runShell } from '../out/agent/tools/shell.js';
import { TaskGrantSchema } from '../out/shared/contracts.js';

const ROOT = '/tmp/tf-sandbox-root';

function grant(overrides = {}) {
  return {
    taskId: 'task-sandbox-test',
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    rootDir: ROOT,
    allowedTools: ['fs.readFile', 'shell.run', 'fs.writeFile'],
    expiresAt: Date.now() + 60_000,
    maxSteps: 5,
    grantVersion: 1,
    ...overrides
  };
}

test('profile：默认放行读取、禁止一切写入，再把授权目录与临时目录放开', () => {
  const profile = buildSeatbeltProfile({ rootDir: ROOT });
  assert.match(profile, /\(deny file-write\*\)/, '必须禁止一切写入');
  assert.match(profile, /\(allow file-write\*/, '必须再显式放开允许写的位置');
  assert.ok(profile.includes(`"${ROOT}"`), '授权目录必须出现在可写清单里');
  assert.ok(profile.includes(`"${os.tmpdir()}"`), '系统临时目录要放开，否则构建会莫名 EPERM');
  assert.ok(profile.includes('/dev/null'), '写 /dev/null 不该被拦');
  // 顺序错了就变成「全禁」：deny 必须在 allow 之前。
  assert.ok(
    profile.indexOf('(deny file-write*)') < profile.indexOf('(allow file-write*'),
    'deny 必须写在 allow 之前，否则规则被反过来'
  );
});

test('profile：额外可写位置进清单，路径里的引号与反斜杠被转义', () => {
  const weird = '/tmp/tf "quoted" \\ dir';
  const profile = buildSeatbeltProfile({ rootDir: ROOT, extraWritable: [weird] });
  assert.ok(profile.includes('\\"quoted\\"'), '引号要转义，否则 profile 语法会被撑破');
  assert.ok(profile.includes('\\\\'), '反斜杠要转义');
});

test('profile：关掉网络时才写 deny network*', () => {
  assert.ok(!buildSeatbeltProfile({ rootDir: ROOT }).includes('(deny network*)'));
  assert.ok(buildSeatbeltProfile({ rootDir: ROOT, network: false }).includes('(deny network*)'));
});

test('argv 拼装：sandbox-exec -p <profile> <command> … 的顺序', () => {
  const argv = sandboxArgv('(version 1)', '/bin/sh', ['-c', 'echo hi']);
  assert.deepEqual(argv, ['-p', '(version 1)', '/bin/sh', '-c', 'echo hi']);
});

test('探测结果一定带原因，不返回空话', () => {
  resetSandboxProbe();
  const probe = probeSandbox();
  assert.equal(typeof probe.ok, 'boolean');
  // 成功时就是一句「沙箱可用」，短是对的；失败时必须写清为什么退不回去。
  assert.ok(
    probe.ok ? probe.reason.trim().length > 0 : probe.reason.trim().length > 4,
    '无论成功还是失败都要说清楚原因'
  );
  // 缓存要真的生效：第二次不必再跑一次 canary。
  assert.deepEqual(probeSandbox(), probe);
});

test('沙箱不可用：命令原样执行且如实标 sandboxed:false', () => {
  const probe = probeSandbox();
  if (probe.ok) {
    // 这台机器能用沙箱，这条断言没有意义，跳过而不是假装通过。
    return;
  }
  const plan = wrapWithSandbox('/bin/sh', ['-c', 'echo hi'], { rootDir: ROOT });
  assert.equal(plan.command, '/bin/sh');
  assert.deepEqual(plan.argv, ['-c', 'echo hi']);
  assert.equal(plan.sandboxed, false);
  assert.ok(plan.reason.includes('沙箱') || plan.reason.includes('拒绝'), `原因要能读懂：${plan.reason}`);
});

test('shell.run：结果里带真实的沙箱状态，命令本身照常执行', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  const result = await runShell(grant(), { command: 'echo tf-sandbox-ok' });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tf-sandbox-ok/);
  assert.equal(typeof result.sandboxed, 'boolean', '报告必须能看出这一轮有没有被关进笼子');
  assert.ok(result.sandboxReason.length > 4);
  // 白名单策略没被沙箱改动带坏。
  assert.equal(result.policy, 'allowlist');
});

test('shell.run：workspace-write 仍然拒绝组合符（沙箱不替代命令白名单）', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  // 用不含「删根」这类硬拦词的组合符，确保是组合符规则本身在起作用。
  await assert.rejects(
    () => runShell(grant(), { command: 'ls && pwd' }),
    /组合符/
  );
});

test('needsApproval：off 不问、every 全问、mutating 只问有副作用的', () => {
  assert.equal(needsApproval('fs.writeFile', 'off'), false);
  assert.equal(needsApproval('fs.readFile', 'every'), true);
  assert.equal(needsApproval('fs.writeFile', 'mutating'), true);
  assert.equal(needsApproval('fs.readFile', 'mutating'), false);
  assert.equal(needsApproval('fs.tree', 'mutating'), false, '只读工具不该打断用户');
  assert.equal(needsApproval('shell.run', 'mutating'), true);
  assert.equal(needsApproval('fs.search', 'mutating'), false, '搜索也是只读');
});

test('riskOf：只读 / 写 / 高危分得开', () => {
  assert.equal(riskOf('fs.readFile'), 'read');
  assert.equal(riskOf('fs.writeFile'), 'write');
  assert.equal(riskOf('shell.run'), 'danger');
  assert.equal(riskOf('fs.remove'), 'danger');
  assert.equal(riskOf('code.run'), 'danger');
});

test('previewArgs：截断要留痕，不能让人以为看到的是全部', () => {
  assert.equal(previewArgs({ a: 1 }), '{"a":1}');
  const long = previewArgs({ text: 'x'.repeat(ARGS_PREVIEW_LIMIT * 2) });
  assert.ok(long.endsWith(`（已截断，共 ${JSON.stringify({ text: 'x'.repeat(ARGS_PREVIEW_LIMIT * 2) }).length} 字符）`));
  assert.ok(long.length < ARGS_PREVIEW_LIMIT + 80);
  // 循环引用不能让预览炸掉整条审批链路。
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof previewArgs(cyclic), 'string');
});

test('grant：stepApproval 三档可写，缺省留给 Runtime 兜；非法值被拒', () => {
  assert.equal(TaskGrantSchema.parse(grant()).stepApproval, undefined);
  for (const mode of ['every', 'mutating', 'off']) {
    assert.equal(TaskGrantSchema.parse(grant({ stepApproval: mode })).stepApproval, mode);
  }
  assert.throws(() => TaskGrantSchema.parse(grant({ stepApproval: 'sometimes' })), /stepApproval|Invalid/);
});
