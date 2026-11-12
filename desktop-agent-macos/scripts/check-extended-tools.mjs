/**
 * 第一批补齐能力的回归：多 hunk 补丁 / git worktree / 依赖概览 / 源码骨架。
 *
 * 盯的是「能力真能干活且边界没破」：补丁真改文件、上下文对不上整份拒绝、
 * git 真建真删工作树、非法分支名与越界路径被挡、只读档位放行只读工具而
 * 拒绝写操作。不是只检查函数存在。
 *
 * Run with: npm run test:extended-tools
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { PlanSchema, TOOL_NAMES, READ_ONLY_TOOLS, MUTATING_TOOLS } from '../out/shared/contracts.js';
import { allowedToolsForPreset } from '../out/shared/protocol.js';
import { CAPABILITY_CATALOG } from '../out/shared/capabilities.js';
import { extendedTools } from '../out/agent/tools/extended.js';

// TOOL_SPEC 是 protocol.ts 里的模块内常量：直接读源码确认「模型看得见」，
// 比把它导出成公共 API 更贴近这份测试想守的东西。
const TOOL_SPEC = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8');
const base = mkdtempSync(join(tmpdir(), 'tf-extended-'));
const root = join(base, 'project');
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'node_modules'), { recursive: true });
after(() => rmSync(base, { recursive: true, force: true }));

function grant(preset = 'workspace-write', tools = TOOL_NAMES) {
  return {
    taskId: 'task-extended',
    permissionPreset: preset,
    approvalPolicy: 'ask',
    rootDir: root,
    allowedTools: [...tools],
    expiresAt: Date.now() + 60_000,
    maxSteps: 10,
    grantVersion: 1
  };
}

function planWith(step) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 'task-extended',
    roundId: 'round-1',
    title: '补齐能力',
    description: '',
    steps: [step],
    completion: { condition: '完成' }
  };
}

const NEW_IDS = ['fs.applyPatch', 'git.worktree', 'project.dependencies', 'project.outline'];

// ---------------------------------------------------------------------------
// 1. 接线：schema、清单、权限、模型可见的工具说明
// ---------------------------------------------------------------------------

test('四个新工具都在计划 schema、清单与模型工具说明里', () => {
  for (const id of NEW_IDS) {
    assert.ok(TOOL_NAMES.includes(id), `${id} 不在 TOOL_NAMES`);
    assert.ok(CAPABILITY_CATALOG.some(meta => meta.id === id), `${id} 不在清单`);
    assert.ok(TOOL_SPEC.includes(`- ${id}:`), `${id} 没写进给模型看的工具说明`);
  }
  assert.ok(READ_ONLY_TOOLS.includes('project.dependencies'));
  assert.ok(READ_ONLY_TOOLS.includes('project.outline'));
  assert.ok(MUTATING_TOOLS.includes('fs.applyPatch'));
  assert.ok(MUTATING_TOOLS.includes('git.worktree'));
  assert.ok(allowedToolsForPreset('read-only').includes('project.dependencies'));
  assert.ok(!allowedToolsForPreset('read-only').includes('fs.applyPatch'));
  assert.ok(allowedToolsForPreset('workspace-write').includes('fs.applyPatch'));
});

test('四个新工具的参数都能被 PlanSchema 收下，写错的会被拒', () => {
  const steps = [
    { id: 's1', tool: 'fs.applyPatch', args: { path: 'a.txt', patch: '@@ -1 +1 @@\n-x\n+y\n', expectedHash: 'a'.repeat(64) } },
    { id: 's2', tool: 'git.worktree', args: { action: 'list' } },
    { id: 's3', tool: 'project.dependencies', args: {} },
    { id: 's4', tool: 'project.outline', args: { maxSymbols: 5 } }
  ];
  for (const step of steps) {
    const parsed = PlanSchema.safeParse(planWith(step));
    assert.equal(parsed.success, true, `${step.tool} 的合法参数被 schema 拒绝`);
  }
  const bad = PlanSchema.safeParse(planWith({ id: 's5', tool: 'fs.applyPatch', args: { path: 'a.txt' } }));
  assert.equal(bad.success, false, '缺 patch 却通过了校验');
});

// ---------------------------------------------------------------------------
// 2. fs.applyPatch
// ---------------------------------------------------------------------------

const PATCH = [
  '--- a/sample.txt',
  '+++ b/sample.txt',
  '@@ -1,2 +1,2 @@',
  ' alpha',
  '-beta',
  '+BETA',
  '@@ -3,2 +3,3 @@',
  ' gamma',
  ' delta',
  '+epsilon',
  ''
].join('\n');

test('多 hunk 补丁一次改两处，指纹与行数都对', async () => {
  const before = 'alpha\nbeta\ngamma\ndelta\n';
  writeFileSync(join(root, 'sample.txt'), before);
  const result = await extendedTools.applyPatch(grant(), {
    path: 'sample.txt',
    patch: PATCH,
    expectedHash: createHash('sha256').update(before).digest('hex')
  });
  assert.equal(result.hunks, 2);
  assert.equal(readFileSync(join(root, 'sample.txt'), 'utf8'), 'alpha\nBETA\ngamma\ndelta\nepsilon\n');
  assert.equal(result.sha256.length, 64);
  assert.notEqual(result.previousSha256, result.sha256);
});

test('上下文对不上整份拒绝，文件一个字节都不改', async () => {
  const before = readFileSync(join(root, 'sample.txt'), 'utf8');
  await assert.rejects(
    () => extendedTools.applyPatch(grant(), {
      path: 'sample.txt', patch: PATCH,
      expectedHash: createHash('sha256').update(before).digest('hex')
    }),
    /上下文不匹配/
  );
  assert.equal(readFileSync(join(root, 'sample.txt'), 'utf8'), before);
});

test('CRLF 文件应用补丁后仍是 CRLF', async () => {
  const before = 'alpha\r\nbeta\r\n';
  writeFileSync(join(root, 'crlf.txt'), before);
  await extendedTools.applyPatch(grant(), {
    path: 'crlf.txt',
    patch: '--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA',
    expectedHash: createHash('sha256').update(before).digest('hex')
  });
  assert.equal(readFileSync(join(root, 'crlf.txt'), 'utf8'), 'alpha\r\nBETA\r\n');
});

test('没有 expectedHash 直接拒绝；hash 不符、坏补丁、只读档位都拒绝', async () => {
  const before = readFileSync(join(root, 'sample.txt'), 'utf8');
  await assert.rejects(
    () => extendedTools.applyPatch(grant(), { path: 'sample.txt', patch: PATCH }),
    /OBSERVATION_REQUIRED/
  );
  await assert.rejects(
    () => extendedTools.applyPatch(grant(), { path: 'sample.txt', patch: PATCH, expectedHash: '0'.repeat(64) }),
    /已经变化/
  );
  await assert.rejects(
    () => extendedTools.applyPatch(grant(), {
      path: 'sample.txt', patch: '@@ -1 +1 @@\n-nope\n+yep',
      expectedHash: createHash('sha256').update(before).digest('hex')
    }),
    /上下文不匹配/
  );
  await assert.rejects(
    () => extendedTools.applyPatch(grant('read-only'), { path: 'sample.txt', patch: PATCH }),
    /仅可查看/
  );
  assert.equal(readFileSync(join(root, 'sample.txt'), 'utf8'), before);
});

// ---------------------------------------------------------------------------
// 3. git.worktree
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} 失败：${run.stderr}`);
  return run.stdout;
}

test('worktree 真的列出/新增/移除，非法分支名与越界路径被挡', async () => {
  git(root, ['init', '-q']);
  git(root, ['-c', 'user.email=test@local', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init']);
  git(root, ['branch', 'feature-x']);

  const listed = await extendedTools.gitWorktree(grant(), { action: 'list' });
  assert.equal(listed.action, 'list');
  assert.ok(listed.worktrees.length >= 1);

  // 目标必须留在授权目录内：`..` 会被 resolveGrantedPath 挡掉（下面有专门断言）。
  const target = join(root, 'wt-feature');
  const added = await extendedTools.gitWorktree(grant(), { action: 'add', path: 'wt-feature', branch: 'feature-x' });
  assert.equal(added.exitCode, 0);
  assert.equal(readFileSync(join(target, '.git'), 'utf8').includes('gitdir:'), true);

  const afterAdd = await extendedTools.gitWorktree(grant(), { action: 'list' });
  assert.equal(afterAdd.worktrees.length, listed.worktrees.length + 1);

  const removed = await extendedTools.gitWorktree(grant(), { action: 'remove', path: 'wt-feature' });
  assert.equal(removed.exitCode, 0);

  // create=true 用 -b 新建分支；脏工作树不 force 不能删。
  await extendedTools.gitWorktree(grant(), {
    action: 'add', path: 'wt-created', branch: 'wt-new-branch', create: true
  });
  writeFileSync(join(root, 'wt-created', 'dirty.txt'), 'not committed\n');
  await assert.rejects(
    () => extendedTools.gitWorktree(grant(), { action: 'remove', path: 'wt-created' }),
    /WORKTREE_DIRTY/
  );
  const forced = await extendedTools.gitWorktree(grant(), { action: 'remove', path: 'wt-created', force: true });
  assert.equal(forced.exitCode, 0);

  await assert.rejects(
    () => extendedTools.gitWorktree(grant(), { action: 'add', path: 'wt-bad', branch: '--upload-pack=whoami' }),
    /branch 不合法/
  );
  await assert.rejects(
    () => extendedTools.gitWorktree(grant(), { action: 'remove', path: '../../escape' }),
    /路径|授权/
  );
  await assert.rejects(
    () => extendedTools.gitWorktree(grant('read-only'), { action: 'list' }),
    /仅可查看/
  );
});

// ---------------------------------------------------------------------------
// 4. 只读概览
// ---------------------------------------------------------------------------

test('依赖概览读出包管理器、锁文件、脚本与依赖数量', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'demo',
    version: '1.2.3',
    scripts: { test: 'node --test', build: 'tsc' },
    dependencies: { zod: '^3.0.0', react: '^19.0.0' },
    devDependencies: { typescript: '^5.0.0' }
  }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

  const view = await extendedTools.projectDependencies(grant('read-only'), {});
  assert.equal(view.name, 'demo');
  assert.equal(view.packageManager, 'pnpm');
  assert.equal(view.lockfile, 'pnpm-lock.yaml');
  assert.deepEqual(view.scripts, ['test', 'build']);
  assert.deepEqual(view.counts, {
    dependencies: 2, devDependencies: 1, peerDependencies: 0, optionalDependencies: 0
  });
  assert.ok(view.dependencies.some(dep => dep.name === 'zod'));
});

test('源码骨架列出符号、跳过忽略目录、只读放行、上限生效', async () => {
  writeFileSync(join(root, 'src', 'index.ts'), [
    'export function alpha() { return 1; }',
    'export const beta = 2;',
    'class Internal {}',
    ''
  ].join('\n'));
  writeFileSync(join(root, 'src', 'util.py'), 'def py_helper():\n    return 3\n');
  writeFileSync(join(root, 'node_modules', 'ignored.ts'), 'export function hidden() {}\n');

  const view = await extendedTools.projectOutline(grant('read-only'), {});
  const names = view.symbols.map(s => s.name);
  assert.ok(names.includes('alpha'), '没找到导出的函数');
  assert.ok(names.includes('beta'), '没找到导出的常量');
  assert.ok(names.includes('py_helper'), '没找到 python 函数');
  assert.ok(!names.includes('hidden'), 'node_modules 不该被扫');
  assert.ok(view.files >= 2);

  const capped = await extendedTools.projectOutline(grant('read-only'), { maxFiles: 1, maxSymbols: 1 });
  assert.equal(capped.symbols.length, 1);
  assert.equal(capped.truncated, true);
});
