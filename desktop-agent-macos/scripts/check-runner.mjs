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
import { ChannelBusyError } from '../out-test/main/channels/types.js';

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
    async status() {
      return { id, label: id, available: true, loggedIn: true, pageReady: true, generating: false };
    },
    async ask(input) {
      return behaviour(input, id);
    },
    cancel() {}
  };
}

function fakeRegistry(channels) {
  return {
    available: async () => channels,
    ask: async (id, input) => {
      const channel = channels.find(item => item.id === id);
      if (!channel) throw new ChannelBusyError(id);
      return channel.ask(input);
    },
    cancel() {}
  };
}

function makeRunner(channels, options = {}) {
  const store = fakeStore();
  const events = [];
  const runner = new ConversationRunner({
    store,
    registry: fakeRegistry(channels),
    emit: event => events.push(event),
    submitWorkspace: options.submitWorkspace ?? (async () => {
      throw new Error('unexpected workspace hand-off');
    })
  });
  return { runner, store, events };
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
    fakeChannel('a', () => answer('连接数过高的主要原因是客户端没有复用连接。')),
    fakeChannel('b', () => answer('连接数过高的主要原因是客户端没有复用连接，而是每次新建。'))
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
      throw new ChannelBusyError('b');
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
