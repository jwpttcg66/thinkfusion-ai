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
  const order = [];
  return {
    resets,
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

test('a plain question asks exactly one channel and synthesises nothing', async () => {
  let asked = 0;
  const { runner } = makeRunner([
    fakeChannel('a', () => {
      asked += 1;
      return answer('这是一个直接回答，没有比较对象。');
    }),
    fakeChannel('b', () => {
      asked += 1;
      return answer('第二个通道不应该被问到。');
    })
  ]);

  const started = await runner.start({ text: '什么是连接池' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.intent, 'answer');
  assert.equal(done.status, 'answered');
  assert.equal(asked, 1, 'a question should not fan out');
  const messages = runner.messages(started.conversationId);
  assert.equal(messages.filter(message => message.role === 'channel').length, 1);
  assert.equal(messages.filter(message => message.role === 'synthesis').length, 0);
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
