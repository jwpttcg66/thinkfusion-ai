/**
 * 第二批补齐能力的回归（23 个）：
 * git 读与轻写 / 数据文件 / 压缩包 / 文本 / 图片 / 宿主环境 / 进程树 / 目录体积。
 *
 * 盯的仍然是「真能干活 + 边界没破」，不是函数存在：
 * - git 真建仓库、真提交、真 stash，diff 能直接喂给 fs.applyPatch；
 * - JSON 取值支持 `a.b[0].c` 与 JSON Pointer，缺键返回 found:false 而不是抛错；
 * - CSV 的引号、引号内逗号、空值都要算对，数值统计不把非数字混进均值；
 * - SQLite 只读打开且写语句在工具层就被拒；
 * - 压缩包 round-trip 成功，条目含 `..` 时整包拒绝（zip-slip）；
 * - 环境变量里的密钥打码，端口/进程树/时间给结构化结果。
 *
 * Run with: npm run test:batch2
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { TOOL_NAMES, READ_ONLY_TOOLS, MUTATING_TOOLS, PlanSchema } from '../out/shared/contracts.js';
import { CAPABILITY_CATALOG } from '../out/shared/capabilities.js';
import { localCapabilities } from '../out/agent/local-plugins.js';
import { gitTools } from '../out/agent/tools/git-tools.js';
import { dataTools } from '../out/agent/tools/data-tools.js';
import { archiveTools, assertSafeArchiveEntries } from '../out/agent/tools/archive.js';
import { textTools } from '../out/agent/tools/text-tools.js';
import { imageTools } from '../out/agent/tools/image-tools.js';
import { hostTools } from '../out/agent/tools/host-tools.js';
import { systemTools } from '../out/agent/tools/system.js';
import { fsExtraTools } from '../out/agent/tools/fs-extra.js';

const TOOL_SPEC = readFileSync(new URL('../src/shared/protocol.ts', import.meta.url), 'utf8');
const base = mkdtempSync(join(tmpdir(), 'tf-batch2-'));
after(() => rmSync(base, { recursive: true, force: true }));

let seq = 0;
function workspace() {
  seq += 1;
  const root = join(base, `ws-${seq}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function grant(rootDir, preset = 'workspace-write') {
  return {
    taskId: `task-batch2-${seq}`,
    permissionPreset: preset,
    approvalPolicy: 'ask',
    rootDir,
    allowedTools: [...TOOL_NAMES],
    expiresAt: Date.now() + 120_000,
    maxSteps: 10,
    grantVersion: 1
  };
}

const NEW_IDS = [
  'git.status', 'git.diff', 'git.log', 'git.show', 'git.stash', 'git.branch',
  'json.query', 'csv.summary', 'sqlite.query',
  'archive.list', 'archive.extract', 'archive.create',
  'text.diff', 'text.base64', 'image.resize',
  'env.read', 'port.list', 'app.list', 'window.list', 'dns.lookup', 'time.now',
  'process.tree', 'fs.du'
];

const git = (cwd, ...argv) => spawnSync('git', argv, { cwd, encoding: 'utf8' });

function initRepo(root) {
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first commit');
}

// ---------------------------------------------------------------------------
// 1. 接线：61 个能力（60 + 输入框附件读取）、23 个新 id 进了 schema / 清单 / 模型可见说明
// ---------------------------------------------------------------------------

test('清单与注册表：23 个新能力都在，合计 96 个，Runtime 全注册', () => {
  assert.equal(CAPABILITY_CATALOG.length, 96);
  for (const id of NEW_IDS) {
    assert.ok(TOOL_NAMES.includes(id), `${id} 不在 TOOL_NAMES`);
    assert.ok(CAPABILITY_CATALOG.some(meta => meta.id === id), `${id} 不在清单`);
    assert.ok(TOOL_SPEC.includes(`- ${id}:`), `${id} 没写进给模型看的工具说明`);
    assert.ok(localCapabilities.has(id), `${id} 没有注册到 Runtime 宿主`);
  }
  assert.deepEqual([...localCapabilities.ids()].sort(), [...TOOL_NAMES].sort());
});

test('每个新工具都能写进计划——StepSchema 是逐工具手写的，只进 TOOL_NAMES 不够', () => {
  // 真机 s32 就是栽在这里：模型写了 `git.status` / `fs.du`，但 StepSchema 里没有
  // 对应分支，计划被判「不受支持的工具名」，用户看到的是一次失败的任务。
  const minimal = {
    'git.status': {},
    'git.diff': {},
    'git.log': {},
    'git.show': { commit: 'HEAD' },
    'git.stash': { action: 'list' },
    'git.branch': { action: 'list' },
    'json.query': { path: 'a.json' },
    'csv.summary': { path: 'a.csv' },
    'sqlite.query': { path: 'a.db', sql: 'select 1' },
    'archive.list': { path: 'a.zip' },
    'archive.extract': { path: 'a.zip' },
    'archive.create': { output: 'a.zip', sources: ['a.txt'] },
    'text.diff': { pathA: 'a.txt', pathB: 'b.txt' },
    'text.base64': { action: 'encode', path: 'a.txt' },
    'image.resize': { path: 'a.png', output: 'b.png' },
    'env.read': {},
    'port.list': {},
    'app.list': {},
    'window.list': {},
    'dns.lookup': { host: 'example.com' },
    'time.now': {},
    'process.tree': {},
    'fs.du': {}
  };

  for (const [tool, args] of Object.entries(minimal)) {
    const plan = {
      protocol: 'desktop-agent/v1',
      type: 'plan',
      taskId: 'task-schema',
      roundId: 'round-schema',
      title: '接线检查',
      description: '',
      steps: [{ id: 'step-1', tool, args, description: '检查' }],
      completion: { condition: '完成' }
    };
    const parsed = PlanSchema.parse(plan);
    assert.equal(parsed.steps[0].tool, tool, `${tool} 没通过计划校验`);
    // 多余参数必须被拒：schema 是 strict 的，写错字段名要立刻报错。
    assert.throws(
      () => PlanSchema.parse({ ...plan, steps: [{ id: 'step-1', tool, args: { ...args, nope: 1 } }] }),
      `${tool} 的 args 没有限制未知字段`
    );
  }
});

test('权限分层：只读与可写不重叠，且覆盖全部工具', () => {
  for (const id of READ_ONLY_TOOLS) assert.ok(!MUTATING_TOOLS.includes(id), `${id} 同时在只读和可写里`);
  assert.deepEqual([...READ_ONLY_TOOLS, ...MUTATING_TOOLS].sort(), [...TOOL_NAMES].sort());
  // 会改仓库、写盘、发DNS 的，都不能进只读。
  for (const id of ['git.stash', 'git.branch', 'archive.extract', 'archive.create', 'text.base64', 'image.resize', 'dns.lookup']) {
    assert.ok(MUTATING_TOOLS.includes(id), `${id} 应该是有副作用的`);
  }
  // 纯查看的必须是只读，否则「仅可查看」档位下用不了。
  for (const id of ['git.status', 'git.log', 'json.query', 'csv.summary', 'env.read', 'port.list', 'time.now', 'process.tree', 'fs.du']) {
    assert.ok(READ_ONLY_TOOLS.includes(id), `${id} 应该允许在只读档位使用`);
  }
});

// ---------------------------------------------------------------------------
// 2. git
// ---------------------------------------------------------------------------

test('git.status 读出分支、改动与未跟踪文件', async () => {
  const root = workspace();
  initRepo(root);
  writeFileSync(join(root, 'a.txt'), 'one\nCHANGED\nthree\n');
  writeFileSync(join(root, 'new.txt'), 'x\n');

  const status = await gitTools.gitStatus(grant(root), {});
  assert.equal(status.branch.length > 0, true);
  assert.equal(status.clean, false);
  const paths = status.changes.map(item => item.path);
  assert.ok(paths.includes('a.txt'), '要能看到已跟踪文件的改动');
  assert.ok(paths.includes('new.txt'), '要能看到未跟踪文件');
  assert.equal(status.changes.find(item => item.path === 'new.txt').untracked, true);
});

test('git.diff 给出可用的 unified diff，git.log/git.show 给出提交', async () => {
  const root = workspace();
  initRepo(root);
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nTHREE\n');

  const diff = await gitTools.gitDiff(grant(root), {});
  assert.equal(diff.truncated, false);
  assert.match(diff.text, /^--- /m);
  assert.match(diff.text, /^\+THREE$/m);
  assert.match(diff.text, /^-three$/m);

  const log = await gitTools.gitLog(grant(root), { limit: 5 });
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].subject, 'first commit');
  assert.match(log.entries[0].date, /^\d{4}-\d{2}-\d{2}T/);

  const shown = await gitTools.gitShow(grant(root), { commit: log.entries[0].hash, stat: true });
  assert.match(shown.text, /first commit/);
  assert.match(shown.text, /a\.txt/);
});

test('git.stash 真暂存真恢复，git.branch 能建能切', async () => {
  const root = workspace();
  initRepo(root);
  writeFileSync(join(root, 'a.txt'), 'one\nSTASHED\nthree\n');

  await gitTools.gitStash(grant(root), { action: 'push', message: 'wip' });
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n', '暂存后工作区要回到干净版本');
  const list = await gitTools.gitStash(grant(root), { action: 'list' });
  assert.match(list.output, /wip/);
  await gitTools.gitStash(grant(root), { action: 'pop' });
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\nSTASHED\nthree\n', '恢复后改动要回来');

  const created = await gitTools.gitBranch(grant(root), { action: 'create', name: 'feature/x' });
  assert.ok(created.branches.some(item => item.name === 'feature/x'));
  const switched = await gitTools.gitBranch(grant(root), { action: 'switch', name: 'feature/x' });
  assert.equal(switched.current, 'feature/x');
});

test('git 拒绝以 - 开头的引用名与越界路径', async () => {
  const root = workspace();
  initRepo(root);
  await assert.rejects(gitTools.gitShow(grant(root), { commit: '--upload-pack=whoami' }), /不合法/);
  await assert.rejects(gitTools.gitBranch(grant(root), { action: 'create', name: '-x' }), /不合法/);
  await assert.rejects(gitTools.gitDiff(grant(root), { path: '../etc/passwd' }), /非法|越界/);
  await assert.rejects(gitTools.gitStash(grant(root, 'read-only'), { action: 'push' }), /仅可查看/);
});

// ---------------------------------------------------------------------------
// 3. 数据文件
// ---------------------------------------------------------------------------

test('json.query 按 a.b[0].c 与 JSON Pointer 取值，缺键如实说没有', async () => {
  const root = workspace();
  writeFileSync(join(root, 'data.json'), JSON.stringify({ a: { b: [{ c: 42 }] }, 'weird.key': 1, list: [1, 2] }));

  const nested = await dataTools.jsonQuery(grant(root), { path: 'data.json', pointer: 'a.b[0].c' });
  assert.equal(nested.found, true);
  assert.equal(nested.value, 42);

  const pointer = await dataTools.jsonQuery(grant(root), { path: 'data.json', pointer: '/weird.key' });
  assert.equal(pointer.value, 1);

  const array = await dataTools.jsonQuery(grant(root), { path: 'data.json', pointer: 'list' });
  assert.equal(array.type, 'array');

  const missing = await dataTools.jsonQuery(grant(root), { path: 'data.json', pointer: 'a.nope' });
  assert.equal(missing.found, false);

  await assert.rejects(dataTools.jsonQuery(grant(root), { path: 'data.json', pointer: 'a.b[x]' }), /无法解析/);
});

test('csv.summary 算对带引号的逗号、空值与数值统计', async () => {
  const root = workspace();
  writeFileSync(
    join(root, 'rows.csv'),
    ['name,qty,note', 'alpha,10,"a,b"', 'beta,,"say ""hi"""', 'gamma,30,'].join('\n')
  );

  const summary = await dataTools.csvSummary(grant(root), { path: 'rows.csv' });
  assert.equal(summary.delimiter, ',');
  assert.equal(summary.rows, 3);
  assert.equal(summary.columns.length, 3);
  assert.equal(summary.columns[0].name, 'name');
  assert.equal(summary.columns[0].distinct, 3);

  const qty = summary.columns[1];
  assert.equal(qty.filled, 2);
  assert.equal(qty.empty, 1);
  assert.deepEqual(qty.numeric, { min: 10, max: 30, mean: 20 });

  const note = summary.columns[2];
  assert.equal(note.filled, 2);
  assert.equal(note.empty, 1);
  assert.ok(note.samples.includes('a,b'), '引号里的逗号不能被当分隔符');
  assert.ok(note.samples.includes('say "hi"'), '双引号转义要还原');
});

test('sqlite.query 只读打开，写语句在工具层就被拒', async () => {
  const root = workspace();
  const file = join(root, 'app.db');
  const available = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
  if (available) {
    spawnSync('sqlite3', [file, 'CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (1, "a"), (2, "b");']);
  } else {
    writeFileSync(file, '');
  }

  await assert.rejects(
    dataTools.sqliteQuery(grant(root), { path: 'app.db', sql: 'INSERT INTO t VALUES (3, "c")' }),
    /只允许 SELECT/
  );
  await assert.rejects(
    dataTools.sqliteQuery(grant(root), { path: 'app.db', sql: 'SELECT 1; DROP TABLE t' }),
    /写操作关键字/
  );

  if (!available) return; // 本机没有 sqlite3 时只验拒绝逻辑，不假装查到了数据

  const result = await dataTools.sqliteQuery(grant(root), { path: 'app.db', sql: 'SELECT id, name FROM t ORDER BY id' });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, 'a');
  assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// 4. 压缩包 / 文本 / 图片
// ---------------------------------------------------------------------------

test('压缩包 round-trip：打包、列条目、解压回原内容', async () => {
  const root = workspace();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.txt'), 'alpha\n');
  writeFileSync(join(root, 'b.txt'), 'beta\n');

  const created = await archiveTools.archiveCreate(grant(root), { output: 'pkg.zip', sources: ['src', 'b.txt'] });
  assert.equal(created.entries > 0, true);
  assert.ok(existsSync(join(root, 'pkg.zip')));

  const listed = await archiveTools.archiveList(grant(root), { path: 'pkg.zip' });
  assert.ok(listed.names.some(name => name.includes('a.txt')));

  const extracted = await archiveTools.archiveExtract(grant(root), { path: 'pkg.zip', destination: 'out' });
  assert.equal(extracted.entries > 0, true);
  assert.equal(readFileSync(join(root, 'out', 'b.txt'), 'utf8'), 'beta\n');
  assert.equal(readFileSync(join(root, 'out', 'src', 'a.txt'), 'utf8'), 'alpha\n');
});

test('压缩包拒绝越界条目（zip-slip）与重复输出', async () => {
  assert.throws(() => assertSafeArchiveEntries(['ok.txt', '../../.ssh/authorized_keys']), /越界/);
  assert.throws(() => assertSafeArchiveEntries(['/etc/passwd']), /绝对路径/);
  assert.doesNotThrow(() => assertSafeArchiveEntries(['src/a.txt', 'dir/b.txt']));

  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'x');
  await assert.rejects(
    archiveTools.archiveCreate(grant(root), { output: 'pkg.zip', sources: ['a.txt'] }).then(() =>
      archiveTools.archiveCreate(grant(root), { output: 'pkg.zip', sources: ['a.txt'] })
    ),
    /已存在/
  );
  await assert.rejects(
    archiveTools.archiveCreate(grant(root, 'read-only'), { output: 'x.zip', sources: ['a.txt'] }),
    /仅可查看/
  );
});

test('text.diff 分清「有差异」与「执行失败」，text.base64 能往返', async () => {
  const root = workspace();
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'b.txt'), 'one\nTWO\n');

  const changed = await textTools.textDiff(grant(root), { pathA: 'a.txt', pathB: 'b.txt' });
  assert.equal(changed.same, false);
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 1);
  assert.match(changed.text, /^--- /m);

  const same = await textTools.textDiff(grant(root), { pathA: 'a.txt', pathB: 'a.txt' });
  assert.equal(same.same, true);
  assert.equal(same.text, '');

  const encoded = await textTools.textBase64(grant(root), { action: 'encode', path: 'a.txt' });
  assert.equal(Buffer.from(encoded.encoded, 'base64').toString('utf8'), 'one\ntwo\n');

  writeFileSync(join(root, 'b64.txt'), encoded.encoded);
  const decoded = await textTools.textBase64(grant(root), { action: 'decode', path: 'b64.txt', output: 'round.txt' });
  assert.equal(decoded.text ?? readFileSync(join(root, 'round.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(readFileSync(join(root, 'round.txt'), 'utf8'), 'one\ntwo\n');
});

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('image.resize 用 sips 真缩放，且不覆盖原图与已有输出', async () => {
  const root = workspace();
  writeFileSync(join(root, 'tiny.png'), Buffer.from(PNG_1X1, 'base64'));

  const resized = await imageTools.imageResize(grant(root), { path: 'tiny.png', output: 'big.png', width: 8, height: 8 });
  assert.deepEqual(resized.from, { width: 1, height: 1 });
  assert.deepEqual(resized.to, { width: 8, height: 8 });
  assert.ok(existsSync(join(root, 'big.png')));

  await assert.rejects(
    imageTools.imageResize(grant(root), { path: 'tiny.png', output: 'big.png', maxDimension: 4 }),
    /已存在/
  );
  await assert.rejects(
    imageTools.imageResize(grant(root), { path: 'tiny.png', output: 'tiny.png', maxDimension: 4 }),
    /同一个路径/
  );
});

// ---------------------------------------------------------------------------
// 5. 宿主环境
// ---------------------------------------------------------------------------

test('env.read 把密钥类变量打码，普通变量原样', async () => {
  process.env.TF_TEST_API_TOKEN = 'super-secret-value';
  process.env.TF_TEST_PLAIN = 'hello';
  const result = await hostTools.envRead(grant(workspace()), { names: ['TF_TEST_API_TOKEN', 'TF_TEST_PLAIN'] });

  const token = result.entries.find(item => item.name === 'TF_TEST_API_TOKEN');
  assert.equal(token.masked, true);
  assert.ok(!token.value.includes('super-secret-value'), '密钥不能出现在返回值里');
  assert.match(token.value, /已隐藏/);

  const plain = result.entries.find(item => item.name === 'TF_TEST_PLAIN');
  assert.equal(plain.masked, false);
  assert.equal(plain.value, 'hello');
});

test('port.list / process.tree / time.now 给结构化结果', async () => {
  const ports = await hostTools.portList(grant(workspace()), {});
  assert.equal(Array.isArray(ports.entries), true);
  for (const entry of ports.entries) {
    assert.equal(typeof entry.port, 'number');
    assert.equal(typeof entry.pid, 'number');
  }

  const tree = await systemTools.processTree(grant(workspace()), { maxEntries: 5 });
  assert.ok(tree.processes.length > 0);
  assert.ok(tree.processes.length <= 5);
  assert.equal(tree.processes[0].depth, 0);

  const now = await hostTools.timeNow();
  assert.ok(!Number.isNaN(Date.parse(now.iso)));
  assert.equal(typeof now.timeZone, 'string');
  assert.ok(now.timeZone.length > 0);
});

test('app.list 只读名字，fs.du 算对体积', async () => {
  const apps = await hostTools.appList(grant(workspace()), { maxEntries: 5 });
  assert.equal(Array.isArray(apps.apps), true);
  assert.ok(apps.apps.length <= 5);

  const root = workspace();
  writeFileSync(join(root, 'small.txt'), 'a'.repeat(100));
  writeFileSync(join(root, 'big.txt'), 'b'.repeat(900));
  const usage = await fsExtraTools.diskUsage(grant(root), {});
  assert.equal(usage.totalBytes, 1000);
  assert.deepEqual(usage.entries.map(item => item.path), ['big.txt', 'small.txt'], '要按体积降序');
  assert.equal(usage.entries[0].bytes, 900);
});

test('dns.lookup 只接受域名形状的 host', async () => {
  await assert.rejects(hostTools.dnsLookup(grant(workspace()), { host: 'http://example.com' }), /必须|域名/);
  await assert.rejects(hostTools.dnsLookup(grant(workspace()), { host: 'localhost:3000' }), /必须|域名/);
});
