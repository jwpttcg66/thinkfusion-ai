/**
 * Phase F：协作策略与执行记录。
 *
 * 两条最该钉住的红线：任何策略都不能减少参与成员；任何策略都不能改用户
 * 的问题文本（Sequential 的前序结果走结构化 context，不拼进字符串）。
 *
 * Run with: npm run test:collaboration
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planCollaboration } from '../out-test/main/collaboration/strategy.js';
import { CollaborationResearch, runCollaboration } from '../out-test/main/collaboration/runner.js';

const AGENTS = [
  { id: 'web-a', label: '网页 A' },
  { id: 'local', label: '本地模型' },
  { id: 'cloud', label: '云端模型' }
];
const QUESTION = '17 乘 3 等于多少？';
const SIMPLE = ['a', 'b', 'c'].map(id => ({ id, label: id }));

function makePool(ids, behaviour, { failNewConversation = false } = {}) {
  const agents = ids.map(id => ({
    id,
    label: id,
    identity: { id, label: id, kind: 'provider', role: 'test' },
    health: async () => ({ id, label: id, available: true, loggedIn: true, pageReady: true, generating: false }),
    ask: async task => behaviour(id, task),
    cancel: () => {}
  }));
  return {
    all: async () => agents,
    available: async () => agents,
    ask: async (id, task) => {
      const agent = agents.find(item => item.id === id);
      if (!agent) throw new Error(`未知成员 ${id}`);
      return agent.ask(task);
    },
    newConversation: async () => (failNewConversation ? { ok: false, detail: '重置失败' } : { ok: true }),
    deleteConversation: async () => ({ ok: true }),
    cancel: () => {}
  };
}

function makeSink() {
  const calls = { join: [], phase: [], notes: [], status: [], records: [] };
  let seq = 0;
  return {
    calls,
    join: id => calls.join.push(id),
    record: answer => { seq += 1; calls.records.push(answer); return `m${seq}`; },
    phase: (id, phase, detail) => calls.phase.push({ id, phase, detail }),
    note: text => calls.notes.push(text),
    status: status => calls.status.push(status),
    cancelled: () => false
  };
}

const answer = id => ({
  agentId: id,
  text: `${id} 的回答`,
  receivedAt: Date.now(),
  attribution: { requestId: 'r', note: 'test' },
  stage: 'initial'
});

// ---------------------------------------------------------------------------

test('四种策略都不减少参与成员，且问题文本原样', () => {
  for (const strategy of ['smart', 'parallel', 'all-selected', 'sequential']) {
    const plan = planCollaboration({ strategy, question: QUESTION, agents: AGENTS, maxConcurrency: 2 });
    assert.equal(plan.tasks.length, AGENTS.length, `${strategy} 少了成员`);
    assert.deepEqual(plan.tasks.map(task => task.agentId), AGENTS.map(agent => agent.id));
    assert.ok(plan.tasks.every(task => task.question === QUESTION), `${strategy} 改了问题文本`);
    assert.ok(plan.reason.length > 0, `${strategy} 没有可解释的理由`);
  }
});

test('parallel 分批、all-selected 全量、sequential 每人一轮', () => {
  const parallel = planCollaboration({ strategy: 'parallel', question: QUESTION, agents: AGENTS, maxConcurrency: 2 });
  assert.equal(parallel.stages, 1);
  assert.equal(parallel.concurrency, 2);
  assert.ok(parallel.tasks.every(task => task.dependsOn.length === 0));

  const all = planCollaboration({ strategy: 'all-selected', question: QUESTION, agents: AGENTS, maxConcurrency: 2 });
  assert.equal(all.concurrency, 3, '全模型协作不分批');

  const seq = planCollaboration({ strategy: 'sequential', question: QUESTION, agents: AGENTS });
  assert.equal(seq.stages, 3);
  assert.equal(seq.concurrency, 1);
  assert.deepEqual(seq.tasks.map(task => task.stage), [0, 1, 2]);
  assert.deepEqual(seq.tasks[1].dependsOn, [seq.tasks[0].taskId]);
});

test('smart 用可解释的规则选串/并，理由里写着判据', () => {
  const simple = planCollaboration({ strategy: 'smart', question: '17 乘 3 等于多少？', agents: AGENTS });
  assert.match(simple.reason, /偏事实型/);
  assert.equal(simple.stages, 1);

  const complex = planCollaboration({
    strategy: 'smart',
    question: '请分析为什么这个方案在并发场景下会变慢，并比较几种优化路径的权衡',
    agents: AGENTS
  });
  assert.match(complex.reason, /递进协作/);
  assert.equal(complex.stages, 3);
});

test('runCollaboration：每个子任务有独立记录，状态与耗时齐全', async () => {
  const pool = makePool(['a', 'b', 'c'], id => Promise.resolve(answer(id)));
  const plan = planCollaboration({ strategy: 'parallel', question: QUESTION, agents: SIMPLE, maxConcurrency: 2 });
  const sink = makeSink();
  const result = await runCollaboration(pool, plan, sink);
  assert.equal(result.records.length, 3);
  assert.ok(result.records.every(record => record.status === 'done'));
  assert.ok(result.records.every(record => record.attempts === 1 && typeof record.latencyMs === 'number'));
  assert.equal(result.outcome.answers.length, 3);
  assert.ok(result.outcome.synthesis, '三条回答要出综合');
  assert.deepEqual(sink.calls.join.length, 3);
});

test('sequential：后序任务拿到前序回答作为 context，但 question 一个字没变', async () => {
  const seen = [];
  const ids = ['a', 'b', 'c'];
  const agents = ids.map(id => ({ id, label: id }));
  const pool = makePool(ids, (id, task) => {
    seen.push({ id, question: task.question, context: task.context ?? [], stage: task.stage });
    return Promise.resolve(answer(id));
  });
  const plan = planCollaboration({ strategy: 'sequential', question: QUESTION, agents });
  const result = await runCollaboration(pool, plan, makeSink());

  assert.deepEqual(seen.map(item => item.id), ids, '按顺序执行');
  assert.deepEqual(seen.map(item => item.context.length), [0, 1, 2]);
  assert.ok(seen.every(item => item.question === QUESTION), '问题文本不能被前序结果污染');
  assert.deepEqual(seen[1].context, ['a 的回答']);
  assert.deepEqual(seen[2].context, ['a 的回答', 'b 的回答']);
  assert.deepEqual(result.records.map(record => record.contextCount), [0, 1, 2]);
});

test('单个任务失败重试一次，且不影响同批其他人', async () => {
  let attempts = 0;
  const pool = makePool(['a', 'b', 'c'], id => {
    if (id === 'b') {
      attempts += 1;
      if (attempts === 1) throw new Error('页面忙');
      return Promise.resolve(answer(id));
    }
    return Promise.resolve(answer(id));
  });
  const plan = planCollaboration({ strategy: 'parallel', question: QUESTION, agents: SIMPLE, maxConcurrency: 3 });
  const result = await runCollaboration(pool, plan, makeSink());
  assert.equal(attempts, 2);
  assert.equal(result.records.find(r => r.agentId === 'b').attempts, 2);
  assert.ok(result.records.every(record => record.status === 'done'));
  assert.equal(result.outcome.failures.length, 0);
});

test('彻底失败的任务记 unanswered，其他人照常完成', async () => {
  const pool = makePool(['a', 'b', 'c'], id => {
    if (id === 'b') throw new Error('一直失败');
    return Promise.resolve(answer(id));
  });
  const plan = planCollaboration({ strategy: 'parallel', question: QUESTION, agents: SIMPLE, maxConcurrency: 3 });
  const result = await runCollaboration(pool, plan, makeSink());
  assert.equal(result.records.find(r => r.agentId === 'b').status, 'failed');
  assert.equal(result.outcome.answers.length, 2);
  assert.equal(result.outcome.failures.length, 1);
  assert.match(result.outcome.failures[0], /一直失败/);
});

test('用户中止后，尚未开始的任务是 skipped，不伪装成失败', async () => {
  const sink = makeSink();
  let cancelled = false;
  sink.cancelled = () => cancelled;
  const pool = makePool(['a', 'b', 'c'], id => {
    cancelled = true;
    return Promise.resolve(answer(id));
  });
  const plan = planCollaboration({ strategy: 'sequential', question: QUESTION, agents: SIMPLE });
  const result = await runCollaboration(pool, plan, sink);
  assert.ok(result.records.some(record => record.status !== 'done'));
  assert.equal(result.outcome.synthesis, null, '中止后不该包装出一份综合');
});

test('只有一条回答时不生成综合，避免把单个答案说成共识', async () => {
  const pool = makePool(['a'], id => Promise.resolve(answer(id)));
  const plan = planCollaboration({ strategy: 'parallel', question: QUESTION, agents: [{ id: 'a', label: 'a' }] });
  const result = await runCollaboration(pool, plan, makeSink());
  assert.equal(result.outcome.synthesis, null);
});

test('没有可用成员时报的是花名册里的名字，不是写死的站点', async () => {
  const pool = makePool([], () => Promise.resolve(answer('x')));
  await assert.rejects(
    new CollaborationResearch(pool, 'sequential', QUESTION).research(
      { question: QUESTION, followup: false, continuing: new Set() },
      makeSink()
    ),
    /没有可用的通道/
  );
});

test('CollaborationResearch 与 MasterAgent 同接口：research() 返回标准 outcome', async () => {
  const pool = makePool(['a', 'b'], id => Promise.resolve(answer(id)));
  const research = new CollaborationResearch(pool, 'all-selected', QUESTION);
  const outcome = await research.research({ question: QUESTION, followup: false, continuing: new Set() }, makeSink());
  assert.equal(outcome.answers.length, 2);
  assert.ok(outcome.synthesis);
  assert.equal(research.records().length, 2);
  assert.equal(research.plan().strategy, 'all-selected');
});
