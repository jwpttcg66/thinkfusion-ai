/**
 * Phase E：执行模式（2026-11-05 定稿）、选人、接线。
 *
 * 硬规则：第一手回答永远来自网页通道。执行模式 = 谁当主导人（网页/本地/
 * 云端/混合），主导人负责汇总、指定辩论、读辩论结果给最终意见。本地与云端
 * 模型都不参与第一轮回答，但可以当主导人或辩手。
 *
 * Run with: npm run test:execution
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExecutionConfig, DEFAULT_EXECUTION_CONFIG } from '../out-test/shared/conversation.js';
import { selectParticipants } from '../out-test/main/execution/policy.js';
import { ExecutionPool } from '../out-test/main/execution/execution-pool.js';
import { ProviderBackedSubAgent } from '../out-test/main/execution/provider-sub-agent.js';
import { ConversationRunner } from '../out-test/main/conversation-runner.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function webAgent(id) {
  return {
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: 'web' },
    health: async () => ({ id, label: id, available: true, loggedIn: true, pageReady: true, generating: false }),
    ask: async task => ({ agentId: id, text: 'web', receivedAt: Date.now(), attribution: { requestId: 'r', note: 'web' }, stage: task.stage }),
    cancel: () => {}
  };
}

function fakeProvider(type, id = type) {
  return {
    id,
    label: id,
    type,
    capabilities: async () => ({ streaming: true, cancellation: 'abort', modelDiscovery: 'listed', maxConcurrency: 1, structuredOutput: true, toolCalling: true }),
    listModels: async () => [],
    health: async () => ({ available: true, checkedAt: Date.now() }),
    generate: async request => ({
      text: `${type} 回答`,
      providerId: id,
      modelId: request.modelId ?? 'default',
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1
    }),
    cancel: () => {}
  };
}

const web = [webAgent('chatgpt'), webAgent('kimi')];
const local = new ProviderBackedSubAgent(fakeProvider('local', 'ollama'), 'qwen2.5:7b');
const cloud = new ProviderBackedSubAgent(fakeProvider('cloud', 'openai'), 'gpt-4o-mini');
const extra = [local, cloud];
const answers = selection => [...selection.answerIds].sort();
const executors = selection => [...selection.executorIds].sort();

// ---------------------------------------------------------------------------

test('默认配置是 web / allow-cloud，老会话照这个读', () => {
  assert.deepEqual(DEFAULT_EXECUTION_CONFIG, { executionMode: 'web', fallbackEnabled: false, privacyMode: 'allow-cloud' });
  assert.deepEqual(normalizeExecutionConfig(), DEFAULT_EXECUTION_CONFIG);
  assert.deepEqual(normalizeExecutionConfig(null), DEFAULT_EXECUTION_CONFIG);
  assert.equal(normalizeExecutionConfig({}).executionMode, 'web');
});

test('四种主导人保持不变；短暂上线过的处理动作四档按行为归位', () => {
  for (const mode of ['web', 'local', 'cloud', 'hybrid']) {
    assert.equal(normalizeExecutionConfig({ executionMode: mode }).executionMode, mode);
  }
  assert.equal(normalizeExecutionConfig({ executionMode: 'direct' }).executionMode, 'web');
  assert.equal(normalizeExecutionConfig({ executionMode: 'lead' }).executionMode, 'web');
  assert.equal(normalizeExecutionConfig({ executionMode: 'summary' }).executionMode, 'local');
  assert.equal(normalizeExecutionConfig({ executionMode: 'auto' }).executionMode, 'hybrid');
  // 回答必发网页，「仅本地」没有成立的前提；老配置带 local-only 也归一。
  assert.equal(normalizeExecutionConfig({ executionMode: 'web', privacyMode: 'local-only' }).privacyMode, 'allow-cloud');
  assert.equal(normalizeExecutionConfig({ executionMode: 'hybrid', privacyMode: 'local-only' }).privacyMode, 'allow-cloud');
});

test('主导成员被持久化；给空串等于没设', () => {
  assert.equal(normalizeExecutionConfig({ leadAgentId: 'chatgpt' }).leadAgentId, 'chatgpt');
  assert.equal(normalizeExecutionConfig({ leadAgentId: '   ' }).leadAgentId, undefined);
  assert.equal(normalizeExecutionConfig({ leadAgentId: 42 }).leadAgentId, undefined);
});

test('IPC 传来的非法值一律退回默认，不进 undefined 分支', () => {
  assert.equal(normalizeExecutionConfig({ executionMode: 'nonsense' }).executionMode, 'web');
  const config = normalizeExecutionConfig({ selectedWebChannels: ['ok', 3, null] });
  assert.deepEqual(config.selectedWebChannels, ['ok']);
  assert.equal(config.fallbackEnabled, false);
});

test('回答名单 = 网页通道；执行名单 = 本地 + 云端模型（可当主导/辩手）', () => {
  const selection = selectParticipants({}, web, extra);
  assert.deepEqual(answers(selection), ['chatgpt', 'kimi']);
  assert.deepEqual(executors(selection), ['ollama:qwen2.5:7b', 'openai:gpt-4o-mini']);
  assert.ok(
    !selection.blocked.some(item => item.id === 'ollama:qwen2.5:7b'),
    '本地模型不是回答者，但不该被挡在执行阶段之外——它能当主导人、能当辩手'
  );
});

test('按选择裁名单，空数组表示「一个都不选」而不是「没指定」', () => {
  const onlyChatgpt = selectParticipants({ selectedWebChannels: ['chatgpt'] }, web, extra);
  assert.deepEqual(answers(onlyChatgpt), ['chatgpt']);
  const noCloud = selectParticipants({ selectedCloudModels: [] }, web, extra);
  assert.deepEqual(executors(noCloud), ['ollama:qwen2.5:7b'], '显式清空云端只清云端，本地仍在执行名单里');
  const explicitCloud = selectParticipants({ selectedCloudModels: ['gpt-4o-mini'] }, web, extra);
  assert.deepEqual(executors(explicitCloud), ['ollama:qwen2.5:7b', 'openai:gpt-4o-mini']);
});

test('ExecutionPool：all/available 只给回答者（网页）；ask 放行回答者与执行者', async () => {
  const base = {
    all: async () => web,
    available: async () => web,
    ask: async (id, task) => web.find(a => a.id === id).ask(task),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
  const pool = new ExecutionPool(base, extra, new Set(['chatgpt']), new Set([cloud.id]));
  // 第一轮只问网页回答者；云端不进 all()，否则 MasterAgent 会把它当回答者。
  assert.deepEqual((await pool.all()).map(a => a.id), ['chatgpt']);
  assert.deepEqual((await pool.available()).map(a => a.id), ['chatgpt']);
  const answer = await pool.ask('chatgpt', { question: 'x', stage: 'initial' });
  assert.equal(answer.text, 'web');
  // 云端执行成员可以单独被问（主导轮读全部回答）。
  const leadAnswer = await pool.ask(cloud.id, { question: 'x', stage: 'challenge' });
  assert.equal(leadAnswer.text, 'cloud 回答');
  // 名单外（网页 kimi 没被选、本地模型这一轮没进执行名单）连问都不让问。
  await assert.rejects(pool.ask('kimi', { question: 'x', stage: 'initial' }), /这一轮不选/);
  await assert.rejects(pool.ask(local.id, { question: 'x', stage: 'initial' }), /这一轮不选/);
});

test('ProviderBackedSubAgent 把 Provider 的回答转成 MasterAgent 认识的 SubAgentAnswer', async () => {
  const answer = await cloud.ask({ question: '17 乘 3', stage: 'followup', timeoutMs: 1000 });
  assert.equal(answer.agentId, cloud.id);
  assert.equal(answer.text, 'cloud 回答');
  assert.equal(answer.stage, 'followup');
  const status = await cloud.health();
  assert.equal(status.available, true);
  assert.equal(status.pageReady, true);
});

test('runner 保存 executionConfig，并把它交给 poolFor', async () => {
  const conversations = new Map();
  const store = {
    listConversations: () => [...conversations.values()],
    getConversation: id => conversations.get(id) ?? null,
    listMessages: () => [],
    upsertConversation: c => conversations.set(c.conversationId, c),
    appendMessage: () => {},
    deleteConversation: id => conversations.delete(id)
  };
  const base = {
    all: async () => [],
    available: async () => [],
    ask: async () => { throw new Error('not used'); },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
  const seen = [];
  const runner = new ConversationRunner({
    store,
    registry: base,
    emit: () => {},
    submitWorkspace: async () => { throw new Error('not used'); },
    budgetMs: 40,
    poolFor: (config, pool) => { seen.push(config); return pool; }
  });

  const conversation = await runner.start({
    text: '17 乘 3 等于多少？',
    executionConfig: { executionMode: 'local' }
  });
  assert.equal(conversation.executionConfig.executionMode, 'local');
  assert.equal(conversation.executionConfig.privacyMode, 'allow-cloud');
  await sleep(20);
  assert.equal(seen[0].executionMode, 'local');
});

test('删除云端参与的会话，不提示「手动删除网页里的那份」', async () => {
  // 真机回归抓到的：非网页成员回答完也在 answered 里，但没有 threadUrl。
  // 原来的分支把「没有网页地址」当成「网页里还有一份要手动删」，
  // 让用户去一个不存在的侧栏找记录。
  const conversation = {
    conversationId: 'c-extra',
    title: '云端问答',
    channels: ['openai:gpt-4o-mini'],
    answered: ['openai:gpt-4o-mini'],
    threads: {},
    status: 'answered',
    createdAt: 1,
    updatedAt: 1
  };
  const store = {
    getConversation: id => (id === 'c-extra' ? conversation : null),
    deleteConversation: () => {},
    listConversations: () => [],
    listMessages: () => [],
    upsertConversation: () => {},
    appendMessage: () => {}
  };
  const calls = { deleted: 0, newChat: 0 };
  const registry = {
    get: () => undefined,
    cancelAll: () => {},
    deleteConversation: async () => { calls.deleted += 1; return { ok: true }; },
    newConversation: async () => { calls.newChat += 1; return { ok: true }; },
    all: async () => [],
    available: async () => [],
    ask: async () => { throw new Error('not used'); },
    cancel: () => {}
  };
  const runner = new ConversationRunner({
    store, registry, emit: () => {},
    submitWorkspace: async () => { throw new Error('not used'); }
  });
  const outcome = await runner.delete('c-extra');
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(outcome.cleaned, []);
  assert.deepEqual(outcome.reset, []);
  assert.equal(calls.deleted, 0, '没有任何网页会话可删');
  assert.equal(calls.newChat, 0, '没有页面需要重置');
});

test('老会话没有 executionConfig 时，poolFor 收到的是默认 web', async () => {
  const conversations = new Map();
  const store = {
    listConversations: () => [...conversations.values()],
    getConversation: id => conversations.get(id) ?? null,
    listMessages: () => [],
    upsertConversation: c => conversations.set(c.conversationId, c),
    appendMessage: () => {},
    deleteConversation: id => conversations.delete(id)
  };
  const base = {
    all: async () => [], available: async () => [],
    ask: async () => { throw new Error('not used'); },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }), cancel: () => {}
  };
  const seen = [];
  const runner = new ConversationRunner({
    store, registry: base, emit: () => {},
    submitWorkspace: async () => { throw new Error('not used'); },
    budgetMs: 40,
    poolFor: config => { seen.push(config); return base; }
  });
  const created = await runner.start({ text: '你好' });
  delete created.executionConfig;
  // 直接走 normalize，模拟从磁盘读出来的老对象。
  assert.deepEqual(normalizeExecutionConfig(created.executionConfig), DEFAULT_EXECUTION_CONFIG);
  await sleep(20);
  assert.equal(seen[0].executionMode, 'web');
});
