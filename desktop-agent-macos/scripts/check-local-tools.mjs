/**
 * 本地 harness 能力的回归：shell / 截图 / 找文件 / 打开应用。
 *
 * 这份测试盯的不是「函数存在」，而是四件真事：
 * 1. 计划能表达这四类动作（schema 真的收得下）。
 * 2. 权限真的分层（只读一律拒绝，workspace-write 只放白名单命令）。
 * 3. 危险命令真的被拦（不是靠模型自觉）。
 * 4. 命令真的执行了（退出码、stdout、超时都是从子进程读回来的）。
 *
 * 截图与打开应用要动到真实屏幕和进程，只在真机场景里验证；这里验证
 * 参数校验与权限边界，避免 pytest 式的「测试通过但能力没到用户手上」。
 *
 * Run with: npm run test:local-tools
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlanSchema, READ_ONLY_TOOLS } from '../out/shared/contracts.js';
import { allowedToolsForPreset } from '../out/shared/protocol.js';
import { assertGrant } from '../out/agent/policy.js';
import { checkShellCommand, runShell } from '../out/agent/tools/shell.js';
import { captureScreen } from '../out/agent/tools/screen.js';
import { openApp } from '../out/agent/tools/app-open.js';
import { projectReadTools, globToRegExp } from '../out/agent/tools/project-read.js';

const base = mkdtempSync(join(tmpdir(), 'tf-local-tools-'));
const root = join(base, 'project');
mkdirSync(join(root, 'src', 'deep'), { recursive: true });
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'README.md'), '# demo\n');
writeFileSync(join(root, 'src', 'index.ts'), 'export const ok = true;\n');
writeFileSync(join(root, 'src', 'deep', 'nested.ts'), 'export const nested = 1;\n');
writeFileSync(join(root, 'docs', 'guide.md'), '指南\n');
after(() => rmSync(base, { recursive: true, force: true }));

function grant(preset, tools) {
  return {
    taskId: 'task-local-tools',
    permissionPreset: preset,
    approvalPolicy: 'ask',
    rootDir: root,
    allowedTools: tools,
    expiresAt: Date.now() + 60_000,
    maxSteps: 10,
    grantVersion: 1
  };
}

function planWith(step) {
  return {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 'task-local-tools',
    roundId: 'round-1',
    title: '本地能力',
    description: '',
    steps: [step],
    completion: { condition: '命令真的执行过' }
  };
}

// ---------------------------------------------------------------------------
// 1. 计划能表达这四类动作
// ---------------------------------------------------------------------------

test('计划可以要求执行 shell 命令、截屏、打开应用', () => {
  const parsed = PlanSchema.parse(planWith({
    id: 'step-1',
    tool: 'shell.run',
    args: { command: 'ls -la', cwd: 'src', timeoutMs: 30_000 }
  }));
  assert.equal(parsed.steps[0].tool, 'shell.run');
  assert.equal(parsed.steps[0].args.command, 'ls -la');

  const capture = PlanSchema.parse(planWith({
    id: 'step-1',
    tool: 'screen.capture',
    args: { target: 'region', region: { x: 0, y: 0, width: 800, height: 600 } }
  }));
  assert.equal(capture.steps[0].tool, 'screen.capture');

  const open = PlanSchema.parse(planWith({
    id: 'step-1',
    tool: 'app.open',
    args: { app: 'TextEdit' }
  }));
  assert.equal(open.steps[0].tool, 'app.open');
});

test('计划可以按文件名找文件', () => {
  const parsed = PlanSchema.parse(planWith({
    id: 'step-1', tool: 'fs.find', args: { pattern: '*.md' }
  }));
  assert.equal(parsed.steps[0].tool, 'fs.find');
});

test('app.open 同时给 app 和 path 会被 schema 拒绝', () => {
  assert.throws(
    () => PlanSchema.parse(planWith({ id: 'step-1', tool: 'app.open', args: { app: 'TextEdit', path: 'a.txt' } })),
    /只给一个|只能给/
  );
});

test('截图声明 region 却没给参数会被 schema 拒绝', () => {
  assert.throws(
    () => PlanSchema.parse(planWith({ id: 'step-1', tool: 'screen.capture', args: { target: 'region' } })),
    /region/
  );
});

test('shell 命令不允许为空', () => {
  assert.throws(
    () => PlanSchema.parse(planWith({ id: 'step-1', tool: 'shell.run', args: { command: '' } })),
    /at least 1|too small/
  );
});

// ---------------------------------------------------------------------------
// 2. 权限分层
// ---------------------------------------------------------------------------

test('只读权限的可用工具里没有任何系统动作', () => {
  const tools = allowedToolsForPreset('read-only');
  assert.ok(tools.includes('fs.find'), '只读必须能按文件名找文件');
  for (const tool of ['shell.run', 'screen.capture', 'app.open', 'test.run', 'fs.writeFile']) {
    assert.ok(!tools.includes(tool), `只读不该包含 ${tool}`);
  }
  assert.deepEqual([...tools].sort(), [...READ_ONLY_TOOLS].sort());
});

test('只读授权下 shell.run 直接被拒', () => {
  const g = grant('read-only', ['shell.run']);
  assert.throws(() => assertGrant(g, 'shell.run', 1), /仅可查看/);
});

test('只读授权下截屏与打开应用都被拒', async () => {
  const g = grant('read-only', ['screen.capture', 'app.open']);
  await assert.rejects(() => captureScreen(g, {}), /仅可查看/);
  await assert.rejects(() => openApp(g, { app: 'TextEdit' }), /仅可查看/);
});

// ---------------------------------------------------------------------------
// 3. 命令策略
// ---------------------------------------------------------------------------

test('只读权限不允许任何 shell 命令', () => {
  assert.throws(() => checkShellCommand('ls', 'read-only'), /仅可查看/);
});

test('workspace-write 允许只读与构建类命令', () => {
  assert.equal(checkShellCommand('ls -la', 'workspace-write'), 'allowlist');
  assert.equal(checkShellCommand('git status --short', 'workspace-write'), 'allowlist');
  assert.equal(checkShellCommand('npm run test', 'workspace-write'), 'allowlist');
  assert.equal(checkShellCommand('grep -r "ok" src', 'workspace-write'), 'allowlist');
});

test('workspace-write 拒绝写与网络类命令', () => {
  assert.throws(() => checkShellCommand('rm -rf src', 'workspace-write'), /白名单/);
  assert.throws(() => checkShellCommand('curl https://example.com', 'workspace-write'), /白名单/);
  assert.throws(() => checkShellCommand('npx cowsay hi', 'workspace-write'), /白名单/);
});

test('workspace-write 拒绝用组合符绕过白名单', () => {
  assert.throws(() => checkShellCommand('ls; rm -rf src', 'workspace-write'), /组合符/);
  assert.throws(() => checkShellCommand('ls $(rm -rf src)', 'workspace-write'), /组合符/);
  assert.throws(() => checkShellCommand('ls > out.txt', 'workspace-write'), /组合符/);
  assert.throws(() => checkShellCommand('ls && pwd', 'workspace-write'), /组合符/);
});

test('find -exec / xargs 在 workspace-write 下也不给走', () => {
  assert.throws(() => checkShellCommand('find . -name x -exec rm {} \\;', 'workspace-write'), /组合符|写法/);
  assert.throws(() => checkShellCommand('find . -name x -delete', 'workspace-write'), /写法/);
});

test('完全权限允许普通命令', () => {
  assert.equal(checkShellCommand('echo hi', 'danger-full-access'), 'full');
  assert.equal(checkShellCommand('rm -rf build', 'danger-full-access'), 'full');
});

test('任何权限下都拦不可回收的操作', () => {
  for (const command of [
    'sudo ls',
    'mkfs.ext4 /dev/disk2',
    'dd if=/dev/zero of=/dev/disk2',
    'rm -rf /',
    'rm -rf ~',
    ':(){ :|:& };:',
    'shutdown -h now',
    'chmod -R 777 /'
  ]) {
    assert.throws(
      () => checkShellCommand(command, 'danger-full-access'),
      /拒绝|不允许/,
      `应当拦截：${command}`
    );
  }
});

// ---------------------------------------------------------------------------
// 4. 命令真的执行
// ---------------------------------------------------------------------------

test('shell 真的执行并回传 stdout 与退出码', async () => {
  const g = grant('workspace-write', ['shell.run']);
  const result = await runShell(g, { command: 'echo thinkfusion-ok' });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /thinkfusion-ok/);
  // macOS 的 /var 是 /private/var 的软链，运行时拿到的是 realpath。
  assert.equal(result.cwd, realpathSync(root));
  assert.ok(result.durationMs >= 0);
});

test('非零退出码原样返回，不伪装成成功', async () => {
  const g = grant('workspace-write', ['shell.run']);
  const result = await runShell(g, { command: 'cat no-such-file-here' });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stderr.length > 0);
});

test('超时会杀掉整个进程组', async () => {
  const g = grant('danger-full-access', ['shell.run']);
  const result = await runShell(g, { command: 'sleep 5', timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('workspace-write 下不能靠 cwd 逃出工作区', async () => {
  const g = grant('workspace-write', ['shell.run']);
  await assert.rejects(() => runShell(g, { command: 'ls', cwd: '..' }), /越过|非法|必须在工作区内/);
});

// ---------------------------------------------------------------------------
// 5. 找文件
// ---------------------------------------------------------------------------

test('通配符按预期匹配', () => {
  assert.ok(globToRegExp('*.md').test('README.md'));
  assert.ok(globToRegExp('*.md').test('docs/guide.md'));
  assert.ok(!globToRegExp('*.md').test('src/index.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/index.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/deep/nested.ts'));
  assert.ok(globToRegExp('**/*.ts').test('src/deep/nested.ts'));
});

test('真的按文件名搜索工作区', async () => {
  const g = grant('read-only', ['fs.find']);
  const result = await projectReadTools.find(g, { pattern: '*.md' });
  const paths = result.matches.map(item => item.path).sort();
  assert.deepEqual(paths, ['README.md', 'docs/guide.md']);
});

test('找文件能限定目录', async () => {
  const g = grant('read-only', ['fs.find']);
  const result = await projectReadTools.find(g, { pattern: '*.ts', path: 'src' });
  const paths = result.matches.map(item => item.path).sort();
  assert.deepEqual(paths, ['deep/nested.ts', 'index.ts']);
});

// ---------------------------------------------------------------------------
// 6. 打开应用的权限边界（不真的启动进程）
// ---------------------------------------------------------------------------

test('workspace-write 只能打开常见图形应用', async () => {
  const g = grant('workspace-write', ['app.open']);
  await assert.rejects(() => openApp(g, { app: 'Terminal' }), /完全权限|只允许/);
});

test('打开工作区外的路径会被拒', async () => {
  const g = grant('workspace-write', ['app.open']);
  await assert.rejects(() => openApp(g, { path: '/etc/hosts' }), /相对路径|越过/);
});
