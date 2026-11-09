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

test('问题点名的文件即使超过单文件上限也进证据，带上全文行数', async () => {
  // 真机事故：_log_details_20261105_123537.txt_ 有 414KB，超过 256KB 单文件
  // 上限被直接跳过，用户问「总共多少条记录」时主导人根本没拿到这个文件。
  const bigName = '_log_details_20261105_123537.txt_';
  const lines = Array.from({ length: 5000 }, (_, i) => `record-${i} 第${i}条日志 无关词汇 zzqq ${'x'.repeat(40)}`);
  const bigBody = lines.join('\n') + '\n';
  assert.ok(Buffer.byteLength(bigBody) > 262144, '测试文件必须真的超过单文件上限');
  writeFileSync(join(root, bigName), bigBody);

  const scan = await scanProject(root, `读取  /Users/yalla/Downloads/${bigName} 文档 告诉我总共有多少条记录`);
  const hit = scan.evidence.find(item => item.path === bigName);
  assert.ok(hit, '点名文件必须出现在证据里');
  assert.equal(scan.evidence[0].path, bigName, '点名文件排证据第一位');
  assert.equal(hit.totalLines, 5000, '全文行数要按整个文件统计，不是片段');
  assert.ok(hit.partial, '超过上限的点名文件要标记 partial');
  assert.equal(hit.partial.totalBytes, Buffer.byteLength(bigBody));
  assert.ok(scan.warnings.some(w => w.includes(bigName) && w.includes('只取前')), '截断要写进警告');

  const material = engineeringMaterial(scan);
  assert.match(material, /全文共 5000 行/);
  assert.match(material, /只读了前 256 KB/);
  // 真机 s21：统计埋在括号里主导人看不见，点名文件统计必须独立成段。
  assert.match(material, /【点名文件统计】/);
  assert.match(material, /行数统计用的是完整文件/);
});

test('点名文件的结构统计由本机数好：标签、属性、级别都是精确计数', async () => {
  // 真机 s24：用户要「统计这份日志里的标签」，可证据只喂模型前 256 KB，
  // 664 行里它只看到一半多，任何自己数出来的数都系统性偏小。
  const logName = 'struct-20261108.log';
  const body =
    [
      '2026/11/05 09:00:00.001 INFO otlp - [Alpha] a1 [k1=v1] [k2=v2]',
      '2026/11/05 09:00:00.002 WARN otlp - [Beta] b1 [k1=v1] [k2=v3]',
      '2026/11/05 09:00:00.003 INFO otlp - [Alpha] a2 [k1=v1] [k2=v2]',
      'no timestamp line [Alpha] tail [k9=v9]'
    ].join('\n') + '\n';
  writeFileSync(join(root, logName), body);

  const scan = await scanProject(root, `统计 ${logName} 里的标签分布`);
  const hit = scan.evidence.find(item => item.path === logName);
  assert.ok(hit?.structure, '点名文件必须带结构统计');
  const stats = hit.structure;
  assert.equal(stats.lines, 4);
  assert.equal(stats.tagScope, 'line-head', '有日志行首格式时只数行首标签');
  assert.deepEqual(stats.tags.map(t => [t.value, t.count]), [['Alpha', 2], ['Beta', 1]]);
  assert.equal(stats.tagTotal, 3);
  assert.equal(stats.tagDistinct, 2, '正文里的 [Alpha] 不算模块标签');
  assert.equal(stats.attributeTotal, 7, 'k1×3 + k2×3 + k9×1');
  assert.equal(stats.attributeDistinct, 3);
  assert.deepEqual(
    stats.attributes.map(a => [a.key, a.count, a.distinct]),
    [['k1', 3, 1], ['k2', 3, 2], ['k9', 1, 1]]
  );
  assert.deepEqual(stats.levels.map(l => [l.value, l.count]), [['INFO', 2], ['WARN', 1]]);

  const material = engineeringMaterial(scan);
  assert.match(material, /【点名文件结构统计】/);
  assert.match(material, /行首方括号标签/);
  assert.match(material, /Alpha×2、Beta×1/);
  assert.match(material, /INFO×2、WARN×1/);
  assert.match(material, /k1×3（1 种取值：v1）/);
  assert.match(material, /另有 1 行没有这个字段/, '没有级别字段的行要如实说明');
});

test('文件没有日志行首格式时，退回全文方括号统计', async () => {
  const plain = 'plain-20261108.txt';
  writeFileSync(join(root, plain), '见面记录 [TODO] 一条\n[A] 与 [TODO] 两条\n');
  const scan = await scanProject(root, `看一下 ${plain} 里的标签`);
  const stats = scan.evidence.find(item => item.path === plain)?.structure;
  assert.equal(stats.tagScope, 'bracket');
  assert.equal(stats.tagTotal, 3);
  assert.equal(stats.tagDistinct, 2);
  assert.deepEqual(stats.tags.map(t => [t.value, t.count]), [['TODO', 2], ['A', 1]]);
});

test('点名的小文件排进证据第一位，即使别的文件关键词分更高', async () => {
  writeFileSync(join(root, 'notes-20261108.md'), '只有一句话，不含任何问题关键词。\n');
  const scan = await scanProject(root, '帮我读 notes-20261108.md，virtualThread 在里面吗');
  assert.equal(scan.evidence[0].path, 'notes-20261108.md');
  assert.ok(scan.evidence.some(item => item.path === 'src/index.ts'), '其余证据照常保留');
});

test('点名也不会越过凭证与二进制边界', async () => {
  // 「.env」太短不会被当成点名文件；就算写全路径，IGNORED_FILES 也照样拦。
  const scan = await scanProject(root, '读取 /Users/yalla/Downloads/.env 告诉我 API_KEY 是多少');
  assert.ok(!scan.evidence.some(item => item.path === '.env'), '凭证文件永远不进证据');
});

test('不点名时行为与以前完全一致', async () => {
  const scan = await scanProject(root, 'virtualThread 在哪里实现');
  assert.ok(scan.evidence.every(item => item.totalLines === undefined && item.partial === undefined));
  assert.ok(scan.evidence.every(item => item.structure === undefined), '不点名就不做结构统计');
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
  for (const tool of ['fs.search', 'test.run', 'shell.run', 'fs.edit', 'web.search', 'code.run']) {
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

test('目录不像单个工程时，摘要不逐条列顶层文件', async () => {
  // 真机 2026-11-09：工程目录选的是 ~/Downloads，用户只附了一份 md 问行数，
  // 转录里却列出 20 条顶层文件（DS_Store、dmg、pkg…），看着像读了一堆相关文件。
  const big = mkdtempSync(join(tmpdir(), 'tf-big-'));
  try {
    for (let index = 0; index < 220; index += 1) {
      writeFileSync(join(big, `dump-${String(index).padStart(3, '0')}.txt`), 'placeholder\n');
    }
    const scan = await scanProject(big, '这个文件有多少行', {});
    assert.match(scan.summary, /未逐条列出/, '文件太多时不该逐条列顶层');
    // 只要求「顶层：」那一行不点名；「本轮取用」那行仍要写清读了哪几个片段。
    const topLine = scan.summary.split('\n').find(line => line.startsWith('顶层：')) ?? '';
    assert.doesNotMatch(topLine, /dump-000\.txt/, '顶层文件名不该出现在摘要里');
  } finally {
    rmSync(big, { recursive: true, force: true });
  }

  // 真正的工程照旧列出来，别因为这条把有用信息也省了
  const normal = await scanProject(root, '虚拟线程在哪里用', {});
  assert.match(normal.summary, /顶层：/);
  assert.match(normal.summary, /README\.md/);
});

test('数据格式的文本文件会被读，且材料里给出精确行数', async () => {
  // 真机 2026-11-09：目录里只有 data.tsv，扫描按扩展名把它跳过了，模型只看到
  // readme 里「这里没有 tsv」，于是答「无法确定」。表格/日志都是纯文本。
  const data = mkdtempSync(join(tmpdir(), 'tf-data-'));
  try {
    const rows = ['id\tname'];
    for (let index = 1; index <= 212; index += 1) rows.push(`${String(index)}\titem-${String(index)}`);
    writeFileSync(join(data, 'data.tsv'), `${rows.join('\n')}\n`);
    writeFileSync(join(data, 'run.log'), 'line-1\nline-2\n');

    const scan = await scanProject(data, '这个 tsv 有多少行', {});
    assert.ok(scan.fileStats?.some(item => item.path === 'data.tsv'), 'tsv 必须被当成文本读取');
    const tsv = scan.fileStats.find(item => item.path === 'data.tsv');
    assert.equal(tsv.lines, 213, '行数必须按整份文件算');

    const material = engineeringMaterial(scan);
    assert.match(material, /【本机文件统计】/);
    assert.match(material, /data\.tsv：213 行/);
    assert.match(material, /run\.log：2 行/);
    assert.match(material, /不要说无法确定/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('问题里的具体标识由本机定位，补进证据', async () => {
  // 真机 2026-11-09：问「item-137 的 amount 是多少」，本地模型只看到文件开头
  // 7 行，答「无法确定」——它不会主动请求读文件。所以本机按标识先找。
  const data = mkdtempSync(join(tmpdir(), 'tf-hit-'));
  try {
    const rows = ['id\tname\tamount'];
    for (let index = 1; index <= 200; index += 1) rows.push(`${String(index)}\titem-${String(index)}\t${String(index * 7)}`);
    writeFileSync(join(data, 'data.tsv'), `${rows.join('\n')}\n`);
    writeFileSync(join(data, 'notes.md'), '# 说明\n这里只讲流程。\n');

    // maxEvidence 设 0：不靠常规排名，才能单独证明「按标识定位」这一段逻辑。
    const scan = await scanProject(data, 'item-137 的 amount 是多少', { maxEvidence: 0 });
    const hit = scan.evidence.find(item => /本机按问题里的/.test(item.why));
    assert.ok(hit, '带数字的标识必须由本机定位出一段证据');
    assert.equal(hit.path, 'data.tsv');
    assert.match(hit.excerpt, /item-137/);
    assert.match(hit.excerpt, /959/, '命中那一段要包含这一行的值');
    assert.match(scan.summary, /已由本机按内容定位/);

    // 普通词不当标识，避免满目录命中
    const plain = await scanProject(data, '这个表的 am 是多少', { maxEvidence: 0 });
    assert.ok(!(plain.evidence ?? []).some(item => /本机按问题里的/.test(item.why)));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('点名的文件也会把片段挪到标识那一行', async () => {
  // 真机 2026-11-09：问「data.tsv 里 item-137 的 amount」，文件被点名选中了，
  // 但片段取在第 1 行表头（表头里也有 amount），模型只能答「只看到前 7 行」。
  const data = mkdtempSync(join(tmpdir(), 'tf-move-'));
  try {
    const rows = ['id\tname\tamount'];
    for (let index = 1; index <= 200; index += 1) rows.push(`${String(index)}\titem-${String(index)}\t${String(index * 7)}`);
    writeFileSync(join(data, 'data.tsv'), `${rows.join('\n')}\n`);

    const scan = await scanProject(data, 'data.tsv 里 item-137 的 amount 是多少', {});
    const item = scan.evidence.find(entry => entry.path === 'data.tsv');
    assert.ok(item);
    assert.match(item.excerpt, /item-137/, '片段必须落在标识那一行');
    assert.match(item.excerpt, /959/);
    assert.match(scan.summary, /已由本机按内容定位/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
