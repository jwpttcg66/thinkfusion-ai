/**
 * 多云端服务：DeepSeek / OpenCode Go / OpenAI。
 *
 * 这里起一个真实 HTTP 服务，按路径前缀分三套端点，验证的不是「函数返回值
 * 长得对」，而是**换一个 baseUrl 和 Key 之后请求真的发对了地方**：
 *
 * 1. 每个服务用自己的 baseUrl，不会拼成 `https://api.deepseek.com/v1/v1/...`。
 * 2. 每个服务用自己的 Key，A 的 Key 不会发到 B。
 * 3. `/models` 探活、非流式、流式 SSE 三条路都通。
 * 4. 模型名失效时是 `model-not-found`，不是含糊的 `unknown`——云厂商改名
 *    是常态（DeepSeek 2026-07-24 停用了 deepseek-chat），这个错误要能照做。
 *
 * Run with: npm run test:cloud-multi
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../out-test/main/providers/openai-compatible.js';
import { CloudConfigStore } from '../out-test/main/providers/cloud-config.js';
import { CLOUD_PRESETS, normalizeModels, presetOf, resolvePreset } from '../out-test/main/providers/cloud-presets.js';

const KEYS = { openai: 'sk-openai-test', deepseek: 'sk-deepseek-test', 'opencode-go': 'sk-opencode-test' };

function keyStore(calls) {
  return {
    has: id => Boolean(KEYS[id]),
    get: id => { calls.push(id); return KEYS[id] ?? null; }
  };
}

/** 三套端点，按前缀区分，认证头不对就 401。 */
function startServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const match = /^\/(openai|deepseek|opencode-go)\/(?:go\/)?v1(\/.*)$/.exec(req.url ?? '');
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, headers: req.headers, body });
      if (!match) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `未知路径 ${req.url}` } }));
        return;
      }
      const [, providerId, rest] = match;
      if (req.headers.authorization !== `Bearer ${KEYS[providerId]}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (rest === '/models' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: `${providerId}-model` }] }));
        return;
      }
      if (rest === '/chat/completions' && req.method === 'POST') {
        // 模拟云厂商停用旧模型名：请求里带 retired 就 404。
        if (String(body.model ?? '').includes('retired')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `model ${body.model} not found`, type: 'invalid_request_error' } }));
          return;
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta, extra = {}) => `data: ${JSON.stringify({
            choices: [{ index: 0, delta, finish_reason: null }], ...extra
          })}\n\n`;
          res.write(chunk({ role: 'assistant', content: '' }));
          res.write(chunk({ content: '42' }));
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: `${providerId} 的回答` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
        }));
        return;
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'method not allowed' } }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, seen, base: id => `http://127.0.0.1:${port}/${id}/${id === 'opencode-go' ? 'go/' : ''}v1` });
    });
  });
}

// ---------------------------------------------------------------------------
// 预设
// ---------------------------------------------------------------------------

test('预设覆盖 DeepSeek 与 OpenCode Go，且不再写已停用的 deepseek-chat', () => {
  const ids = CLOUD_PRESETS.map(item => item.id);
  assert.deepEqual(ids, ['openai', 'deepseek', 'opencode-go']);
  const deepseek = presetOf('deepseek');
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/v1');
  assert.ok(deepseek.models.includes('deepseek-v4-flash'));
  assert.ok(!deepseek.models.includes('deepseek-chat'), 'deepseek-chat 已于 2026-07-24 停用，不能当默认');
  const opencode = presetOf('opencode-go');
  assert.equal(opencode.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
  // Go 网关把所有文本模型翻译成 chat/completions，所以 GPT/Claude 能列进来；
  // note 说的是「订阅制、不估算单价」，不再是 Zen 那条协议边界。
  assert.ok(opencode.models.includes('gpt-6-luna'));
  assert.match(opencode.note, /订阅|额度/);
  assert.equal(presetOf('opencode'), undefined, 'Zen 预设已合并到 Go，不应再单列');
});

test('模型清单去空白、去重、丢非字符串；空清单退回预设而不是变成零模型', () => {
  assert.deepEqual(normalizeModels([' a ', 'a', '', 3, 'b']), ['a', 'b']);
  const preset = presetOf('deepseek');
  const resolved = resolvePreset(preset, { models: [] });
  assert.deepEqual(resolved.models, preset.models);
  const custom = resolvePreset(preset, { models: ['my-model'] });
  assert.deepEqual(custom.models, ['my-model']);
});

test('baseUrl 只接受 http(s)，尾斜杠会被去掉，避免拼出 //chat/completions', () => {
  const preset = presetOf('opencode-go');
  assert.equal(resolvePreset(preset, { baseUrl: 'https://example.com/v1/' }).baseUrl, 'https://example.com/v1');
  assert.equal(resolvePreset(preset, { baseUrl: 'file:///etc/passwd' }).baseUrl, preset.baseUrl);
  assert.equal(resolvePreset(preset, { baseUrl: '' }).baseUrl, preset.baseUrl);
});

test('配置存储：读写保留、损坏文件退回空、删除生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cloud-config-'));
  const file = path.join(dir, 'cloud-config.json');
  try {
    const store = new CloudConfigStore(file);
    assert.equal(store.get('deepseek'), null);
    store.set('deepseek', { models: ['deepseek-v4-pro'] });
    assert.deepEqual(new CloudConfigStore(file).get('deepseek').models, ['deepseek-v4-pro']);
    store.set('deepseek', { baseUrl: 'https://proxy.example.com/v1' });
    assert.deepEqual(new CloudConfigStore(file).get('deepseek'), {
      models: ['deepseek-v4-pro'], baseUrl: 'https://proxy.example.com/v1'
    });
    fs.writeFileSync(file, '{ 不是 JSON');
    assert.equal(new CloudConfigStore(file).get('deepseek'), null);
    fs.writeFileSync(file, JSON.stringify({ 'opencode-go': { models: ['x'] } }));
    new CloudConfigStore(file).remove('opencode-go');
    assert.equal(new CloudConfigStore(file).get('opencode-go'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 真实 HTTP：换 baseUrl 与 Key 之后请求发对了地方
// ---------------------------------------------------------------------------

test('三家服务各自用自己的端点和 Key，探活到的是自己的 /models', async () => {
  const { server, seen, base } = await startServer();
  try {
    for (const id of ['openai', 'deepseek', 'opencode-go']) {
      const calls = [];
      const provider = new OpenAICompatibleProvider({
        id, label: id, baseUrl: base(id), models: ['m'], defaultModel: 'm', keyStore: keyStore(calls)
      });
      const health = await provider.health();
      assert.equal(health.available, true, `${id} 探活失败：${health.detail}`);
      assert.equal(calls[0], id, '取 Key 时用的是自己的 provider id');
    }
    const urls = seen.map(item => item.url);
    assert.ok(urls.includes('/openai/v1/models'));
    assert.ok(urls.includes('/deepseek/v1/models'));
    assert.ok(urls.includes('/opencode-go/go/v1/models'));
    // 没有任何请求把 A 的 Key 发到 B 的路径
    for (const item of seen) {
      const providerId = /^\/(openai|deepseek|opencode-go)\//.exec(item.url)?.[1];
      assert.equal(item.auth, `Bearer ${KEYS[providerId]}`);
    }
  } finally {
    server.close();
  }
});

test('非流式与流式都走对路径，并带回 usage', async () => {
  const { server, seen, base } = await startServer();
  try {
    const provider = new OpenAICompatibleProvider({
      id: 'deepseek', label: 'DeepSeek', baseUrl: base('deepseek'),
      models: ['deepseek-v4-flash'], defaultModel: 'deepseek-v4-flash', keyStore: keyStore([])
    });
    const answer = await provider.generate({ question: '17 乘 3' });
    assert.match(answer.text, /deepseek 的回答/);
    assert.equal(answer.usage.inputTokens, 9);
    assert.equal(answer.usage.outputTokens, 2);

    let streamed = '';
    for await (const piece of provider.stream({ question: '17 乘 3' })) streamed += piece;
    assert.equal(streamed, '42');
    const posts = seen.filter(item => item.url === '/deepseek/v1/chat/completions');
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.stream, true);
    assert.equal(posts[1].body.stream_options?.include_usage, true, '流式必须开 include_usage');
  } finally {
    server.close();
  }
});

test('模型名被云厂商停用时是 model-not-found，不是含糊的 unknown', async () => {
  const { server, base } = await startServer();
  try {
    const provider = new OpenAICompatibleProvider({
      id: 'deepseek', label: 'DeepSeek', baseUrl: base('deepseek'),
      models: ['retired-model'], defaultModel: 'retired-model', keyStore: keyStore([]), maxRetries: 0
    });
    await assert.rejects(
      () => provider.generate({ question: 'hi' }),
      error => error.code === 'model-not-found'
    );
  } finally {
    server.close();
  }
});

test('OpenCode Go 要求的客户端头每次都带：探活与生成都发 user-agent 与稳定 session', async () => {
  const { server, seen, base } = await startServer();
  try {
    const headers = { 'user-agent': 'ThinkFusion/9.9.9', 'x-opencode-session': 'sess-abc' };
    const provider = new OpenAICompatibleProvider({
      id: 'opencode-go', label: 'OpenCode Go', baseUrl: base('opencode-go'),
      models: ['kimi-k3'], defaultModel: 'kimi-k3', keyStore: keyStore([]), extraHeaders: headers
    });
    const health = await provider.health();
    assert.equal(health.available, true, `探活失败：${health.detail}`);
    await provider.generate({ question: 'hi' });
    assert.equal(seen.length, 2);
    for (const item of seen) {
      assert.equal(item.headers['user-agent'], 'ThinkFusion/9.9.9');
      assert.equal(item.headers['x-opencode-session'], 'sess-abc');
      assert.equal(item.auth, 'Bearer sk-opencode-test', '额外头不能把鉴权头挤掉');
    }
  } finally {
    server.close();
  }
});

test('改成自定义 baseUrl（代理/自建网关）照样能用', async () => {
  const { server, seen, base } = await startServer();
  try {
    // 把 OpenCode Go 指向本地前缀，但通过配置传进去，走的是同一条代码路径
    const provider = new OpenAICompatibleProvider({
      id: 'opencode-go', label: 'OpenCode Go', baseUrl: base('opencode-go'),
      models: ['kimi-k3'], defaultModel: 'kimi-k3', keyStore: keyStore([])
    });
    const answer = await provider.generate({ question: 'hi' });
    assert.match(answer.text, /opencode-go 的回答/);
    assert.ok(seen.some(item => item.url === '/opencode-go/go/v1/chat/completions'));
  } finally {
    server.close();
  }
});
