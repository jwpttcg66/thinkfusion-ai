/**
 * 多 Agent 编码：角色分工、只回 diff、不改工作区。
 *
 * Run with: npm run test:coding-team
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPatches, runCodingTeam } from '../out-test/main/coding/team.js';

const diff = [
  '```diff',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-export const a = 1;',
  '+export const a = 2;',
  '```'
].join('\n');

const deps = () => ({
  ask: async (agentId, task) => {
    if (task.system?.[0]?.includes('编码')) {
      return { text: `改一行：\n${diff}` };
    }
    if (task.system?.[0]?.includes('验证')) return { text: '跑 npm test，退出码应为 0。' };
    if (agentId === 'bad') throw new Error('模型超时');
    return { text: '相关文件：src/a.ts:1' };
  }
});

test('四个角色按顺序分工，Code 只回 diff', async () => {
  const result = await runCodingTeam(
    { task: '把 a 改成 2', files: ['src/a.ts'], members: ['a', 'b', 'c', 'd'], maxParallel: 4 },
    deps()
  );
  assert.deepEqual(result.proposals.map(item => item.role), ['explore', 'code', 'verify', 'review']);
  const code = result.proposals.find(item => item.role === 'code');
  assert.ok(code);
  assert.deepEqual(code.patches.map(item => item.path), ['src/a.ts']);
  assert.match(result.note, /没有写进工作区/);
  assert.equal(result.conflicts.length, 0);
});

test('成员失败如实记录，不拖垮其他角色', async () => {
  const result = await runCodingTeam(
    { task: 'x', members: ['bad', 'b', 'c'], maxParallel: 3 },
    deps()
  );
  const failed = result.proposals.find(item => item.agentId === 'bad');
  assert.ok(failed?.failure);
  assert.equal(result.proposals.filter(item => !item.failure).length, 2);
});

test('没有成员直接拒绝', async () => {
  await assert.rejects(() => runCodingTeam({ task: 'x', members: [] }, deps()), /至少需要一个成员/);
});

test('extractPatches 只认带文件头的 diff 代码块', () => {
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
