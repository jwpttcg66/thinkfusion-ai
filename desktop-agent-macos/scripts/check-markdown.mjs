/**
 * 来源回答的排版解析。
 *
 * 每条用例都对应一次真机上的难看：ChatGPT 的回答落盘时换行数为 0（现在抓取
 * 端给的是 Markdown）、Kimi 的列表项里套着段落（短横线独占一行）、Gemini 的
 * 表格是 tab 分隔的。这些形状一旦解析错，界面上不是「少一个样式」，而是内容
 * 变成一堆点或者一行字，所以钉在这里。
 *
 * Run with: npm run test:markdown
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlocks } from '../out-test/shared/markdown.js';

const kinds = blocks => blocks.map(block => block.kind);

test('标题、列表、表格各自成块', () => {
  const blocks = parseBlocks([
    '【最终结论】',
    '维持原结论：Java 是核心业务的首选。',
    '',
    '### 最终技术分工',
    '',
    '| 中台领域 | 首选语言 |',
    '| --- | --- |',
    '| 账号中心 | Java |',
    '| 网关 | Go |',
    '',
    '- 资产中心是独立业务域',
    '- 网关是独立基础设施'
  ].join('\n'));

  assert.deepEqual(kinds(blocks), ['paragraph', 'heading', 'table', 'list']);
  assert.equal(blocks[1].level, 3);
  assert.equal(blocks[1].text, '最终技术分工');
  assert.deepEqual(blocks[2].head, ['中台领域', '首选语言']);
  assert.deepEqual(blocks[2].rows, [['账号中心', 'Java'], ['网关', 'Go']]);
  assert.deepEqual(blocks[3].items, ['资产中心是独立业务域', '网关是独立基础设施']);
});

test('列表项之间隔着空行仍然是一个列表', () => {
  const blocks = parseBlocks('- 第一\n\n- 第二\n\n- 第三');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].items, ['第一', '第二', '第三']);
});

test('tab 分隔的表格也能认出来', () => {
  // Gemini 的表格在页面文本里就是「维度\tGo\tJava」这种形状。
  const blocks = parseBlocks('维度\tGo\tJava\n并发模型\tgoroutine\t线程\n部署\t静态二进制\tJVM');
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(blocks[0].head, ['维度', 'Go', 'Java']);
  assert.equal(blocks[0].rows.length, 2);
  assert.deepEqual(blocks[0].rows[0], ['并发模型', 'goroutine', '线程']);
});

test('一行两列的普通文本不会被当成表格', () => {
  // 单独一个 tab 只是排版，不是表格：把它当表就会凭空造出表头。
  const blocks = parseBlocks('结论\tGo 更适合');
  assert.deepEqual(kinds(blocks), ['paragraph']);
});

test('代码块里的井号和竖线不算标记', () => {
  const blocks = parseBlocks('```bash\n# 注释 | 管道\nls -la\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].text, '# 注释 | 管道\nls -la');
});

test('短横线独占一行的历史数据会被接回列表项', () => {
  // 抓取端修复之前落盘的回答长这样：短横线一行、内容在下一行。
  const blocks = parseBlocks('-\n**连接密集、逻辑轻**。玩家会话短。\n\n-\n**成本敏感**。靠买量驱动。');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].items, ['**连接密集、逻辑轻**。玩家会话短。', '**成本敏感**。靠买量驱动。']);
});

test('认不出的文本原样留在段落里，单换行也留着', () => {
  const blocks = parseBlocks('第一行\n第二行\n\n第三段');
  assert.deepEqual(kinds(blocks), ['paragraph', 'paragraph']);
  assert.equal(blocks[0].text, '第一行\n第二行');
  assert.equal(blocks[1].text, '第三段');
});

test('空文本不是崩溃也不是空块', () => {
  assert.deepEqual(parseBlocks(''), []);
  assert.deepEqual(parseBlocks('   \n\n  '), []);
});

test('有序列表认得中文顿号和右括号', () => {
  const blocks = parseBlocks('1、先建账号中心\n2、再拆支付');
  assert.equal(blocks[0].kind, 'list');
  assert.equal(blocks[0].ordered, true);
  assert.deepEqual(blocks[0].items, ['先建账号中心', '再拆支付']);
});

test('没有分隔行、行间有空行的表格也认（我们自己抓出来的形状）', () => {
  // 页面上的表格被读成「每行都是竖线行」，且每行之间空一行——这是 structuredText
  // 的真实产物，标准 Markdown 的分隔行不存在。认不出它，表格就会显示成一串带竖线
  // 的句子（真机上就是这么发现的第一版问题）。
  const blocks = parseBlocks([
    '| 比较维度 | HTTP | HTTPS |',
    '',
    '| 安全性 | 明文传输 | 加密传输 |',
    '',
    '| 默认端口 | 80 | 443 |',
    '',
    '注意事项：证书要续期。'
  ].join('\n'));

  assert.deepEqual(kinds(blocks), ['table', 'paragraph']);
  assert.deepEqual(blocks[0].head, ['比较维度', 'HTTP', 'HTTPS']);
  assert.deepEqual(blocks[0].rows, [['安全性', '明文传输', '加密传输'], ['默认端口', '80', '443']]);
});

test('孤零零的竖线不会把表格截断', () => {
  // Kimi 的表格中间会多读出一个只有竖线的行，它既不是表行也不是正文。
  const blocks = parseBlocks('| 对比点 | HTTP |\n\n|\n\n| 传输安全 | 明文 |');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(blocks[0].rows, [['传输安全', '明文']]);
});

test('表头没有收尾竖线也能认（Kimi 的形状）', () => {
  // 真机读出来是「| 对比点  | HTTP  | HTTPS」——最后一个单元格后面没有竖线。
  const blocks = parseBlocks('| 对比点  | HTTP  | HTTPS\n\n| 传输安全 | 明文传输 | 加密传输 |');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(blocks[0].head, ['对比点', 'HTTP', 'HTTPS']);
  assert.deepEqual(blocks[0].rows, [['传输安全', '明文传输', '加密传输']]);
});
