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
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import { PageBusyError } from '../out-test/main/adapters/browser/types.js';
import { buildLeadSummaryQuestion, inlineLeadInstructions, parseTopics, rewriteSourceRefs, sourceTags } from '../out-test/main/synthesis/lead-stage.js';

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
    // `unusable` 模拟「开关开着但此刻不可用」：在 all() 里、不在 available() 里。
    available: async () =>
      options.noneUsable ? [] : channels.filter(channel => !options.unusable?.includes(channel.id)),
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
    }),
    ...options.deps
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
  // followup 立刻返回、run 异步开跑：上一轮已经是 answered，settle 会马上
  // 当成「结束了」——必须等第二问真的发出去。
  await waitFor(() => sent.length >= 2);
  await settle(runner, started.conversationId);

  assert.deepEqual(sent, ['第一问', '第二问']);
});

test('追问换名单后，提问条只留这一轮成员', async () => {
  // 关掉的通道若还挂在 conversation.channels 上，界面会继续显示上一轮的
  // 「失败 / 已回答」——正是「模型保存后提问里还有」的根因之一。
  let allow = ['a', 'b'];
  const channels = [
    fakeChannel('a', () => answer('a 的回答')),
    fakeChannel('b', () => answer('b 的回答'))
  ];
  const { runner } = makeRunner(channels, {
    deps: {
      poolFor: (_config, registry) => ({
        all: async () => (await registry.all()).filter(item => allow.includes(item.id)),
        available: async () => (await registry.available()).filter(item => allow.includes(item.id)),
        ask: (id, task) => registry.ask(id, task),
        newConversation: id => registry.newConversation(id),
        deleteConversation: (id, threadUrl) => registry.deleteConversation(id, threadUrl),
        cancel: () => {},
        get: id => registry.get(id)
      })
    }
  });

  const started = await runner.start({ text: '第一问' });
  const first = await settle(runner, started.conversationId);
  assert.deepEqual([...first.channels].sort(), ['a', 'b']);

  allow = ['a'];
  const before = runner.messages(started.conversationId).filter(message => message.role === 'channel').length;
  await runner.followup(started.conversationId, '第二问');
  // followup 立刻返回、run 异步开跑：不能靠 status===answered 判断第二轮结束，
  // 那会在 channels 刚被清空、还没 join 时就读到空条。
  await waitFor(
    () => runner.messages(started.conversationId).filter(message => message.role === 'channel').length > before
  );
  const second = runner.get(started.conversationId);
  assert.deepEqual([...second.channels], ['a'], '关掉的 b 不能再出现在这一轮提问条上');
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
  const card = synthesis.synthesis;
  assert.ok(Array.isArray(card.consensus));
  // 两条路：主导人读过全部回答、它的结论就是这张卡的全部内容；或者没有主导人，
  // 规则版必须自己说出分歧/缺口/降级。不能两条都不占——那才是「什么都没说」。
  assert.ok(
    card.leadSummary === true ||
      card.disputed.length > 0 ||
      card.gaps.length > 0 ||
      card.degraded === true,
    'a synthesis must either come from a lead or surface disagreement, a gap, or admit it degraded'
  );
  assert.ok(card.recommendation.length > 0, '写点东西，不能是一张空卡');
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

test('追问前把网页视图带回上一轮记录的会话地址，恢复过的通道不再被重置', async () => {
  const calls = [];
  const { runner, registry, store } = makeRunner(
    [
      fakeChannel('a', () => answer('第一轮 a 的回答。')),
      fakeChannel('b', () => answer('第一轮 b 的回答。'))
    ],
    {
      deps: {
        restoreThreads: async threads => {
          calls.push(threads);
          return { restored: Object.keys(threads), failed: [] };
        }
      }
    }
  );
  const started = await runner.start({ text: '第一个问题' });
  await settle(runner, started.conversationId);
  const conversation = store.getConversation(started.conversationId);
  conversation.threads = {
    a: 'https://chatgpt.com/c/old-a',
    b: 'https://chatgpt.com/c/old-b'
  };
  const resetsBefore = registry.resets.length;
  const before = runner.messages(started.conversationId).filter(message => message.role === 'channel').length;

  await runner.followup(started.conversationId, '接着问第二个问题');
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0], conversation.threads, '追问要拿到上一轮记下的网页地址');
  assert.equal(registry.resets.length, resetsBefore, '已经回到原会话的页面不能再被重置');
  await waitFor(
    () => runner.messages(started.conversationId).filter(message => message.role === 'channel').length > before,
    3000
  );
});

test('回到原网页会话失败时如实写进系统消息', async () => {
  const { runner, store } = makeRunner(
    [fakeChannel('a', () => answer('第一轮回答。'))],
    {
      deps: {
        restoreThreads: async () => ({
          restored: [],
          failed: [{ agentId: 'a', detail: '导航回原会话超时或失败' }]
        })
      }
    }
  );
  const started = await runner.start({ text: '第一个问题' });
  await settle(runner, started.conversationId);
  store.getConversation(started.conversationId).threads = { a: 'https://chatgpt.com/c/old-a' };

  await runner.followup(started.conversationId, '第二个问题');
  await waitFor(
    () => runner.messages(started.conversationId).some(
      message => message.role === 'system' && /没能回到 a 上一次的网页会话/.test(message.text)
    ),
    3000
  );
});

test('恢复后页面还没就绪就等它，而不是静默少问', async () => {
  // 2026-11-06 真机复现：追问恢复刚导航回原会话，就绪探测要几秒才通过；
  // 名单是一次性筛的，结果三家只问了一家，另外两家连失败记录都没有。
  let statusCalls = 0;
  const { runner, store } = makeRunner(
    [
      fakeChannel('a', () => answer('第二轮 a 的回答。')),
      fakeChannel('b', () => answer('第二轮 b 的回答。'))
    ],
    {
      deps: {
        restoreThreads: async threads => ({ restored: Object.keys(threads), failed: [] }),
        channelStatuses: async () => {
          statusCalls += 1;
          // 前两次 b 还没就绪（页面刚导航回来 / 上一轮 generating 未回落）。
          const bReady = statusCalls > 2;
          return [
            { id: 'a', available: true },
            { id: 'b', available: bReady, pageReady: bReady, generating: !bReady }
          ];
        }
      }
    }
  );
  const started = await runner.start({ text: '第一个问题' });
  await settle(runner, started.conversationId);
  store.getConversation(started.conversationId).threads = {
    a: 'https://chatgpt.com/c/old-a',
    b: 'https://chatgpt.com/c/old-b'
  };
  const before = runner.messages(started.conversationId).filter(message => message.role === 'channel').length;

  await runner.followup(started.conversationId, '第二个问题');
  await waitFor(
    () => runner.messages(started.conversationId).filter(message => message.role === 'channel').length > before + 1,
    5000
  );
  assert.ok(statusCalls > 2, 'runner 应该轮询健康状态等到 b 可用');
  const followup = runner.messages(started.conversationId).slice(-4);
  assert.ok(followup.some(m => m.role === 'channel' && m.channelId === 'b'), 'b 必须被问到，不能被静默排除');
});

test('开关开着但被排除的通道要写明原因，不能只显示待命', async () => {
  const { runner, events } = makeRunner(
    [
      fakeChannel('a', () => answer('a 的回答。')),
      fakeChannel('b', () => answer('b 不会被问到。'))
    ],
    { unusable: ['b'] }
  );
  const started = await runner.start({ text: '帮我分析 Redis 连接数过高的原因' });
  const done = await settle(runner, started.conversationId);

  assert.equal(done.status, 'answered', '一个通道不可用不该拖垮这一轮');
  const note = runner.messages(started.conversationId).find(
    message => message.role === 'system' && /没有给出回答/.test(message.text)
  );
  assert.ok(note, '排除原因要有系统消息');
  assert.match(note.text, /b：本轮未参与提问/);
  assert.ok(
    events.some(event => event.type === 'channel.phase' && event.channelId === 'b' && /本轮未参与提问/.test(event.detail ?? '')),
    '状态条要有 b 的失败相位，而不是停在待命'
  );
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

/**
 * 执行阶段成员（本地/云端）的替身：它们不参与第一轮回答，只在主导/辩论时被问。
 * `replies` 是「收到什么就回什么」的函数，方便断言提示词确实带着各家回答。
 */
function execPool(channels, replies) {
  return {
    all: async () => channels,
    available: async () => channels,
    ask: async (id, task) => {
      const reply = replies[id];
      if (reply) {
        return {
          agentId: id,
          text: reply(task),
          receivedAt: 1,
          attribution: { requestId: 'r', note: 'n' },
          stage: task.stage
        };
      }
      const channel = channels.find(item => item.id === id);
      if (!channel) throw new Error(`没有 ${id}`);
      return channel.ask(task);
    },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
}

const SUMMARY_REPLY = '【结论】综合结论\n【一致】都说到的点\n【分歧】没有\n【存疑】没有\n【辩题】无';

test('网页主导：由回答者当主导，它读全部回答写汇总', async () => {
  const prompts = [];
  const channels = [
    fakeChannel('a', async input => {
      prompts.push(input.question);
      return answer(input.question.includes('【各来源的回答】') ? SUMMARY_REPLY : 'a 的回答');
    }),
    fakeChannel('b', async () => answer('b 的回答'))
  ];
  const { runner, store, events } = execRunner(channels, { fusionEnabled: true });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'web', leadAgentId: 'a' }
  });
  await settle(runner, conversation.conversationId);

  // 第一次是用户原话，第二次才是把各家回答递进去的汇总请求。
  assert.equal(prompts[0], '一个问题');
  assert.ok(prompts.some(text => text.includes('【各来源的回答】')), '网页主导应当收到全部回答');
  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.recommendation, SUMMARY_REPLY);
  assert.equal(synthesis?.fusion?.backend, 'web');
  assert.equal(synthesis?.fusion?.leadAgentId, 'a');
  // 第二轮汇总必须标 leading，不能再标 asking——否则通道条会把已回答的主导人
  // 显示成「提问中」，看起来像第一轮没答完。
  assert.ok(
    events.some(event =>
      event.type === 'channel.phase' &&
      event.channelId === 'a' &&
      event.phase === 'leading'
    ),
    '主导人汇总应发出 leading 阶段，供第二轮进度卡使用'
  );
});

test('主导汇总宣布在第一轮答完之后，开场系统消息不再写「由谁汇总」', async () => {
  // 真机 2026-11-10：开场就写「由 deepseek 汇总」，hy4 还在提问中，像上来就总结。
  const channels = [
    fakeChannel('a', async input =>
      answer(input.question.includes('【各来源的回答】') ? SUMMARY_REPLY : 'a 的回答')
    ),
    fakeChannel('b', async () => answer('b 的回答'))
  ];
  const { runner, store } = execRunner(channels, { fusionEnabled: true });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'web', leadAgentId: 'a', debateMode: 'off' }
  });
  await settle(runner, conversation.conversationId);
  const systems = store
    .listMessages(conversation.conversationId)
    .filter(message => message.role === 'system')
    .map(message => message.text);
  assert.ok(
    systems.some(text => text.includes('第一轮回答已齐') && text.includes('主导人')),
    '答完之后才宣布进入主导汇总'
  );
});

test('主导汇总保持 leading 直到执行阶段结束，第二轮通道条才不会中途空掉', async () => {
  // 真机 2026-11-10：汇总刚写完就把相位改成 answered，辩论还没开、
  // 最终意见还没写，第二轮通道条已经消失。
  const channels = [
    fakeChannel('a', async input =>
      answer(input.question.includes('【各来源的回答】') ? SUMMARY_REPLY : 'a 的回答')
    ),
    fakeChannel('b', async () => answer('b 的回答'))
  ];
  const { runner, events } = execRunner(channels, { fusionEnabled: true });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'web', leadAgentId: 'a', debateMode: 'off' }
  });
  await settle(runner, conversation.conversationId);

  const leadPhases = events
    .filter(event => event.type === 'channel.phase' && event.channelId === 'a')
    .map(event => event.phase);
  const firstLeading = leadPhases.indexOf('leading');
  assert.ok(firstLeading >= 0, '应进入 leading');
  const after = leadPhases.slice(firstLeading);
  const answeredAt = after.indexOf('answered');
  assert.ok(answeredAt >= 0, '执行结束应落到 answered');
  assert.ok(
    after.slice(0, answeredAt).every(phase => phase === 'leading'),
    '汇总进行中应保持 leading，不能中途改成 answered'
  );
  // 主导只能是 a：b 在执行阶段不应被标成 leading。
  assert.equal(
    events.filter(event =>
      event.type === 'channel.phase' && event.channelId === 'b' && event.phase === 'leading'
    ).length,
    0,
    '非主导人不能进 leading'
  );
});

test('提问开始时通道条就应包含全部成员，而不是等人家开始问才 join', async () => {
  // 本地模型逐个问：若等轮到 hy4 才 join，前面云端在答时条上没有它。
  let resolveB;
  const gate = new Promise(resolve => {
    resolveB = resolve;
  });
  const seen = [];
  /** @type {{ get: (id: string) => { channels: string[] } }} */
  let runner;
  let conversationId = '';
  const channels = [
    fakeChannel('a', async () => {
      seen.push([...runner.get(conversationId).channels].sort());
      resolveB();
      return answer('a 的回答');
    }),
    fakeChannel('b', async () => {
      await gate;
      return answer('b 的回答');
    })
  ];
  runner = makeRunner(channels).runner;
  const started = await runner.start({ text: '什么是连接池' });
  conversationId = started.conversationId;
  await settle(runner, started.conversationId);
  assert.ok(seen.length >= 1, 'a 被问时应已记录通道条');
  assert.deepEqual(seen[0], ['a', 'b'], 'a 开始答时 b 就该已在通道条上');
});

test('本地主导：本地模型当主导，汇总与辩题都由它出', async () => {
  const channels = execChannels();
  const seen = [];
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => execPool(channels, {
      local: task => {
        seen.push(task.question);
        return SUMMARY_REPLY;
      }
    }),
    executorIdsFor: () => new Set(['local']),
    agentSource: id => (id === 'local' ? 'local' : undefined)
  });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'local' }
  });
  await settle(runner, conversation.conversationId);

  assert.equal(seen.length, 1, '本地主导应当只做一次汇总（没有辩题就不辩）');
  assert.ok(seen[0].includes('【各来源的回答】'));
  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.recommendation, SUMMARY_REPLY);
  assert.equal(synthesis?.fusion?.backend, 'local-model');
  assert.equal(synthesis?.fusion?.leadAgentId, 'local');
});

test('追问按当前研究设置跑，而不是会话创建时存的那份', async () => {
  // 真机（2026-11-06）：会话是网页主导时建的，用户随后把研究设置改成
  // 「本地主导」——输入框的胶囊已经写着本地主导，追问却还是由 Kimi 汇总、
  // 交锋、给最终意见。原因很具体：执行模式只在 start() 时写进会话，
  // followup 一直沿用创建时那份。研究设置是给「下一条提问」用的。
  const channels = execChannels();
  const seen = [];
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () =>
      execPool(channels, {
        local: task => {
          seen.push(task.question);
          return SUMMARY_REPLY;
        }
      }),
    executorIdsFor: () => new Set(['local']),
    agentSource: id => (id === 'local' ? 'local' : undefined)
  });

  const started = await runner.start({ text: '一个问题', executionConfig: { executionMode: 'web' } });
  await settle(runner, started.conversationId);
  const first = store.listMessages(started.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(first?.fusion?.backend, 'web', '第一轮是网页主导');

  await runner.followup(started.conversationId, '再问一句', { executionMode: 'local' });
  await waitFor(
    () => store.listMessages(started.conversationId).filter(message => message.synthesis).length > 1,
    3000
  );

  const syntheses = store.listMessages(started.conversationId).filter(message => message.synthesis);
  assert.equal(syntheses[syntheses.length - 1].synthesis.fusion.backend, 'local-model', '这一条要按本地主导跑');
  assert.ok(seen.length >= 1, '本地模型要真的被问到');
  assert.equal(
    store.getConversation(started.conversationId).executionConfig.executionMode,
    'local',
    '设置要落到会话上，别只在这一个进程里生效'
  );
});

test('改研究设置当场存到会话上，下一句不带设置也按它跑', async () => {
  // 面板改了设置只活在那个进程里的话：换个会话再回来、或者重开应用，胶囊就退回
  // 默认的「网页主导」，下一条追问照着默认跑——用户看到的正是「设了没生效」。
  // 所以改动要当场落盘，追问不带设置也得读到它。
  const channels = execChannels();
  const seen = [];
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () =>
      execPool(channels, {
        local: task => {
          seen.push(task.question);
          return SUMMARY_REPLY;
        }
      }),
    executorIdsFor: () => new Set(['local']),
    agentSource: id => (id === 'local' ? 'local' : undefined)
  });

  const started = await runner.start({ text: '一个问题', executionConfig: { executionMode: 'web' } });
  await settle(runner, started.conversationId);

  const saved = runner.updateExecutionConfig(started.conversationId, { executionMode: 'local' });
  assert.equal(saved.executionConfig.executionMode, 'local', '返回值要是存进去的那一份');
  assert.equal(
    store.getConversation(started.conversationId).executionConfig.executionMode,
    'local',
    '不落盘的话，下次打开这个会话又变回网页主导'
  );

  // 不带 executionConfig：模拟重开应用后渲染层手里只有默认值的那种追问。
  await runner.followup(started.conversationId, '再问一句');
  await waitFor(
    () => store.listMessages(started.conversationId).filter(message => message.synthesis).length > 1,
    3000
  );

  const syntheses = store.listMessages(started.conversationId).filter(message => message.synthesis);
  assert.equal(
    syntheses[syntheses.length - 1].synthesis.fusion.backend,
    'local-model',
    '存下来的设置要真的生效'
  );
  assert.ok(seen.length >= 1, '本地模型要真的被问到');
});

test('云端主导：云端没参与回答，也能读全部回答当主导', async () => {
  const channels = execChannels();
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => execPool(channels, { cloud: () => SUMMARY_REPLY }),
    executorIdsFor: () => new Set(['cloud']),
    agentSource: id => (id === 'cloud' ? 'cloud' : undefined)
  });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'cloud', leadAgentId: 'cloud' }
  });
  await settle(runner, conversation.conversationId);

  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.recommendation, SUMMARY_REPLY);
  assert.equal(synthesis?.fusion?.backend, 'remote');
  assert.equal(synthesis?.fusion?.leadAgentId, 'cloud');
  assert.equal(synthesis?.fusion?.leadAuto, false, '手动指定不算自动');
});

test('混合主导：先综合决定采用哪种方式，不借本地模型做判断', async () => {
  const { runner, store } = execRunner(execChannels(), { fusionEnabled: true });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'hybrid' }
  });
  await settle(runner, conversation.conversationId);

  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.ok(['a', 'b'].includes(synthesis?.fusion?.leadAgentId), '没有可用本地/云端成员时，混合择一采用网页方式');
  assert.equal(synthesis?.fusion?.leadAuto, true);
  assert.match(synthesis?.fusion?.leadReason ?? '', /混合.*没有可用的本地\/云端模型/);
});

test('主导人指定辩题：辩前汇总与辩后意见分开存，前者不被覆盖', async () => {
  const channels = execChannels();
  const debateInputs = [];
  const localReplies = [];
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => execPool(channels, {
      local: task => {
        localReplies.push(task.question);
        // 第一次是汇总 + 定辩题，第二次是读辩论记录给最终意见。
        return localReplies.length === 1
          ? '【结论】两家结论不一致\n【分歧】a 说涨、b 说跌\n【辩题】价格到底会涨还是会跌？'
          : '【最终意见】按证据看，涨的概率更高。';
      }
    }),
    executorIdsFor: () => new Set(['local', 'cloud']),
    agentSource: id => (id === 'local' ? 'local' : id === 'cloud' ? 'cloud' : undefined),
    runDebate: async input => {
      debateInputs.push(input);
      return {
        debateId: 'debate-1',
        status: 'completed',
        rounds: [
          {
            index: 0,
            messages: [
              { author: '本地', kind: 'position', text: '会涨' },
              { author: '本地', kind: 'question', text: '会跌？' }
            ]
          }
        ]
      };
    }
  });
  const conversation = await runner.start({ text: '价格会涨还是会跌', executionConfig: { executionMode: 'local' } });
  await settle(runner, conversation.conversationId);

  assert.equal(debateInputs.length, 1, '有辩题时应当发起辩论');
  assert.deepEqual(debateInputs[0].topics, ['价格到底会涨还是会跌？']);
  assert.deepEqual(debateInputs[0].debaters, ['local'], '本地主导只用本地模型，不掺云端');
  assert.equal(debateInputs[0].mode, 'local');
  assert.equal(debateInputs[0].effectiveMode, 'local');
  assert.equal(debateInputs[0].seeds.length, 2, '网页回答作为辩论的基准观点');
  assert.equal(localReplies.length, 2, '主导人先汇总、再读辩论记录');

  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  // 汇总里有【分歧】【辩题】，最终意见里有对质疑的裁定。以前用最终意见覆盖
  // 汇总，综合卡就只剩最后一段话——分歧和辩题在界面上都消失了。
  assert.equal(
    synthesis?.recommendation,
    '【结论】两家结论不一致\n【分歧】a 说涨、b 说跌\n【辩题】价格到底会涨还是会跌？'
  );
  assert.equal(synthesis?.finalOpinion, '【最终意见】按证据看，涨的概率更高。');
  assert.equal(synthesis?.leadSummary, true);
  assert.equal(synthesis?.fusion?.debateId, 'debate-1');
  assert.deepEqual(synthesis?.fusion?.debateTopics, ['价格到底会涨还是会跌？']);
  assert.match(synthesis?.fusion?.confidence?.why ?? '', /辩论跑了 1 轮/);
  assert.match(synthesis?.fusion?.confidence?.why ?? '', /最终意见/);
});

test('辩题解析：一行里挤了多条编号辩题也能拆开，且不吞掉「8杯水」的数字', () => {
  const summary = '【结论】没有定论\n【辩题】1. 8杯水是否包括食物水分？2. 每天该喝多少水？';
  assert.deepEqual(parseTopics(summary), ['8杯水是否包括食物水分？', '每天该喝多少水？']);
  assert.deepEqual(parseTopics('【辩题】无'), [], '写「无」表示不辩');
  assert.deepEqual(parseTopics('【结论】没有分歧'), [], '没有这一节也表示不辩');
  // 页面把站点自己的追问粘在回答末尾，读回来成了「无你喜欢这种回复风格吗？」。
  // 这不是辩题；按行拆会当成一条，白跑一场辩论。
  assert.deepEqual(parseTopics('【辩题】无你喜欢这种回复风格吗？'), [], '「无」后面跟着站点追问也不辩');
  // 真正的「无X」构词不能一起误杀。
  assert.deepEqual(
    parseTopics('【辩题】无服务器架构是否比传统部署更适合小团队？'),
    ['无服务器架构是否比传统部署更适合小团队？']
  );
});

// ---------------------------------------------------------------------------
// 主导人写结论时用「观点A/B/C」，不写站点名字
// ---------------------------------------------------------------------------

test('提示词用观点A/B标来源，不写站点名字', () => {
  const answers = [
    { channelId: 'kimi', label: 'Kimi', text: '金鱼记忆只有七秒是谣言。' },
    { channelId: 'chatgpt', label: 'ChatGPT', text: '金鱼记忆远不止七秒。' }
  ];
  const prompt = buildLeadSummaryQuestion('金鱼记忆只有七秒吗？', answers);
  assert.ok(prompt.includes('观点A：'), '第一份叫观点A');
  assert.ok(prompt.includes('观点B：'), '第二份叫观点B');
  assert.ok(!prompt.includes('【来源1】'), '不再出现编号');
  assert.ok(!prompt.includes('【Kimi】'), '也不出现带括号的站点名');

  const inline = inlineLeadInstructions('q', answers);
  assert.ok(inline.includes('观点A：'));
  assert.ok(inline.includes('不要加括号'), '提示词要求结论里也不加括号');
  assert.deepEqual(sourceTags(answers), ['观点A', '观点B']);
});

test('结论里残留的编号、站点名换回观点标签', () => {
  const answers = [
    { channelId: 'kimi', label: 'Kimi', text: '' },
    { channelId: 'chatgpt', label: 'ChatGPT', text: '' }
  ];
  // 真机原文（网页主导写出来的）：编号和名字都写了。
  assert.equal(
    rewriteSourceRefs('【分歧】来源2介绍的是呼吸作用，不是光合作用。【存疑】【来源2】ChatGPT 显然答非所问。', answers),
    '【分歧】观点B介绍的是呼吸作用，不是光合作用。【存疑】观点B 显然答非所问。'
  );
  assert.equal(rewriteSourceRefs('来源1 说可以用。', answers), '观点A 说可以用。');
  // 站点名字套方括号的也收成标签，不留括号。
  assert.equal(rewriteSourceRefs('【Kimi】说金鱼记忆不止七秒。', answers), '观点A说金鱼记忆不止七秒。');
  assert.equal(rewriteSourceRefs('【观点A】说可以。', answers), '观点A说可以。');
  // 越界的编号没有对应的人，原样留着，不要换成空字符串。
  assert.equal(rewriteSourceRefs('来源9 说了什么？', answers), '来源9 说了什么？');
  // 真答案里本来就有「来源」两个字的不动。
  assert.equal(rewriteSourceRefs('数据来源：一份公开报告。', answers), '数据来源：一份公开报告。');
});

// ---------------------------------------------------------------------------
// 一轮只留一套结论：主导人写了汇总，规则版的「分歧/共识/覆盖缺口」不再并列
// ---------------------------------------------------------------------------

test('主导人给了汇总后，规则版的分歧/共识/缺口不再挂到同一张卡上', async () => {
  // 这两句在规则引擎里确实会被判成 contradicts（见 check-fusion），所以「清空」
  // 这件事是可验证的，不是因为本来就空。
  const channels = [
    fakeChannel('a', async () => answer('这个接口提供了多线程安全保证，可以放心并发调用。')),
    fakeChannel('b', async () => answer('这个接口没有提供多线程安全保证，不能并发调用。'))
  ];
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => execPool(channels, { local: () => SUMMARY_REPLY }),
    executorIdsFor: () => new Set(['local']),
    agentSource: id => (id === 'local' ? 'local' : undefined)
  });
  const conversation = await runner.start({ text: '这个接口能并发调用吗', executionConfig: { executionMode: 'local' } });
  await settle(runner, conversation.conversationId);

  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.recommendation, SUMMARY_REPLY);
  assert.equal(synthesis?.leadSummary, true, '这张卡的内容由主导人给');
  assert.equal(synthesis?.fusion?.leadAgentId, 'local');
  assert.deepEqual(synthesis?.disputed, [], '主导人说过【分歧】没有，就不该再列「分歧（n）」');
  assert.deepEqual(synthesis?.consensus, []);
  assert.deepEqual(synthesis?.gap ?? synthesis?.gaps, []);
  assert.deepEqual(synthesis?.overlap, []);
  assert.equal(synthesis?.degraded, false, '主导人给了结论，就不是「未形成共识」');
});

test('主导人没成时，规则版综合还在（兜底不能被一起清掉）', async () => {
  const channels = [
    fakeChannel('a', async () => answer('这个接口提供了多线程安全保证，可以放心并发调用。')),
    fakeChannel('b', async () => answer('这个接口没有提供多线程安全保证，不能并发调用。'))
  ];
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => execPool(channels, { local: () => { throw new Error('模型没起来'); } }),
    executorIdsFor: () => new Set(['local']),
    agentSource: id => (id === 'local' ? 'local' : undefined)
  });
  const conversation = await runner.start({ text: '这个接口能并发调用吗', executionConfig: { executionMode: 'local' } });
  await settle(runner, conversation.conversationId);

  const synthesis = store.listMessages(conversation.conversationId).find(message => message.synthesis)?.synthesis;
  assert.equal(synthesis?.leadSummary ?? false, false, '没成就不算主导人结论');
  assert.equal(synthesis?.fusion?.leadAgentId, undefined, '没成就不记主导人');
  assert.ok((synthesis?.disputed?.length ?? 0) > 0, '规则版分歧保留');
});

// ---------------------------------------------------------------------------
// V2.1：双工作空间接进会话链路。
//
// 老行为是底线：`start({text})` 不带 workspaceMode 时，一个字节都不能变。
// 新分支全部由显式 `workspaceMode: 'engineering'` 触发。
// ---------------------------------------------------------------------------

const v21Root = mkdtempSync(join(tmpdir(), 'tf-v21-runner-'));
mkdirSync(join(v21Root, 'src'), { recursive: true });
writeFileSync(join(v21Root, 'src', 'index.ts'), 'export const virtualThread = 1;\n');
after(() => rmSync(v21Root, { recursive: true, force: true }));

test('V2.1：不带 workspaceMode 的旧调用仍然是旧会话', async () => {
  const channels = execChannels();
  const { runner, store } = execRunner(channels);
  const conversation = await runner.start({ text: '什么是连接池' });
  assert.equal(conversation.workspaceMode, undefined);
  assert.equal(conversation.routing, undefined);
  assert.equal(conversation.engineeringEvidence, undefined);
  assert.equal(conversation.intent, 'answer');
  await settle(runner, conversation.conversationId);
  assert.ok(store.listMessages(conversation.conversationId).some(message => message.role === 'channel'));
});

test('V2.1：工程空间没选项目，停下来问，不触发任何模型调用', async () => {
  const asked = [];
  const channels = execChannels().map(channel => ({
    ...channel,
    ask: async input => { asked.push(input.question); return channel.ask(input); }
  }));
  const { runner, store } = execRunner(channels);
  const conversation = await runner.start({
    text: '分析当前项目结构', workspaceMode: 'engineering'
  });
  assert.equal(conversation.status, 'awaiting_user');
  assert.equal(conversation.routing?.needsProject, true);
  assert.equal(asked.length, 0);
  assert.ok(store.listMessages(conversation.conversationId).some(
    message => message.role === 'system' && message.text.includes('选择项目')
  ));
});

test('V2.1：工程分析真的读文件，第一手网页提问仍是用户原话', async () => {
  const questions = [];
  const channels = [
    fakeChannel('a', async input => { questions.push(input.question); return answer('a 的回答'); }),
    fakeChannel('b', async input => { questions.push(input.question); return answer('b 的回答'); })
  ];
  const { runner, store } = execRunner(channels);
  const text = '分析当前项目结构里的 virtualThread';
  const conversation = await runner.start({
    text, workspaceMode: 'engineering', workspaceRoot: v21Root
  });
  await settle(runner, conversation.conversationId);

  assert.equal(conversation.routing?.taskKind, 'engineering_analysis');
  assert.ok((conversation.engineeringEvidence?.length ?? 0) > 0, '证据要落到会话上');
  assert.ok(conversation.engineeringEvidence?.some(item => item.path === 'src/index.ts'));
  // 前两句是发给两个网页通道的第一手问题：问题原样，不套角色行、不塞工程材料。
  assert.equal(questions[0], text);
  assert.equal(questions[1], text);
  assert.ok(questions.slice(0, 2).every(item => !item.includes('【工程证据')));
  // 工程证据只允许出现在「回答之后」的主导人汇总里（这次主导人是网页通道）。
  assert.ok(
    questions.slice(2).some(item => item.includes('【工程证据')),
    '工程证据要真的进主导人汇总材料，否则分析还是凭模型猜'
  );
  const system = store.listMessages(conversation.conversationId)
    .filter(message => message.role === 'system').map(message => message.text).join('\n');
  assert.match(system, /已读取工程目录/);
});

// 真机第一轮就踩到：结构分析在 scanProject 里算出来了，却只把 evidence 交给
// 汇总，analysis 直接丢掉——主导人看到的还是零散几行，符号索引和调用点白算。
test('V2.1：结构关系跟着证据一起进主导人材料，不是算完就丢', async () => {
  const questions = [];
  const channels = [
    fakeChannel('a', async input => { questions.push(input.question); return answer('a 的回答'); }),
    fakeChannel('b', async input => { questions.push(input.question); return answer('b 的回答'); })
  ];
  const { runner } = execRunner(channels);
  const conversation = await runner.start({
    text: '分析当前项目结构，并说明谁调用了 virtualThread',
    workspaceMode: 'engineering',
    workspaceRoot: v21Root
  });
  await settle(runner, conversation.conversationId);

  assert.ok(conversation.engineeringAnalysis, '结构分析要落到会话上，汇总才能引用');
  assert.match(conversation.engineeringAnalysis, /【结构概览】/);
  assert.ok(
    questions.slice(2).some(item => item.includes('【结构概览】')),
    '结构分析必须进主导人材料'
  );
  // 第一手提问仍然只有原话：结构分析也不能塞进那一问。
  assert.equal(questions[0], '分析当前项目结构，并说明谁调用了 virtualThread');
  assert.ok(questions.slice(0, 2).every(item => !item.includes('【结构概览】')));
});

test('V2.1：工程实施交去出计划，识别结果和项目一起存下来', async () => {
  let handed = null;
  const { runner } = makeRunner(execChannels(), {
    submitWorkspace: async input => { handed = input; return { taskId: 'task-v21' }; }
  });
  const conversation = await runner.start({
    text: '实现一个功能', workspaceMode: 'engineering', workspaceRoot: v21Root
  });
  assert.equal(conversation.taskId, 'task-v21');
  assert.equal(conversation.routing?.taskKind, 'engineering_execution');
  assert.equal(conversation.workspaceRoot, v21Root);
  assert.equal(handed.workspaceRoot, v21Root);
});

test('V2.1：表达含糊时待确认，不默认进高权限执行', async () => {
  const { runner } = makeRunner(execChannels());
  const conversation = await runner.start({
    text: '嗯……这个怎么说', workspaceMode: 'engineering', workspaceRoot: v21Root
  });
  assert.equal(conversation.status, 'awaiting_user');
  assert.equal(conversation.routing?.taskKind, 'clarify');
});

test('V2.1：用户手动改判优先于规则', async () => {
  const { runner } = makeRunner(execChannels());
  const conversation = await runner.start({
    text: '实现一个功能', workspaceMode: 'engineering', workspaceRoot: v21Root,
    taskKindOverride: 'analysis'
  });
  assert.equal(conversation.routing?.taskKind, 'engineering_analysis');
  assert.equal(conversation.routing?.source, 'user_selected');
});

test('V2.1：辩论关闭时主导人只汇总，不发起交锋', async () => {
  const channels = execChannels();
  const seen = [];
  let debateCalls = 0;
  const { runner, store } = execRunner(channels, {
    fusionEnabled: true,
    poolFor: () => execPool(channels, {
      local: task => { seen.push(task.question); return '【结论】好\n【一致】有\n【分歧】两种做法冲突吗？\n【存疑】没有\n【辩题】哪种做法更好？'; }
    }),
    executorIdsFor: () => new Set(['local']),
    agentSource: id => (id === 'local' ? 'local' : undefined),
    runDebate: async () => { debateCalls += 1; return { debateId: 'd', rounds: [], status: 'stopped' }; }
  });
  const conversation = await runner.start({
    text: '一个问题',
    executionConfig: { executionMode: 'local', debateMode: 'off' }
  });
  await settle(runner, conversation.conversationId);
  assert.equal(debateCalls, 0, 'off 时不应发起辩论');
  assert.equal(seen.length, 1, '只做一次汇总');
  const system = store.listMessages(conversation.conversationId)
    .filter(message => message.role === 'system').map(message => message.text).join('\n');
  assert.match(system, /关闭了辩论/);
});
