/**
 * 工程空间「模型读证据回答」的行为测试（2026-11-08 用户裁决）。
 *
 * 这条裁决是：「工程模式，不需要优先问网页，读取本地应该是模型所做的」。
 * 所以有两半必须逐条钉住：
 *
 * 1. 选人——本地优先，云端主导才用云端，点名就用点名的，全不可用才退回网页；
 * 2. 链路——工程空间一个网页都不问，模型收到的就是「用户原话 + 真实证据」；
 *    知识空间一个字节都没变；没有模型时如实退回网页并写明原因。
 *
 * Run with: npm run test:engineering-round
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  buildEngineeringAnswerQuestion,
  engineeringAnswerSystem,
  planEngineeringAnswer
} from '../out-test/main/research/engineering-round.js';

// ---------------------------------------------------------------------------
// 纯函数：谁回答
// ---------------------------------------------------------------------------

const local = (id = 'ollama:qwen', label = 'Ollama Qwen') => ({
  agentId: id,
  label,
  kind: 'local',
  available: true
});
const cloud = (id = 'openai:gpt', label = 'GPT') => ({
  agentId: id,
  label,
  kind: 'cloud',
  available: true
});

test('本地可用就本地回答，哪怕界面上选的是网页主导', () => {
  const plan = planEngineeringAnswer({ mode: 'web', members: [local(), cloud()] });
  assert.deepEqual(plan.targets.map(item => item.agentId), ['ollama:qwen']);
  assert.equal(plan.fallback, false);
  assert.match(plan.reason, /本地模型读工程证据/);
});

test('没有本地模型时改用云端，并说明为什么', () => {
  const plan = planEngineeringAnswer({ mode: 'local', members: [cloud()] });
  assert.deepEqual(plan.targets.map(item => item.agentId), ['openai:gpt']);
  assert.equal(plan.fallback, false);
  assert.match(plan.reason, /没有可用本地模型/);
});

test('云端主导且云端可用时才用云端', () => {
  const plan = planEngineeringAnswer({ mode: 'cloud', members: [local(), cloud()] });
  assert.deepEqual(plan.targets.map(item => item.agentId), ['openai:gpt']);
  assert.match(plan.reason, /云端主导/);
});

test('用户点名了成员就只问它', () => {
  const plan = planEngineeringAnswer({
    mode: 'hybrid',
    leadAgentId: 'openai:gpt',
    members: [local(), cloud()]
  });
  assert.deepEqual(plan.targets.map(item => item.agentId), ['openai:gpt']);
  assert.match(plan.reason, /你指定了/);
});

test('多个本地模型只问第一个：同一份证据问两遍只是把等待翻倍', () => {
  const plan = planEngineeringAnswer({
    mode: 'local',
    members: [local('ollama:a', 'A'), local('ollama:b', 'B')]
  });
  assert.deepEqual(plan.targets.map(item => item.agentId), ['ollama:a']);
});

test('一个可用模型都没有时退回网页，原因写清楚', () => {
  const plan = planEngineeringAnswer({
    mode: 'local',
    members: [{ ...local(), available: false }, { ...cloud(), available: false }]
  });
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.fallback, true);
  assert.match(plan.reason, /没有可用的本地\/云端模型/);
});

test('发给模型的问题：用户原话在前，证据在后，没有角色开场', () => {
  const question = buildEngineeringAnswerQuestion('读取 log.txt 有多少条记录', '【工程证据：以下由本机真实读取获得】\n[证据1] log.txt:1');
  assert.ok(question.startsWith('【用户的问题】\n读取 log.txt 有多少条记录'));
  assert.ok(question.includes('【工程证据'));
  assert.ok(!question.includes('你是一位'));
  assert.ok(!question.includes('研究伙伴'));
});

test('system 只对模型说两条：依据证据、写明路径行号、不足就说无法确定', () => {
  const system = engineeringAnswerSystem().join('\n');
  assert.match(system, /路径:行号/);
  assert.match(system, /无法确定/);
});

// ---------------------------------------------------------------------------
// 链路：工程空间不问网页
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'tf-eng-round-'));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'log.txt'), 'record-1\nrecord-2\nrecord-3\n');

function fakeStore() {
  const conversations = new Map();
  const messages = [];
  return {
    listConversations: () => [...conversations.values()],
    getConversation: id => conversations.get(id) ?? null,
    listMessages: id => messages.filter(message => message.conversationId === id),
    upsertConversation: conversation => conversations.set(conversation.conversationId, conversation),
    appendMessage: message => messages.push(message),
    deleteConversation: () => {}
  };
}

function fakeWebChannel(id, log) {
  return {
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: id },
    async health() {
      return { id, label: id, available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask(input) {
      log.web.push({ id, question: input.question, stage: input.stage });
      return { agentId: id, channelId: id, stage: input.stage, text: `${id} 说：读不到本地文件，请上传。`, receivedAt: Date.now() };
    },
    cancel() {}
  };
}

function fakeModel(id, label, kind, options = {}) {
  return {
    id,
    label,
    kind,
    available: options.available ?? true,
    asks: [],
    identity: { id, label, kind: 'provider', role: label },
    async health() {
      return { id, label, available: options.available ?? true, detail: options.detail };
    },
    async ask(input) {
      this.asks.push(input);
      if (options.fail) throw new Error(options.fail);
      return {
        agentId: id,
        channelId: id,
        stage: input.stage,
        text: `${label}：依据 log.txt:1，全文共 3 行，因此 3 条记录。`,
        receivedAt: Date.now()
      };
    },
    cancel() {}
  };
}

function fakeRegistry(channels) {
  return {
    all: async () => channels,
    available: async () => channels,
    get: id => channels.find(channel => channel.id === id),
    ask: async (id, input) => {
      const channel = channels.find(item => item.id === id);
      if (!channel) throw new Error(`no channel ${id}`);
      return channel.ask(input);
    },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel() {},
    cancelAll() {}
  };
}

function makeRunner({ web = [], models = [] }) {
  const store = fakeStore();
  const log = { web: [], models };
  const base = fakeRegistry(web.map(id => fakeWebChannel(id, log)));
  const runner = new ConversationRunner({
    store,
    registry: base,
    emit: () => {},
    submitWorkspace: async () => {
      throw new Error('unexpected workspace hand-off');
    },
    poolFor: (_config, pool) => ({
      all: () => pool.all(),
      available: () => pool.available(),
      get: id => pool.get(id) ?? models.find(model => model.id === id),
      ask: (id, input) => {
        const model = models.find(item => item.id === id);
        return model ? model.ask(input) : pool.ask(id, input);
      },
      newConversation: async () => ({ ok: true }),
      deleteConversation: async () => ({ ok: true }),
      cancel() {},
      cancelAll() {}
    }),
    executorIdsFor: () => new Set(models.map(model => model.id)),
    modelMembers: async () =>
      models.map(model => ({
        agentId: model.id,
        label: model.label,
        kind: model.kind,
        available: model.available
      })),
    agentSource: id => models.find(model => model.id === id)?.kind,
    budgetMs: 8000
  });
  return { runner, log };
}

async function settle(runner, conversationId, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conversation = runner.get(conversationId);
    if (conversation && ['answered', 'failed', 'cancelled'].includes(conversation.status)) return conversation;
    if (Date.now() > deadline) throw new Error(`conversation did not settle: ${conversation?.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function engineeringInput(text) {
  return {
    text,
    workspaceMode: 'engineering',
    workspaceRoot: root,
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local' }
  };
}

test('工程空间：一个网页都不问，模型拿到的是用户原话 + 真实证据', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen', 'local');
  const { runner, log } = makeRunner({ web: ['chatgpt', 'gemini'], models: [model] });

  const started = await runner.start(engineeringInput('读取 log.txt 告诉我总共有多少条记录'));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 0, '工程空间不该问网页通道');

  const ask = model.asks.find(item => item.stage === 'initial');
  assert.ok(ask, '模型要被问第一手问题');
  assert.ok(ask.question.includes('【用户的问题】'));
  assert.ok(ask.question.includes('读取 log.txt 告诉我总共有多少条记录'));
  assert.ok(ask.question.includes('【工程证据'), '证据必须随问题一起给模型');
  assert.ok(ask.question.includes('log.txt'), '点名的文件要真的在证据里');
  assert.ok(ask.system?.join('\n').includes('路径:行号'));

  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'channel' && message.channelId === 'ollama:qwen'),
    '模型的回答要以回答消息落库'
  );
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('本地模型读工程证据')),
    '要写清楚这一轮谁回答、没发网页'
  );
});

test('知识空间完全不变：仍然问所有网页通道，模型不参与第一手回答', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen', 'local');
  const { runner, log } = makeRunner({ web: ['chatgpt', 'gemini'], models: [model] });

  const started = await runner.start({ text: '帮我看看 Redis 连接数过高的原因' });
  await settle(runner, started.conversationId);

  assert.ok(log.web.length >= 2, '知识空间照旧问网页');
  assert.equal(
    model.asks.filter(item => item.stage === 'initial').length,
    0,
    '知识空间的第一手回答不交给本地模型'
  );
});

test('工程空间没有可用模型：退回网页，并写明网页读不到本地文件', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen', 'local', { available: false });
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(engineeringInput('读取 log.txt 有多少条记录'));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.ok(log.web.length >= 1, '没有模型时退回网页');
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('退回网页通道')),
    '退回网页要写明原因'
  );
});

test('工程空间模型报错：不假装答过，退回网页并写明是谁没成', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen', 'local', { fail: '连不上 http://127.0.0.1:11434' });
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(engineeringInput('读取 log.txt 有多少条记录'));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.ok(log.web.length >= 1);
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('本机模型没有给出回答')),
    '模型失败要如实说，而不是当成「没有证据」'
  );
});
