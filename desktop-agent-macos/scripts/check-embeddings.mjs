/**
 * Embedding 提供方：状态探测、Ollama / OpenAI 兼容两条路、失败语义。
 *
 * 用本地假 HTTP 服务，不依赖外网与真实模型；真机状态由应用里的
 * embedding:status 单独看。
 *
 * Run with: npm run test:embeddings
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import http from 'node:http';

import { EmbeddingService } from '../out-test/main/embeddings/service.js';

let server;
let base;
let mode = 'chat-only';
let lastAuth = '';
let embedCalls = 0;

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/api/tags') {
      const models = mode === 'with-embed'
        ? [{ name: 'nomic-embed-text' }, { name: 'deepseek-r1:14b' }]
        : [{ name: 'deepseek-r1:14b' }];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models }));
      return;
    }
    if (request.url === '/api/embed') {
      embedCalls += 1;
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ embeddings: parsed.input.map((_, index) => [index + 1, 0.5, 0.25]) }));
      });
      return;
    }
    if (request.url === '/v1/embeddings') {
      lastAuth = String(request.headers.authorization ?? '');
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: parsed.input.map((_, index) => ({ embedding: [index + 0.5, 0.1] })) }));
      });
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

test('Ollama 在线但没有 embedding 模型：available=false 并说明要拉哪个', async () => {
  mode = 'chat-only';
  const service = new EmbeddingService({ ollamaUrl: base });
  const status = await service.status();
  assert.equal(status.ollama.available, false);
  assert.match(status.ollama.detail, /nomic-embed-text/);
});

test('自动挑出已安装的 embedding 模型并返回向量', async () => {
  mode = 'with-embed';
  const service = new EmbeddingService({ ollamaUrl: base });
  const status = await service.status();
  assert.equal(status.ollama.available, true);
  assert.equal(status.ollama.picked, 'nomic-embed-text');
  const result = await service.embed({ texts: ['hello', 'world'] });
  assert.equal(result.backend, 'ollama');
  assert.equal(result.model, 'nomic-embed-text');
  assert.deepEqual(result.vectors, [[1, 0.5, 0.25], [2, 0.5, 0.25]]);
});

test('没有模型时 embed 明确 EMBEDDING_UNAVAILABLE，不编造向量', async () => {
  mode = 'chat-only';
  const service = new EmbeddingService({ ollamaUrl: base });
  await assert.rejects(() => service.embed({ texts: ['x'] }), /EMBEDDING_UNAVAILABLE/);
});

test('OpenAI 兼容后端带 Bearer Key，返回向量', async () => {
  const service = new EmbeddingService({
    ollamaUrl: base,
    resolveCloud: providerId => providerId === 'openai' ? { baseUrl: `${base}/v1`, key: 'sk-test' } : null
  });
  const result = await service.embed({
    backend: 'openai',
    providerId: 'openai',
    model: 'text-embedding-3-small',
    texts: ['a', 'b']
  });
  assert.equal(result.backend, 'openai');
  assert.equal(result.vectors.length, 2);
  assert.equal(lastAuth, 'Bearer sk-test');
});

test('云端没有 Key：EMBEDDING_UNAVAILABLE', async () => {
  const service = new EmbeddingService({ ollamaUrl: base, resolveCloud: () => null });
  await assert.rejects(
    () => service.embed({ backend: 'openai', providerId: 'openai', model: 'x', texts: ['a'] }),
    /EMBEDDING_UNAVAILABLE/
  );
});

test('空文本 / 超过 64 条直接拒绝', async () => {
  const service = new EmbeddingService({ ollamaUrl: base });
  await assert.rejects(() => service.embed({ texts: [] }), /没有要 embed/);
  await assert.rejects(() => service.embed({ texts: Array.from({ length: 65 }, () => 'x') }), /最多 64/);
});
