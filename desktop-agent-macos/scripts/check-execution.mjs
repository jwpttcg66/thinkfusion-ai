/**
 * Phase E：执行模式、隐私边界、名单过滤、接线。
 *
 * 最该钉住的是 local-only：它必须在「选人」阶段就把网页和云端全部拿掉，
 * 而不是指望后面每一层都记得判断一次。
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
const ids = selection => [...selection.ids].sort();

// ---------------------------------------------------------------------------

test('默认配置是 web / allow-cloud，老会话照这个读', () => {
  assert.deepEqual(DEFAULT_EXECUTION_CONFIG, { executionMode: 'web', fallbackEnabled: false, privacyMode: 'allow-cloud' });
  assert.deepEqual(normalizeExecutionConfig(), DEFAULT_EXECUTION_CONFIG);
  assert.deepEqual(normalizeExecutionConfig(null), DEFAULT_EXECUTION_CONFIG);
  assert.equal(normalizeExecutionConfig({}).executionMode, 'web');
});

test('web 模式与 local-only 互斥：归一成 allow-cloud，但 web 模式保留', () => {
  const config = normalizeExecutionConfig({ executionMode: 'web', privacyMode: 'local-only' });
  assert.equal(config.executionMode, 'web', '不能因为隐私模式就禁用 web');
  assert.equal(config.privacyMode, 'allow-cloud', '网页本来就外发，不能标成 local-only 自欺欺人');
});

test('IPC 传来的非法值一律退回默认，不进 undefined 分支', () => {
  assert.equal(normalizeExecutionConfig({ executionMode: 'nonsense' }).executionMode, 'web');
  assert.equal(normalizeExecutionConfig({ privacyMode: 'nonsense' }).privacyMode, 'allow-cloud');
  const config = normalizeExecutionConfig({ selectedLocalModels: ['ok', 3, null] });
  assert.deepEqual(config.selectedLocalModels, ['ok']);
  assert.equal(config.fallbackEnabled, false);
});

test('四种模式各自包含哪些来源', () => {
  assert.deepEqual(ids(selectParticipants({ executionMode: 'web' }, web, extra)), ['chatgpt', 'kimi']);
  assert.deepEqual(ids(selectParticipants({ executionMode: 'local' }, web, extra)), [local.id]);
  assert.deepEqual(ids(selectParticipants({ executionMode: 'cloud' }, web, extra)), [cloud.id]);
  // 本地模型不是来源：混合模式下它不参与回答，只在汇总阶段被叫到。
  assert.deepEqual(ids(selectParticipants({ executionMode: 'hybrid' }, web, extra)), ['chatgpt', 'openai:gpt-4o-mini', 'kimi'].sort());
  assert.ok(
    selectParticipants({ executionMode: 'hybrid' }, web, extra).blocked.some(item => item.id === 'ollama:qwen2.5:7b'),
    '本地模型要被明确挡在名单外，不是悄悄消失'
  );
});

test('local-only 是硬边界：hybrid 里也只剩本地，网页和云端都被挡下', () => {
  const selection = selectParticipants({ executionMode: 'hybrid', privacyMode: 'local-only' }, web, extra);
  assert.deepEqual(ids(selection), [local.id]);
  assert.equal(selection.blocked.length, 3);
  assert.ok(selection.blocked.every(item => /local-only/.test(item.why)));
});

test('local-only 下即使用户显式选了网页/云端，也不放行', () => {
  const selection = selectParticipants(
    {
      executionMode: 'hybrid',
      privacyMode: 'local-only',
      selectedWebChannels: ['chatgpt'],
      selectedCloudModels: ['gpt-4o-mini'],
      fallbackEnabled: true
    },
    web,
    extra
  );
  assert.deepEqual(ids(selection), [local.id]);
});

test('fallback 只在非隐私模式下退回网页，local-only 下明确报错而不是偷偷外发', () => {
  const withFallback = selectParticipants(
    { executionMode: 'cloud', privacyMode: 'allow-cloud', selectedCloudModels: [], fallbackEnabled: true },
    web,
    extra
  );
  assert.deepEqual(ids(withFallback), ['chatgpt', 'kimi']);
  assert.match(withFallback.reason, /fallback/);

  const localOnly = selectParticipants(
    { executionMode: 'local', privacyMode: 'local-only', selectedLocalModels: [], fallbackEnabled: true },
    web,
    extra
  );
  assert.deepEqual(ids(localOnly), [], '隐私模式下宁可无人可问，也不退回网页');
});

test('按模型选择生效，空数组表示「一个都不选」而不是「没指定」', () => {
  const none = selectParticipants({ executionMode: 'hybrid', selectedLocalModels: [], selectedCloudModels: [] }, web, extra);
  assert.deepEqual(ids(none), ['chatgpt', 'kimi']);
  // 哪怕显式勾了本地模型，混合模式也不会把它当来源提问。
  const one = selectParticipants({ executionMode: 'hybrid', selectedLocalModels: ['qwen2.5:7b'], selectedCloudModels: [] }, web, extra);
  assert.deepEqual(ids(one), ['chatgpt', 'kimi'].sort());
});

test('ExecutionPool：名单外的人连问都不让问', async () => {
  const base = {
    all: async () => web,
    available: async () => web,
    ask: async (id, task) => web.find(a => a.id === id).ask(task),
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
  const pool = new ExecutionPool(base, extra, new Set([local.id]));
  assert.deepEqual((await pool.all()).map(a => a.id), [local.id]);
  assert.deepEqual((await pool.available()).map(a => a.id), [local.id]);
  await assert.rejects(pool.ask('chatgpt', { question: 'x', stage: 'initial' }), /这一轮不选/);
  const answer = await pool.ask(local.id, { question: 'x', stage: 'initial' });
  assert.equal(answer.text, 'local 回答');
  assert.deepEqual(await pool.newConversation(local.id), { ok: true, detail: '本地/云端每次请求本身就是新会话' });
});

test('ProviderBackedSubAgent 把 Provider 的回答转成 MasterAgent 认识的 SubAgentAnswer', async () => {
  const answer = await local.ask({ question: '17 乘 3', stage: 'followup', timeoutMs: 1000 });
  assert.equal(answer.agentId, local.id);
  assert.equal(answer.text, 'local 回答');
  assert.equal(answer.stage, 'followup');
  assert.match(answer.attribution.note, /local:/);
  const status = await local.health();
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
    executionConfig: { executionMode: 'local', privacyMode: 'local-only' }
  });
  assert.equal(conversation.executionConfig.executionMode, 'local');
  assert.equal(conversation.executionConfig.privacyMode, 'local-only');
  await sleep(20);
  assert.equal(seen[0].executionMode, 'local');
  assert.equal(seen[0].privacyMode, 'local-only');
});

test('删除本地模型参与的会话，不提示「手动删除网页里的那份」', async () => {
  // 真机回归抓到的：本地回答完也在 answered 里，但没有 threadUrl。
  // 原来的分支把「没有网页地址」当成「网页里还有一份要手动删」，
  // 让用户去一个不存在的侧栏找记录。
  const conversation = {
    conversationId: 'c-local',
    title: '本地问答',
    channels: ['ollama:qwen2.5:7b'],
    answered: ['ollama:qwen2.5:7b'],
    threads: {},
    status: 'answered',
    createdAt: 1,
    updatedAt: 1
  };
  const store = {
    getConversation: id => (id === 'c-local' ? conversation : null),
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
  const outcome = await runner.delete('c-local');
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
