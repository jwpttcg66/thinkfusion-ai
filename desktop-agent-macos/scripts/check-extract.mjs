/**
 * V2.1 Knowledge Workspace / Extract。
 *
 * 这一组用例对应《产品结构定义》第 3 节的 extract：它不能只是给网页通道贴个
 * 标签，而要真的把正文抓回来。同时把 SSRF 边界钉住——「网页提取」最容易被
 * 拿来读本机服务，那等于给了一个内网读取入口。
 *
 * 全部用注入的 fetcher，不访问网络。
 *
 * Run with: npm run test:extract
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractMaterial,
  fetchPageText,
  htmlToText,
  isFetchableUrl
} from '../out-test/main/knowledge/page-extract.js';
import { buildLeadSummaryQuestion, inlineLeadInstructions, leadSummarySystem } from '../out-test/main/synthesis/lead-stage.js';

const OK = { ok: true, status: 200, headers: { get: () => null } };

function response(html, status = 200, contentLength = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-length' ? contentLength : null) },
    text: async () => html
  };
}

test('只抓公网 http/https，本机与私网地址一律拒绝', () => {
  for (const url of ['https://example.com/a', 'http://example.com', 'https://news.ycombinator.com/item?id=1']) {
    assert.equal(isFetchableUrl(url).ok, true, url);
  }
  const blocked = [
    'http://localhost:3000/admin',
    'http://127.0.0.1/',
    'http://0.0.0.0:8080/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://router.local/'
  ];
  for (const url of blocked) {
    assert.equal(isFetchableUrl(url).ok, false, `${url} 不该被允许`);
  }
  assert.match(isFetchableUrl('http://10.0.0.5/').reason, /私网/);
});

test('正文提取去掉脚本和导航，保留可读内容', () => {
  const html = `<!doctype html><html><head><title>关于 429</title>
    <style>body{color:red}</style></head><body>
    <nav>首页 / 文档 / 关于</nav>
    <main><h1>429 是什么</h1><p>请求过多。</p><script>alert('x')</script>
    <p>客户端应当退避 &amp; 重试。</p></main>
    <footer>版权所有</footer></body></html>`;
  const parsed = htmlToText(html);
  assert.equal(parsed.title, '关于 429');
  assert.match(parsed.text, /429 是什么/);
  assert.match(parsed.text, /客户端应当退避 & 重试/);
  assert.doesNotMatch(parsed.text, /alert/);
  assert.doesNotMatch(parsed.text, /版权所有/);
  assert.match(parsed.notes.join(''), /main\/article/);
});

test('抓取成功时给出状态码、字数与指纹', async () => {
  const html = '<html><head><title>t</title></head><body><main><p>正文内容</p></main></body></html>';
  const evidence = await fetchPageText('https://example.com/a', async () => response(html));
  assert.equal(evidence.status, 200);
  assert.equal(evidence.title, 't');
  assert.match(evidence.text, /正文内容/);
  assert.equal(evidence.chars, evidence.text.length);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.ok(evidence.fetchedAt > 0);
});

test('抓不到时抛出原因，而不是返回空正文让模型去编', async () => {
  await assert.rejects(
    () => fetchPageText('https://example.com/missing', async () => response('nope', 404)),
    /HTTP 404/
  );
  await assert.rejects(
    () => fetchPageText('https://example.com/empty', async () => response('<html><body><script>x</script></body></html>')),
    /没有可读正文/
  );
  await assert.rejects(
    () => fetchPageText('https://example.com/big', async () => response('<html/>', 200, String(5 * 1024 * 1024))),
    /超过/
  );
  await assert.rejects(
    () => fetchPageText('https://example.com/boom', async () => { throw new Error('ECONNRESET'); }),
    /抓取失败.*ECONNRESET/
  );
});

test('正文超过上限时截断，但如实说明截断了', async () => {
  const long = `<html><body><main><p>${'字'.repeat(30_000)}</p></main></body></html>`;
  const evidence = await fetchPageText('https://example.com/long', async () => response(long));
  assert.equal(evidence.chars, 20_000);
  assert.match(evidence.notes.join(''), /只保留前 20000 字/);
});

test('汇总材料写明地址、时间、状态与指纹', async () => {
  const evidence = await fetchPageText(
    'https://example.com/a',
    async () => response('<html><head><title>页面标题</title></head><body><main><p>正文</p></main></body></html>')
  );
  const material = extractMaterial(evidence);
  assert.match(material, /【网页正文】页面标题/);
  assert.match(material, /地址：https:\/\/example\.com\/a/);
  assert.match(material, /状态：200/);
  assert.match(material, /sha256：/);
  assert.match(material, /正文：/);
});

test('compare 要求逐项对比，extract 只依据正文，普通问答不加这些要求', () => {
  const answers = [{ channelId: 'a', label: 'A', text: '回答一' }];
  const compare = buildLeadSummaryQuestion('Envoy 和 Redis Proxy 怎么选', answers, { taskKind: 'compare' });
  assert.match(compare, /比较任务/);
  assert.match(compare, /逐项对比/);

  const extract = buildLeadSummaryQuestion('整理这个网页 https://example.com/a', answers, {
    taskKind: 'extract',
    material: '【网页正文】示例\n正文：hello'
  });
  assert.match(extract, /【补充材料】/);
  assert.match(extract, /只依据【补充材料】里的网页正文/);
  assert.match(extract, /正文：hello/);

  const plain = buildLeadSummaryQuestion('什么是 429', answers, { taskKind: 'answer' });
  assert.doesNotMatch(plain, /比较任务/);
  assert.doesNotMatch(plain, /只依据【补充材料】/);
  assert.doesNotMatch(plain, /【补充材料】/);

  // 网页主导走 inline 版，同样要带上这些要求与材料。
  const inline = inlineLeadInstructions('整理这个网页', answers, { taskKind: 'extract', material: '正文：hi' });
  assert.match(inline, /【请你做的事】/);
  assert.match(inline, /【补充材料】/);

  assert.ok(leadSummarySystem('compare').some(line => line.includes('比较任务')));
  assert.ok(!leadSummarySystem().some(line => line.includes('比较任务')));
});
