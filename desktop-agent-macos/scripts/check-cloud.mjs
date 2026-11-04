/**
 * Phase D：云端 Provider + API Key 密文存储的行为测试。
 *
 * 注意 fixture 的来源：本机没有云端 API Key，`scripts/fixtures/cloud/` 里的
 * payload 是 OpenAI API 文档里的响应**结构**（见 `_meta.json`），不是真机
 * 录制。有 key 时跑 `npm run test:cloud:live` 才能算真机验证。
 *
 * Run with: npm run test:cloud
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../out-test/main/providers/openai-compatible.js';
import { ApiKeyStore, memorySecretBox } from '../out-test/main/providers/secrets.js';
import { ProviderError } from '../out-test/main/providers/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures/cloud');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const fixture = name => JSON.parse(read(name));

const BASE = 'https://api.example.test/v1';
const KEY = 'sk-test-do-not-log-123';
const completion = fixture('chat-completion.json');
const sse = read('chat-stream.sse');
const models = fixture('models.json');
const rateLimit = read('error-429.json').trim();

const PRICING = { 'gpt-4o-mini': { inputPerMillion: 1, outputPerMillion: 2, currency: 'CNY' } };
const sleep = () => Promise.resolve();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

function keyStore(hasKey = true) {
  let current = hasKey ? KEY : null;
  return {
    has: () => current !== null,
    get: () => current,
    set: value => { current = value; },
    clear: () => { current = null; }
  };
}

function makeFetch(handlers = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = url.replace(BASE, '');
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers, signal: init.signal });
    const handler = handlers[path];
    if (handler) return typeof handler === 'function' ? handler(calls.length, init) : handler;
    if (path === '/models') return json(models);
    if (path === '/chat/completions') {
      return init.body && JSON.parse(init.body).stream
        ? textResponse(sse)
        : json(completion);
    }
    throw new TypeError(`fetch failed: 未预期路径 ${path}`);
  };
  impl.calls = calls;
  return impl;
}

function provider(overrides = {}) {
  const keys = overrides.keys ?? keyStore();
  return new OpenAICompatibleProvider({
    id: 'cloud-test',
    baseUrl: BASE,
    keyStore: keys,
    pricing: PRICING,
    fetchImpl: overrides.fetchImpl ?? makeFetch(),
    maxRetries: 1,
    retryBaseMs: 1,
    sleep,
    ...overrides
  });
}

// ---------------------------------------------------------------------------

test('fixture 来源如实标注：没有真机录制就不许写成有', () => {
  const meta = fixture('_meta.json');
  assert.equal(meta.recordedFromLiveService, false);
  assert.match(meta.note, /无法真机录制/);
  assert.equal(completion.choices[0].message.content, '51');
  assert.deepEqual(completion.usage, { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 });
});

test('ApiKeyStore：落盘是密文，清单不含明文，重启后能取回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-keys-'));
  const file = path.join(dir, 'secrets.json');
  const store = new ApiKeyStore({ file, box: memorySecretBox(), now: () => 1000 });

  assert.equal(store.has('cloud-test'), false);
  store.set('cloud-test', KEY);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(KEY), false, '明文绝不落盘');
  assert.equal(store.get('cloud-test'), KEY);
  assert.deepEqual(store.list(), [{ id: 'cloud-test', updatedAt: 1000 }]);
  assert.equal(JSON.stringify(store.list()).includes(KEY), false);

  const reopened = new ApiKeyStore({ file, box: memorySecretBox() });
  assert.equal(reopened.get('cloud-test'), KEY);
  reopened.remove('cloud-test');
  assert.equal(reopened.has('cloud-test'), false);
  assert.equal(new ApiKeyStore({ file, box: memorySecretBox() }).has('cloud-test'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ApiKeyStore：加密不可用时拒绝写入，绝不降级成明文', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-keys-'));
  const file = path.join(dir, 'secrets.json');
  const broken = { available: () => false, encrypt: () => { throw new Error('should not be called'); }, decrypt: () => '' };
  const store = new ApiKeyStore({ file, box: broken });
  assert.throws(() => store.set('x', KEY), /拒绝以明文保存/);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('health：没有 Key 时明确说没配，不假装可用', async () => {
  const p = provider({ keys: keyStore(false) });
  const status = await p.health();
  assert.equal(status.available, false);
  assert.match(status.detail, /还没有配置 API Key/);
});

test('health：探活只打 /models，不烧 chat completions', async () => {
  const fetchImpl = makeFetch();
  const status = await provider({ fetchImpl }).health();
  assert.equal(status.available, true);
  assert.deepEqual(fetchImpl.calls.map(c => c.path), ['/models']);
  assert.equal(fetchImpl.calls[0].headers.authorization, `Bearer ${KEY}`);
});

test('health：401 与 429 分别说明，不混成一句「云端不可用」', async () => {
  const denied = await provider({ fetchImpl: makeFetch({ '/models': new Response('{}', { status: 401 }) }) }).health();
  assert.equal(denied.available, false);
  assert.match(denied.detail, /API Key 被拒绝/);

  const limited = await provider({ fetchImpl: makeFetch({ '/models': new Response('{}', { status: 429 }) }) }).health();
  assert.equal(limited.available, false);
  assert.match(limited.detail, /限流/);
});

test('listModels：云端不提供上下文长度，写 null 而不是编一个', async () => {
  const list = await provider().listModels();
  assert.equal(list[0].id, 'gpt-4o-mini');
  assert.equal(list[0].contextTokens, null);
});

test('generate：真实结构的 usage 与费用都能读出来', async () => {
  const p = provider();
  const r = await p.generate({ question: '17 乘 3？' });
  assert.equal(r.text, '51');
  assert.deepEqual(r.usage.inputTokens, 12);
  assert.deepEqual(r.usage.outputTokens, 2);
  // (12*1 + 2*2)/1e6 = 0.000016
  assert.ok(Math.abs(r.usage.cost.amount - 0.000016) < 1e-12);
  assert.equal(r.usage.cost.currency, 'CNY');
  assert.equal(p.usageSummary().calls, 1);
});

test('没有单价配置时费用是 null，不是 0', async () => {
  const p = provider({ pricing: {} });
  const r = await p.generate({ question: 'hi' });
  assert.equal(r.usage.cost, null);
});

test('stream：SSE 按 data 行解析，[DONE] 收尾，并显式打开 include_usage', async () => {
  const fetchImpl = makeFetch();
  const p = provider({ fetchImpl });
  let text = '';
  for await (const piece of p.stream({ question: 'hi' })) text += piece;
  assert.equal(text, '51');
  const body = fetchImpl.calls.find(c => c.path === '/chat/completions').body;
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const summary = p.usageSummary();
  assert.equal(summary.inputTokens, 12);
  assert.equal(summary.outputTokens, 2);
  assert.equal(summary.unknownUsageCalls, 0);
});

test('stream：SSE 被 TCP 切成任意块也能拼对', async () => {
  const bytes = new TextEncoder().encode(sse);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 9) chunks.push(bytes.slice(i, i + 9));
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  const p = provider({ fetchImpl: makeFetch({ '/chat/completions': () => new Response(body, { status: 200 }) }) });
  let text = '';
  for await (const piece of p.stream({ question: 'hi' })) text += piece;
  assert.equal(text, '51');
});

test('429 重试后成功；重试耗尽报 busy，而不是无限重试', async () => {
  let hits = 0;
  const fetchImpl = makeFetch({
    '/chat/completions': () => {
      hits += 1;
      return hits <= 2 ? new Response(rateLimit, { status: 429 }) : json(completion);
    }
  });
  const p = provider({ fetchImpl, maxRetries: 2 });
  const r = await p.generate({ question: 'hi' });
  assert.equal(r.text, '51');
  assert.equal(hits, 3);

  const always = makeFetch({ '/chat/completions': () => new Response(rateLimit, { status: 429 }) });
  await assert.rejects(
    provider({ fetchImpl: always, maxRetries: 1 }).generate({ question: 'hi' }),
    error => error instanceof ProviderError && error.code === 'busy' && /限流/.test(error.message)
  );
  assert.equal(always.calls.filter(c => c.path === '/chat/completions').length, 2, '首次 + 1 次重试，没有第三次');
});

test('流式只在吐字之前重试：已经开始 yield 后不会再发一次请求', async () => {
  const fetchImpl = makeFetch();
  const p = provider({ fetchImpl });
  let text = '';
  for await (const piece of p.stream({ question: 'hi' })) text += piece;
  assert.equal(text, '51');
  assert.equal(fetchImpl.calls.filter(c => c.path === '/chat/completions').length, 1);
});

test('401 不重试，直接报 auth', async () => {
  const fetchImpl = makeFetch({ '/chat/completions': () => new Response('{"error":{"message":"invalid"}}', { status: 401 }) });
  await assert.rejects(
    provider({ fetchImpl }).generate({ question: 'hi' }),
    error => error instanceof ProviderError && error.code === 'auth'
  );
  assert.equal(fetchImpl.calls.filter(c => c.path === '/chat/completions').length, 1);
});

test('没有 Key 时发请求报 auth，且 Key 不进请求体', async () => {
  const fetchImpl = makeFetch();
  const p = provider({ keys: keyStore(false), fetchImpl });
  await assert.rejects(p.generate({ question: 'hi' }), error => error.code === 'auth');
  assert.equal(fetchImpl.calls.length, 0, '不该发出没有认证的请求');

  const good = makeFetch();
  await provider({ fetchImpl: good }).generate({ question: 'hi' });
  const body = JSON.stringify(good.calls[0].body);
  assert.equal(body.includes(KEY), false);
});

test('取消：AbortSignal 触发后报 cancelled，连接也被断掉', async () => {
  const controller = new AbortController();
  const hanging = makeFetch({
    '/chat/completions': (_n, init) => new Response(
      new ReadableStream({
        start(stream) {
          // 真实 fetch 在 signal abort 时会让读操作立刻 reject。
          init.signal?.addEventListener('abort', () => {
            try { stream.error(new Error('aborted')); } catch { /* 已关闭 */ }
          }, { once: true });
          stream.enqueue(new TextEncoder().encode(sse.split('\n\n')[0] + '\n\n'));
        }
      }),
      { status: 200 }
    )
  });
  const p = provider({ fetchImpl: hanging });
  const pending = (async () => {
    for await (const _ of p.stream({ question: 'hi' }, controller.signal)) { /* 不产生内容 */ }
  })();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, error => error instanceof ProviderError && error.code === 'cancelled');
  assert.equal(hanging.calls[0].signal.aborted, true);
});

test('usageSummary：没有 usage 的调用要单独计数，不能被当成 0', async () => {
  const noUsage = makeFetch({ '/chat/completions': () => json({ choices: [{ message: { content: 'x' } }] }) });
  const p = provider({ fetchImpl: noUsage });
  await p.generate({ question: 'hi' });
  const summary = p.usageSummary();
  assert.equal(summary.unknownUsageCalls, 1);
  assert.equal(summary.inputTokens, 0);
  assert.equal(summary.calls, 1);
});
