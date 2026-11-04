/**
 * Ollama Provider 的行为测试：回放真实录制的响应。
 *
 * `scripts/fixtures/ollama/` 里的 payload 全部是从运行中的 Ollama 0.33.2
 * （qwen2.5:7b / nomic-embed-text:latest）真实端点录下来的，见 `_meta.json`。
 * 不是手写样例——手写样例会照着实现写，实现里的错也跟着被写进期望值里。
 *
 * 真实数据已经逼出过一处修正：/api/tags 会列 nomic-embed-text，但它的
 * /api/show capabilities 只有 ["embedding"]，不能拿来对话。测试里钉住了。
 *
 * 想连真服务跑端到端：npm run test:ollama:live（不进 npm test，CI 没有 Ollama）。
 *
 * Run with: npm run test:ollama
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { OllamaProvider } from '../out-test/main/providers/ollama.js';
import { ProviderError } from '../out-test/main/providers/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures/ollama');
const read = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const fixture = name => JSON.parse(read(name));

const BASE = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:7b';
const tags = fixture('tags.json');
const ps = fixture('ps.json');
const showQwen = fixture('show-qwen.json');
const showNomic = fixture('show-nomic.json');
const chatOnce = fixture('chat-once.json');
const missing = fixture('chat-missing-model.json');
const streamText = read('chat-stream.ndjson');
const expectedStreamText = streamText
  .trim()
  .split('\n')
  .map(line => JSON.parse(line).message?.content ?? '')
  .join('');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

/** 每个字符串模拟一个网络 chunk，hang=true 时流不结束。 */
function ndjsonResponse(chunks, hang = false, signal) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        // 真实连接被 abort 时读操作会立刻 reject。不模拟这一步，取消测试里
        // 读操作会一直挂着，最后被空闲超时抢先报成 timeout。
        if (signal) {
          const onAbort = () => {
            try { controller.error(new Error('aborted')); } catch { /* 已关闭 */ }
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!hang) controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
  );
}

function byLine(text) {
  return text.split('\n').filter(Boolean).map(line => line + '\n');
}

function byBytes(text, size) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(decoder.decode(bytes.slice(i, i + size), { stream: true }));
  }
  return chunks;
}

/**
 * 回放录制好的端点。`overrides[path]` 可以是 Response、函数，或 null（表示
 * 直接抛连接错误）。`chunks` 控制流怎么被 TCP 切。
 */
function makeFetch({ overrides = {}, chunks, hang = false } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = url.replace(BASE, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, signal: init.signal });

    if (path in overrides) {
      const value = overrides[path];
      if (value === null) {
        const error = new TypeError('fetch failed');
        error.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw error;
      }
      return typeof value === 'function' ? value(body, init) : value;
    }

    switch (path) {
      case '/api/tags':
        return json(tags);
      case '/api/ps':
        return json(ps);
      case '/api/show':
        return json((body?.model ?? '').startsWith('qwen') ? showQwen : showNomic);
      case '/api/chat':
        if (body?.model?.includes('no-such')) {
          return new Response(missing.body, { status: missing.status });
        }
        if (body?.stream) {
          return ndjsonResponse(chunks ?? byLine(streamText), hang, init.signal);
        }
        return json(chatOnce);
      case '/api/generate':
        return json({ done: true });
      default:
        throw new TypeError(`fetch failed: 未预期的路径 ${path}`);
    }
  };
  impl.calls = calls;
  impl.paths = () => calls.map(call => call.path);
  return impl;
}

function provider(fetchImpl, options = {}) {
  return new OllamaProvider({
    defaultModel: MODEL,
    fetchImpl,
    contextTokens: 8192,
    firstTokenTimeoutMs: 150,
    idleTimeoutMs: 150,
    connectTimeoutMs: 150,
    generateTimeoutMs: 500,
    ...options
  });
}

const chatBodies = fetchImpl => fetchImpl.calls.filter(c => c.path === '/api/chat').map(c => c.body);

// ---------------------------------------------------------------------------

test('fixture 确实来自真实服务，不是手写样例', () => {
  const meta = fixture('_meta.json');
  assert.equal(meta.baseUrl, BASE);
  assert.ok(meta.recordedAt);
  assert.ok(meta.models.some(m => m.name === MODEL));
  assert.ok(meta.models.some(m => m.name === 'nomic-embed-text:latest'));
  assert.equal(showQwen.model_info['qwen2.context_length'], 32768);
  assert.equal(showNomic.model_info['nomic-bert.context_length'], 2048);
  assert.deepEqual(showNomic.capabilities, ['embedding']);
  assert.equal(chatOnce.message.content, '17 乘 3 等于 51。');
  assert.ok(expectedStreamText.length > 0);
});

test('health：服务在跑时给出模型数，不可达时给出能照做的提示', async () => {
  assert.deepEqual(
    { available: (await provider(makeFetch()).health()).available, detail: (await provider(makeFetch()).health()).detail },
    { available: true, detail: `已安装 ${tags.models.length} 个模型` }
  );

  const dead = await provider(makeFetch({ overrides: { '/api/tags': null } })).health();
  assert.equal(dead.available, false);
  assert.match(dead.detail, /ollama serve/);
});

test('listModels：真实 tags 有两个模型，但只返回能对话的那个', async () => {
  const fetchImpl = makeFetch();
  const models = await provider(fetchImpl).listModels();
  assert.equal(tags.models.length, 2, '录制数据里确实有 embedding 模型');
  assert.equal(models.length, 1);
  assert.equal(models[0].id, MODEL);
  assert.equal(models[0].contextTokens, 32768);
  assert.ok(fetchImpl.paths().includes('/api/show'), '必须真的问过每个模型的能力');
});

test('listModels：30 秒内复用缓存，不重复打 /api/show', async () => {
  const fetchImpl = makeFetch();
  const p = provider(fetchImpl);
  await p.listModels();
  const first = fetchImpl.calls.length;
  await p.listModels();
  assert.equal(fetchImpl.calls.length, first);
});

test('context_length 按后缀匹配，不写死架构名', async () => {
  const fetchImpl = makeFetch();
  const p = provider(fetchImpl);
  await p.generate({ question: 'hi' });
  // 配置 8192，qwen 真实 32768 → 取小的那个。
  assert.equal(chatBodies(fetchImpl)[0].options.num_ctx, 8192);

  const other = makeFetch();
  await provider(other).generate({ question: 'hi', modelId: 'nomic-embed-text:latest' });
  // nomic 的 key 是 nomic-bert.context_length，值 2048 → 不能拿 8192 去喂它。
  assert.equal(chatBodies(other)[0].options.num_ctx, 2048);
});

test('generate：真实响应里的文本、token 用量、耗时都能读出来', async () => {
  const r = await provider(makeFetch()).generate({ question: '17 乘 3？' });
  assert.equal(r.text, chatOnce.message.content);
  assert.equal(r.modelId, MODEL);
  assert.equal(r.usage.inputTokens, chatOnce.prompt_eval_count);
  assert.equal(r.usage.outputTokens, chatOnce.eval_count);
  assert.equal(typeof r.latencyMs, 'number');
});

test('stream：按行切、整段一个 chunk、每 7 字节切，解析结果必须一样', async () => {
  const variants = [
    byLine(streamText),
    [streamText],
    byBytes(streamText, 7)
  ];
  for (const chunks of variants) {
    let text = '';
    let pieces = 0;
    for await (const piece of provider(makeFetch({ chunks })).stream({ question: 'hi' })) {
      text += piece;
      pieces += 1;
    }
    assert.equal(text, expectedStreamText);
    assert.ok(pieces > 1);
  }
});

test('stream：首字迟迟不来要报 timeout，文案说清是冷加载', async () => {
  const p = provider(makeFetch({ chunks: [], hang: true }), { firstTokenTimeoutMs: 60 });
  await assert.rejects(
    async () => { for await (const _ of p.stream({ question: 'hi' })) { /* 永不进入 */ } },
    error => error instanceof ProviderError && error.code === 'timeout' && /第一个字/.test(error.message)
  );
});

test('stream：出了一段之后卡住，报的是「中断」而不是「第一个字」', async () => {
  const p = provider(
    makeFetch({ chunks: [byLine(streamText)[0]], hang: true }),
    { idleTimeoutMs: 60 }
  );
  await assert.rejects(
    async () => { for await (const _ of p.stream({ question: 'hi' })) { /* 只来一段 */ } },
    error => error instanceof ProviderError && error.code === 'timeout' && /中断/.test(error.message)
  );
});

test('取消：AbortSignal 触发后是 cancelled，且连接真的被断掉', async () => {
  const fetchImpl = makeFetch({ chunks: [byLine(streamText)[0]], hang: true });
  const controller = new AbortController();
  const p = provider(fetchImpl);
  await assert.rejects(
    async () => {
      for await (const _ of p.stream({ question: 'hi' }, controller.signal)) {
        controller.abort();
      }
    },
    error => error instanceof ProviderError && error.code === 'cancelled'
  );
  const signal = fetchImpl.calls.find(c => c.path === '/api/chat')?.signal;
  assert.equal(signal?.aborted, true, '不 abort，服务端还在算，就不算真的取消');
});

test('cancel(requestId) 也能断掉正在跑的请求', async () => {
  const p = provider(makeFetch({ chunks: [byLine(streamText)[0]], hang: true }));
  const pending = (async () => {
    for await (const _ of p.stream({ question: 'hi', requestId: 'job-1' })) { /* 挂着 */ }
  })();
  await sleep(10);
  p.cancel('job-1');
  await assert.rejects(pending, error => error instanceof ProviderError);
});

test('模型不存在：真实 404 响应映射成 model-not-found，并给出 pull 提示', async () => {
  await assert.rejects(
    provider(makeFetch()).generate({ question: 'hi', modelId: missing.body.match(/'([^']+)'/)[1] }),
    error => error instanceof ProviderError && error.code === 'model-not-found' && /ollama pull/.test(error.message)
  );
});

test('服务不可达：generate 抛 unavailable，不是裸的 fetch failed', async () => {
  await assert.rejects(
    provider(makeFetch({ overrides: { '/api/ps': null, '/api/tags': null, '/api/show': null, '/api/chat': null } }))
      .generate({ question: 'hi' }),
    error => error instanceof ProviderError && error.code === 'unavailable'
  );
});

test('并发闸门：两个请求同时在跑时，真正打到 /api/chat 的只有一个', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = makeFetch({
    overrides: {
      '/api/chat': async body => {
        if (!body.stream) {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(40);
          active -= 1;
          return json(chatOnce);
        }
        return ndjsonResponse(byLine(streamText));
      }
    }
  });
  const p = provider(fetchImpl);
  const [a, b] = await Promise.all([
    p.generate({ question: '一' }),
    p.generate({ question: '二' })
  ]);
  assert.equal(peak, 1);
  assert.equal(a.text, chatOnce.message.content);
  assert.equal(b.text, chatOnce.message.content);
  assert.deepEqual(p.queue(), { running: 0, queued: 0 });
});

test('排队有上限：超过就报 busy，不是无限加载', async () => {
  const fetchImpl = makeFetch({
    overrides: {
      '/api/chat': async body => {
        if (!body.stream) {
          await sleep(200);
          return json(chatOnce);
        }
        return ndjsonResponse(byLine(streamText));
      }
    }
  });
  const p = provider(fetchImpl, { queueTimeoutMs: 40, generateTimeoutMs: 1000 });
  const first = p.generate({ question: '一' });
  await sleep(5);
  await assert.rejects(
    p.generate({ question: '二' }),
    error => error instanceof ProviderError && error.code === 'busy' && /本地模型正忙/.test(error.message)
  );
  await first;
});

test('切模型前先卸载别的驻留模型（keep_alive: 0）', async () => {
  const fetchImpl = makeFetch({
    overrides: {
      // 真实 ps 结构的字段名，只把名字换成另一个模型来触发卸载分支。
      '/api/ps': json({ models: [{ ...ps.models[0], name: 'another-model:7b' }] })
    }
  });
  await provider(fetchImpl).generate({ question: 'hi' });
  const unload = fetchImpl.calls.find(c => c.path === '/api/generate');
  assert.ok(unload, '应该发过一次卸载请求');
  assert.equal(unload.body.model, 'another-model:7b');
  assert.equal(unload.body.keep_alive, 0);
});

test('能力描述如实：真机实测过取消语义，才敢写 abort', async () => {
  const caps = await provider(makeFetch()).capabilities();
  assert.equal(caps.streaming, true);
  assert.equal(caps.cancellation, 'abort');
  assert.equal(caps.modelDiscovery, 'listed');
  assert.equal(caps.maxConcurrency, 1);
  assert.equal(caps.toolCalling, true);
  assert.equal(showQwen.capabilities.includes('tools'), true);
});
