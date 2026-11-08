/**
 * V2.1 工程理解 / 工程实施的能力测试。
 *
 * 全部在本机临时目录里跑：不连网页、不建会话、不往用户自己的工程写东西。
 * 测的是「真的读到了文件」「真的能搜到行号」「覆盖写真的校验旧版本」
 * 「测试失败真的会被记录」这四件事，而不是又一组类型断言。
 *
 * Run with: npm run test:engineering
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject, engineeringMaterial } from '../out-test/main/engineering/project.js';
import { ruleReview, reviewExecution } from '../out-test/main/engineering/review.js';
import { filesystemTools } from '../out/agent/tools/filesystem.js';
import { projectReadTools } from '../out/agent/tools/project-read.js';
import { assertGrant } from '../out/agent/policy.js';
import { PlanSchema, TaskGrantSchema, TOOL_NAMES, READ_ONLY_TOOLS } from '../out/shared/contracts.js';
import { allowedToolsForPreset } from '../out/shared/protocol.js';

const root = mkdtempSync(join(tmpdir(), 'tf-v21-'));
after(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(root, 'README.md'), '# demo\n这个工程演示虚拟线程的用法。\n');
writeFileSync(
  join(root, 'src', 'index.ts'),
  ['export const name = "demo";', '', 'function virtualThread() {', '  return 42;', '}', ''].join('\n')
);
writeFileSync(join(root, '.env'), 'API_KEY=should-never-be-read\n');
writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

function grant(overrides = {}) {
  return {
    taskId: 't1',
    permissionPreset: 'workspace-write',
    approvalPolicy: 'ask',
    rootDir: root,
    allowedTools: [...TOOL_NAMES],
    expiresAt: Date.now() + 60_000,
    maxSteps: 10,
    ...overrides
  };
}

test('工程扫描真的读到文件，带路径、行号、指纹与时间', async () => {
  const scan = await scanProject(root, 'virtualThread 在哪里实现');
  assert.ok(scan.filesScanned >= 2);
  const hit = scan.evidence.find(item => item.path === 'src/index.ts');
  assert.ok(hit, '应该读到 src/index.ts');
  assert.equal(hit.line >= 1, true);
  assert.match(hit.excerpt, /virtualThread/);
  assert.equal(hit.sha256.length, 64);
  assert.ok(hit.mtime > 0 && hit.readAt > 0);
  // macOS 上 /var 会被 realpath 展开成 /private/var，只断言它是同一个目录。
  assert.equal(realpathSync(scan.root), realpathSync(root));

  const material = engineeringMaterial(scan);
  assert.match(material, /src\/index\.ts:\d+/);
  assert.match(material, /真实读取/);
});

test('凭证、依赖目录不会被读进证据', async () => {
  const scan = await scanProject(root, 'API_KEY 是什么');
  const paths = scan.evidence.map(item => item.path);
  assert.ok(!paths.some(item => item.includes('.env')));
  assert.ok(!paths.some(item => item.includes('node_modules')));
  assert.ok(!scan.evidence.some(item => item.excerpt.includes('should-never-be-read')));
});

test('Runtime 的 tree 跳过依赖目录，search 返回路径:行号', async () => {
  const tree = await projectReadTools.tree(grant(), { path: '.' });
  assert.ok(tree.entries.some(item => item.path === 'src/index.ts'));
  assert.ok(!tree.entries.some(item => item.path.includes('node_modules')));
  assert.ok(!tree.entries.some(item => item.path.includes('.env')));

  const found = await projectReadTools.search(grant(), { query: 'virtualThread' });
  assert.ok(found.matches.length >= 1);
  assert.equal(found.matches[0].path, 'src/index.ts');
  assert.equal(found.matches[0].line, 3);
  assert.match(found.matches[0].text, /virtualThread/);
});

test('覆盖已有文件必须带当时读到的 sha256，旧版本一律拒绝', async () => {
  const before = await filesystemTools.readFile(grant(), { path: 'src/index.ts' });
  assert.equal(before.sha256.length, 64);

  await assert.rejects(
    filesystemTools.overwriteFile(grant(), { path: 'src/index.ts', content: 'x' }),
    /必须提供/
  );
  await assert.rejects(
    filesystemTools.overwriteFile(grant(), {
      path: 'src/index.ts', content: 'x', expectedHash: 'a'.repeat(64)
    }),
    /已经变化|拒绝覆盖/
  );

  const result = await filesystemTools.overwriteFile(grant(), {
    path: 'src/index.ts', content: 'export const name = "changed";\n', expectedHash: before.sha256
  });
  assert.equal(result.replaced, true);
  assert.equal(result.previousSha256, before.sha256);
  assert.match(readFileSync(join(root, 'src', 'index.ts'), 'utf8'), /changed/);

  // 中间被别人改过：把旧 hash 再用一次必须失败。
  await assert.rejects(
    filesystemTools.overwriteFile(grant(), {
      path: 'src/index.ts', content: 'y', expectedHash: before.sha256
    }),
    /已经变化|拒绝覆盖/
  );
});

test('只读预设允许搜索，但绝不允许测试命令', () => {
  const readOnly = grant({ permissionPreset: 'read-only', allowedTools: [...READ_ONLY_TOOLS] });
  assert.doesNotThrow(() => assertGrant(readOnly, 'fs.search', 1));
  assert.doesNotThrow(() => assertGrant(readOnly, 'fs.tree', 1));
  assert.throws(() => assertGrant(readOnly, 'test.run', 1), /仅可查看|未授权工具/);
  assert.throws(() => assertGrant(readOnly, 'fs.writeFile', 1), /仅可查看|未授权工具/);
  assert.ok(allowedToolsForPreset('read-only').includes('fs.search'));
  assert.ok(!allowedToolsForPreset('read-only').includes('test.run'));
});

test('新工具进得了协议，未登记的工具与越权调用仍然进不来', () => {
  // 别再写死工具数量：每补一个本地能力就要改一次断言，改的人只会顺手把数字调大。
  // 这里断言"存在"与"越权仍被拒"，那才是这条用例真正关心的。
  for (const tool of ['fs.search', 'test.run', 'shell.run', 'fs.edit']) {
    assert.ok(TOOL_NAMES.includes(tool), `${tool} 应当登记在工具集里`);
  }
  const base = {
    protocol: 'desktop-agent/v1', type: 'plan', taskId: 't1', roundId: 'r1',
    title: '改文件', description: '演示', completion: { condition: '测试通过' }
  };
  assert.doesNotThrow(() => PlanSchema.parse({
    ...base,
    steps: [
      { id: 's1', tool: 'fs.search', args: { query: 'name' } },
      { id: 's2', tool: 'test.run', args: { command: 'npm test' } }
    ]
  }));
  // shell 现在是登记过的工具：能进协议，但是否真的执行由授权决定。
  const readOnly = grant({ permissionPreset: 'read-only', allowedTools: [...READ_ONLY_TOOLS] });
  assert.doesNotThrow(() => PlanSchema.parse({
    ...base, steps: [{ id: 's1', tool: 'shell.run', args: { command: 'ls -la' } }]
  }));
  assert.throws(() => assertGrant(readOnly, 'shell.run', 1), /仅可查看|未授权工具/);
  assert.throws(() => PlanSchema.parse({
    ...base, steps: [{ id: 's1', tool: 'shell.exec', args: { command: 'rm -rf /' } }]
  }));
  assert.throws(() => PlanSchema.parse({
    ...base,
    steps: [{ id: 's1', tool: 'fs.writeFile', args: { path: 'a.txt', content: 'x', overwrite: true } }]
  }), /expectedHash/);
  assert.doesNotThrow(() => TaskGrantSchema.parse(grant()));
});

test('独立 Review：改了文件却没跑测试、测试非零退出码都会被指出', () => {
  const plan = {
    protocol: 'desktop-agent/v1', type: 'plan', taskId: 't1', roundId: 'r1',
    title: '改文件', description: '演示',
    steps: [{ id: 's1', tool: 'fs.writeFile', args: { path: 'a.txt', content: 'x' } }],
    completion: { condition: '完成' }
  };
  const report = {
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't1', roundId: 'r1', planId: 'p1',
    status: 'completed',
    results: [{ stepId: 's1', tool: 'fs.writeFile', status: 'completed', verified: true, durationMs: 2 }],
    errors: [], nextAction: 'complete', createdAt: Date.now()
  };
  const first = ruleReview(report, plan);
  assert.ok(first.issues.some(issue => issue.includes('没有 test.run')));

  const withTest = {
    ...report,
    results: [
      ...report.results,
      {
        stepId: 's2', tool: 'test.run', status: 'failed', verified: true, durationMs: 100,
        result: { command: 'npm test', exitCode: 1 }, error: '命令退出码 1'
      }
    ]
  };
  const second = ruleReview(withTest, plan);
  assert.ok(second.issues.some(issue => issue.includes('退出码 1')));
});

test('没有可用模型时 Review 如实标成规则版，不假装模型裁决', async () => {
  const plan = {
    protocol: 'desktop-agent/v1', type: 'plan', taskId: 't1', roundId: 'r1',
    title: '改文件', description: '演示',
    steps: [{ id: 's1', tool: 'test.run', args: { command: 'npm test' } }],
    completion: { condition: '完成' }
  };
  const report = {
    protocol: 'desktop-agent/v1', type: 'execution_report', taskId: 't1', roundId: 'r1', planId: 'p1',
    status: 'completed',
    results: [{ stepId: 's1', tool: 'test.run', status: 'completed', verified: true, durationMs: 5, result: { exitCode: 0 } }],
    errors: [], nextAction: 'complete', createdAt: Date.now()
  };
  const verdict = await reviewExecution(report, plan);
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.needsFix, false);
  assert.equal(verdict.reviewer, '本机规则');
});
