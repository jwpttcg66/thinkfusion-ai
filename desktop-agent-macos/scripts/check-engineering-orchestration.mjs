/**
 * 工程空间「多 agent 编排」的行为测试（2026-11-08 用户裁决）。
 *
 * 原话：「工程默认改成多agent编排，优先本地和远程模型，除非采用混合模式，
 * 才可以进行网页编排。」
 *
 * 这条覆盖了同一天更早的两条裁决——「只问一个模型的第一意见」、以及
 * 「决策类问题追加一个网页第二意见、两份并列不汇总」。要钉住的是：
 *
 * 1. 选人——所有可用的本地 + 云端模型**全部**并行读同一份证据，本地优先；
 *    local / web / cloud 三档在工程空间不再决定谁读得动文件；
 * 2. 网页——非混合档一个都不问（连探活都不做），只有 hybrid 才把**所有已开启
 *    且可用**的网页通道作为并列成员编进来，网页永不主导、也不进交锋名单；
 * 3. 执行——恢复「汇总 → 辩题 → 交锋 → 最终意见」，哪怕只有一个模型也照常开；
 *    名单直接来自编排计划，不走知识空间的归属收敛；
 * 4. 边界——用户原话原样、知识空间零改动、网页挂了如实记失败。
 *
 * Run with: npm run test:engineering-orchestration
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  buildWebOrchestrationQuestion,
  planEngineeringOrchestration
} from '../out-test/main/research/engineering-orchestration.js';
import { SECOND_OPINION_MATERIAL_LIMIT } from '../out-test/main/research/second-opinion.js';

const FACT = '读取 log.txt 告诉我总共有多少条记录';
const DECISION = '要不要把 session 存到 SQLite';

const local = (id = 'ollama:qwen', label = 'Ollama Qwen', available = true) => ({
  agentId: id, label, kind: 'local', available
});
const cloud = (id = 'openai:gpt', label = 'GPT', available = true) => ({
  agentId: id, label, kind: 'cloud', available
});
const web = (id, label = id.toUpperCase(), available = true) => ({ agentId: id, label, available });

function plan(overrides = {}) {
  return planEngineeringOrchestration({
    mode: 'local',
    question: FACT,
    models: [local(), cloud()],
    webChannels: [web('chatgpt'), web('gemini')],
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// 纯函数：这一轮谁进场、谁来汇总、谁去交锋
// ---------------------------------------------------------------------------

test('默认非混合档：本地 + 云端模型全部进场，本地在前，网页一个都不问', () => {
  const p = plan();
  assert.deepEqual(p.members.map(item => item.agentId), ['ollama:qwen', 'openai:gpt']);
  assert.deepEqual(p.debaters, ['ollama:qwen', 'openai:gpt']);
  assert.equal(p.webIncluded, false);
  assert.equal(p.fallback, false);
  assert.equal(p.lead.agentId, 'ollama:qwen');
  assert.match(p.reason, /工程空间多 agent 编排/);
  assert.match(p.reason, /网页编排只在混合模式开放/);
  assert.match(p.reason, /由 Ollama Qwen 汇总/);
});

test('网页主导 / 云端主导档在工程空间也不按归属挑人：照样是全部模型', () => {
  for (const mode of ['web', 'local', 'cloud']) {
    const p = plan({ mode });
    assert.deepEqual(p.members.map(item => item.agentId), ['ollama:qwen', 'openai:gpt'], mode);
    assert.equal(p.webIncluded, false, mode);
  }
});

test('主导人本地优先；点名云端模型就用它', () => {
  assert.equal(plan().lead.agentId, 'ollama:qwen');
  const p = plan({ leadAgentId: 'openai:gpt' });
  assert.equal(p.lead.agentId, 'openai:gpt');
  assert.deepEqual(p.debaters, ['ollama:qwen', 'openai:gpt'], '点名主导不改变交锋名单');
});

test('点名网页通道不能主导：它读不到本机文件，执行阶段也找不到它', () => {
  const p = plan({ mode: 'hybrid', question: DECISION, leadAgentId: 'chatgpt' });
  assert.equal(p.lead.kind, 'local');
  assert.equal(p.lead.agentId, 'ollama:qwen');
  assert.match(p.reason, /点名的网页通道不能主导工程汇总/);
});

test('只有一个可用模型也照常编排，交锋名单不为空（允许自辩）', () => {
  const p = plan({ models: [local()] });
  assert.equal(p.members.length, 1);
  assert.deepEqual(p.debaters, ['ollama:qwen']);
  assert.equal(p.fallback, false);
  assert.equal(p.lead.agentId, 'ollama:qwen');
});

test('一个可用模型都没有才退回网页，原因写清楚', () => {
  const p = plan({
    models: [local('ollama:a', 'A', false), cloud('openai:b', 'B', false)]
  });
  assert.equal(p.fallback, true);
  assert.deepEqual(p.members, []);
  assert.deepEqual(p.debaters, []);
  assert.equal(p.webIncluded, false);
  assert.match(p.reason, /没有可用的本地\/云端模型/);
});

test('hybrid + auto + 决策问题：所有已开启网页通道并列进场，且不进交锋名单', () => {
  const p = plan({ mode: 'hybrid', question: DECISION });
  assert.deepEqual(p.members.map(item => item.agentId), [
    'ollama:qwen', 'openai:gpt', 'chatgpt', 'gemini'
  ]);
  assert.equal(p.webIncluded, true);
  assert.deepEqual(p.debaters, ['ollama:qwen', 'openai:gpt']);
  assert.equal(p.lead.agentId, 'ollama:qwen', '网页成员永不主导');
  assert.match(p.reason, /2 个网页通道作为编排成员一起进场/);
});

test('hybrid + auto + 事实问题：网页不加入编排，理由写明不是决策类', () => {
  const p = plan({ mode: 'hybrid', question: FACT });
  assert.equal(p.webIncluded, false);
  assert.deepEqual(p.members.map(item => item.agentId), ['ollama:qwen', 'openai:gpt']);
  assert.match(p.reason, /不是决策类问题/);
});

test('hybrid + always：事实问题也编排网页，理由写明是设置要求的', () => {
  const p = plan({ mode: 'hybrid', question: FACT, webSecondOpinion: 'always' });
  assert.equal(p.webIncluded, true);
  assert.match(p.reason, /设置要求每个工程问题都编排网页/);
});

test('hybrid + off：决策问题也不编排网页', () => {
  const p = plan({ mode: 'hybrid', question: DECISION, webSecondOpinion: 'off' });
  assert.equal(p.webIncluded, false);
  assert.match(p.reason, /设置里关掉了网页编排/);
});

test('非混合档即使 always 也不问网页：只有混合模式才开放网页编排', () => {
  for (const mode of ['web', 'local', 'cloud']) {
    const p = plan({ mode, question: DECISION, webSecondOpinion: 'always' });
    assert.equal(p.webIncluded, false, mode);
    assert.equal(p.members.some(item => item.kind === 'web'), false, mode);
    assert.match(p.reason, /网页编排只在混合模式开放/, mode);
  }
});

test('混合档但没有可用网页通道：如实跳过，不假装编排了', () => {
  const p = plan({
    mode: 'hybrid',
    question: DECISION,
    webChannels: [web('chatgpt', 'CHATGPT', false), web('gemini', 'GEMINI', false)]
  });
  assert.equal(p.webIncluded, false);
  assert.match(p.reason, /没有可用的网页通道/);
});

test('混合档勾选了网页通道就只编那几个', () => {
  const p = plan({ mode: 'hybrid', question: DECISION, selectedWebChannels: ['gemini'] });
  assert.deepEqual(p.members.map(item => item.agentId), [
    'ollama:qwen', 'openai:gpt', 'gemini'
  ]);
  assert.equal(p.webIncluded, true);
});

// ---------------------------------------------------------------------------
// 纯函数：网页编排成员拿到的那条消息
// ---------------------------------------------------------------------------

test('网页成员的问题：用户原话在前 + 工程证据，没有角色行、也没有「第二意见」话术', () => {
  const question = buildWebOrchestrationQuestion(DECISION, '【工程证据】\n[证据1] log.txt:1');
  assert.ok(question.startsWith(`【用户的问题】\n${DECISION}`), '用户原话必须在最前面');
  assert.ok(question.includes('【工程证据】'));
  assert.ok(!question.includes('你是一位'), '不写角色行');
  assert.ok(!question.includes('研究伙伴'));
  assert.ok(!question.includes('第一意见'), '网页是并列成员，不是事后复核');
  assert.ok(!question.includes('第二意见'));
  assert.ok(!question.includes('请给第二意见'));
});

test('证据太长只发前 6000 字，并标明是摘录', () => {
  const material = '证'.repeat(SECOND_OPINION_MATERIAL_LIMIT + 500);
  const question = buildWebOrchestrationQuestion(FACT, material);
  assert.ok(question.length < material.length);
  assert.match(question, /以上是摘录/);
  assert.ok(question.startsWith(`【用户的问题】\n${FACT}`));
});

// ---------------------------------------------------------------------------
// 链路
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'tf-eng-orch-'));
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
      log.web.push({ id, question: input.question, stage: input.stage, system: input.system });
      if (options.fail) throw new Error(options.fail);
      return {
        agentId: id, channelId: id, stage: input.stage,
        text: `${id}：从摘录看，先别急着加 SQLite，要考虑迁移成本。`,
        receivedAt: Date.now()
      };
    },
    cancel() {}
  };
}

function fakeModel(id, label, kind, options = {}) {
  return {
    id, label, kind,
    available: options.available ?? true,
    asks: [],
    challengeCount: 0,
    identity: { id, label, kind: 'provider', role: label },
    async health() {
      return { id, label, available: options.available ?? true };
    },
    async ask(input) {
      this.asks.push(input);
      // 真机回归用：本地模型共用单名额推理闸门，两个同时进来就是 bug。
      if (options.concurrency && input.stage === 'initial') {
        options.concurrency.active += 1;
        options.concurrency.max = Math.max(options.concurrency.max, options.concurrency.active);
        try {
          await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 30));
        } finally {
          options.concurrency.active -= 1;
        }
      }
      if (input.stage === 'challenge') {
        this.challengeCount += 1;
        const text = options.challengeReply
          ? options.challengeReply(this.challengeCount, input)
          : '【结论】依据 log.txt:1，全文共 3 行\n【一致】没有\n【分歧】没有\n【存疑】没有\n【辩题】无';
        return { agentId: id, channelId: id, stage: input.stage, text, receivedAt: Date.now() };
      }
      if (options.failInitial) throw new Error(options.failInitial);
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
        const channel = channels.find(item => item.id === id);
        if (!channel) throw new Error(`no channel ${id}`);
        return channel.ask(input);
      },
      newConversation: async () => ({ ok: true }),
      deleteConversation: async () => ({ ok: true }),
      cancel() {},
      cancelAll() {}
    }
  };
}

function makeRunner({ web: webChannels = [], models = [], hooks = {} } = {}) {
  const store = fakeStore();
  const log = { web: [] };
  const channels = webChannels.map(item =>
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
      models.map(model => ({
        agentId: model.id, label: model.label, kind: model.kind, available: model.available
      })),
    agentSource: id => models.find(model => model.id === id)?.kind,
    fusionEnabled: hooks.fusionEnabled ?? false,
    runDebate: hooks.runDebate,
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

test('非混合档：所有模型都进场读证据，网页零调用、连探活都不做', async () => {
  const a = fakeModel('ollama:a', 'A', 'local');
  const b = fakeModel('ollama:b', 'B', 'local');
  const c = fakeModel('openai:c', 'C', 'cloud');
  const { runner, log, state } = makeRunner({ web: ['chatgpt', 'gemini'], models: [a, b, c] });

  const started = await runner.start(engineeringInput(FACT));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 0, '工程空间默认一个网页都不问');
  assert.equal(state.availableCalls, 0, '非混合档连网页探活都不做');

  for (const model of [a, b, c]) {
    const ask = model.asks.find(item => item.stage === 'initial');
    assert.ok(ask, `${model.label} 要拿到第一手问题`);
    assert.ok(ask.question.startsWith(`【用户的问题】\n${FACT}`), '用户原话原样在最前面');
    assert.ok(ask.question.includes('【工程证据'), '真实证据随问题一起给模型');
    assert.ok(ask.question.includes('log.txt'), '点名的文件要真的在证据里');
    assert.ok(ask.system?.join('\n').includes('路径:行号'), '证据纪律只进模型 system');
    assert.ok(!ask.question.includes('你是一位') && !ask.question.includes('研究伙伴'), '不套角色行');
  }

  const messages = runner.messages(started.conversationId);
  assert.equal(messages.filter(message => message.role === 'channel').length, 3, '三份编排成员的回答都落库');
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('工程空间多 agent 编排')),
    '要写清楚这一轮谁回答、为什么没发网页'
  );
});

test('本地模型逐个问，不抢同一个推理闸门；云端模型照样进场', async () => {
  // 真机 2026-11-08：两个 Ollama 模型同时发，第二个在 LocalAdmission 的
  // 30 秒排队上限里超时，编排只剩一份回答。回归要钉住「不重叠」而不是
  // 「都问了」——旧代码也「都问了」，只是把第二个问丢了。
  const gate = { active: 0, max: 0 };
  const a = fakeModel('ollama:a', 'A', 'local', { concurrency: gate, delayMs: 40 });
  const b = fakeModel('ollama:b', 'B', 'local', { concurrency: gate, delayMs: 40 });
  const c = fakeModel('openai:c', 'C', 'cloud');
  const { runner } = makeRunner({ models: [a, b, c] });

  const started = await runner.start(engineeringInput(FACT));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(gate.max, 1, '同一时刻只能有一个本地生成在飞');
  for (const model of [a, b, c]) {
    assert.equal(
      model.asks.filter(item => item.stage === 'initial').length,
      1,
      `${model.label} 要各自拿到一份第一手问题`
    );
  }
  assert.equal(
    runner.messages(started.conversationId).filter(message => message.role === 'channel').length,
    3,
    '三位成员的回答都要落库，不能因为排队丢一份'
  );
});

test('知识空间零改动：仍然问所有网页通道，模型不参与第一手回答', async () => {
  const a = fakeModel('ollama:a', 'A', 'local');
  const { runner, log } = makeRunner({ web: ['chatgpt', 'gemini'], models: [a] });

  const started = await runner.start({ text: '帮我看看 Redis 连接数过高的原因' });
  await settle(runner, started.conversationId);

  assert.ok(log.web.length >= 2, '知识空间照旧问所有已开启网页通道');
  assert.equal(
    a.asks.filter(item => item.stage === 'initial').length,
    0,
    '知识空间的第一手回答不交给本地模型'
  );
});

test('只有一个可用模型也执行汇总，不因「不足两位辩手」跳过执行阶段', async () => {
  const a = fakeModel('ollama:qwen', 'Qwen', 'local', {
    challengeReply: () => '【结论】共 3 条记录\n【一致】没有\n【分歧】没有\n【存疑】没有\n【辩题】无'
  });
  const { runner } = makeRunner({ models: [a] });

  const started = await runner.start(engineeringInput(FACT));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(a.challengeCount, 1, '一个成员也要主导人写汇总（允许自辩）');
  const synthesis = runner.messages(started.conversationId).find(message => message.role === 'synthesis')?.synthesis;
  assert.ok(synthesis, '没有融合引擎也要有综合卡容器，主导人的汇总不能丢');
  assert.match(synthesis.recommendation, /共 3 条记录/);
  assert.equal(synthesis.leadSummary, true);
});

test('编排恢复汇总 → 辩题 → 交锋 → 最终意见，且交锋名单不被归属收敛', async () => {
  const summary = [
    '【结论】两份意见不一致',
    '【一致】都读到 log.txt:1 共 3 行',
    '【分歧】一方认为该存 SQLite、另一方认为不必',
    '【存疑】没有',
    '【辩题】到底要不要把 session 存到 SQLite？'
  ].join('\n');
  const verdict = '【最终意见】按 log.txt:1 的证据，先保留现有实现。';
  const a = fakeModel('ollama:a', 'A', 'local', {
    challengeReply: (count) => (count === 1 ? summary : verdict)
  });
  const b = fakeModel('ollama:b', 'B', 'local');
  const c = fakeModel('openai:c', 'C', 'cloud');
  const debateInputs = [];
  const { runner, log } = makeRunner({
    models: [a, b, c],
    hooks: {
      fusionEnabled: true,
      runDebate: async input => {
        debateInputs.push(input);
        return {
          debateId: 'debate-orch-1',
          status: 'completed',
          rounds: [{ index: 0, messages: [{ author: 'A', kind: 'position', text: '该存' }] }]
        };
      }
    }
  });

  // 故意选「云端主导」：知识空间会按归属把本地模型剔掉，工程编排不能。
  const started = await runner.start(engineeringInput(DECISION, { executionMode: 'cloud' }));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.web.length, 0, '云端主导档也不是混合，不问网页');
  assert.equal(debateInputs.length, 1, '主导人列出辩题后要真的开一场交锋');
  assert.deepEqual(debateInputs[0].topics, ['到底要不要把 session 存到 SQLite？']);
  assert.deepEqual(
    debateInputs[0].debaters,
    ['ollama:a', 'ollama:b', 'openai:c'],
    '工程编排把本地 + 云端模型一起交锋，不按 executionMode 收敛成一类'
  );
  assert.equal(debateInputs[0].lead.agentId, 'ollama:a', '本地模型主导');
  assert.equal(debateInputs[0].mode, 'cloud');
  assert.match(debateInputs[0].orchestration.reason, /工程空间多 agent 编排/);
  assert.equal(a.challengeCount, 2, '主导人先汇总、再读辩论记录给最终意见');

  const synthesis = runner.messages(started.conversationId).find(message => message.role === 'synthesis')?.synthesis;
  assert.equal(synthesis?.recommendation, summary, '辩前汇总单独保留');
  assert.equal(synthesis?.finalOpinion, verdict, '辩后最终意见不被汇总顶掉');
  assert.equal(synthesis?.fusion?.backend, 'local-model');
  assert.equal(synthesis?.fusion?.leadAgentId, 'ollama:a');
  assert.equal(synthesis?.fusion?.debateId, 'debate-orch-1');
});

test('混合档：所有网页通道作为并列成员进场，回答落库且不进交锋名单', async () => {
  const a = fakeModel('ollama:a', 'A', 'local');
  const debateInputs = [];
  const { runner, log, state } = makeRunner({
    web: ['chatgpt', 'gemini'],
    models: [a],
    hooks: {
      runDebate: async input => {
        debateInputs.push(input);
        return { debateId: 'd', status: 'completed', rounds: [] };
      }
    }
  });

  const started = await runner.start(engineeringInput(DECISION, { executionMode: 'hybrid' }));
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(state.availableCalls, 1, '只有混合档才探测网页可用性');
  assert.equal(log.web.length, 2, '所有已开启且可用的网页通道都作为成员，不是只挑一个');
  for (const item of log.web) {
    assert.ok(item.question.startsWith(`【用户的问题】\n${DECISION}`), '网页拿到的也是用户原话在前');
    assert.ok(item.question.includes('【工程证据'), '网页要给证据摘录才能判断');
    assert.ok(!item.question.includes('第一意见') && !item.question.includes('第二意见'));
    assert.ok(!item.question.includes('你是一位'), '网页消息不套角色行');
    assert.equal(item.system, undefined, '网页成员不发 system');
  }

  const messages = runner.messages(started.conversationId);
  assert.deepEqual(
    messages.filter(message => message.role === 'channel').map(message => message.channelId).sort(),
    ['chatgpt', 'gemini', 'ollama:a'],
    '网页与模型的回答并列落库'
  );
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('作为编排成员一起进场')),
    '要说明这一轮网页为什么参与'
  );
  for (const input of debateInputs) {
    assert.deepEqual(input.debaters, ['ollama:a'], '网页成员不进多轮交锋名单');
  }
});

test('混合档网页成员失败：如实记一条失败，不假装拿到了回答', async () => {
  const a = fakeModel('ollama:a', 'A', 'local');
  const { runner } = makeRunner({
    web: [{ id: 'chatgpt', options: { fail: '页面卡住了' } }],
    models: [a]
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
