/**
 * 会话导出（Markdown / Word）的行为测试。
 *
 * 要钉住的是三件事：
 *
 * 1. 内容——导出的字就是会话里存的字：按轮分组、通道名可读、系统提示不丢、
 *    综合结论的结构化部分（一致 / 分歧 / 只有一家提到）也要在；
 * 2. 文件——md 是 UTF-8 文本、docx 是合法 zip（PK + word/document.xml），
 *    路径后缀和所选格式一致，保存对话框取消时不算失败；
 * 3. 边界——会话不存在要报错、证据附录可关掉。
 *
 * Run with: npm run test:export
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConversationMarkdown } from '../out-test/main/export/markdown.js';
import { markdownToDocx, parseMarkdown } from '../out-test/main/export/docx.js';
import { exportConversation } from '../out-test/main/export/index.js';
import { defaultExportName, ensureExtension, resolveExportFormat } from '../out-test/shared/export.js';

const work = mkdtempSync(join(tmpdir(), 'tf-export-'));
after(() => rmSync(work, { recursive: true, force: true }));

const conversation = (patch = {}) => ({
  conversationId: 'conv-1',
  title: '统计这份日志里的标签',
  intent: 'research',
  intentReason: '工程空间直接问',
  status: 'answered',
  channels: ['ollama:deepseek-r1:14b'],
  createdAt: Date.UTC(2026, 10, 8, 7, 51),
  updatedAt: Date.UTC(2026, 10, 8, 8, 5),
  workspaceMode: 'engineering',
  workspaceRoot: '/Users/yalla/Downloads',
  executionConfig: { executionMode: 'local' },
  ...patch
});

const message = (role, text, patch = {}) => ({
  messageId: `${role}-${Math.random().toString(16).slice(2, 8)}`,
  conversationId: 'conv-1',
  role,
  text,
  at: Date.UTC(2026, 10, 8, 8, 0),
  ...patch
});

const labels = { 'ollama:deepseek-r1:14b': 'DeepSeek · deepseek-r1:14b', chatgpt: 'ChatGPT' };

// ---------------------------------------------------------------------------
// 内容
// ---------------------------------------------------------------------------

test('按轮分组：提问、每个通道的回答、系统提示各就各位', () => {
  const markdown = buildConversationMarkdown({
    conversation: conversation(),
    messages: [
      message('user', '统计这份日志里的标签'),
      message('channel', '共 14 种标签。', { channelId: 'ollama:deepseek-r1:14b' }),
      message('system', '本地模型主导：本轮不问网页。'),
      message('user', '再按级别统计一次'),
      message('channel', 'DEBUG 476 / INFO 167 / WARN 21。', { channelId: 'chatgpt' })
    ],
    labels,
    now: Date.UTC(2026, 10, 8, 8, 30)
  });

  assert.match(markdown, /^# 统计这份日志里的标签/m);
  assert.match(markdown, /## 第 1 轮/);
  assert.match(markdown, /### 提问\n\n统计这份日志里的标签/);
  assert.match(markdown, /#### DeepSeek · deepseek-r1:14b\n\n共 14 种标签。/);
  assert.match(markdown, /> 本地模型主导：本轮不问网页。/);
  assert.match(markdown, /## 第 2 轮/);
  assert.match(markdown, /#### ChatGPT\n\nDEBUG 476/);
});

test('过程记录不把几百字的目录清单原样搬进文档，但要说清后面还有多少', () => {
  const long = `已读取工程目录：\n${'文件 something.dmg、'.repeat(200)}`;
  const markdown = buildConversationMarkdown({
    conversation: conversation(),
    messages: [message('user', '问'), message('system', long)],
    labels
  });
  assert.ok(markdown.includes('还有'), '截断处要说明还剩多少字');
  assert.ok(markdown.length < 3000, `导出的文档不该被这条系统消息撑爆：${markdown.length}`);
  assert.ok(long.length > 3000, '样本本身要够长，否则这条测试什么都没测');
});

test('通道名认不出来时退回裸模型名，不把 `ollama:` 前缀写进文档', () => {  const markdown = buildConversationMarkdown({
    conversation: conversation(),
    messages: [message('user', '问一句'), message('channel', '答一句', { channelId: 'ollama:qwen2.5:7b' })],
    labels: {}
  });
  assert.match(markdown, /#### qwen2\.5:7b/);
  assert.doesNotMatch(markdown, /ollama:qwen2\.5/);
});

test('综合结论：主导人写的只留一段，规则版的结构化部分照实列出', () => {
  const lead = buildConversationMarkdown({
    conversation: conversation(),
    messages: [
      message('user', '两个方案哪个好'),
      message('synthesis', '先做 A，成本低。', {
        synthesis: {
          consensus: [{ text: '都不建议 C', sources: [], evidence: [] }],
          disputed: [],
          unique: [],
          gaps: [],
          recommendation: '先做 A，成本低。',
          leadSummary: true
        }
      })
    ]
  });
  assert.match(lead, /### 综合结论\n\n先做 A，成本低。/);
  assert.doesNotMatch(lead, /\*\*一致\*\*/, '主导人写过就别再摆规则版四段');

  const rule = buildConversationMarkdown({
    conversation: conversation(),
    messages: [
      message('user', '两个方案哪个好'),
      message('synthesis', '两说。', {
        synthesis: {
          consensus: [{ text: '都同意先备份', sources: [], evidence: [] }],
          disputed: [{ topic: '迁移顺序', positions: [{ channelId: 'chatgpt', stance: '先迁数据' }], pivot: '谁先谁后' }],
          unique: [{ text: '只有一家提到回滚脚本', sources: [], evidence: [] }],
          gaps: [{ topic: '耗时', why: '两家都没给数字' }],
          recommendation: '两说。'
        }
      })
    ]
  });
  assert.match(rule, /\*\*一致\*\*\n\n- 都同意先备份/);
  assert.match(rule, /- 迁移顺序：谁先谁后/);
  assert.match(rule, /- 只有一家提到回滚脚本/);
  assert.match(rule, /- 耗时：两家都没给数字/);
});

test('工程证据附录：路径、行号、指纹都在，能关掉', () => {
  const base = conversation({
    engineeringEvidence: [
      {
        path: '_log_details_20261105_123537.txt_',
        line: 1,
        excerpt: '2026/11/05 09:00:09.818 DEBUG otlp - [CarromStream] …',
        sha256: 'abcdef1234567890',
        mtime: Date.UTC(2026, 10, 5),
        readAt: Date.UTC(2026, 10, 8),
        why: '问题里点名了这个文件',
        totalLines: 664
      }
    ]
  });
  const messages = [message('user', '多少行'), message('channel', '664 行。', { channelId: 'ollama:deepseek-r1:14b' })];

  const withEvidence = buildConversationMarkdown({ conversation: base, messages, labels });
  assert.match(withEvidence, /## 附录 A　本机读取的工程证据/);
  assert.match(withEvidence, /\| _log_details_20261105_123537\.txt_ \| 1 \|/);
  assert.match(withEvidence, /全文 664 行/);

  const without = buildConversationMarkdown({ conversation: base, messages, labels, includeEvidence: false });
  assert.doesNotMatch(without, /附录 A/);
});

test('表格单元格里的竖线要转义，否则整张表会断成两截', () => {
  const markdown = buildConversationMarkdown({
    conversation: conversation({ title: 'a|b 的名字' }),
    messages: [message('user', '问')],
    labels
  });
  assert.match(markdown, /^# a\|b 的名字/m);
});

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

test('默认文件名去掉路径分隔符，后缀跟着格式走', () => {
  const at = Date.UTC(2026, 10, 8, 8, 30);
  assert.equal(defaultExportName('统计/日志:标签', at, 'md'), '统计 日志 标签-20261108-1630.md');
  assert.equal(defaultExportName('   ', at, 'docx'), '会话-20261108-1630.docx');
  assert.equal(ensureExtension('/tmp/报告.md', 'docx'), '/tmp/报告.md.docx');
  assert.equal(ensureExtension('/tmp/报告.DOCX', 'docx'), '/tmp/报告.DOCX');
});

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

test('markdown 解析认得出标题、列表、表格、代码块', () => {
  const blocks = parseMarkdown(
    ['# 标题', '', '> 引用', '', '- 一', '- 二', '', '1. 甲', '2. 乙', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '```', 'code', '```'].join('\n')
  );
  assert.deepEqual(
    blocks.map(block => block.kind),
    ['heading', 'quote', 'bullets', 'ordered', 'table', 'code']
  );
});

test('docx 是合法 zip，正文、表格、页眉页脚都在', async () => {
  const markdown = buildConversationMarkdown({
    conversation: conversation(),
    messages: [message('user', '多少行'), message('channel', '全文 664 行。', { channelId: 'ollama:deepseek-r1:14b' })],
    labels
  });
  const buffer = await markdownToDocx(markdown, { header: '统计这份日志里的标签', footer: 'ThinkFusion 本机导出' });
  assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'docx 必须是 zip');

  const target = join(work, 'report.docx');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(target, buffer);
  const xml = execFileSync('unzip', ['-p', target, 'word/document.xml'], { encoding: 'utf8' });
  assert.match(xml, /全文 664 行/);
  assert.match(xml, /<w:tbl>/, '元信息表要真的写成表格');
  assert.match(xml, /w:eastAsia="宋体"|w:eastAsia="黑体"/, '中文字体要写进 rFonts');
  const footer = execFileSync('unzip', ['-p', target, 'word/footer1.xml'], { encoding: 'utf8' });
  assert.match(footer, /PAGE/);
});

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

test('格式名只有明确写 Word 才算 docx，其余（含写错）一律 md', () => {
  assert.equal(resolveExportFormat(undefined), 'md', '不传格式就是默认 md');
  assert.equal(resolveExportFormat(''), 'md');
  assert.equal(resolveExportFormat('pdf'), 'md', '认不出来的格式退回 md，不生成空 Word');
  assert.equal(resolveExportFormat('md'), 'md');
  assert.equal(resolveExportFormat('doc'), 'docx', '用户嘴上说的是 doc');
  assert.equal(resolveExportFormat('DOCX'), 'docx');
  assert.equal(resolveExportFormat(' word '), 'docx');
});

test('导出 md：写到指定路径，返回大小与轮数', async () => {
  const target = join(work, 'conv.md');
  const result = await exportConversation(
    { conversationId: 'conv-1', format: 'md', path: target },
    {
      conversation: id => (id === 'conv-1' ? conversation() : null),
      messages: () => [message('user', '问'), message('channel', '答', { channelId: 'chatgpt' })],
      labels: () => labels,
      defaultDir: () => work
    }
  );
  assert.ok(result);
  assert.equal(result.path, target);
  assert.equal(result.turns, 1);
  assert.equal(result.bytes, statSync(target).size);
  assert.match(readFileSync(target, 'utf8'), /# 统计这份日志里的标签/);
});

test('不指定格式默认存 md：磁盘上不会多出一份 Word', async () => {
  const target = join(work, 'conv-default');
  const result = await exportConversation(
    { conversationId: 'conv-1', path: target },
    {
      conversation: () => conversation(),
      messages: () => [message('user', '问'), message('channel', '答', { channelId: 'chatgpt' })],
      labels: () => labels,
      defaultDir: () => work
    }
  );
  assert.equal(result.format, 'md', '返回的格式要是实际落盘的格式');
  assert.equal(result.path, `${target}.md`);
  assert.ok(existsSync(`${target}.md`));
  assert.ok(!existsSync(`${target}.docx`), '没点名要 Word 就不该有 docx');
});

test('点名要 doc：按 Word 生成，后缀是 .docx', async () => {
  const target = join(work, 'conv-doc');
  const result = await exportConversation(
    { conversationId: 'conv-1', format: 'doc', path: target },
    {
      conversation: () => conversation(),
      messages: () => [message('user', '问'), message('channel', '答', { channelId: 'chatgpt' })],
      labels: () => labels,
      defaultDir: () => work
    }
  );
  assert.equal(result.format, 'docx');
  assert.equal(result.path, `${target}.docx`);
  assert.equal(readFileSync(`${target}.docx`).subarray(0, 2).toString(), 'PK');
});

test('导出 docx：后缀自动补，文件真的落在磁盘上', async () => {
  const target = join(work, 'conv-word');
  const result = await exportConversation(
    { conversationId: 'conv-1', format: 'docx', path: target },
    {
      conversation: () => conversation(),
      messages: () => [message('user', '问'), message('channel', '答', { channelId: 'chatgpt' })],
      labels: () => labels,
      defaultDir: () => work
    }
  );
  assert.equal(result.path, `${target}.docx`);
  assert.ok(existsSync(`${target}.docx`));
  assert.ok(result.bytes > 4000);
});

test('用户在保存对话框里点取消：返回 null，不当作失败', async () => {
  const result = await exportConversation(
    { conversationId: 'conv-1', format: 'md' },
    {
      conversation: () => conversation(),
      messages: () => [],
      labels: () => labels,
      defaultDir: () => work,
      pickPath: async () => null
    }
  );
  assert.equal(result, null);
});

test('会话不在了要报错，而不是导出一个空文件', async () => {
  await assert.rejects(
    () =>
      exportConversation(
        { conversationId: 'missing', format: 'md', path: join(work, 'x.md') },
        { conversation: () => null, messages: () => [], labels: () => ({}), defaultDir: () => work }
      ),
    /会话已经不在了/
  );
});
