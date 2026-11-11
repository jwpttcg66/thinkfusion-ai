/**
 * 网页源「保存文档」的行为测试。
 *
 * 要钉住的是四件事：
 * 1. 提取——文档是页面回答的原样，计划只从「计划块」里挑，普通项目符号
 *    不能凭空变成待办；
 * 2. 成稿——元信息表转义、转录附录截断、附录可关；
 * 3. 落盘——默认 md、显式 doc 才生成 docx、取消对话框不算失败；
 * 4. 页面探针——「读全部回答」是默认关闭的开关，不能拖慢提问时的轮询。
 *
 * Run with: npm run test:page-document
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROBE_SCRIPT } from '../out-test/main/adapters/browser/page-driver.js';
import { buildPageDocument, planItemsOf } from '../out-test/main/export/page-document.js';
import { savePageDocument } from '../out-test/main/export/page.js';
import { previewPageDocument } from '../out-test/shared/export.js';

const work = mkdtempSync(join(tmpdir(), 'tf-page-doc-'));
after(() => rmSync(work, { recursive: true, force: true }));

const content = (patch = {}) => ({
  sourceLabel: 'ChatGPT',
  pageTitle: 'Q4 迁移方案',
  url: 'https://chatgpt.com/c/abc',
  documents: ['# 迁移方案\n\n先备份数据库，再切流量。'],
  transcript: '用户：写一份迁移方案\n助手：# 迁移方案 …',
  ...patch
});

// ---------------------------------------------------------------------------
// 计划条目的提取
// ---------------------------------------------------------------------------

test('计划标题下的步骤条目被挑出来，普通正文里的项目符号不算计划', () => {
  const draft = buildPageDocument(
    content({
      documents: [
        [
          '# 文档',
          '',
          '- 这是正文里的一条说明',
          '- 这也是说明，不是待办',
          '',
          '## 实施计划',
          '',
          '1. 全量备份',
          '2. 灰度 10% 流量',
          '- [ ] 回滚脚本演练',
          '',
          '## 附录说明',
          '',
          '- 附录里的项目符号不该被算成计划'
        ].join('\n')
      ]
    }),
    { now: Date.UTC(2026, 10, 8, 9, 20) }
  );
  assert.deepEqual(draft.planItems, ['1. 全量备份', '2. 灰度 10% 流量', '- [ ] 回滚脚本演练']);
  // 条目自带标记，不再套一层短横（真机 s28 出现过「- - **代码与功能检查**」）。
  assert.match(draft.markdown, /## 计划\n\n1\. 全量备份\n2\. 灰度 10% 流量\n- \[ \] 回滚脚本演练/);
});

test('带复选框的任务清单即使没有计划标题也算计划', () => {
  assert.deepEqual(planItemsOf('- 普通说明\n- [x] 已完成项\n- [ ] 待办项'), ['- [x] 已完成项', '- [ ] 待办项']);
});

test('页面里同一份计划被重发一轮时，完全相同的条目只留一条', () => {
  const repeated = ['## 实施计划', '- 备份', '- 灰度', '## 又一轮实施计划', '- 备份', '- 灰度'].join('\n');
  assert.deepEqual(planItemsOf(repeated), ['- 备份', '- 灰度']);
});

test('认不出计划就如实说明，不硬凑条目', () => {
  const draft = buildPageDocument(content({ documents: ['# 说明\n\n- 一条普通说明'] }));
  assert.deepEqual(draft.planItems, []);
  assert.match(draft.markdown, /没有从上面的文档里识别到计划类条目/);
});

// ---------------------------------------------------------------------------
// 成稿
// ---------------------------------------------------------------------------

test('文档原文照搬，元信息表、来源、时间都在', () => {
  const draft = buildPageDocument(content(), { now: Date.UTC(2026, 10, 8, 9, 20) });
  assert.match(draft.markdown, /^# Q4 迁移方案/m);
  assert.match(draft.markdown, /由 ThinkFusion 从「ChatGPT」网页提取于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(draft.markdown, /\| 页面地址 \| https:\/\/chatgpt\.com\/c\/abc \|/);
  assert.match(draft.markdown, /### 文档 1\n\n# 迁移方案\n\n先备份数据库，再切流量。/);
  assert.equal(draft.documents, 1);
});

test('表格单元格里的竖线转义，整张元信息表不会断成两截', () => {
  const draft = buildPageDocument(content({ pageTitle: 'A|B 方案', sourceLabel: '网页|源' }));
  assert.match(draft.markdown, /^# A\|B 方案/m);
  assert.match(draft.markdown, /\| 网页源 \| 网页\\\|源 \|/);
});

test('转录附录只留节选并写明剩余字数，也可以整个关掉', () => {
  const long = 'x'.repeat(9000);
  const withAppendix = buildPageDocument(content({ transcript: long }));
  assert.match(withAppendix.markdown, /转录共 9000 字，这里只留前 6000 字/);
  assert.ok(withAppendix.markdown.length < 8000, '附录不该把正文撑爆');

  const without = buildPageDocument(content({ transcript: long }), { includeTranscript: false });
  assert.doesNotMatch(without.markdown, /附录　页面转录/);
});

test('页面里没有回答时不假装保存成功：成稿直说是登录页或空会话', () => {
  const draft = buildPageDocument(content({ documents: [] }));
  assert.match(draft.markdown, /这一页没有读到助手回答/);
  assert.equal(draft.documents, 0);
});

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

test('不指定格式默认存 md，磁盘上不会多出一份 Word', async () => {
  const target = join(work, '网页文档');
  const result = await savePageDocument({ path: target }, content(), { defaultDir: () => work });
  assert.equal(result.format, 'md');
  assert.equal(result.path, `${target}.md`);
  assert.ok(existsSync(`${target}.md`));
  assert.ok(!existsSync(`${target}.docx`));
  assert.equal(result.documents, 1);
  assert.equal(result.bytes, statSync(`${target}.md`).size);
  assert.match(readFileSync(`${target}.md`, 'utf8'), /先备份数据库，再切流量。/);
});

test('点名要 doc 才生成合法 Word，正文与表格都在', async () => {
  const target = join(work, '网页文档-word');
  const result = await savePageDocument({ format: 'doc', path: target }, content(), { defaultDir: () => work });
  assert.equal(result.format, 'docx');
  assert.equal(result.path, `${target}.docx`);
  assert.equal(readFileSync(`${target}.docx`).subarray(0, 2).toString(), 'PK');
  const xml = execFileSync('unzip', ['-p', `${target}.docx`, 'word/document.xml'], { encoding: 'utf8' });
  assert.match(xml, /先备份数据库，再切流量。/);
  assert.match(xml, /<w:tbl>/, '元信息表要真的写成表格');
});

test('保存对话框点取消：返回 null，不写任何文件', async () => {
  const result = await savePageDocument({}, content(), {
    defaultDir: () => work,
    pickPath: async () => null
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 页面探针的开关
// ---------------------------------------------------------------------------

test('「读全部回答」默认关闭，只有保存文档时才打开，且两种脚本都能编译', () => {
  const profile = { assistant: ['[data-message-author-role="assistant"]'], input: [], sendButton: [], stopButton: [], passwordField: [] };
  const normal = PROBE_SCRIPT(profile, [], [], [], [], []);
  const full = PROBE_SCRIPT(profile, [], [], [], [], [], true);
  assert.match(normal, /const allAnswers = false;/);
  assert.match(full, /const allAnswers = true;/);
  assert.doesNotThrow(() => new Function('return ' + normal), '默认探针脚本必须能编译');
  assert.doesNotThrow(() => new Function('return ' + full), '读全部回答的探针脚本必须能编译');
});

// ---------------------------------------------------------------------------
// 勾选保存（像微信多选）
// ---------------------------------------------------------------------------

const multi = () => content({
  documents: [
    '# 第一条\n\n关于消防安全的通知。',
    '# 第二条\n\n关于假期值班的安排，正文更长一些。',
    '第三条没有标题，只有一句话。'
  ],
  transcript: '用户：发三条通知\n助手：……'
});

test('预览把每条对话列成一条：标题、摘要、字数', () => {
  const preview = previewPageDocument(multi());
  assert.equal(preview.items.length, 3);
  assert.equal(preview.items[0].title, '第一条');
  assert.match(preview.items[0].excerpt, /消防安全/);
  assert.equal(preview.items[1].title, '第二条');
  assert.equal(preview.items[2].title, '第三条没有标题，只有一句话。');
  assert.equal(preview.totalChars, multi().documents.reduce((sum, text) => sum + text.length, 0));
});

test('只保存勾选的那一条：其余对话不写进文件', async () => {
  const target = join(work, '只存第二条');
  const result = await savePageDocument(
    { path: target, documents: [1] },
    multi(),
    { defaultDir: () => work }
  );
  assert.equal(result.documents, 1);
  const text = readFileSync(`${target}.md`, 'utf8');
  assert.match(text, /关于假期值班的安排/);
  assert.doesNotMatch(text, /消防安全/);
  assert.doesNotMatch(text, /第三条没有标题/);
});

test('逐条保存：每条一个文件，不附页面转录', async () => {
  const dir = join(work, '逐条');
  const result = await savePageDocument(
    { documents: [0, 2], mode: 'per-item', path: dir },
    multi(),
    { defaultDir: () => work }
  );
  assert.equal(result.files.length, 2);
  assert.equal(result.documents, 2);
  assert.ok(existsSync(join(dir, `${result.files[0].path.split('/').pop()}`)));
  const first = readFileSync(result.files[0].path, 'utf8');
  const second = readFileSync(result.files[1].path, 'utf8');
  assert.match(first, /消防安全/);
  assert.doesNotMatch(first, /假期值班/);
  assert.match(second, /第三条没有标题/);
  assert.doesNotMatch(first, /附录　页面转录/, '逐条保存不复制整段转录');
  assert.doesNotMatch(second, /附录　页面转录/);
});

test('勾选的下标越界或被清空时不写空文件', async () => {
  await assert.rejects(
    () => savePageDocument({ path: join(work, '空选择'), documents: [] }, multi(), { defaultDir: () => work }),
    /没有可保存的对话/
  );
  const target = join(work, '越界只剩一条');
  const result = await savePageDocument(
    { path: target, documents: [99, 1] },
    multi(),
    { defaultDir: () => work }
  );
  assert.equal(result.documents, 1);
  assert.match(readFileSync(`${target}.md`, 'utf8'), /假期值班/);
});
