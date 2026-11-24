/**
 * 流式超时按「无输出」计算（回归）。
 *
 * 旧实现用固定总时长：模型一直在吐推理/正文，120 秒一到仍然 abort，
 * 界面显示「请求超时」，而模型其实还在输出。
 *
 * Run with: npm run test:provider-idle
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAICompatibleProvider } from '../out-test/main/providers/openai-compatible.js';

const encoder = new TextEncoder();

function sseStream(chunks, gapMs) {
  let index = 0;
  return new ReadableStream({
    start(controller) {
      const push = () => {
        if (index >= chunks.length) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        const payload = typeof chunks[index] === 'string'
          ? chunks[index]
          : JSON.stringify({ choices: [{ delta: chunks[index] }] });
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        index += 1;
        setTimeout(push, gapMs);
      };
      push();
    }
  });
}

function providerWith(makeStream, timeoutMs) {
  return new OpenAICompatibleProvider({
    id: 'stub',
    label: 'Stub',
    baseUrl: 'http://stub.invalid',
    models: ['m'],
    defaultModel: 'm',
    timeoutMs,
    maxRetries: 0,
    keyStore: { get: () => 'key', has: () => true },
    fetchImpl: async (_url, init) => new Response(makeStream(init?.signal), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  });
}

test('持续输出超过单次超时时间仍然读完整条流', async () => {
  // 8 块 × 25ms = 200ms，远超 60ms 的静默阈值。
  const stream = sseStream(
    Array.from({ length: 8 }, (_, index) => ({ reasoning_content: `推理 ${index}` })),
    25
  );
  const provider = providerWith(() => stream, 60);
  const reasoning = [];
  const texts = [];
  for await (const chunk of provider.streamChunks({
    question: 'hi',
    modelId: 'm',
    requestId: 'r1',
    timeoutMs: 60
  })) {
    if (chunk.reasoning) reasoning.push(chunk.reasoning);
    if (chunk.text) texts.push(chunk.text);
  }
  assert.equal(reasoning.length, 8);
  assert.equal(texts.length, 0);
});

test('真正静默超过阈值才报「连续没有输出」', async () => {
  let sent = false;
  const provider = providerWith(signal => new ReadableStream({
    start(controller) {
      const push = () => {
        if (sent) return; // 第一块之后永远不再输出
        sent = true;
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '第一块' } }] })}\n\n`
        ));
      };
      push();
      // 真实 fetch 在 abort 时会结束 body；测试流也照这个语义收尾。
      signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    }
  }), 100);
  await assert.rejects(
    async () => {
      for await (const _chunk of provider.streamChunks({
        question: 'hi',
        modelId: 'm',
        requestId: 'r2',
        timeoutMs: 100
      })) { /* 只等错误 */ }
    },
    /连续 1 秒没有输出|没有输出/
  );
});
