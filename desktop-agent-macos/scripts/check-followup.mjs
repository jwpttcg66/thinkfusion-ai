/**
 * P6 多轮自主研究的行为测试。
 *
 * 两半：
 *
 * 1. 纯函数——缺口怎么读出来、什么时候不该再问、拼出去的问题长什么样。
 *    这几条决定了「会不会在用户看不见的地方多花一次生成」，所以逐条断言。
 * 2. 会话链路——用脚本化通道跑一遍：单轮时一个字节都不多发；开了追加研究
 *    之后，缺口会被原样问回所有网页通道，汇总会被更新成第二版；缺口重复、
 *    用户停手、汇总更新失败都就地停下并写明原因。
 *
 * Run with: npm run test:followup
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  buildFollowUpQuestion,
  buildFollowUpSummaryQuestion,
  decideFollowUp,
  followUpBudget,
  followUpKey,
  parseFollowUps
} from '../out-test/main/research/follow-up.js';
import { normalizeExecutionConfig } from '../out-test/shared/conversation.js';
import { leadSummarySystem, buildLeadSummaryQuestion } from '../out-test/main/synthesis/lead-stage.js';

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('缺口只从【待补】里读，五段之外的文字不当成缺口', () => {
  const summary = [
    '【结论】连接池该开。',
    '【一致】两处都说要开。',
    '【分歧】没有。',
    '【存疑】观点B没给数据。',
    '【辩题】无',
    '【待补】',
    '1. 生产环境的连接上限具体是多少？',
    '2. 这个上限是数据库侧还是应用侧设的？'
  ].join('\n');
  assert.deepEqual(parseFollowUps(summary), [
    '生产环境的连接上限具体是多少？',
    '这个上限是数据库侧还是应用侧设的？'
  ]);
});

test('「无」「没有」「无需补充」都表示不补', () => {
  for (const value of ['无', '没有', '无需补充', 'None', '无。']) {
    const summary = `【结论】可以。\n【待补】${value}`;
    assert.deepEqual(parseFollowUps(summary), [], `expected empty for ${value}`);
  }
});

test('没有【待补】这一段就不补——不按关键词自己猜', () => {
  const summary = '【结论】可以。\n【一致】都说可以。\n【分歧】没有。\n【存疑】无。\n【辩题】无';
  assert.deepEqual(parseFollowUps(summary), []);
});

test('站点粘在段末的「需要我继续查吗」不算缺口', () => {
  const summary = '【待补】无需要我继续查吗？';
  assert.deepEqual(parseFollowUps(summary), []);
});

test('多条缺口挤在同一行也能拆开，且最多取三条', () => {
  const summary = '【待补】1. 具体数字是多少？2. 版本是哪个？3. 出处在哪里？4. 第四条不该被问';
  const items = parseFollowUps(summary);
  assert.equal(items.length, 3);
  assert.equal(items[0], '具体数字是多少？');
});

test('预算默认 0，且被夹在 0–3', () => {
  assert.equal(followUpBudget(undefined), 0);
  assert.equal(followUpBudget(normalizeExecutionConfig({})), 0);
  assert.equal(followUpBudget(normalizeExecutionConfig({ followUpRounds: 2 })), 2);
  assert.equal(followUpBudget(normalizeExecutionConfig({ followUpRounds: 9 })), 3);
  assert.equal(followUpBudget(normalizeExecutionConfig({ followUpRounds: -1 })), 0);
  // 字符串也收（界面上的 select 值可能是字符串）
  assert.equal(followUpBudget(normalizeExecutionConfig({ followUpRounds: '2' })), 2);
});

test('该不该再问：停的条件都优先于走', () => {
  const items = ['生产环境的连接上限是多少？'];
  assert.equal(decideFollowUp({ round: 1, budget: 2, items, asked: new Set(), cancelled: false }).go, true);
  assert.equal(decideFollowUp({ round: 1, budget: 2, items, asked: new Set(), cancelled: true }).go, false);
  assert.equal(decideFollowUp({ round: 1, budget: 0, items, asked: new Set(), cancelled: false }).go, false);
  assert.equal(decideFollowUp({ round: 3, budget: 2, items, asked: new Set(), cancelled: false }).go, false);
  assert.equal(decideFollowUp({ round: 1, budget: 2, items: [], asked: new Set(), cancelled: false }).go, false);
  // 已经问过同一句（忽略标点与空白）
  assert.equal(
    decideFollowUp({
      round: 2,
      budget: 3,
      items,
      asked: new Set([followUpKey('生产环境的连接上限是多少')]),
      cancelled: false
    }).go,
    false
  );
});

test('发出去的是普通问题：原问题做锚点、缺口逐条列出、没有角色话术', () => {
  const question = buildFollowUpQuestion('Redis 连接数为什么这么高', ['生产环境的连接上限是多少？'], 1);
  assert.ok(question.includes('Redis 连接数为什么这么高'));
  assert.ok(question.includes('1. 生产环境的连接上限是多少？'));
  // 曾经那套「你是我在 ThinkFusion 里的研究伙伴」不能再回来
  assert.ok(!/研究伙伴|你是|请以|JSON/i.test(question), question);
  assert.ok(!question.includes('desktop-agent/v1'));
});

test('第二轮的措辞是「补充之后仍未落实」，不假装还是第一次问', () => {
  const question = buildFollowUpQuestion('原始问题', ['还缺什么？'], 2);
  assert.ok(question.includes('补充之后'), question);
});

test('更新汇总的问句里有上一版汇总与新回答，并要求保持同一套五段', () => {
  const prompt = buildFollowUpSummaryQuestion({
    question: '原问题',
    previousSummary: '【结论】旧结论。',
    round: 1,
    answers: [{ label: '观点A', text: '补充事实。' }],
    followUp: true
  });
  assert.ok(prompt.includes('【你上一轮的汇总】\n【结论】旧结论。'));
  assert.ok(prompt.includes('补充事实。'));
  assert.ok(prompt.includes('【待补】'));
  assert.ok(prompt.includes('重新写一遍'));
});

test('不开追加研究时，汇总提示词一个字都不变', () => {
  const base = leadSummarySystem('answer');
  const withFollowUp = leadSummarySystem('answer', true);
  assert.deepEqual(base, leadSummarySystem('answer', false));
  assert.equal(withFollowUp.length, base.length + 1);
  assert.ok(withFollowUp[withFollowUp.length - 1].startsWith('【待补】'));

  const answers = [{ channelId: 'a', label: 'a', text: '回答' }];
  const plain = buildLeadSummaryQuestion('问题', answers);
  assert.ok(!plain.includes('【待补】'), '单轮不应该要求【待补】');
  assert.ok(buildLeadSummaryQuestion('问题', answers, { followUp: true }).includes('【待补】'));
});

// ---------------------------------------------------------------------------
// 会话语义
// ---------------------------------------------------------------------------

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

function fakeChannel(id, behaviour) {
  return {
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: id },
    async health() {
      return { id, label: id, available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask(input) {
      return { agentId: id, stage: input.stage, channelId: id, text: '', receivedAt: Date.now(), ...(await behaviour(input, id)) };
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

function makeRunner(channels, deps = {}) {
  const store = fakeStore();
  return {
    store,
    runner: new ConversationRunner({
      store,
      registry: fakeRegistry(channels),
      emit: () => {},
      submitWorkspace: async () => {
        throw new Error('unexpected workspace hand-off');
      },
      ...deps
    })
  };
}

async function settle(runner, conversationId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conversation = runner.get(conversationId);
    if (conversation && ['answered', 'failed', 'cancelled'].includes(conversation.status)) return conversation;
    if (Date.now() > deadline) throw new Error(`conversation did not settle: ${conversation?.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const SUMMARY_ONE = [
  '【结论】连接池该开，但上限要按数据库侧算。',
  '【一致】两处都说要开。',
  '【分歧】没有。',
  '【存疑】观点B没给数字。',
  '【辩题】无',
  '【待补】',
  '1. 生产环境的连接上限具体是多少？'
].join('\n');

const SUMMARY_TWO = [
  '【结论】上限是 200，由数据库侧设置。',
  '【一致】两处都说要开、都说 200。',
  '【分歧】没有。',
  '【存疑】无。',
  '【辩题】无',
  '【待补】无'
].join('\n');

/**
 * 一个会分场合回答的假通道：
 * - 汇总请求（带【各来源的回答】）回 SUMMARY_ONE，第二轮更新回 SUMMARY_TWO；
 * - 「关于「…」」开头的追加问题回一段补充事实；
 * - 其余就是第一轮回答。
 */
function scriptedChannel(id, log) {
  let summaryCount = 0;
  return fakeChannel(id, input => {
    log.asks.push({ id, question: input.question, stage: input.stage });
    const question = input.question;
    if (question.includes('【各来源的回答】') || question.includes('【你上一轮的汇总】')) {
      summaryCount += 1;
      return { text: summaryCount === 1 ? SUMMARY_ONE : SUMMARY_TWO };
    }
    if (question.startsWith('关于「')) {
      return { text: `${id} 的补充事实：上限是 200，由数据库侧设置。` };
    }
    return { text: `${id} 的第一轮回答：连接池该开，上限按数据库侧算。` };
  });
}

test('默认单轮：不会追加提问，也不会要求【待补】', async () => {
  const log = { asks: [] };
  const { runner } = makeRunner([scriptedChannel('a', log), scriptedChannel('b', log)]);
  const started = await runner.start({ text: '帮我看看 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered');
  assert.equal(log.asks.filter(item => item.question.startsWith('关于「')).length, 0, '默认不该追加提问');
  assert.ok(
    log.asks.every(item => !item.question.includes('【待补】')),
    '不开追加研究时不该要求【待补】'
  );
  const messages = runner.messages(started.conversationId);
  assert.ok(!messages.some(message => message.role === 'system' && message.text.includes('追加研究')));
  assert.equal(done.executionConfig.followUpRounds, undefined);
});

test('开一轮追加：缺口被原样问回所有网页通道，汇总更新成第二版', async () => {
  const log = { asks: [] };
  const { runner } = makeRunner([scriptedChannel('a', log), scriptedChannel('b', log)]);
  const started = await runner.start({
    text: '帮我看看 Redis 连接数过高的原因',
    executionConfig: { followUpRounds: 1 }
  });
  const done = await settle(runner, started.conversationId);
  assert.equal(done.status, 'answered');

  const followUps = log.asks.filter(item => item.question.startsWith('关于「'));
  // 两个通道都被重新问了一遍，而不是只问主导人
  assert.deepEqual([...new Set(followUps.map(item => item.id))].sort(), ['a', 'b']);
  assert.ok(followUps.every(item => item.question.includes('生产环境的连接上限具体是多少？')));
  assert.ok(followUps.every(item => !/研究伙伴|你是/.test(item.question)), '追加问题不能带角色话术');

  const messages = runner.messages(started.conversationId);
  const synthesis = messages.filter(message => message.role === 'synthesis').pop();
  assert.ok(synthesis, 'expected a synthesis');
  assert.ok(synthesis.synthesis.recommendation.includes('上限是 200'), '结论应来自更新后的汇总');
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('第 1 轮追加研究')),
    '会话里应写明这一轮补了什么'
  );
  // 第一轮的通道消息仍在，第二轮的补充回答也在
  assert.ok(messages.filter(message => message.role === 'channel').length >= 4);
});

test('缺口重复出现时就停下，不会一轮轮问同一句', async () => {
  const log = { asks: [] };
  let summaryCount = 0;
  const channel = fakeChannel('a', input => {
    log.asks.push({ id: 'a', question: input.question, stage: input.stage });
    if (input.question.includes('【各来源的回答】') || input.question.includes('【你上一轮的汇总】')) {
      summaryCount += 1;
      // 两轮都给同一个缺口
      return { text: SUMMARY_ONE };
    }
    if (input.question.startsWith('关于「')) return { text: '补充：仍是 200。' };
    return { text: '第一轮回答。' };
  });
  const channelB = fakeChannel('b', input => {
    log.asks.push({ id: 'b', question: input.question, stage: input.stage });
    if (input.question.includes('【各来源的回答】')) return { text: SUMMARY_ONE };
    if (input.question.startsWith('关于「')) return { text: '补充：200。' };
    return { text: '第一轮回答。' };
  });

  const { runner } = makeRunner([channel, channelB]);
  const started = await runner.start({
    text: '帮我看看 Redis 连接数过高的原因',
    executionConfig: { followUpRounds: 3 }
  });
  await settle(runner, started.conversationId);

  const rounds = log.asks.filter(item => item.question.startsWith('关于「')).length;
  // 一轮追加 = 两个通道各问一次；重复缺口不该触发第二轮
  assert.equal(rounds, 2, `expected one follow-up round, got ${String(rounds)} asks`);
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('上一轮已经问过')),
    '应该说明为什么停'
  );
  assert.ok(summaryCount >= 2);
});

test('没有【待补】就不追加，并说明原因', async () => {
  const log = { asks: [] };
  const channel = fakeChannel('a', input => {
    log.asks.push({ id: 'a', question: input.question, stage: input.stage });
    if (input.question.includes('【各来源的回答】')) {
      return { text: '【结论】可以。\n【一致】无。\n【分歧】没有。\n【存疑】无。\n【辩题】无' };
    }
    return { text: '第一轮回答。' };
  });
  const channelB = fakeChannel('b', input => {
    log.asks.push({ id: 'b', question: input.question, stage: input.stage });
    return { text: '第一轮回答。' };
  });

  const { runner } = makeRunner([channel, channelB]);
  const started = await runner.start({
    text: '帮我看看 Redis 连接数过高的原因',
    executionConfig: { followUpRounds: 2 }
  });
  await settle(runner, started.conversationId);

  assert.equal(log.asks.filter(item => item.question.startsWith('关于「')).length, 0);
  const messages = runner.messages(started.conversationId);
  assert.ok(
    messages.some(message => message.role === 'system' && message.text.includes('没有可补的问题')),
    '应该说明为什么没有追加'
  );
});

test('追加阶段的通道全部失败时，结论停在上一版并写明', async () => {
  const log = { asks: [] };
  let followUpAsks = 0;
  const make = id =>
    fakeChannel(id, input => {
      log.asks.push({ id, question: input.question, stage: input.stage });
      if (input.question.includes('【各来源的回答】')) return { text: SUMMARY_ONE };
      if (input.question.startsWith('关于「')) {
        followUpAsks += 1;
        throw new Error('页面没有响应');
      }
      return { text: '第一轮回答。' };
    });

  const { runner } = makeRunner([make('a'), make('b')]);
  const started = await runner.start({
    text: '帮我看看 Redis 连接数过高的原因',
    executionConfig: { followUpRounds: 1 }
  });
  const done = await settle(runner, started.conversationId);

  assert.ok(followUpAsks > 0);
  assert.equal(done.status, 'answered');
  const synthesis = runner.messages(started.conversationId).filter(message => message.role === 'synthesis').pop();
  assert.ok(synthesis.synthesis.recommendation.includes('连接池该开'), '结论应仍是第一轮汇总');
  assert.ok(
    runner
      .messages(started.conversationId)
      .some(message => message.role === 'system' && message.text.includes('没有拿到回答')),
    '应该说明追加研究失败'
  );
});

test('用户停手后不再追加', async () => {
  const log = { asks: [] };
  let started = null;
  const { runner } = makeRunner([scriptedChannel('a', log), scriptedChannel('b', log)]);
  started = await runner.start({
    text: '帮我看看 Redis 连接数过高的原因',
    executionConfig: { followUpRounds: 2 }
  });
  // 第一轮网页提问还在飞的时候停手
  runner.cancel(started.conversationId);
  const done = await settle(runner, started.conversationId);
  assert.equal(done.status, 'cancelled');
  assert.equal(log.asks.filter(item => item.question.startsWith('关于「')).length, 0);
});
