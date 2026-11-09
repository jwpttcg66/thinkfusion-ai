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

test('OpenCode Go 预设带完整的付费清单，不再只有六条「主力」', async () => {
  const { OPENCODE_GO_MODELS } = await import('../out-test/shared/opencode-models.js');
  const opencode = presetOf('opencode-go');
  // 原先只列 6 条，界面上看起来「这家只有六个模型」；网关实际报 30 条。
  assert.ok(opencode.models.length >= 25, `预设只有 ${opencode.models.length} 条，仍像一个残缺清单`);
  for (const model of ['deepseek-v4.1-flash', 'glm-5.3', 'grok-4.7', 'claude-haiku-5-5', 'gemini-4-argon', 'kimi-k3.1-pro']) {
    assert.ok(opencode.models.includes(model), `预设缺少 ${model}`);
  }
  // `-free` 有区域限制（不含中国大陆），不进默认值；配好 Key 后仍会从网关读回来。
  assert.equal(opencode.models.filter(model => model.endsWith('-free')).length, 0);
  assert.deepEqual(opencode.models, [...OPENCODE_GO_MODELS]);
  // 「添加提供商」的目录用同一份清单，两处不能各写各的。
  const { catalogEntryOf } = await import('../out-test/main/providers/cloud-presets.js');
  assert.deepEqual(catalogEntryOf('opencode-go').models, opencode.models);
});

test('「选择模型」只动看得见的候选；候选去重保序，空选择不算全选', async () => {
  const { allVisiblePicked, filterModels, mergeCandidates, toggleVisibleModels } =
    await import('../out-test/shared/cloud-selection.js');
  // 网关清单 + 已选里才有的旧模型：去重且保持首次出现的顺序。
  assert.deepEqual(mergeCandidates(['a', 'b'], ['b', 'old']), ['a', 'b', 'old']);
  // 搜索只缩窄视图，不改变已选项。
  assert.deepEqual(filterModels(['glm-5.3', 'gpt-6-luna'], 'GPT'), ['gpt-6-luna']);
  // 全选可见项：隐藏的 'old' 保留。
  assert.deepEqual(toggleVisibleModels(['old'], ['a', 'b'], true), ['old', 'a', 'b']);
  // 取消全选可见项：同样不碰隐藏的。
  assert.deepEqual(toggleVisibleModels(['old', 'a', 'b'], ['a', 'b'], false), ['old']);
  assert.equal(allVisiblePicked(['a'], ['a', 'b']), false);
  assert.equal(allVisiblePicked([], []), false, '空可见清单不算「已经全选」');
  assert.equal(allVisiblePicked(['a', 'b'], ['a', 'b']), true);
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

test('「来自网关」是记下来的来源，不是拿清单长度冒充的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cloud-origin-'));
  const file = path.join(dir, 'cloud-config.json');
  try {
    const store = new CloudConfigStore(file);
    // 预设自带的模型名落进配置，也不等于网关给过：来源字段必须缺省。
    store.set('deepseek', { models: ['deepseek-v4-flash'] });
    assert.equal(store.get('deepseek')?.modelsFromGateway, undefined, '没问过 /models 就不能说「来自网关」');
    // 真问过才标 true。
    store.set('deepseek', { models: ['deepseek-v4-flash', 'deepseek-v4-pro'], modelsFromGateway: true });
    assert.equal(new CloudConfigStore(file).get('deepseek')?.modelsFromGateway, true);
    // 换端点：清单保留（常常只是同一网关的代理地址），来源标记作废。
    store.set('deepseek', { baseUrl: 'https://proxy.example.com/v1' });
    const after = new CloudConfigStore(file).get('deepseek');
    assert.equal(after?.modelsFromGateway, undefined, '端点换了，旧清单不是新端点给的');
    assert.deepEqual(after?.models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
    // 手写进来的清单把来源改回 false。
    store.set('deepseek', { models: ['hand-typed'], modelsFromGateway: false });
    assert.equal(new CloudConfigStore(file).get('deepseek')?.modelsFromGateway, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('候选与已选分开存：勾选子集后，catalog 仍留着完整清单', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cloud-pick-'));
  const file = path.join(dir, 'cloud-config.json');
  try {
    const store = new CloudConfigStore(file);
    store.set('opencode-go', {
      catalog: ['a', 'b', 'c'],
      models: ['a', 'b', 'c'],
      modelsFromGateway: true
    });
    // 用户在「选择模型」里只留 a、c。
    store.set('opencode-go', { models: ['a', 'c'], modelsPicked: true });
    const after = new CloudConfigStore(file).get('opencode-go');
    assert.deepEqual(after?.models, ['a', 'c']);
    assert.deepEqual(after?.catalog, ['a', 'b', 'c'], '取消勾选不能把候选一起删掉');
    assert.equal(after?.modelsPicked, true);
    assert.equal(after?.modelsFromGateway, true, '从网关候选里勾的，来源仍是网关');
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

/**
 * 「像 harness 那样自己选云模型」的数据层。
 *
 * 这里钉的是三件以后最容易退化的约定：目录只收 OpenAI 兼容端点、
 * 用户加的服务 id 一定带 `user:` 前缀、名字能随配置落盘再读回来。
 * 前端那一层（下拉、获取模型按钮）在真机上验，不在这里假装。
 */
test('目录里每一项都说得清端点，自定义项故意留空等用户填', async () => {
  const { PROVIDER_CATALOG, catalogEntryOf } = await import('../out-test/main/providers/cloud-presets.js');
  assert.ok(PROVIDER_CATALOG.length >= 8, '目录太短，等于没得选');
  for (const entry of PROVIDER_CATALOG) {
    assert.ok(entry.id && entry.label, '每一项都要有 id 和名字');
    if (entry.custom) {
      assert.equal(entry.baseUrl, '', '自定义项不该替用户写死端点');
      continue;
    }
    assert.match(entry.baseUrl, /^https:\/\//, `${entry.id} 的端点必须是 https`);
    assert.ok(entry.models.length > 0, `${entry.id} 至少要给一个默认模型`);
  }
  // 目录里的 id 不重复，否则下拉里会出现两行一样的服务
  assert.equal(new Set(PROVIDER_CATALOG.map(entry => entry.id)).size, PROVIDER_CATALOG.length);
  assert.equal(catalogEntryOf('custom')?.custom, true);
  assert.equal(catalogEntryOf('nope'), undefined);
});

test('用户加的服务：id 带 user: 前缀，重名时自动加序号', async () => {
  const { userProviderId, isUserProvider } = await import('../out-test/main/providers/cloud-presets.js');
  const first = userProviderId('公司 内网', []);
  assert.equal(first, 'user:公司-内网', '中文名要留下来，否则两家中转网关分不出谁是谁');
  assert.equal(isUserProvider(first), true);
  assert.equal(isUserProvider('openai'), false, '内置 id 不能被当成用户服务（否则会被删掉）');

  const taken = ['user:公司-内网'];
  assert.equal(userProviderId('公司 内网', taken), 'user:公司-内网-2');
  assert.equal(userProviderId('!!!', []), 'user:custom', '全是符号时给个兜底 id，不能是空的');
});

test('用户服务的名字随配置落盘，重启后还读得回来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cloud-'));
  try {
    const store = new CloudConfigStore(path.join(dir, 'cloud-config.json'));
    store.set('user:company-network', { label: '公司 内网', baseUrl: 'https://gw.example.com/v1', models: ['m1'] });
    const again = new CloudConfigStore(path.join(dir, 'cloud-config.json'));
    assert.equal(again.get('user:company-network')?.label, '公司 内网');
    assert.equal(again.get('user:company-network')?.baseUrl, 'https://gw.example.com/v1');
    again.remove('user:company-network');
    assert.equal(again.get('user:company-network'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
