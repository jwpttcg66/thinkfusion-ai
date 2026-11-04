/**
 * Phase D 真机端到端。只有设置了 CLOUD_API_KEY 才真的发请求；没设置就整组
 * skip，不把「没跑」写成「通过」。
 *
 *   CLOUD_API_KEY=sk-... CLOUD_BASE_URL=https://api.openai.com/v1 \
 *     CLOUD_MODEL=gpt-4o-mini npm run test:cloud:live
 *
 * 明文 Key 只在这个进程里出现，不落盘、不打印、不进日志。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleProvider } from '../out-test/main/providers/openai-compatible.js';

const KEY = process.env.CLOUD_API_KEY ?? '';
const BASE = process.env.CLOUD_BASE_URL ?? 'https://api.openai.com/v1';
const MODEL = process.env.CLOUD_MODEL ?? 'gpt-4o-mini';
const live = KEY.length > 0;

if (!live) {
  console.log('[skip] 没有 CLOUD_API_KEY，跳过云端真机测试。设置环境变量后重跑。');
}

function provider() {
  return new OpenAICompatibleProvider({
    id: 'cloud-live',
    baseUrl: BASE,
    defaultModel: MODEL,
    models: [MODEL],
    keyStore: { has: () => true, get: () => KEY },
    maxRetries: 1
  });
}

test('health：真实云端可达且 Key 有效', { skip: !live }, async () => {
  const status = await provider().health();
  assert.equal(status.available, true, status.detail);
});

test('generate：真实回答与真实 token 用量', { skip: !live }, async () => {
  const r = await provider().generate({ question: '只回答一个数字：17 乘 3 等于多少？' });
  assert.match(r.text, /51/);
  assert.ok(r.usage.inputTokens > 0);
  assert.ok(r.usage.outputTokens > 0);
  console.log(`[live] ${MODEL} tokens=${r.usage.inputTokens}+${r.usage.outputTokens} latency=${r.latencyMs}ms`);
});

test('stream：真实 SSE，且最后能拿到 usage', { skip: !live }, async () => {
  const p = provider();
  let text = '';
  let chunks = 0;
  for await (const piece of p.stream({ question: '用一句话说你好。' })) {
    text += piece;
    chunks += 1;
  }
  assert.ok(text.length > 0);
  assert.ok(chunks > 1);
  const summary = p.usageSummary();
  assert.ok(summary.inputTokens > 0, 'include_usage 没生效时这里是 0');
  console.log(`[live] ${chunks} 块，${text.length} 字，usage ${summary.inputTokens}+${summary.outputTokens}`);
});
