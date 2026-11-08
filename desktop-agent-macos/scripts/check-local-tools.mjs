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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
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

// ---------------------------------------------------------------------------
// 7. 文件系统：元数据 / 字面量编辑 / 移动 / 复制 / 删除 / 读图
// ---------------------------------------------------------------------------

import { fsExtraTools } from '../out/agent/tools/fs-extra.js';
import { systemTools } from '../out/agent/tools/system.js';
import { webFetch, isFetchableUrl } from '../out/agent/tools/web-fetch.js';
import { jobOutput, killJob, listJobs, startJob } from '../out/agent/tools/jobs.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('元数据带类型与指纹，不必先读一遍', async () => {
  const g = grant('read-only', ['fs.stat']);
  const result = await fsExtraTools.stat(g, { path: 'README.md' });
  assert.equal(result.type, 'file');
  assert.ok(result.bytes > 0);
  assert.match(result.sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('字面量编辑只改目标，且拒绝含糊的多处命中', async () => {
  const g = grant('workspace-write', ['fs.edit']);
  writeFileSync(join(root, 'edit.txt'), 'alpha beta gamma\n');
  const ok = await fsExtraTools.edit(g, { path: 'edit.txt', oldString: 'beta', newString: 'BETA' });
  assert.equal(ok.replaced, 1);
  assert.match(readFileSync(join(root, 'edit.txt'), 'utf8'), /alpha BETA gamma/);

  writeFileSync(join(root, 'dup.txt'), 'x x x\n');
  await assert.rejects(
    () => fsExtraTools.edit(g, { path: 'dup.txt', oldString: 'x', newString: 'y' }),
    /出现了 3 次/
  );
  const all = await fsExtraTools.edit(g, { path: 'dup.txt', oldString: 'x', newString: 'y', replaceAll: true });
  assert.equal(all.replaced, 3);
});

test('编辑时 hash 不符就拒绝，不会盖掉别人刚改的内容', async () => {
  const g = grant('workspace-write', ['fs.edit']);
  writeFileSync(join(root, 'hash.txt'), 'one\n');
  await assert.rejects(
    () => fsExtraTools.edit(g, {
      path: 'hash.txt', oldString: 'one', newString: 'two',
      expectedHash: '0'.repeat(64)
    }),
    /已经变化/
  );
});

test('只读权限下编辑、移动、复制、删除全部拒绝', async () => {
  const g = grant('read-only', [...READ_ONLY_TOOLS]);
  await assert.rejects(() => fsExtraTools.edit(g, { path: 'README.md', oldString: '#', newString: '#' }), /仅可查看/);
  await assert.rejects(() => fsExtraTools.move(g, { from: 'README.md', to: 'r.md' }), /仅可查看/);
  await assert.rejects(() => fsExtraTools.copy(g, { from: 'README.md', to: 'r.md' }), /仅可查看/);
  await assert.rejects(() => fsExtraTools.remove(g, { path: 'README.md' }), /仅可查看/);
});

test('移动与复制真的改了磁盘，目标已存在就拒绝', async () => {
  const g = grant('workspace-write', ['fs.move', 'fs.copy']);
  writeFileSync(join(root, 'a.txt'), 'A\n');
  const moved = await fsExtraTools.move(g, { from: 'a.txt', to: 'docs/a.txt' });
  assert.equal(moved.to, realpathSync(join(root, 'docs/a.txt')));
  assert.equal(readFileSync(join(root, 'docs/a.txt'), 'utf8'), 'A\n');

  writeFileSync(join(root, 'b.txt'), 'B\n');
  await fsExtraTools.copy(g, { from: 'b.txt', to: 'docs/b.txt' });
  assert.equal(readFileSync(join(root, 'docs/b.txt'), 'utf8'), 'B\n');
  await assert.rejects(() => fsExtraTools.copy(g, { from: 'b.txt', to: 'docs/b.txt' }), /目标已存在/);
});

test('删除默认进废纸篓，目录必须显式 recursive', async () => {
  const g = grant('workspace-write', ['fs.remove']);
  writeFileSync(join(root, 'trash-me.txt'), 'bye\n');
  mkdirSync(join(root, 'tree'), { recursive: true });
  writeFileSync(join(root, 'tree', 'x.txt'), 'x\n');

  await assert.rejects(() => fsExtraTools.remove(g, { path: 'tree' }), /recursive/);
  const result = await fsExtraTools.remove(g, { path: 'trash-me.txt' });
  assert.equal(result.trashed, true);
  assert.ok(result.trashPath && existsSync(result.trashPath));
  // 废纸篓里的文件不直接用 rmSync 删（会触发安全删除策略）；移回临时目录由 after() 收尾。
  spawnSync('/bin/mv', [result.trashPath, join(base, `restored-${Date.now()}.txt`)], { stdio: 'ignore' });
});

test('永久删除只在完全权限下允许', async () => {
  const limited = grant('workspace-write', ['fs.remove']);
  writeFileSync(join(root, 'perm.txt'), 'x\n');
  await assert.rejects(() => fsExtraTools.remove(limited, { path: 'perm.txt', permanent: true }), /完全权限/);
  const full = grant('danger-full-access', ['fs.remove']);
  const result = await fsExtraTools.remove(full, { path: 'perm.txt', permanent: true });
  assert.equal(result.deleted, true);
  assert.equal(existsSync(join(root, 'perm.txt')), false);
});

test('读图返回尺寸、指纹与 base64', async () => {
  writeFileSync(join(root, 'dot.png'), PNG_1X1);
  const g = grant('read-only', ['fs.readImage']);
  const image = await fsExtraTools.readImage(g, { path: 'dot.png' });
  assert.equal(image.mime, 'image/png');
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.match(image.sha256, /^[a-f0-9]{64}$/);
  assert.ok(image.base64.length > 20);
  await assert.rejects(() => fsExtraTools.readImage(g, { path: 'README.md' }), /不支持的图片格式/);
});

// ---------------------------------------------------------------------------
// 8. 系统：剪贴板 / 系统信息 / 进程
// ---------------------------------------------------------------------------

test('剪贴板能写能读，且只读权限拒绝写入', async () => {
  const reader = grant('read-only', ['clipboard.read']);
  const writer = grant('workspace-write', ['clipboard.write']);
  const before = await systemTools.clipboardRead(reader);

  await systemTools.clipboardWrite(writer, { text: 'thinkfusion-clipboard-check' });
  const after = await systemTools.clipboardRead(reader);
  assert.equal(after.text, 'thinkfusion-clipboard-check');

  await assert.rejects(
    () => systemTools.clipboardWrite(grant('read-only', ['clipboard.write']), { text: 'x' }),
    /仅可查看/
  );
  // 还原用户原来的剪贴板。
  await systemTools.clipboardWrite(writer, { text: before.text });
});

test('系统信息给的是本机真实指标', async () => {
  const g = grant('read-only', ['system.info']);
  const info = await systemTools.info(g, { scope: 'all' });
  assert.ok(typeof info.os === 'object' && info.os !== null);
  assert.ok(info.cpu.cores > 0);
  assert.ok(info.memory.totalGb > 0);
  assert.ok(Array.isArray(info.disk));
});

test('进程列表能列出并过滤（被宿主环境挡住时如实拒绝）', async () => {
  const g = grant('read-only', ['process.list']);
  try {
    const all = await systemTools.processList(g, { limit: 10 });
    assert.ok(all.total > 0);
    assert.ok(all.processes.length > 0);
    const filtered = await systemTools.processList(g, { filter: 'definitely-not-a-process-name' });
    assert.equal(filtered.matched, 0);
  } catch (error) {
    // 某些受管环境会拦住 ps/pgrep 的 spawn；这时工具必须明说"读不到"，
    // 而不是返回空列表让模型以为机器上没有进程。真实枚举在真机场景验证。
    assert.match(error.message, /无法读取进程列表/);
  }
});

test('结束任意进程需要完全权限', async () => {
  await assert.rejects(
    () => systemTools.processKill(grant('workspace-write', ['process.kill']), { pid: process.pid }),
    /完全权限/
  );
});

// ---------------------------------------------------------------------------
// 9. 网络抓取
// ---------------------------------------------------------------------------

test('抓取前先拒本机、私网与非 http 协议', async () => {
  assert.equal(isFetchableUrl('http://127.0.0.1:9222/json').ok, false);
  assert.equal(isFetchableUrl('http://192.168.1.1/').ok, false);
  assert.equal(isFetchableUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(isFetchableUrl('file:///etc/passwd').ok, false);
  assert.equal(isFetchableUrl('https://example.com').ok, true);
  await assert.rejects(() => webFetch({ url: 'http://127.0.0.1:9222/json' }), /拒绝抓取/);
});

// ---------------------------------------------------------------------------
// 10. 后台作业
// ---------------------------------------------------------------------------

test('后台作业：启动、读输出、列出来、结束后拒绝 kill', async () => {
  const g = grant('workspace-write', ['shell.run']);
  const job = await startJob(g, { command: 'echo job-hello; sleep 0.2', cwd: root });
  assert.match(job.id, /^job-/);
  assert.ok(job.pid && job.pid > 0);

  await new Promise(resolve => setTimeout(resolve, 600));
  const output = await jobOutput({ id: job.id });
  assert.match(output.output, /job-hello/);
  assert.equal(output.running, false);

  const jobs = await listJobs();
  assert.ok(jobs.some(item => item.id === job.id));
  await assert.rejects(() => killJob({ id: job.id }), /已经退出/);

  // 作业元数据与日志是本次测试产生的，删掉。
  rmSync(job.logPath, { force: true });
  rmSync(join(jobsDirForTest(), `${job.id}.json`), { force: true });
});

test('后台作业的 id 不能被用来读别的文件', async () => {
  await assert.rejects(() => jobOutput({ id: '../../etc/passwd' }), /格式不正确/);
  await assert.rejects(() => killJob({ id: 'job-../x' }), /格式不正确/);
});

function jobsDirForTest() {
  return join(homedir(), 'Library', 'Application Support', 'ThinkFusion', 'jobs');
}
