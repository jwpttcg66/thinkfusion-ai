/**
 * 「决策判定 / 证据摘录 / 混合档网页编排」的行为测试。
 *
 * 2026-11-08 早些时候的裁决是「网页是辅导重大决策用的第二意见」，同一天晚些
 * 被覆盖：「工程默认改成多agent编排，优先本地和远程模型，除非采用混合模式，
 * 才可以进行网页编排」。所以旧的「只问一个通道、事后并列、不再汇总」不复存在，
 * 但两件通用工具留了下来，并换了新的用途：
 *
 * - `classifyDecision` 仍然判定「要不要拍板」，现在给混合档的 `auto` 用；
 * - `secondOpinionExcerpt` 仍然按 6000 字摘录，现在给**并列的网页编排成员**用。
 *
 * 链路部分钉住的是新规则里最容易走偏的边界：
 *
 * 1. 非混合档一个网页都不问，哪怕设置调成 always、问题是重大决策；
 * 2. 混合档 auto 只在决策类加网页，always 每次加，off 不加；
 * 3. 加进来的是所有已开启且可用的网页通道，不是「挑一个」；
 * 4. 网页拿到的是用户原话 + 证据摘录，不带第一意见、不带角色行；
 * 5. 网页挂了如实记失败，不假装拿到了回答。
 *
 * Run with: npm run test:web-orchestration
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  classifyDecision,
  SECOND_OPINION_MATERIAL_LIMIT,
  secondOpinionExcerpt
} from '../out-test/main/research/second-opinion.js';

const FACT = '读取 log.txt 告诉我总共有多少条记录';
const DECISION = '要不要把 session 存到 SQLite';

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
// 纯函数：发给网页编排成员的证据摘录
// ---------------------------------------------------------------------------

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
// 链路：只有混合模式才编排网页
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'tf-web-orch-'));
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
        agentId: id, channelId: id, stage: input.stage,
        text: `${id}：如果只是重启丢数据，加一层 SQLite 就够；但要注意并发写入与迁移成本。`,
        receivedAt: Date.now()
      };
    },
    cancel() {}
  };
}

function fakeModel(id, label) {
  return {
    id, label,
    kind: 'local',
    available: true,
    asks: [],
    identity: { id, label, kind: 'provider', role: label },
    async health() {
      return { id, label, available: true };
    },
    async ask(input) {
      this.asks.push(input);
      if (input.stage === 'challenge') {
        return {
          agentId: id, channelId: id, stage: input.stage,
          text: '【结论】共 3 条记录\n【一致】没有\n【分歧】没有\n【存疑】没有\n【辩题】无',
          receivedAt: Date.now()
        };
      }
      return {
        agentId: id, channelId: id, stage: input.stage,
        text: `${label}：依据 log.txt:1，全文共 3 行，因此 3 条记录。`,
        receivedAt: Date.now()
      };
    },
    cancel() {}
  };
}

function fakeRegistry(channels) {
  const state = { availableCalls: 0 };
  return {
    state,
    registry: {
      all: async () => channels,
      available: async () => {
        state.availableCalls += 1;
        return channels;
      },
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
    }
  };
}

function makeRunner({ web = [], models = [] }) {
  const store = fakeStore();
  const log = { web: [], models };
  const channels = web.map(item =>
    typeof item === 'string' ? fakeWebChannel(item, log) : fakeWebChannel(item.id, log, item.options)
  );
  const { registry, state } = fakeRegistry(channels);
  const runner = new ConversationRunner({
    store,
    registry,
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
  return { runner, log, state };
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

test('混合档 + 自动 + 决策问题：所有网页通道作为并列成员进场，材料是原话 + 证据摘录', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt', 'gemini'], models: [model] });
  // 这一问必须提到「工程」才会真的扫描目录：2026-11-10 起常识/纯选型题
  // 默认不读工程（`needsProjectEvidence`），没有证据可摘不是编排坏了。
  const question = '要不要把工程里的 session 存到 SQLite';

  const started = await runner.start(engineeringInput(question, { executionMode: 'hybrid' }));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 2, '所有已开启且可用的网页通道都进场，不是只挑一个');

  for (const sent of log.web) {
    assert.ok(sent.question.includes(question), '网页要看到用户原话');
    assert.ok(sent.question.startsWith(`【用户的问题】\n${question}`), '用户原话在最前面');
    assert.ok(sent.question.includes('【工程证据'), '网页要给证据才能判断');
    assert.ok(!sent.question.includes('第一意见'), '不是事后复核，没有第一意见');
    assert.ok(!sent.question.includes('请给第二意见'), '不套引导语');
    assert.ok(!sent.question.includes('你是一位'), '不写角色行');
  }

  const messages = runner.messages(started.conversationId);
  assert.deepEqual(
    messages.filter(message => message.role === 'channel').map(message => message.channelId).sort(),
    ['chatgpt', 'gemini', 'ollama:qwen'],
    '模型与网页的回答并列落库'
  );
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('作为编排成员一起进场')),
    '要说明这一轮网页为什么参与'
  );
  assert.ok(
    messages.some(message => message.role === 'synthesis'),
    '编排产物照常汇总，不再让两份意见并列了事'
  );
});

test('混合档 + 自动 + 事实问题：一个网页都不发，理由写清楚', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(engineeringInput(FACT, { executionMode: 'hybrid' }));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 0, '事实查询不发网页');
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('不是决策类问题')),
    '没问也要说明为什么没问'
  );
});

test('非混合档 + 总是 + 重大决策：硬规则优先，仍然一个网页都不问', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log, state } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(
    engineeringInput(DECISION, { executionMode: 'local', webSecondOpinion: 'always' })
  );
  await settle(runner, started.conversationId);

  assert.equal(log.web.length, 0, '只有 executionMode=hybrid 才开放网页编排');
  assert.equal(state.availableCalls, 0, '非混合档连网页可用性都不探测');
});

test('混合档 + 总是：事实问题也编排网页', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(
    engineeringInput(FACT, { executionMode: 'hybrid', webSecondOpinion: 'always' })
  );
  await settle(runner, started.conversationId);

  assert.equal(log.web.length, 1, '设置要求每次都编排网页');
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('设置要求每个工程问题都编排网页'))
  );
});

test('混合档 + 关闭：决策问题也只用本地/云端模型', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt'], models: [model] });

  const started = await runner.start(
    engineeringInput(DECISION, { executionMode: 'hybrid', webSecondOpinion: 'off' })
  );
  await settle(runner, started.conversationId);

  assert.equal(log.web.length, 0);
  assert.equal(model.asks.filter(item => item.stage === 'initial').length, 1, '模型照常被问');
});

test('混合档勾选了网页通道：只在勾选范围里编排', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner, log } = makeRunner({ web: ['chatgpt', 'gemini'], models: [model] });

  const started = await runner.start(
    engineeringInput(DECISION, { executionMode: 'hybrid', selectedWebChannels: ['gemini'] })
  );
  await settle(runner, started.conversationId);

  assert.deepEqual(log.web.map(item => item.id), ['gemini']);
});

test('混合档网页成员失败：如实记一条失败，不假装拿到了', async () => {
  const model = fakeModel('ollama:qwen', 'Ollama Qwen');
  const { runner } = makeRunner({
    web: [{ id: 'chatgpt', options: { fail: '页面卡住了' } }],
    models: [model]
  });

  const started = await runner.start(engineeringInput(DECISION, { executionMode: 'hybrid' }));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered', '模型那一份还在，这一轮不算失败');
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
