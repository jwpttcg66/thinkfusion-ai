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
