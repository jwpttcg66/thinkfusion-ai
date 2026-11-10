/**
 * Phase K：项目书列出的 17 项稳定性场景。
 *
 * 这一组是逻辑级回归，用真实模块 + 注入的失败，不依赖真机。真机结果另见
 * `docs/testing/TEST_REPORT.md`。没跑的场景在报告里如实标注，不标通过。
 *
 * Run with: npm run test:scenarios
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeExecutionConfig } from '../out-test/shared/conversation.js';
import { selectParticipants } from '../out-test/main/execution/policy.js';
import { ProviderBackedSubAgent } from '../out-test/main/execution/provider-sub-agent.js';
import { planCollaboration } from '../out-test/main/collaboration/strategy.js';
import { runCollaboration } from '../out-test/main/collaboration/runner.js';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { VerdictStore } from '../out-test/main/judge/store.js';
import { JudgeEngine } from '../out-test/main/judge/engine.js';
import { ApiKeyStore, memorySecretBox } from '../out-test/main/providers/secrets.js';
import { OllamaProvider } from '../out-test/main/providers/ollama.js';
import { OpenAICompatibleProvider } from '../out-test/main/providers/openai-compatible.js';
import { extractClaims } from '../out-test/main/synthesis/claim-extractor.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const webAgent = id => ({ id, label: id });

function provider(type, id, overrides = {}) {
  return {
    id, label: id, type,
    capabilities: async () => ({ streaming: true, cancellation: 'abort', modelDiscovery: 'listed', maxConcurrency: 1, structuredOutput: true, toolCalling: true }),
    listModels: async () => [],
    health: async () => ({ available: true, checkedAt: Date.now() }),
    generate: async () => ({ text: `${id} 回答`, providerId: id, modelId: 'm', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 }),
    cancel: () => {},
    ...overrides
  };
}

function sink() {
  return {
    join: () => {}, record: answer => `m-${answer.agentId}`, phase: () => {}, note: () => {},
    status: () => {}, cancelled: () => false
  };
}

// 1–4 执行模式（2026-11-09 更新：模式同时决定谁回答，本地/云端主导不问网页）
const web = [webAgent('chatgpt'), webAgent('kimi')];
const local = new ProviderBackedSubAgent(provider('local', 'ollama'), 'qwen2.5:7b');
const cloud = new ProviderBackedSubAgent(provider('cloud', 'openai'), 'gpt-4o-mini');
const extra = [local, cloud];
const expectedAnswers = {
  web: ['chatgpt', 'kimi'],
  hybrid: ['chatgpt', 'kimi'],
  local: [local.id],
  cloud: [cloud.id]
};

for (const mode of ['web', 'local', 'cloud', 'hybrid']) {
  test(`场景 ${mode} 主导：第一手回答按执行模式归属，本地/云端同时进执行名单`, () => {
    const config = normalizeExecutionConfig({ executionMode: mode });
    const selection = selectParticipants(config, web, extra);
    assert.deepEqual(
      [...selection.answerIds].sort(),
      [...expectedAnswers[mode]].sort(),
      '网页/混合由网页回答；本地/云端主导由对应模型回答，不问网页'
    );
    assert.deepEqual(
      [...selection.executorIds].sort(),
      [local.id, cloud.id].sort(),
      '本地与云端都是执行阶段成员（可当主导/辩手）'
    );
  });
}

test('场景 老配置归位：处理动作四档按行为就近映射到主导人', () => {
  assert.equal(normalizeExecutionConfig({ executionMode: 'direct' }).executionMode, 'web');
  assert.equal(normalizeExecutionConfig({ executionMode: 'lead' }).executionMode, 'web');
  assert.equal(normalizeExecutionConfig({ executionMode: 'summary' }).executionMode, 'local');
  assert.equal(normalizeExecutionConfig({ executionMode: 'auto' }).executionMode, 'hybrid');
});

// 5 多模型并行
test('场景 5 多模型并行：一轮内所有成员都问到，且按并发上限分批', async () => {
  const asked = [];
  const pool = {
    all: async () => [], available: async () => [],
    ask: async (id, task) => { asked.push(id); return { agentId: id, text: `${id} 答`, receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: task.stage }; },
    newConversation: async () => ({ ok: true }), deleteConversation: async () => ({ ok: true }), cancel: () => {}
  };
  const plan = planCollaboration({ strategy: 'parallel', question: '并行测试', agents: ['a', 'b', 'c'].map(webAgent), maxConcurrency: 2 });
  const result = await runCollaboration(pool, plan, sink());
  assert.equal(plan.concurrency, 2);
  assert.deepEqual(asked.sort(), ['a', 'b', 'c']);
  assert.equal(result.outcome.answers.length, 3);
});

// 6 多轮辩论
test('场景 6 多轮辩论：deep 三轮，后轮看到前序发言', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-scenario-'));
  const seen = [];
  const orchestrator = new DebateOrchestrator(new DebateStore(dir), {
    ask: async (agentId, task) => {
      seen.push(task.context?.length ?? 0);
      return { agentId, text: `${agentId} 第 ${seen.length} 次观点`, receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: task.stage };
    }
  });
  const started = orchestrator.start('辩论测试', { strategy: 'deep', participants: ['a', 'b'], convergenceStop: false });
  const state = await orchestrator.waitFor(started.debateId);
  assert.equal(state.rounds.length, 3);
  assert.ok(seen.some(count => count === 2));
  fs.rmSync(dir, { recursive: true, force: true });
});

// 7 模型中途失败
test('场景 7 模型中途失败：隔离、重试一次、其他人照常完成', async () => {
  let attempts = 0;
  const pool = {
    all: async () => [], available: async () => [],
    ask: async id => {
      if (id === 'b') { attempts += 1; if (attempts === 1) throw new Error('中途失败'); }
      return { agentId: id, text: `${id} 答`, receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: 'initial' };
    },
    newConversation: async () => ({ ok: true }), deleteConversation: async () => ({ ok: true }), cancel: () => {}
  };
  const plan = planCollaboration({ strategy: 'parallel', question: '失败测试', agents: ['a', 'b', 'c'].map(webAgent), maxConcurrency: 3 });
  const result = await runCollaboration(pool, plan, sink());
  assert.equal(result.outcome.answers.length, 3);
  assert.equal(result.records.find(item => item.agentId === 'b').attempts, 2);
});

// 8 网络中断 / 9 Ollama 退出
test('场景 8-9 网络中断与 Ollama 退出：unavailable，不抛裸 fetch 错', async () => {
  const dead = new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11499',
    defaultModel: 'qwen2.5:7b',
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
    connectTimeoutMs: 50
  });
  const health = await dead.health();
  assert.equal(health.available, false);
  assert.match(health.detail, /连不上 Ollama/);
  await assert.rejects(dead.generate({ question: 'hi' }), error => error.code === 'unavailable');
});

// 10 API 限流
test('场景 10 API 限流：429 重试后成功，耗尽时报 busy', async () => {
  let hits = 0;
  const keys = { has: () => true, get: () => 'sk-test' };
  const fetchImpl = async () => {
    hits += 1;
    return hits <= 2
      ? new Response('{"error":{"message":"rate limit"}}', { status: 429 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
  };
  const p = new OpenAICompatibleProvider({ id: 'c', keyStore: keys, fetchImpl, maxRetries: 2, retryBaseMs: 1, sleep: async () => {} });
  assert.equal((await p.generate({ question: 'hi' })).text, 'ok');
  assert.equal(hits, 3);

  const always = new OpenAICompatibleProvider({
    id: 'c', keyStore: keys, maxRetries: 1, retryBaseMs: 1, sleep: async () => {},
    fetchImpl: async () => new Response('{"error":{"message":"rate limit"}}', { status: 429 })
  });
  await assert.rejects(always.generate({ question: 'hi' }), error => error.code === 'busy');
});

// 11 用户取消
test('场景 11 用户取消：辩论中止后是 stopped，恢复继续', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-scenario-'));
  const orchestrator = new DebateOrchestrator(new DebateStore(dir), {
    ask: async agentId => { await sleep(20); return { agentId, text: `${agentId} 观点`, receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: 'initial' }; }
  });
  const started = orchestrator.start('取消测试', { strategy: 'deep', participants: ['a', 'b'], convergenceStop: false });
  await sleep(70);
  assert.equal(orchestrator.stop(started.debateId).status, 'stopped');
  const resumed = orchestrator.resume(started.debateId);
  assert.equal(resumed.status, 'running');
  const final = await orchestrator.waitFor(started.debateId, 5000);
  assert.equal(final.status, 'completed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 12 应用重启 / 13 历史恢复
test('场景 12-13 应用重启与历史恢复：辩论/裁决/Key 都能从盘上读回', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-scenario-'));
  const debateStore = new DebateStore(path.join(dir, 'debates'));
  const verdictStore = new VerdictStore(path.join(dir, 'verdicts'));
  const keys = new ApiKeyStore({ file: path.join(dir, 'keys.json'), box: memorySecretBox() });
  keys.set('openai', 'sk-secret');

  const orchestrator = new DebateOrchestrator(debateStore, {
    ask: async agentId => ({ agentId, text: `${agentId} 的观点`, receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: 'initial' })
  });
  const started = orchestrator.start('重启测试', { strategy: 'standard', participants: ['a', 'b'], convergenceStop: false });
  await orchestrator.waitFor(started.debateId);
  const verdict = await new JudgeEngine({}).judge(debateStore.get(started.debateId));
  verdictStore.save(verdict);

  // 模拟进程重启：只从磁盘重建，内存对象全部丢弃。
  const rebootDebates = new DebateStore(path.join(dir, 'debates'));
  const rebootVerdicts = new VerdictStore(path.join(dir, 'verdicts'));
  const rebootKeys = new ApiKeyStore({ file: path.join(dir, 'keys.json'), box: memorySecretBox() });
  const recovered = rebootDebates.get(started.debateId);
  assert.equal(recovered.rounds.length, 2);
  assert.equal(rebootVerdicts.get(started.debateId).verdictId, verdict.verdictId);
  assert.equal(rebootKeys.get('openai'), 'sk-secret');
  assert.equal(new DebateOrchestrator(rebootDebates, { ask: async () => { throw new Error('不该重跑'); } })
    .resume(started.debateId).status, 'completed', '已完成的辩论不该重跑');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 14 隐私模式（2026-11-05 重定义：回答必发网页，local-only 归一为 allow-cloud）
test('场景 14 隐私模式：老配置的 local-only 被归一，回答名单仍是网页通道', () => {
  const selection = selectParticipants(
    normalizeExecutionConfig({ executionMode: 'hybrid', privacyMode: 'local-only', selectedWebChannels: ['chatgpt'], selectedCloudModels: ['gpt-4o-mini'], fallbackEnabled: true }),
    web, extra
  );
  assert.deepEqual([...selection.answerIds], ['chatgpt'], '回答永远来自网页通道，显式选择生效');
  assert.deepEqual([...selection.executorIds].sort(), [local.id, 'openai:gpt-4o-mini'].sort());
});

// 15 超长网页内容
test('场景 15 超长网页内容：切句不崩，位置有效，收尾话不当观点', () => {
  const long = Array.from({ length: 400 }, (_, i) => `这是第 ${i} 段关于连接池与重试机制的说明，因为并发会带来竞争。`).join('\n');
  const claims = extractClaims({ channelId: 'a', messageId: 'm', text: long });
  assert.ok(claims.length > 0);
  assert.ok(claims.length <= 400, '观点数不该超过句子数');
  assert.ok(claims.every(claim => claim.span.end >= claim.span.start));
  const boilerplate = extractClaims({
    channelId: 'a', messageId: 'm2',
    text: '以下是关于连接池的详细说明与建议。\n希望对你有帮助。\n如果需要可以继续问我。\n以上就是全部内容。'
  });
  assert.equal(boilerplate.length, 0, '开场白、收尾话不该成为观点');
});

// 16 Token 预算耗尽
test('场景 16 Token 预算耗尽：达到上限后不再发请求', async () => {
  let calls = 0;
  const p = new OpenAICompatibleProvider({
    id: 'c',
    keyStore: { has: () => true, get: () => 'sk-test' },
    pricing: { m: { inputPerMillion: 1, outputPerMillion: 1, currency: 'CNY' } },
    defaultModel: 'm',
    budget: { maxTokens: 5 },
    maxRetries: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200 });
    }
  });
  await p.generate({ question: '第一次' });
  assert.equal(calls, 1);
  await assert.rejects(p.generate({ question: '第二次' }), error => error.code === 'budget-exceeded');
  assert.equal(calls, 1, '被闸门拦下的请求不能发出去');
});

// 17 多个 Conversation 同时执行
test('场景 17 多个会话同时执行：状态不串台', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-scenario-'));
  const store = new DebateStore(dir);
  const orchestrator = new DebateOrchestrator(store, {
    ask: async agentId => { await sleep(5); return { agentId, text: `${agentId} 观点`, receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: 'initial' }; }
  });
  const [a, b] = ['问题甲', '问题乙'].map(question =>
    orchestrator.start(question, { strategy: 'standard', participants: ['a', 'b'], convergenceStop: false })
  );
  const [fa, fb] = await Promise.all([orchestrator.waitFor(a.debateId), orchestrator.waitFor(b.debateId)]);
  assert.equal(fa.question, '问题甲');
  assert.equal(fb.question, '问题乙');
  assert.equal(fa.rounds.length, 2);
  assert.equal(fb.rounds.length, 2);
  assert.notEqual(fa.rounds[0].messages[0].messageId, fb.rounds[0].messages[0].messageId);
  fs.rmSync(dir, { recursive: true, force: true });
});
