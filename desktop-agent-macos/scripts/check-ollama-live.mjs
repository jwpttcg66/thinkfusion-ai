/**
 * Ollama Provider 真机端到端。
 *
 * 和 check-ollama.mjs 的区别：这里没有任何假 fetch，全部打到
 * 127.0.0.1:11434 的真实服务、真实 qwen2.5:7b。服务没起就整组 skip，
 * 不把「没跑」写成「通过」。
 *
 * 不进 npm test：CI 上没有 Ollama。手动跑：
 *   npm run test:ollama:live
 *
 * 录 fixture 用的也是这些端点，见 scripts/fixtures/ollama/_meta.json。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaProvider } from '../out-test/main/providers/ollama.js';

const BASE = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:7b';

async function reachable() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const live = await reachable();
if (!live) {
  console.log(`[skip] Ollama 没在 ${BASE} 上运行。启动 Ollama.app 或 ollama serve 后重跑。`);
}

function provider(options = {}) {
  return new OllamaProvider({ defaultModel: MODEL, baseUrl: BASE, ...options });
}

test('health：服务在跑且能数出模型', { skip: !live }, async () => {
  const status = await provider().health();
  assert.equal(status.available, true);
  assert.match(status.detail, /已安装 \d+ 个模型/);
});

test('listModels：真实服务里只返回能对话的模型，且读到真实上下文长度', { skip: !live }, async () => {
  const models = await provider().listModels();
  assert.ok(models.some(m => m.id === MODEL));
  assert.equal(models.some(m => m.id === 'nomic-embed-text:latest'), false,
    'embedding 模型不该出现在可对话列表里');
  assert.equal(models.find(m => m.id === MODEL).contextTokens, 32768);
});

test('generate：真回答、真 token 用量', { skip: !live }, async () => {
  const r = await provider().generate({ question: '用一句话回答：17 乘 3 等于多少？' });
  assert.match(r.text, /51/);
  assert.ok(r.usage.outputTokens > 0);
  assert.ok(r.latencyMs > 0);
});

test('stream：真流式，首字比整段早，拼起来非空', { skip: !live }, async () => {
  const started = Date.now();
  let firstAt = null;
  let text = '';
  let chunks = 0;
  for await (const piece of provider().stream({ question: '用三句话介绍你自己。' })) {
    if (firstAt === null) firstAt = Date.now() - started;
    text += piece;
    chunks += 1;
  }
  assert.ok(chunks > 1, '应该分成多个块，不是一次性返回');
  assert.ok(text.length > 0);
  assert.ok(firstAt <= Date.now() - started);
  console.log(`[live] 首字 ${firstAt}ms，总 ${Date.now() - started}ms，${chunks} 块，${text.length} 字`);
});

test('取消：abort 之后服务真的停了，新请求不用排队', { skip: !live }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  try {
    for await (const _ of provider().stream(
      { question: '从 1 数到 300，每个数字之间用逗号隔开，不要省略。' },
      controller.signal
    )) {
      if (Date.now() - started > 1500) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    assert.equal(error.code, 'cancelled');
  }

  const before = await fetch(`${BASE}/api/ps`).then(r => r.json());
  await new Promise(resolve => setTimeout(resolve, 1200));
  const after = await fetch(`${BASE}/api/ps`).then(r => r.json());
  const expires = list => JSON.stringify((list.models ?? []).map(m => m.expires_at));
  assert.equal(expires(after), expires(before),
    '请求若还在算，卸载时间会继续推进；这里应当停在结束那一刻');

  const quickStart = Date.now();
  const quick = await provider().generate({ question: '只回答一个字：好' });
  const quickMs = Date.now() - quickStart;
  assert.ok(quick.text.trim().length > 0);
  assert.ok(quickMs < 5000, `旧请求仍在算：新请求等了 ${quickMs}ms`);
  console.log(`[live] abort 后新请求 ${quickMs}ms，取消语义判定为 abort`);
});

test('并发闸门：两个请求同时发，只有一个在跑', { skip: !live }, async () => {
  const p = provider();
  const a = p.generate({ question: '用一句话说明什么是递归。' });
  const b = p.generate({ question: '用一句话说明什么是哈希表。' });
  const atOnce = p.queue();
  assert.equal(atOnce.running, 1);
  assert.equal(atOnce.queued, 1);
  const [ra, rb] = await Promise.all([a, b]);
  assert.ok(ra.text && rb.text);
  assert.deepEqual(p.queue(), { running: 0, queued: 0 });
});

test('模型不存在：真 404 映射成 model-not-found', { skip: !live }, async () => {
  await assert.rejects(
    provider().generate({ question: 'hi', modelId: 'no-such-model:1b' }),
    error => error.code === 'model-not-found'
  );
});
