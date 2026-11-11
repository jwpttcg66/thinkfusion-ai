/**
 * 多 Agent 编码：两阶段真实交接、补丁校验、只回 diff、不改工作区。
 *
 * Run with: npm run test:coding-team
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { extractPatches, runCodingTeam } from '../out-test/main/coding/team.js';
import { normalizePatchPath, validatePatches } from '../out-test/main/coding/patch.js';

const diff = [
  '```diff',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 2;',
  '```'
].join('\n');

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-team-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

const deps = (log = []) => ({
  ask: async (agentId, task) => {
    log.push({ agentId, system: task.system?.[0] ?? '', question: task.question });
    if (task.system?.[0]?.includes('编码')) return { text: `改一行：\n${diff}` };
    if (task.system?.[0]?.includes('验证')) return { text: '跑 npm test，退出码应为 0。' };
    if (task.system?.[0]?.includes('评审')) return { text: '未发现阻断问题；补丁已看到。' };
    if (agentId === 'bad') throw new Error('模型超时');
    return { text: '相关文件：src/a.ts:1' };
  }
});

test('两阶段交接：Code 的 diff 真的进了 Verify / Review 的提示词', async () => {
  const log = [];
  const result = await runCodingTeam(
    { task: '把 a 改成 2', files: ['src/a.ts'], members: ['a', 'b', 'c', 'd'], maxParallel: 4, root },
    deps(log)
  );
  assert.deepEqual(result.proposals.map(item => item.role), ['explore', 'code', 'verify', 'review']);
  assert.deepEqual(result.stages.map(item => item.name), ['探索 + 编码', '验证 + 评审']);
  assert.equal(result.stages[1].agents.length, 2);

  const code = result.proposals.find(item => item.role === 'code');
  assert.ok(code);
  assert.equal(code.patches.length, 1);
  assert.equal(code.patches[0].valid, true);
  assert.equal(code.patches[0].expectedHash, sha('export const a = 1;\n'));
  assert.equal(result.applyable, true);

  const verify = log.find(item => item.system.includes('验证'));
  const review = log.find(item => item.system.includes('评审'));
  for (const entry of [verify, review]) {
    assert.ok(entry, '验证/评审没有被调用');
    assert.match(entry.question, /补丁 1：src\/a\.ts/);
    assert.match(entry.question, /-export const a = 1;/);
    assert.match(entry.question, /相关文件：src\/a\.ts:1/, '探索结果没有交给下游');
  }
});

test('成员失败如实记录，不拖垮其他角色', async () => {
  const result = await runCodingTeam(
    { task: 'x', members: ['bad', 'b', 'c'], maxParallel: 3, root },
    deps()
  );
  const failed = result.proposals.find(item => item.agentId === 'bad');
  assert.ok(failed?.failure);
  assert.equal(result.proposals.filter(item => !item.failure).length >= 2, true);
});

test('没有成员直接拒绝', async () => {
  await assert.rejects(() => runCodingTeam({ task: 'x', members: [] }, deps()), /至少需要一个成员/);
});

test('补丁上下文与当前文件不符：标为 invalid，不给 expectedHash', async () => {
  fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 9;\n');
  const stale = [
    '```diff',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-export const b = 1;',
    '+export const b = 2;',
    '```'
  ].join('\n');
  const result = await runCodingTeam(
    { task: 'x', files: ['src/b.ts'], members: ['a', 'b'], maxParallel: 2, root },
    {
      ...deps(),
      ask: async (_agentId, task) => {
        if (task.system?.[0]?.includes('编码')) return { text: stale };
        return { text: '看到了。' };
      }
    }
  );
  const code = result.proposals.find(item => item.role === 'code');
  assert.equal(code.patches[0].valid, false);
  assert.match(code.patches[0].reason, /上下文不匹配|基于旧版本/);
  assert.equal(result.applyable, false);
  assert.match(result.note, /没有写进工作区/);
});

test('路径校验：拒绝绝对路径、.. 与重复文件', async () => {
  assert.equal(normalizePatchPath('a/src/x.ts'), 'src/x.ts');
  assert.equal(normalizePatchPath('b/src/x.ts'), 'src/x.ts');
  assert.equal(normalizePatchPath('/etc/passwd'), null);
  assert.equal(normalizePatchPath('../outside.ts'), null);
  assert.equal(normalizePatchPath('src/../../outside.ts'), null);

  const bad = await validatePatches(
    [
      { path: 'src/a.ts', patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;' },
      { path: 'src/a.ts', patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 2;\n+export const a = 3;' }
    ],
    { root }
  );
  assert.equal(bad[0].valid, true);
  assert.equal(bad[1].valid, false);
  assert.match(bad[1].reason, /重复修改/);
});

test('extractPatches 只认带文件头的 diff 代码块，并归一化 a//b/ 前缀', () => {
  const text = [
    '```diff',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1 +1 @@',
    "-let a = 1;",
    '+let a = 2;',
    '```',
    '```ts',
    'const noise = 1;',
    '```'
  ].join('\n');
  assert.deepEqual(extractPatches(text), [{
    path: 'x.ts',
    patch: ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-let a = 1;', '+let a = 2;'].join('\n')
  }]);
});
