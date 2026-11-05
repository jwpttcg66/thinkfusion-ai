/**
 * Behaviour tests for the conversation runner.
 *
 * The live check (`check-conversation.mjs`) needs a logged-in page, which means
 * it cannot run in CI and cannot run on a machine where both AIs happen to be
 * logged out. Everything the runner decides — which channels to ask, what
 * happens when one fails, when a synthesis appears — is independent of the
 * page, so it is tested here against scripted channels.
 *
 * The cases that matter are the failure ones: one channel dying must not take
 * the conversation with it, and "no channel answered" must be a visible error
 * rather than an empty pane.
 *
 * Run with: npm run test:runner
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import { PageBusyError } from '../out-test/main/adapters/browser/types.js';

function fakeStore() {
  const conversations = new Map();
  const messages = [];

  return {
    listConversations: () => [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    getConversation: id => conversations.get(id) ?? null,
    listMessages: id => messages.filter(message => message.conversationId === id),
    upsertConversation: conversation => conversations.set(conversation.conversationId, conversation),
    appendMessage: message => messages.push(message),
    deleteConversation: id => {
      conversations.delete(id);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].conversationId === id) messages.splice(i, 1);
      }
    }
  };
}

function fakeChannel(id, behaviour) {
  return {
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: `代表 ${id}` },
    async health() {
      return { id, label: id, available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask(input) {
      // The real subagent stamps the answer with its own id and the stage it was
      // asked at; the fake does the same, otherwise a test could pass while the
      // app files every answer under `undefined`.
      const result = await behaviour(input, id);
      return { agentId: id, stage: input.stage, ...result };
    },
    cancel() {}
  };
}

/**
 * The registry the runner talks to. `newConversation` is part of the real
 * interface, so the fake has to have it too — otherwise a test could pass while
 * the app throws "not a function" on the first turn.
 */
function fakeRegistry(channels, options = {}) {
  const resets = [];
  const deletes = [];
  const order = [];
  return {
    resets,
    deletes,
    order,
    // `all()` is the roster; `available()` is who can be asked. They differ in
    // exactly one situation — a site is configured but its page is not usable —
    // and that is the situation the failure message has to get right.
    all: async () => channels,
    available: async () => (options.noneUsable ? [] : channels),
    // `get` is how a channel's display name is found when a turn is abandoned
    // without an answer to take it from.
    get: id => channels.find(channel => channel.id === id),
    ask: async (id, input) => {
      order.push(`${id}:ask`);
      const channel = channels.find(item => item.id === id);
      if (!channel) throw new PageBusyError(id);
      return channel.ask(input);
    },
    newConversation: async id => {
      order.push(`${id}:reset`);
      resets.push(id);
      if (options.resetFails?.includes(id)) return { ok: false, detail: '页面没有清空，仍在原会话里' };
      return { ok: true };
    },
    deleteConversation: async (id, threadUrl) => {
      order.push(`${id}:delete`);
      deletes.push({ id, threadUrl });
      if (options.deleteFails?.includes(id)) return { ok: false, detail: '页面里没找到这条会话' };
      return { ok: true };
    },
    cancel() {},
    cancelAll() {}
  };
}

function makeRunner(channels, options = {}) {
  const store = fakeStore();
  const events = [];
  const registry = fakeRegistry(channels, options);
  const runner = new ConversationRunner({
    store,
    registry,
    emit: event => events.push(event),
    budgetMs: options.budgetMs,
    submitWorkspace: options.submitWorkspace ?? (async () => {
      throw new Error('unexpected workspace hand-off');
    })
  });
  return { runner, store, events, registry };
}

async function settle(runner, conversationId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const conversation = runner.get(conversationId);
    if (conversation && ['answered', 'failed', 'cancelled'].includes(conversation.status)) return conversation;
    if (Date.now() > deadline) throw new Error(`conversation did not settle: ${conversation?.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** For turns whose status was already terminal when they started. */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const answer = text => ({ channelId: 'x', text, receivedAt: Date.now(), attribution: { requestId: 'r1', note: 'test' } });

test('a plain question asks every channel that is switched on', async () => {
  // Until 0.0.9 this went to exactly one channel, and the strip said so:
  // "单通道，只问 Gemini" next to two idle pages. One answer is not a
  // cross-check, which is the whole product, so every switched-on channel is
  // asked — plain question or research, same rule.
  const asked = [];
  const { runner } = makeRunner([
    fakeChannel('a', () => {
      asked.push('a');
      return answer('这是个直接回答，只讲一件事。');
    }),
    fakeChannel('b', () => {
      asked.push('b');
      return answer('另一个通道也回答了，讲的是别的事情。');
    })
  ]);

  const started = await runner.start({ text: '什么是连接池' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.intent, 'answer');
  assert.equal(done.status, 'answered');
  // 两个来源都被问到（主导轮会再把其中一份重新问一遍当主导，所以这里只断言
  // 「都问过」，不要求恰好一次）。
  assert.ok(asked.includes('a') && asked.includes('b'), 'both channels must be asked');
  assert.equal(new Set(asked).size, 2, '没有去问名单之外的通道');
  assert.equal(done.channels.length, 2);
  const messages = runner.messages(started.conversationId);
  assert.equal(messages.filter(message => message.role === 'channel').length, 2);
});

test('the question goes out verbatim, with nothing prepended', async () => {
  // The wrapper that used to be sent ("你是我在 ThinkFusion 里的研究伙伴…") was a
  // fixed prompt the user never wrote. It also had to be stripped back out of
  // the page's echo before an answer could be trusted.
  const sent = [];
  const { runner } = makeRunner([
    fakeChannel('a', input => {
      sent.push(input.question);
      return answer('好的。');
    })
  ]);

  const started = await runner.start({ text: '3+5。结果是多少' });
  await settle(runner, started.conversationId);

  assert.deepEqual(sent, ['3+5。结果是多少']);
});

test('a follow-up is sent verbatim too', async () => {
  const sent = [];
  const { runner } = makeRunner([
    fakeChannel('a', input => {
      sent.push(input.question);
      return answer('第二个答案。');
    })
  ]);

  const started = await runner.start({ text: '第一问' });
  await settle(runner, started.conversationId);
  await runner.followup(started.conversationId, '第二问');
  await settle(runner, started.conversationId);

  assert.deepEqual(sent, ['第一问', '第二问']);
});

test('a research question asks every channel and produces a synthesis', async () => {
  const { runner } = makeRunner([
    fakeChannel('a', () => answer('生产环境必须开启连接池复用来降低连接数。')),
    fakeChannel('b', () => answer('生产环境不要开启连接池复用，否则连接数会更高。'))
  ]);

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.intent, 'research');
  assert.equal(done.status, 'answered');
  assert.deepEqual([...done.channels].sort(), ['a', 'b']);

  const messages = runner.messages(started.conversationId);
  const synthesis = messages.find(message => message.role === 'synthesis');
  assert.ok(synthesis, 'expected a synthesis message');
  assert.ok(Array.isArray(synthesis.synthesis.consensus));
  assert.ok(
    synthesis.synthesis.disputed.length > 0 ||
      synthesis.synthesis.gaps.length > 0 ||
      synthesis.synthesis.degraded === true,
    'a synthesis must surface disagreement, a gap, or admit it degraded'
  );
});

test('one channel failing does not lose the other answer', async () => {
  const { runner, events } = makeRunner([
    fakeChannel('a', () => answer('连接数过高的主要原因是客户端没有复用连接。')),
    fakeChannel('b', () => {
      throw new Error('页面崩了');
    })
  ]);

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered', 'a partial answer is still an answer');
  const messages = runner.messages(started.conversationId);
  assert.equal(messages.filter(message => message.role === 'channel').length, 1);
  assert.ok(
    events.some(event => event.type === 'channel.phase' && event.phase === 'failed'),
    'the failure has to be visible, not swallowed'
  );
});

test('a busy channel is reported as busy, not as a broken one', async () => {
  const { runner, events } = makeRunner([
    fakeChannel('a', () => answer('连接数过高的主要原因是客户端没有复用连接。')),
    fakeChannel('b', () => {
      throw new PageBusyError('b');
    })
  ]);

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  await settle(runner, started.conversationId);

  const busy = events.find(event => event.type === 'channel.phase' && event.phase === 'busy');
  assert.ok(busy, 'expected a busy phase');
  assert.match(busy.detail, /跳过/);
});

test('no channel at all is a visible failure, not an empty pane', async () => {
  const { runner } = makeRunner([]);
  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'failed');
  assert.match(done.error, /没有可用的通道/);
  // Nothing is configured, so there is no page to go and log into. Telling the
  // user to log in would be advice they cannot act on.
  assert.match(done.error, /设置里打开/);
});

test('a configured site with an unusable page is named, not treated as absent', async () => {
  const { runner } = makeRunner(
    [fakeChannel('a', () => answer('不会被问到。')), fakeChannel('b', () => answer('不会被问到。'))],
    { noneUsable: true }
  );
  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'failed');
  // The roster comes from the pool, so adding a third site needs no edit to the
  // message. The old text listed two site names by hand and went stale.
  assert.match(done.error, /a 或 b/);
});

test('a workspace intent never touches a channel', async () => {
  let asked = 0;
  let handedOff = null;
  const { runner } = makeRunner(
    [
      fakeChannel('a', () => {
        asked += 1;
        return answer('不应该走到这里。');
      })
    ],
    {
      submitWorkspace: async input => {
        handedOff = input;
        return { taskId: 'task-1', title: 'x', userPrompt: input.prompt, status: 'planning' };
      }
    }
  );

  const started = await runner.start({ text: '帮我修改 README.md 里的标题', workspaceRoot: '/tmp/work' });
  const done = await settle(runner, started.conversationId);

  assert.equal(asked, 0, 'a file change must not be sent to a chat channel');
  assert.equal(done.taskId, 'task-1');
  assert.equal(handedOff.prompt, '帮我修改 README.md 里的标题');
  assert.equal(handedOff.workspaceRoot, '/tmp/work');
});

test('the user message is recorded verbatim, before any channel is asked', async () => {
  const { runner } = makeRunner([fakeChannel('a', () => answer('好的。'))]);
  const text = '  帮我分析 Redis 连接数过高的原因  ';

  const started = await runner.start({ text });
  const messages = runner.messages(started.conversationId);

  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, text.trim(), 'the question is sent as written, only trimmed');
});

test('the first turn opens a new session on every channel it asks', async () => {
  const { runner, registry } = makeRunner([
    fakeChannel('a', () => answer('连接数过高的主要原因是客户端没有复用连接。')),
    fakeChannel('b', () => answer('连接数过高的主要原因是客户端没有复用连接，而是每次新建。'))
  ]);

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  await settle(runner, started.conversationId);

  assert.deepEqual([...registry.resets].sort(), ['a', 'b'], 'both channels must be reset');
  for (const id of ['a', 'b']) {
    assert.ok(
      registry.order.indexOf(`${id}:reset`) < registry.order.indexOf(`${id}:ask`),
      `${id} must be reset before it is asked, not after`
    );
  }
});

test('a follow-up stays in the page session it was asked in', async () => {
  const { runner, registry } = makeRunner([fakeChannel('a', () => answer('第一轮回答。'))]);

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  await settle(runner, started.conversationId);
  assert.equal(registry.resets.length, 1);

  const before = runner.messages(started.conversationId).filter(message => message.role === 'channel').length;
  await runner.followup(started.conversationId, '那具体怎么排查？');

  // The status is already 'answered' from the first turn, so waiting on it
  // would return immediately — the follow-up has to be waited for by content.
  await waitFor(
    () => runner.messages(started.conversationId).filter(message => message.role === 'channel').length > before,
    3000
  );

  assert.equal(registry.resets.length, 1, 'a follow-up must not clear the page it depends on');
});

test('a channel that cannot open a new session is still asked, and the drift is recorded', async () => {
  const { runner, events } = makeRunner(
    [
      fakeChannel('a', () => answer('连接数过高的主要原因是客户端没有复用连接。')),
      fakeChannel('b', () => answer('连接数过高的主要原因是连接池配置过小。'))
    ],
    { resetFails: ['b'] }
  );

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered', 'a failed reset must not cost the answer');
  const messages = runner.messages(started.conversationId);
  assert.equal(messages.filter(message => message.role === 'channel').length, 2);

  const note = messages.find(message => message.role === 'system');
  assert.ok(note, 'expected a note about the channel that kept its old thread');
  assert.match(note.text, /旧上下文/);
  assert.match(note.text, /b/);
  assert.ok(
    events.some(event => event.type === 'channel.phase' && event.phase === 'resetting'),
    'the reset phase has to be observable'
  );
});

test('a second question is refused while the first one is still running', async () => {
  // A page that never answers: the state the pane was actually in when two
  // identical user bubbles appeared over one stuck channel.
  const { runner } = makeRunner(
    [fakeChannel('a', () => new Promise(() => {}))],
    { budgetMs: 60_000 }
  );

  const started = await runner.start({ text: '算一道题：2+3 等于多少' });
  await waitFor(() => runner.get(started.conversationId).channels.length === 1);

  await assert.rejects(
    () => runner.followup(started.conversationId, '算一道题：2+3 等于多少'),
    /还在等回答/
  );

  const asked = runner.messages(started.conversationId).filter(message => message.role === 'user');
  assert.equal(asked.length, 1, '被拒绝的追问不能留下第二条用户消息');

  // Releases the budget timer; without this the test process waits a minute.
  runner.cancel(started.conversationId);
});

test('a turn that never returns ends as a failure that names the channel', async () => {
  const { runner, events } = makeRunner(
    [fakeChannel('a', () => new Promise(() => {}))],
    { budgetMs: 120 }
  );

  const started = await runner.start({ text: '算一道题：2+3 等于多少' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'failed', '卡住的一轮必须结束，不能一直是思考中');
  assert.match(done.error, /没有结果/);
  assert.match(done.error, /a/, '失败要说清楚在等谁');
  assert.ok(
    events.some(event => event.type === 'conversation.failed'),
    'renderer 要收到结束事件，否则界面还停在旧状态'
  );
});

test('a conversation stranded by the last process is marked interrupted', () => {
  const { runner, store } = makeRunner([fakeChannel('a', () => answer('x'))]);
  const stranded = {
    conversationId: 'c-stranded',
    title: '上一轮没跑完',
    intent: 'answer',
    intentReason: '默认按问答处理',
    status: 'thinking',
    channels: ['a'],
    createdAt: 1,
    updatedAt: 1
  };
  store.upsertConversation(stranded);
  store.upsertConversation({ ...stranded, conversationId: 'c-done', status: 'answered' });

  assert.equal(runner.reconcile(), 1, '只有中断的那条该被改');
  assert.equal(runner.get('c-stranded').status, 'failed');
  assert.match(runner.get('c-stranded').error, /没有结束/);
  assert.equal(runner.get('c-done').status, 'answered');
  assert.equal(runner.get('c-done').error, undefined);
});

// ---------------------------------------------------------------------------
// Deleting: the local row and the copies on the sites
// ---------------------------------------------------------------------------

/** An answer that also recorded where the site kept it. */
const answerAt = (threadUrl, text = '这是一条回答。') => ({
  ...answer(text),
  threadUrl
});

test('deleting a conversation removes it from every site that answered', async () => {
  const { runner, registry } = makeRunner([
    fakeChannel('a', () => answerAt('https://a.example/chat/1')),
    fakeChannel('b', () => answerAt('https://b.example/chat/2'))
  ]);

  const started = await runner.start({ text: '3+5 等于多少' });
  await settle(runner, started.conversationId);

  const outcome = await runner.delete(started.conversationId);

  assert.equal(runner.get(started.conversationId), null, '本地记录必须删掉');
  assert.deepEqual([...outcome.cleaned].sort(), ['a', 'b']);
  assert.deepEqual(outcome.failed, []);
  assert.deepEqual(
    registry.deletes.map(item => item.threadUrl).sort(),
    ['https://a.example/chat/1', 'https://b.example/chat/2'],
    '每个有地址的通道都要按地址去删'
  );
  // The pages must not stay on a thread that no longer exists anywhere.
  assert.deepEqual([...outcome.reset].sort(), ['a', 'b']);
});

test('a channel that never answered is not reported as something to remove by hand', async () => {
  // The asked-but-silent channel used to be listed as 「网页里的那份请手动删除」,
  // which sent people looking for a sidebar row that was never created.
  const { runner } = makeRunner([
    fakeChannel('a', () => answer('回答了，但这个站点没留下地址。')),
    fakeChannel('b', () => {
      throw new Error('页面卡住了');
    })
  ]);

  const started = await runner.start({ text: '3+5 等于多少' });
  await settle(runner, started.conversationId);

  const outcome = await runner.delete(started.conversationId);

  assert.deepEqual(outcome.cleaned, []);
  assert.equal(outcome.failed.length, 1, '只有真的回答过、又没地址的通道需要提示');
  assert.equal(outcome.failed[0].channelId, 'a');
  assert.match(outcome.failed[0].detail, /手动删除/);
  assert.deepEqual([...outcome.reset].sort(), ['a', 'b'], '参与过的页面都要回到新对话');
});

test('a site that cannot delete its copy is reported, and its page still moves on', async () => {
  const { runner } = makeRunner(
    [
      fakeChannel('a', () => answerAt('https://a.example/chat/1')),
      fakeChannel('b', () => answerAt('https://b.example/chat/2'))
    ],
    { deleteFails: ['b'] }
  );

  const started = await runner.start({ text: '3+5 等于多少' });
  await settle(runner, started.conversationId);

  const outcome = await runner.delete(started.conversationId);

  assert.deepEqual(outcome.cleaned, ['a']);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].channelId, 'b');
  assert.deepEqual([...outcome.reset].sort(), ['a', 'b']);
});

test('a follow-up resets only the channels that did not answer', async () => {
  let bFails = true;
  const { runner, registry } = makeRunner([
    fakeChannel('a', () => answerAt('https://a.example/chat/1', '第一轮回答。')),
    fakeChannel('b', () => {
      if (bFails) throw new Error('超时了');
      return answerAt('https://b.example/chat/2', '第二轮回答。');
    })
  ]);

  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  await settle(runner, started.conversationId);
  assert.deepEqual([...registry.resets].sort(), ['a', 'b'], '第一轮每页都要开新会话');

  registry.resets.length = 0;
  bFails = false;
  await runner.followup(started.conversationId, '那具体怎么排查？');

  await waitFor(
    () => runner.messages(started.conversationId).filter(message => message.channelId === 'b').length > 0,
    3000
  );

  // `a` already holds this conversation on its page; `b` never did, so only `b`
  // has to start clean — otherwise the follow-up arrives over unrelated history.
  assert.deepEqual(registry.resets, ['b']);
});

/**
 * Every switched-on channel is asked at the same time.
 *
 * The registry used to cap the whole pool at three. With a fourth site switched
 * on, the fourth agent was handed the question and immediately refused with
 * PageBusyError — reported to the user as 「通道正在处理上一个问题，本次跳过」
 * while nothing at all was busy. Measured live: DeepSeek and ChatGPT answered,
 * Gemini was told it was busy, Kimi timed out, and the answers arrived one after
 * another because the cap doubled as a queue.
 *
 * The test holds all four asks open until the fourth has started, so a cap of
 * three fails it by deadlock-free assertion rather than by timing.
 */
test('four channels are asked at once, not three at a time', async () => {
  const { SubAgentRegistry } = await import('../out-test/main/agents/registry.js');
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const agents = ['deepseek', 'chatgpt', 'kimi', 'gemini'].map(id => ({
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: id },
    async health() {
      return { id, label: id, available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask() {
      started.push(id);
      await gate;
      return { agentId: id, text: '4', receivedAt: Date.now(), attribution: { requestId: id, note: '' }, stage: 'initial' };
    }
  }));

  const registry = new SubAgentRegistry(agents);
  const round = Promise.all(agents.map(agent => registry.ask(agent.id, { question: '1+3', stage: 'initial' })));

  // Give the fourth ask a real chance to be refused.
  const deadline = Date.now() + 1000;
  while (started.length < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));

  assert.deepEqual(started.sort(), ['chatgpt', 'deepseek', 'gemini', 'kimi'], '四个通道都应该已经被问上');
  release();
  const answers = await round;
  assert.equal(answers.length, 4);
});

test('one page still refuses a second question while it is answering', async () => {
  const { SubAgentRegistry } = await import('../out-test/main/agents/registry.js');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const agent = {
    id: 'a',
    label: 'a',
    identity: { id: 'a', label: 'a', kind: 'provider', role: 'a' },
    async health() {
      return { id: 'a', label: 'a', available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask() {
      await gate;
      return { agentId: 'a', text: '4', receivedAt: Date.now(), attribution: { requestId: 'a', note: '' }, stage: 'initial' };
    }
  };

  const registry = new SubAgentRegistry([agent]);
  const first = registry.ask('a', { question: '1+3', stage: 'initial' });
  await assert.rejects(() => registry.ask('a', { question: '2+2', stage: 'initial' }), /正在处理|busy/i);
  release();
  await first;
});

// ---------------------------------------------------------------------------
// 执行模式（2026-11-05 重定义）：回答永远来自网页；模式只管回答之后的处理。
// ---------------------------------------------------------------------------

function execChannels() {
  return [
    fakeChannel('a', async () => answer('a 的回答')),
    fakeChannel('b', async () => answer('b 的回答'))
  ];
}

function execRunner(channels, extra) {
  const store = fakeStore();
  const events = [];
  const runner = new ConversationRunner({
    store,
    registry: fakeRegistry(channels),
    emit: event => events.push(event),
    budgetMs: 5000,
    submitWorkspace: async () => { throw new Error('unexpected workspace hand-off'); },
    ...extra
  });
  return { runner, store, events };
}

test('direct 模式：回答之后不请任何模型处理，也没有本地汇总', async () => {
  const calls = { summary: 0, pickLead: 0 };
  const { runner, store } = execRunner(execChannels(), {
    fusionEnabled: true,
    summarizeLocal: async () => { calls.summary += 1; return { text: '不该出现的汇总', modelId: 'm', latencyMs: 1 }; },
    pickLead: async () => { calls.pickLead += 1; return { agentId: 'a', label: 'a', reason: '不该出现' }; }
  });
  const conversation = await runner.start({ text: '一个问题', executionConfig: { executionMode: 'direct' } });
  await settle(runner, conversation.conversationId);
  const messages = store.listMessages(conversation.conversationId);
  const synthesis = messages.find(message => message.synthesis)?.synthesis;
  assert.ok(synthesis, 'direct 也有规则版综合');
  assert.equal(calls.summary, 0, 'direct 模式不做任何模型处理');
  assert.equal(calls.pickLead, 0);
});

test('summary 模式：本地模型汇总写结论，不跑主导轮', async () => {
  const calls = { summary: 0, pickLead: 0 };
  const { runner, store } = execRunner(execChannels(), {
    fusionEnabled: true,
    summarizeLocal: async () => { calls.summary += 1; return { text: '本地模型的四段结论', modelId: 'qwen2.5:7b', latencyMs: 12 }; },
    pickLead: async () => { calls.pickLead += 1; return { agentId: 'a', label: 'a', reason: '不该出现' }; }
  });
  const conversation = await runner.start({ text: '一个问题', executionConfig: { executionMode: 'summary' } });
  await settle(runner, conversation.conversationId);
  assert.equal(calls.pickLead, 0, '汇总模式不选主导');
  assert.equal(calls.summary, 1);
  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.recommendation, '本地模型的四段结论');
  assert.equal(synthesis?.fusion?.backend, 'local-model');
});

test('lead 模式指定云端主导：云端没参与回答也能读全部回答给最终答案', async () => {
  const asked = [];
  const channels = execChannels();
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => ({
      all: async () => channels,
      available: async () => channels,
      ask: async (id, task) => {
        asked.push(`${id}:${task.stage}`);
        if (id === 'cloud') return { agentId: id, text: '云端的最终意见', receivedAt: 1, attribution: { requestId: 'r', note: 'n' }, stage: task.stage };
        return channels.find(channel => channel.id === id).ask(task);
      },
      newConversation: async () => ({ ok: true }),
      deleteConversation: async () => ({ ok: true }),
      cancel: () => {}
    }),
    executorIdsFor: () => new Set(['cloud']),
    agentSource: id => (id === 'cloud' ? 'cloud' : undefined)
  });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'lead', leadAgentId: 'cloud' }
  });
  await settle(runner, conversation.conversationId);
  assert.ok(asked.some(item => item === 'cloud:challenge'), '云端主导在执行阶段被问到');
  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.recommendation, '云端的最终意见');
  assert.equal(synthesis?.fusion?.backend, 'remote');
  assert.equal(synthesis?.fusion?.leadAgentId, 'cloud');
  assert.equal(synthesis?.fusion?.leadAuto, false, '手动指定不算自动');
});

test('auto 模式：pickLead 挑一位回答者主导，它被再问一次', async () => {
  const calls = { pickLead: 0 };
  const { runner, store } = execRunner(execChannels(), {
    fusionEnabled: true,
    pickLead: async () => { calls.pickLead += 1; return { agentId: 'a', label: 'A', reason: '测试理由' }; }
  });
  const conversation = await runner.start({ text: '一个问题', executionConfig: { executionMode: 'auto' } });
  await settle(runner, conversation.conversationId);
  assert.equal(calls.pickLead, 1, '自动模式恰好选一次主导');
  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.fusion?.leadAgentId, 'a');
  assert.equal(synthesis?.fusion?.leadAuto, true);
  assert.match(synthesis?.fusion?.confidence?.why ?? '', /自动选 a 主导/);
});
