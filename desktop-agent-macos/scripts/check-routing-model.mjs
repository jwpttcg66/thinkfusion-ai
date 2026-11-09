/**
 * 工程空间路由交给模型判定：判据、解析、兜底。
 *
 * 两组用例：
 *
 * 1. 纯函数——问句长什么样（用户原话必须原样在里）、模型回的那一行怎么解析、
 *    模型结论怎么套回 `TaskRouting`。这几条决定「模型说错时会不会出事」。
 * 2. 会话链路——本地 / 云端 / 混合三档真的会去问模型；网页主导不问（也绝不
 *    把分类问题发进用户网页的会话历史）；模型说判不了就退回规则。
 *
 * Run with: npm run test:routing-model
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRunner } from '../out-test/main/conversation-runner.js';
import {
  applyRoutingVerdict,
  buildRoutingQuestion,
  parseRoutingVerdict,
  ROUTING_SYSTEM
} from '../out-test/main/research/routing-classifier.js';
import { routeTask } from '../out-test/shared/workspace.js';

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('问句里用户原话逐字在，附件只报名字不塞正文', () => {
  const question = buildRoutingQuestion({
    text: '这个方案怎么样',
    attachmentNames: ['方案.md'],
    hasProject: true
  });
  assert.ok(question.includes('这个方案怎么样'));
  assert.ok(question.includes('方案.md'));
  assert.ok(!/研究伙伴|你是|请以/.test(question), '分类调用不套角色话术');
  // 没有附件时不出现「附了」这一行
  assert.ok(!buildRoutingQuestion({ text: 'x', hasProject: false }).includes('附了'));
});

test('判定时能看到附件开头，但只带一小段', () => {
  // 只报文件名时，「把这个 run.sh 跑一遍」和「这个方案」在模型眼里一样，
  // 判定只能靠句子里的词猜——等于又回到补动词表那条路。
  const long = 'x'.repeat(5000);
  const question = buildRoutingQuestion({
    text: '按这个文件执行',
    attachmentNames: ['deploy.md'],
    attachmentExcerpts: [
      { name: 'deploy.md', text: '# 部署步骤\n1. npm run build\n2. pm2 restart app' },
      { name: 'huge.log', text: long }
    ],
    hasProject: true
  });
  assert.ok(question.includes('pm2 restart app'), '附件开头要进判定问句');
  assert.ok(question.includes('deploy.md'));
  assert.ok(question.length < 3000, `判定问句不能被附件撑爆，实际 ${String(question.length)} 字`);
  assert.ok(!/研究伙伴|你是|请以/.test(question), '分类调用不套角色话术');
});

test('分类器的 system 只讲三类与输出格式，不含例子堆砌', () => {
  assert.match(ROUTING_SYSTEM, /analysis/);
  assert.match(ROUTING_SYSTEM, /execution/);
  assert.match(ROUTING_SYSTEM, /clarify/);
  assert.match(ROUTING_SYSTEM, /JSON/);
  assert.ok(ROUTING_SYSTEM.length < 600, 'system 太长会拖慢每次判定');
});

test('解析：裸 JSON、代码块、中文 kind、大小写都能认', () => {
  assert.deepEqual(parseRoutingVerdict('{"kind":"analysis","reason":"只是看看"}'), {
    kind: 'analysis', reason: '只是看看'
  });
  assert.equal(parseRoutingVerdict('```json\n{"kind":"execution","reason":"要改文件"}\n```').kind, 'execution');
  assert.equal(parseRoutingVerdict('{"kind":"分析","reason":"只读"}').kind, 'analysis');
  assert.equal(parseRoutingVerdict('{"kind":"EXECUTION","reason":"改"}').kind, 'execution');
  assert.equal(parseRoutingVerdict('好的：{"kind":"clarify","reason":"看不出"} 完毕').kind, 'clarify');
});

test('解析失败一律 null，绝不把「认不出」当成「分析」', () => {
  for (const raw of ['', 'analysis', '{}', '{"kind":"nonsense"}', '{"reason":"没 kind"}', '{"kind":123}', null, undefined]) {
    assert.equal(parseRoutingVerdict(raw), null, `不应解析出结论：${String(raw)}`);
  }
});

test('模型结论套回去：只改判定与理由，规则算出的 needsProject 保留', () => {
  const rule = routeTask({ text: '这个方案', workspaceMode: 'engineering', hasProject: false });
  const analysis = applyRoutingVerdict(rule, { kind: 'analysis', reason: '只读评审' });
  assert.equal(analysis.taskKind, 'engineering_analysis');
  assert.equal(analysis.source, 'model');
  assert.match(analysis.reason, /模型判定：只读评审/);
  assert.equal(analysis.needsProject, true, '项目还没选这件事不该被模型覆盖');

  const execution = applyRoutingVerdict(rule, { kind: 'execution', reason: '要落地' });
  assert.equal(execution.taskKind, 'engineering_execution');
  assert.equal(execution.engineeringKind, 'execution');

  const clarify = applyRoutingVerdict(
    routeTask({ text: '改这个', workspaceMode: 'engineering', hasProject: true }),
    { kind: 'clarify', reason: '看不出要改哪里' }
  );
  assert.equal(clarify.taskKind, 'clarify');
  assert.equal(clarify.needsClarification, true);
  assert.deepEqual(clarify.signals, []);
});

// ---------------------------------------------------------------------------
// 会话链路
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

function fakeRegistry() {
  return {
    all: async () => [],
    available: async () => [],
    list: () => [],
    get: () => undefined,
    ask: async () => { throw new Error('这一组用例不该真的发问'); },
    newConversation: async () => ({ ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel() {},
    cancelAll() {}
  };
}

function makeRunner(deps = {}) {
  return new ConversationRunner({
    store: fakeStore(),
    registry: fakeRegistry(),
    emit: () => {},
    submitWorkspace: async () => { throw new Error('这一组用例不该进入执行'); },
    ...deps
  });
}

test('模型主导（本地/云端/混合）时真的去问模型，并用它的结论', async () => {
  for (const executionMode of ['local', 'cloud', 'hybrid']) {
    const calls = [];
    const runner = makeRunner({
      routeWithModel: async input => {
        calls.push(input);
        return { kind: 'execution', reason: '用户要改文件' };
      }
    });
    const conversation = await runner.start({
      text: '这个方案',
      workspaceMode: 'engineering',
      workspaceRoot: '/tmp/project',
      executionConfig: { executionMode }
    });
    assert.equal(calls.length, 1, `${executionMode} 档应该判一次`);
    assert.equal(calls[0].text, '这个方案', '送给模型的是用户原话');
    assert.equal(conversation.routing.taskKind, 'engineering_execution');
    assert.equal(conversation.routing.source, 'model');
  }
});

test('网页主导不问模型：网页读不到别人的回答，还会污染用户账号', async () => {
  let called = 0;
  const runner = makeRunner({
    routeWithModel: async () => { called += 1; return { kind: 'execution', reason: 'x' }; }
  });
  const conversation = await runner.start({
    text: '这个方案',
    workspaceMode: 'engineering',
    workspaceRoot: '/tmp/project',
    executionConfig: { executionMode: 'web' }
  });
  assert.equal(called, 0);
  // 规则判不出来 → 待确认，这是网页主导时的正确行为
  assert.equal(conversation.routing.taskKind, 'clarify');
});

test('模型判不了（null / 抛错）就退回规则，不拦提问', async () => {
  for (const routeWithModel of [async () => null, async () => { throw new Error('ollama 没起'); }]) {
    const runner = makeRunner({ routeWithModel });
    const conversation = await runner.start({
      text: '分析一下连接池',
      workspaceMode: 'engineering',
      workspaceRoot: '/tmp/project',
      executionConfig: { executionMode: 'local' }
    });
    assert.equal(conversation.routing.taskKind, 'engineering_analysis');
    assert.equal(conversation.routing.source, 'rule');
  }
});

test('用户在输入框明确选了「本次按分析」就不问模型', async () => {
  let called = 0;
  const runner = makeRunner({
    routeWithModel: async () => { called += 1; return { kind: 'execution', reason: 'x' }; }
  });
  const conversation = await runner.start({
    text: '实现一个功能',
    workspaceMode: 'engineering',
    workspaceRoot: '/tmp/project',
    taskKindOverride: 'analysis',
    executionConfig: { executionMode: 'local' }
  });
  assert.equal(called, 0);
  assert.equal(conversation.routing.taskKind, 'engineering_analysis');
  assert.equal(conversation.routing.source, 'user_selected');
});

test('还没选工程目录不问模型：判了也跑不了，先让用户选目录', async () => {
  let called = 0;
  const runner = makeRunner({
    routeWithModel: async () => { called += 1; return { kind: 'analysis', reason: 'x' }; }
  });
  const conversation = await runner.start({
    text: '看看这个项目',
    workspaceMode: 'engineering',
    executionConfig: { executionMode: 'local' }
  });
  assert.equal(called, 0);
  assert.equal(conversation.routing.needsProject, true);
});
