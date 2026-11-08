/**
 * 工程空间「网页第二意见」的行为测试（2026-11-08 用户裁决）。
 *
 * 原话：「工程模式模型为第一意见，网页是辅导重大决策用的第二意见。」
 *
 * 要钉住的是三件事，缺一条这个设计就变成了「又在工程空间乱发网页」：
 *
 * 1. 判定——决策类问题才问，事实查询不问（网页看不到文件，只能复述摘录）；
 * 2. 边界——只问一个通道、网页拿到的必须带着第一意见与证据摘录、材料有上限；
 * 3. 链路——问了就两份意见并列（不再做汇总），不问就不发，网页挂了要如实记。
 *
 * Run with: npm run test:second-opinion
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  buildSecondOpinionQuestion,
  classifyDecision,
  planSecondOpinion,
  SECOND_OPINION_MATERIAL_LIMIT,
  secondOpinionExcerpt
} from '../out-test/main/research/second-opinion.js';

const channel = (id, available = true) => ({ agentId: id, label: id.toUpperCase(), available });

// ---------------------------------------------------------------------------
// 纯函数：什么算「重大决策」
// ---------------------------------------------------------------------------

test('读数类问题不算决策：网页看不到文件，问了只会复述摘录', () => {
  const signal = classifyDecision('读取 /Users/yalla/Downloads/_log_details.txt_ 告诉我总共有多少条记录');
  assert.equal(signal.major, false);
  assert.match(signal.reason, /不是决策类问题/);
});

test('定位错误不算决策', () => {
  assert.equal(classifyDecision('这个函数为什么报错，在第几行').major, false);
});

test('「要不要」是要拍板：算决策', () => {
  const signal = classifyDecision('要不要把 session 存到 SQLite');
  assert.equal(signal.major, true);
  assert.deepEqual(signal.signals, ['要不要']);
});

test('两处取舍信号同时出现才算：单独「比较」不算', () => {
  assert.equal(classifyDecision('比较这两个文件的差异').major, false);
  assert.equal(classifyDecision('对比 SQLite 和 DuckDB 在单机应用里的取舍').major, true);
});

test('重构、迁移、删除这类动词单独出现就算决策', () => {
  for (const question of ['把这个模块重构一下', '从 MySQL 迁移到 Postgres', '把旧的 adapters 删除']) {
    assert.equal(classifyDecision(question).major, true, question);
  }
});

test('用户在问题里点名要网页，跳过判定', () => {
  const signal = classifyDecision('帮我看看这个文件有多少行，顺便问问网页');
  assert.equal(signal.major, true);
  assert.match(signal.reason, /点名/);
});

// ---------------------------------------------------------------------------
// 纯函数：要不要问、问谁
// ---------------------------------------------------------------------------

test('关闭时一次都不问，并说明是设置关的', () => {
  const plan = planSecondOpinion({
    mode: 'off',
    question: '要不要迁移到 Postgres',
    hasFirstOpinion: true,
    channels: [channel('chatgpt')]
  });
  assert.equal(plan.ask, false);
  assert.equal(plan.target, null);
  assert.match(plan.reason, /关掉了网页第二意见/);
});

test('自动模式下非决策问题不问，理由写清楚', () => {
  const plan = planSecondOpinion({
    mode: 'auto',
    question: '读取 log.txt 有多少条记录',
    hasFirstOpinion: true,
    channels: [channel('chatgpt')]
  });
  assert.equal(plan.ask, false);
  assert.match(plan.reason, /不需要网页复核/);
});

test('自动模式 + 决策问题：问，且只问一个', () => {
  const plan = planSecondOpinion({
    mode: 'auto',
    question: '要不要把 session 存到 SQLite',
    hasFirstOpinion: true,
    channels: [channel('chatgpt'), channel('gemini')]
  });
  assert.equal(plan.ask, true);
  assert.equal(plan.target.agentId, 'chatgpt');
  assert.match(plan.reason, /网页第二意见/);
});

test('总是模式：事实问题也问，理由说明是设置要求的', () => {
  const plan = planSecondOpinion({
    mode: 'always',
    question: '读取 log.txt 有多少条记录',
    hasFirstOpinion: true,
    channels: [channel('chatgpt')]
  });
  assert.equal(plan.ask, true);
  assert.match(plan.reason, /每个工程问题都问一次网页/);
});

test('没有可用网页通道就不问，理由写明未登录/未就绪', () => {
  const plan = planSecondOpinion({
    mode: 'always',
    question: '要不要迁移到 Postgres',
    hasFirstOpinion: true,
    channels: [channel('chatgpt', false)]
  });
  assert.equal(plan.ask, false);
  assert.match(plan.reason, /没有可用的网页通道/);
});

test('没有第一意见就不发网页：第二意见要有个靶子', () => {
  const plan = planSecondOpinion({
    mode: 'always',
    question: '要不要迁移到 Postgres',
    hasFirstOpinion: false,
    channels: [channel('chatgpt')]
  });
  assert.equal(plan.ask, false);
  assert.match(plan.reason, /没有第一意见/);
});

test('勾选了网页通道就只在那里挑', () => {
  const plan = planSecondOpinion({
    mode: 'always',
    question: '要不要迁移到 Postgres',
    hasFirstOpinion: true,
    channels: [channel('chatgpt'), channel('gemini')],
    selected: ['gemini']
  });
  assert.equal(plan.target.agentId, 'gemini');
});

// ---------------------------------------------------------------------------
// 纯函数：递过去的那条消息
// ---------------------------------------------------------------------------

test('第二意见的问题：用户原话 → 第一意见 → 证据摘录 → 一句要求', () => {
  const question = buildSecondOpinionQuestion({
    question: '要不要把 session 存到 SQLite',
    firstOpinion: '依据 db.ts:12，现在用内存 Map，重启就丢。',
    material: '【工程证据】\n[证据1] db.ts:12'
  });
  assert.ok(question.startsWith('【用户的问题】\n要不要把 session 存到 SQLite'), '用户原话必须在最前面');
  assert.ok(question.includes('【本机模型的意见（第一意见）】'));
  assert.ok(question.includes('依据 db.ts:12'));
  assert.ok(question.includes('【本机读到的工程证据摘录】'));
  assert.ok(question.includes('请给第二意见'));
  assert.ok(!question.includes('你是一位'), '不写角色行');
});

test('证据太长只发前 6000 字，并标明是摘录', () => {
  const material = '证'.repeat(SECOND_OPINION_MATERIAL_LIMIT + 500);
  const excerpt = secondOpinionExcerpt(material);
  assert.ok(excerpt.length < material.length);
  assert.match(excerpt, /以上是摘录/);
  assert.ok(excerpt.startsWith('证'.repeat(100)));
});

test('短材料原样发出，不加摘录标记', () => {
  assert.equal(secondOpinionExcerpt('短证据'), '短证据');
});

// ---------------------------------------------------------------------------
// 链路
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'tf-second-opinion-'));
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

function fakeWebChannel(id, log, options = {}) {
  return {
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: id },
    async health() {
      return { id, label: id, available: options.available ?? true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask(input) {
      log.web.push({ id, question: input.question, stage: input.stage });
      if (options.fail) throw new Error(options.fail);
      return {
        agentId: id,
        channelId: id,
        stage: input.stage,
        text: `${id}：如果只是重启丢数据，加一层 SQLite 就够；但要注意并发写入与迁移成本。`,
        receivedAt: Date.now()
      };
    },
    cancel() {}
  };
}

function fakeModel(id, label) {
  return {
    id,
    label,
    kind: 'local',
    available: true,
    asks: [],
    identity: { id, label, kind: 'provider', role: label },
    async health() {
      return { id, label, available: true };
    },
    async ask(input) {
      this.asks.push(input);
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
    available: async () => channels.filter(item => item.healthAvailable !== false),
    get: id => channels.find(item => item.id === id),
    ask: async (id, input) => {
      const found = channels.find(item => item.id === id);
      if (!found) throw new Error(`no channel ${id}`);
      return found.ask(input);
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
  const webAgents = web.map(id => fakeWebChannel(id, log));
  const base = fakeRegistry(webAgents);
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
      models.map(model => ({ agentId: model.id, label: model.label, kind: 'local', available: true })),
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

function engineeringInput(text, executionConfig = {}) {
  return {
    text,
    workspaceMode: 'engineering',
    workspaceRoot: root,
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local', ...executionConfig }
  };
}

test('决策问题：模型给第一意见，网页拿第二意见，两份并列不再汇总', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt', 'gemini'], models: [model] });

  const started = await runner.start(engineeringInput('要不要把 session 存到 SQLite'));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 1, '第二意见只问一个通道');
  assert.equal(log.web[0].id, 'chatgpt', '取第一个可用通道');

  const sent = log.web[0].question;
  assert.ok(sent.includes('要不要把 session 存到 SQLite'), '网页要看到用户原话');
  assert.ok(sent.includes('【本机模型的意见（第一意见）】'), '网页要拿第一意见做靶子');
  assert.ok(sent.includes('3 条记录'), '第一意见的正文要在里面');
  assert.ok(sent.includes('【本机读到的工程证据摘录】'), '网页要给证据才能判断');

  const messages = runner.messages(started.conversationId);
  const channels = messages.filter(message => message.role === 'channel');
  assert.deepEqual(
    channels.map(message => message.channelId),
    ['ollama:qwen', 'chatgpt'],
    '第一意见在前，第二意见在后'
  );
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('网页第二意见')),
    '要说明这一轮网页为什么参与'
  );
  assert.equal(
    messages.filter(message => message.role === 'synthesis').length,
    0,
    '两份意见并列，不生成第三份规则版综合'
  );
});

test('事实问题：只问模型，网页一次都不发', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(engineeringInput('读取 log.txt 告诉我总共有多少条记录'));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 0, '事实查询不发网页');
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('不需要网页复核')),
    '没问也要说明为什么没问'
  );
});

test('关闭第二意见：决策问题也只问模型', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(
    engineeringInput('要不要把 session 存到 SQLite', { webSecondOpinion: 'off' })
  );
  await settle(runner, started.conversationId);

  assert.equal(log.web.length, 0);
});

test('总是模式：事实问题也问一次网页', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(
    engineeringInput('读取 log.txt 告诉我总共有多少条记录', { webSecondOpinion: 'always' })
  );
  await settle(runner, started.conversationId);

  assert.equal(log.web.length, 1);
});

test('网页第二意见失败：如实记一条失败，不假装拿到了', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const store = fakeStore();
  const log = { web: [], models: [model] };
  const base = fakeRegistry([fakeWebChannel('chatgpt', log, { fail: '页面卡住了' })]);
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
      get: id => pool.get(id) ?? model,
      ask: (id, input) => (id === model.id ? model.ask(input) : pool.ask(id, input)),
      newConversation: async () => ({ ok: true }),
      deleteConversation: async () => ({ ok: true }),
      cancel() {},
      cancelAll() {}
    }),
    executorIdsFor: () => new Set([model.id]),
    modelMembers: async () => [{ agentId: model.id, label: model.label, kind: 'local', available: true }],
    agentSource: id => (id === model.id ? 'local' : undefined),
    budgetMs: 8000
  });

  const started = await runner.start(engineeringInput('要不要把 session 存到 SQLite'));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered', '第一意见还在，这一轮不算失败');
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(
      message => message.role === 'system' && message.text.includes('chatgpt') && message.text.includes('页面卡住了')
    ),
    '失败原因要写进会话'
  );
  assert.ok(
    !messages.some(message => message.role === 'channel' && message.channelId === 'chatgpt'),
    '失败不能留一条空回答'
  );
});
