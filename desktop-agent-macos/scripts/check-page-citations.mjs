/**
 * Phase 3 · 页面引用抓取（任务书 AC-09）。
 *
 * 读引用是这条链路的起点：读错一条，后面的「来源独立不独立」「证据够不够」
 * 全是错的。所以每家站点都用固定 HTML 跑一遍，钉住四件事：
 *
 * 1. 只读**最后一条**回答里的链接，侧栏和上一条回答的链接不许混进来；
 * 2. 隐藏节点、`javascript:` 这类不是来源的地址要挡掉；
 * 3. 相对地址在页面里就解析成绝对地址；
 * 4. 去重与展开跳转包装在 `digestCitations` 里做，同一份文档只留一条。
 *
 * fixture 用的是各家真实的结构（`article .markdown`、`.chat-content-item-assistant`、
 * `model-response`），跑的是 provider 配置里那份 `assistant` 选择器——所以
 * 站点改了结构时，这里会先红。
 *
 * Run with: npm run test:page-citations
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { profileFor } from '../out-test/main/adapters/providers/index.js';
import { CITATIONS_SCRIPT } from '../out-test/main/adapters/browser/page-driver.js';
import { canonicalUrl, digestCitations, fingerprintOf, originKeyOf } from '../out-test/shared/evidence.js';
import { createDocument } from './lib/mini-dom.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/pages/${name}.html`, import.meta.url), 'utf8');

function runFixture(site, name, pageUrl) {
  const { document, location, getComputedStyle } = createDocument(fixture(name), pageUrl);
  // 页面脚本只碰这几个全局：document / location / getComputedStyle / URL。
  const context = vm.createContext({ document, location, getComputedStyle, URL, console });
  return vm.runInContext(CITATIONS_SCRIPT(profileFor(site)), context);
}

const urlsOf = result => result.links.map(link => link.url);

// ---------------------------------------------------------------------------
// 每家站点各跑一遍
// ---------------------------------------------------------------------------

test('chatgpt fixture：只读最后一条回答，跳过侧栏、隐藏项和 javascript:', () => {
  const result = runFixture('chatgpt', 'chatgpt', 'https://chatgpt.com/');
  const urls = urlsOf(result);

  assert.ok(!urls.some(url => url.includes('old.example.com')), '上一条回答的链接不算这一条的引用');
  assert.ok(!urls.some(url => url.includes('sidebar-thread')), '侧栏链接不是回答的来源');
  assert.ok(!urls.some(url => url.includes('hidden.example.com')), '隐藏节点不读');
  assert.ok(!urls.some(url => url.startsWith('javascript:')), 'javascript: 不是来源');
  assert.ok(urls.includes('https://chatgpt.com/c/abc123'), '相对地址要解析成绝对地址');
  assert.ok(urls.some(url => url.startsWith('https://docs.example.com/config')), '正文里的来源要在');

  assert.equal(result.title, 'ChatGPT');
  assert.equal(result.url, 'https://chatgpt.com/');
  assert.ok(result.links.every(link => /^https?:\/\//.test(link.url)), '交出去的地址必须都是 http(s)');
});

test('kimi fixture：同一份文档的两个入口在去重后只剩一条', () => {
  const result = runFixture('kimi', 'kimi', 'https://kimi.moonshot.cn/');
  const urls = urlsOf(result);
  assert.ok(!urls.some(url => url.includes('old.example.com')));
  assert.ok(!urls.some(url => url.includes('sidebar')));
  assert.ok(!urls.some(url => url.includes('hidden.example.com')));

  const digest = digestCitations(
    result.links.map(link => ({ url: link.url, anchorText: link.text, title: link.title } )),
    { pageUrl: result.url, sourceId: 'kimi', now: 1 }
  );
  const docs = digest.citations.filter(item => item.url.includes('docs.example.com/release-notes')
    || (item.finalUrl ?? '').includes('docs.example.com/release-notes'));
  assert.equal(docs.length, 1, 'release notes 有四个入口，只能算一条记录');
  assert.ok(digest.citations.some(item => item.url.includes('arxiv.org')), '论文链接要留下');
});

test('gemini fixture：跳转包装被展开，站内地址解析成绝对地址', () => {
  const result = runFixture('gemini', 'gemini', 'https://gemini.google.com/app');
  const urls = urlsOf(result);
  assert.ok(!urls.some(url => url.includes('old.example.com')));
  assert.ok(!urls.some(url => url.includes('hidden.example.com')));
  assert.ok(urls.includes('https://gemini.google.com/app/abc123'), '相对地址按页面地址解析');

  const digest = digestCitations(result.links.map(link => ({ url: link.url })), {
    pageUrl: result.url,
    sourceId: 'gemini',
    now: 1
  });
  const wrapped = digest.citations.find(item => item.url.includes('google.com/url'));
  assert.ok(wrapped, '原始地址要保留');
  assert.equal(wrapped.finalUrl, 'https://ai.google.dev/release-notes', '展开跳转包装');
});

test('页面没有回答气泡时返回空列表，不抛错', () => {
  const { document, location, getComputedStyle } = createDocument(
    '<html><head><title>空</title></head><body><a href="https://example.com">只有侧栏</a></body></html>',
    'https://chatgpt.com/'
  );
  const context = vm.createContext({ document, location, getComputedStyle, URL, console });
  const result = vm.runInContext(CITATIONS_SCRIPT(profileFor('chatgpt')), context);
  // 跨 realm 的数组原型不同，用长度比较，不用 deepEqual。
  assert.equal(result.links.length, 0);
  assert.equal(result.title, '空');
});

test('脚本能在没有 getComputedStyle 的裁剪环境里跑', () => {
  const { document, location } = createDocument(fixture('chatgpt'), 'https://chatgpt.com/');
  const context = vm.createContext({ document, location, URL, console });
  const result = vm.runInContext(CITATIONS_SCRIPT(profileFor('chatgpt')), context);
  assert.ok(result.links.length > 0, '读不到计算样式时按「可见」处理，不整段放弃');
});

// ---------------------------------------------------------------------------
// 地址归一与指纹
// ---------------------------------------------------------------------------

test('同一份文档的两个地址归一后相同，跟踪参数不算区别', () => {
  const left = 'https://docs.example.com/config?utm_source=chatgpt&utm_medium=chat';
  const right = 'https://docs.example.com/config/#defaults';
  assert.equal(canonicalUrl(left), 'https://docs.example.com/config');
  assert.equal(canonicalUrl(right), 'https://docs.example.com/config');
  assert.equal(originKeyOf({ url: left }), originKeyOf({ url: right }));

  // 真正的不同参数不是同一个地址
  assert.notEqual(canonicalUrl('https://docs.example.com/config?v=1'), canonicalUrl('https://docs.example.com/config?v=2'));
});

test('Bing 的 base64 跳转能被展开（无网络）', () => {
  const wrapped =
    'https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9kb2NzLmV4YW1wbGUuY29tL3JlbGVhc2Utbm90ZXM&ntb=1';
  const digest = digestCitations([{ url: wrapped }], { now: 1 });
  assert.equal(digest.citations[0].finalUrl, 'https://docs.example.com/release-notes');
  assert.equal(digest.dropped.duplicate, 0);
});

test('指纹忽略空白、标点与大小写，但不同内容不同指纹', () => {
  const a = fingerprintOf('默认连接数是 1024，官方文档写明了。');
  const b = fingerprintOf('默认连接数是1024 官方文档写明了');
  const c = fingerprintOf('默认连接数是 10000，官方文档写明了。');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(fingerprintOf('   '), '');
});

test('不是来源的地址在归一阶段就被挡掉', () => {
  const digest = digestCitations(
    [
      { url: 'javascript:void(0)' },
      { url: 'mailto:someone@example.com' },
      { url: '#section' },
      { url: 'https://docs.example.com/a' }
    ],
    { pageUrl: 'https://chatgpt.com/', now: 1 }
  );
  assert.equal(digest.citations.length, 1);
  assert.equal(digest.dropped.notHttp, 3);
});

test('链接条数有上限，多出来的计入 dropped，不静默丢弃', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ url: `https://docs.example.com/p${String(index)}` }));
  const digest = digestCitations(many, { cap: 12, now: 1 });
  assert.equal(digest.citations.length, 12);
  assert.equal(digest.dropped.beyondCap, 8);
});
