/**
 * 方案评审要能看见「每个成员怎么评、想到什么」，而不是只有一个倒计时。
 *
 * Run with: npm run test:review-detail
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reviewPeerEvents, reviewRoundIdOf } from '../out-test/main/debate/review-progress.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

const labels = new Map([
  ['local-a', '本地 A'],
  ['cloud-b', '云端 B']
]);

const round = (index, patch = {}) => ({
  index,
  phase: 'independent',
  messages: [],
  startedAt: 1000,
  converged: false,
  failures: [],
  ...patch
});

const message = (roundIndex, agentId, text, extra = {}) => ({
  messageId: `m-${roundIndex}-${agentId}`,
  roundIndex,
  agentId,
  role: 'challenger',
  kind: 'judgement',
  text,
  ...extra
});

test('还在等的成员先出「评审中」卡，说话后同一张卡补上正文与推理', () => {
  const seen = new Set();
  const waiting = reviewPeerEvents({
    taskId: 't1', debateId: 'd1', labels, seen,
    state: { rounds: [], runningRound: round(0, { pending: ['local-a', 'cloud-b'] }) },
    at: 2000
  });
  assert.equal(waiting.events.length, 2);
  assert.ok(waiting.events.every(event => event.status === 'started'));
  assert.equal(waiting.events[0].label, '本地 A（第 1 轮评审）');
  assert.equal(waiting.events[0].roundId, reviewRoundIdOf('d1'));

  for (const key of waiting.keys) seen.add(key);

  const spoken = reviewPeerEvents({
    taskId: 't1', debateId: 'd1', labels, seen,
    state: {
      rounds: [],
      runningRound: round(0, {
        pending: [],
        messages: [message(0, 'local-a', '这 12 步可以合并到 8 步', { reasoning: '先看依赖再合并' })]
      })
    },
    at: 3000
  });
  assert.equal(spoken.events.length, 1);
  assert.equal(spoken.events[0].status, 'answered');
  assert.equal(spoken.events[0].text, '这 12 步可以合并到 8 步');
  assert.equal(spoken.events[0].reasoning, '先看依赖再合并');
  // 同一轮、同一成员：卡片 key 必须一致，否则会多出一张空卡。
  assert.equal(spoken.events[0].memberId, waiting.events[0].memberId);
});

test('轮询多次不重复出卡，第二轮的同名成员是新卡', () => {
  const seen = new Set();
  const snapshot = {
    rounds: [round(0, { messages: [message(0, 'local-a', '第一轮意见')] })],
    runningRound: round(1, { pending: ['local-a'] })
  };
  const first = reviewPeerEvents({ taskId: 't1', debateId: 'd1', labels, seen, state: snapshot, at: 2000 });
  assert.equal(first.events.length, 2);
  for (const key of first.keys) seen.add(key);

  const again = reviewPeerEvents({ taskId: 't1', debateId: 'd1', labels, seen, state: snapshot, at: 3000 });
  assert.equal(again.events.length, 0);

  const second = reviewPeerEvents({
    taskId: 't1', debateId: 'd1', labels, seen,
    state: {
      rounds: [round(0, { messages: [message(0, 'local-a', '第一轮意见')] })],
      runningRound: round(1, { pending: [], messages: [message(1, 'local-a', '第二轮回应')] })
    },
    at: 4000
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].label, '本地 A（第 2 轮评审）');
  assert.notEqual(second.events[0].memberId, '0:local-a');
});

test('辩论每落一次盘就回调快照，评审过程不靠轮询', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-review-progress-'));
  const store = new DebateStore(dir);
  const progress = [];
  const orchestrator = new DebateOrchestrator(store, {
    ask: async (agentId, task) => ({
      agentId,
      text: `${agentId} 对${String(task.stage)}的意见：可以合并步骤`,
      reasoning: '先看依赖',
      receivedAt: Date.now()
    }),
    onProgress: state => progress.push(state)
  });
  let started = null;
  try {
    started = orchestrator.start('评审这份计划', {
      strategy: 'standard', maxRounds: 2, participants: ['a', 'b'], convergenceStop: false
    });
    const done = await orchestrator.waitFor(started.debateId, 8000);
    assert.ok(done);
    assert.ok(progress.length >= 2, `落盘回调应多次触发，实际 ${String(progress.length)} 次`);

    const seen = new Set();
    const labels = new Map([['a', 'A'], ['b', 'B']]);
    const batch = reviewPeerEvents({
      taskId: 't1', debateId: started.debateId, labels, seen,
      state: { rounds: done.rounds, runningRound: done.runningRound }
    });
    const spoken = batch.events.filter(event => event.status === 'answered');
    assert.equal(spoken.length, done.rounds.reduce((n, round) => n + round.messages.length, 0));
    assert.ok(spoken.every(event => event.reasoning), '推理必须随成员事件一起带到界面');
  } finally {
    if (started) orchestrator.stop(started.debateId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('评审失败的成员如实标失败，不静默消失', () => {
  const batch = reviewPeerEvents({
    taskId: 't1', debateId: 'd1', labels, seen: new Set(),
    state: {
      rounds: [],
      runningRound: round(0, { pending: [], failures: [{ agentId: 'cloud-b', detail: '超时 120 秒' }] })
    },
    at: 2000
  });
  assert.equal(batch.events.length, 1);
  assert.equal(batch.events[0].status, 'failed');
  assert.equal(batch.events[0].error, '超时 120 秒');
});

test('成员卡用发言自己的时间：开始取轮次时间，结束取 endedAt 并带真实耗时', () => {
  const batch = reviewPeerEvents({
    taskId: 't1', debateId: 'd1', labels, seen: new Set(),
    state: {
      rounds: [],
      runningRound: round(0, {
        startedAt: 5_000,
        pending: ['local-a'],
        messages: [
          message(0, 'cloud-b', '意见', { startedAt: 6_000, endedAt: 65_000, createdAt: 65_000 })
        ]
      })
    },
    at: 9_999
  });
  const started = batch.events.find(event => event.status === 'started');
  const answered = batch.events.find(event => event.status === 'answered');
  // 开始卡不能等到落盘那一刻才出现（否则评审前一分钟没有任何卡）。
  assert.equal(started.at, 5_000);
  assert.equal(answered.at, 65_000);
  assert.equal(answered.durationMs, 59_000);
});

test('start() 在后台 run 之前就通知 onStart，第一轮「输出中」卡不再等落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-review-onstart-'));
  const store = new DebateStore(dir);
  const order = [];
  const orchestrator = new DebateOrchestrator(store, {
    ask: async agentId => ({ agentId, text: '意见', receivedAt: Date.now() }),
    onStart: () => order.push('start'),
    onProgress: () => order.push('progress')
  });
  let started = null;
  try {
    started = orchestrator.start('评审', {
      strategy: 'standard', maxRounds: 1, participants: ['a'], convergenceStop: false
    });
    assert.equal(order[0], 'start', `onStart 必须先于首次落盘，实际顺序 ${order.join(',')}`);
    assert.ok(order.includes('progress'));
  } finally {
    if (started) orchestrator.stop(started.debateId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('注册了 onStream 就走流式：增量逐块转发，最终正文以落盘为准', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-review-stream-'));
  const store = new DebateStore(dir);
  const chunks = [];
  const orchestrator = new DebateOrchestrator(store, {
    ask: async agentId => ({ agentId, text: '整段', receivedAt: Date.now() }),
    askStream: async (agentId, task, onDelta) => {
      onDelta({ text: '前半段' });
      onDelta({ text: '后半段' });
      onDelta({ reasoning: '推理中' });
      return { agentId, text: '前半段后半段', reasoning: '推理中', receivedAt: Date.now() };
    },
    onStream: (debateId, roundIndex, agentId, chunk) => chunks.push({ roundIndex, agentId, ...chunk })
  });
  let started = null;
  try {
    started = orchestrator.start('评审', {
      strategy: 'standard', maxRounds: 1, participants: ['a'], convergenceStop: false
    });
    const done = await orchestrator.waitFor(started.debateId, 8000);
    assert.ok(done);
    assert.equal(chunks.length, 3, '三块增量都应转发');
    assert.equal(chunks.map(item => item.text ?? '').join(''), '前半段后半段');
    assert.equal(chunks[0].roundIndex, 0);
    assert.equal(chunks[0].agentId, 'a');
    const spoken = done.rounds.flatMap(round => round.messages);
    assert.equal(spoken[0].text, '前半段后半段');
  } finally {
    if (started) orchestrator.stop(started.debateId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有 onStream 时不用流式，手动/知识空间辩论行为不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-review-nostream-'));
  const store = new DebateStore(dir);
  let streamCalls = 0;
  let askCalls = 0;
  const orchestrator = new DebateOrchestrator(store, {
    ask: async agentId => {
      askCalls += 1;
      return { agentId, text: '整段', receivedAt: Date.now() };
    },
    askStream: async agentId => {
      streamCalls += 1;
      return { agentId, text: '流式', receivedAt: Date.now() };
    }
  });
  let started = null;
  try {
    started = orchestrator.start('评审', {
      strategy: 'standard', maxRounds: 1, participants: ['a'], convergenceStop: false
    });
    await orchestrator.waitFor(started.debateId, 8000);
    assert.equal(streamCalls, 0);
    assert.equal(askCalls, 1);
  } finally {
    if (started) orchestrator.stop(started.debateId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
