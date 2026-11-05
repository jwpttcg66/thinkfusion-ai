/**
 * Phase 3 · 事件流与幂等（任务书第 9 节 / AC-14）。
 *
 * 状态快照回答「现在是什么样」，事件回答「怎么走到这一步」。这一组钉住：
 * 1. 开始、每轮开始/结束、修订、结论、停止、恢复、完成、失败都留下一条；
 * 2. `seq` 单调、`key` 唯一；同一个 key 再写一次不会多出一条（恢复重跑同一轮
 *    不会伪造一段「又开始了」）；
 * 3. 用户连续停止两次，事件里只有一条 `session.stopped`；
 * 4. 老辩论文件没有 `events` 字段也读得动，写入时自动创建。
 *
 * Run with: npm run test:debate-events
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendEvent, eventsOf, lastEvent, resumePointOf } from '../out-test/main/debate/events.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-events-'));
  const store = new DebateStore(dir);
  const ask = async (agentId, task) => {
    if (options.delayMs) await sleep(options.delayMs);
    const text = options.responder?.(agentId, task) ?? '这个接口可以并发调用，理由见文档。';
    return { agentId, text, receivedAt: Date.now(), attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
  };
  const orchestrator = new DebateOrchestrator(store, { ask });
  return { dir, store, orchestrator, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const config = (overrides = {}) => ({
  strategy: 'standard',
  maxRounds: 2,
  participants: ['a', 'b'],
  convergenceStop: false,
  ...overrides
});

function assertWellFormed(events) {
  let previous = 0;
  const keys = new Set();
  for (const event of events) {
    assert.ok(event.seq > previous, `seq 必须单调：${event.seq} 在 ${previous} 之后`);
    previous = event.seq;
    assert.equal(keys.has(event.key), false, `key 不能重复：${event.key}`);
    keys.add(event.key);
    assert.ok(event.eventId.includes('#'), 'eventId 要能看出属于哪一场');
    assert.ok(event.at > 0);
  }
}

test('起一场辩论，第一条事件是 session.created；跑完留下完整的一条链', async () => {
  const h = harness();
  const started = h.orchestrator.start('这个接口能并发调用吗', config());
  const state = await h.orchestrator.waitFor(started.debateId);

  const events = eventsOf(state);
  assert.equal(events[0].type, 'session.created');
  assert.equal(events[0].seq, 1);
  assertWellFormed(events);

  const types = events.map(event => event.type);
  assert.ok(types.includes('round.started'));
  assert.ok(types.includes('round.finished'));
  assert.ok(types.includes('verdict.recorded'));
  assert.equal(types[types.length - 1], 'session.completed', '最后一条是完成');

  // 两轮各自一条 started / finished，轮次号对得上。
  const startedRounds = events.filter(event => event.type === 'round.started').map(event => event.roundIndex);
  const finishedRounds = events.filter(event => event.type === 'round.finished').map(event => event.roundIndex);
  assert.deepEqual(startedRounds, [0, 1]);
  assert.deepEqual(finishedRounds, [0, 1]);

  // 读盘回来事件还在，顺序不变。
  const reloaded = h.store.get(started.debateId);
  assert.deepEqual(eventsOf(reloaded).map(event => event.seq), events.map(event => event.seq));
  h.cleanup();
});

test('同一个 key 再写一次不会多出一条（恢复重跑同一轮不伪造开始）', () => {
  const state = { debateId: 'd1', events: [] };
  assert.ok(appendEvent(state, { type: 'round.started', key: 'round.started:0', at: 1, roundIndex: 0 }));
  assert.equal(appendEvent(state, { type: 'round.started', key: 'round.started:0', at: 2, roundIndex: 0 }), null);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].at, 1, '重复写入连时间戳都不改');

  // 不同 key 正常追加，seq 接着走。
  appendEvent(state, { type: 'round.finished', key: 'round.finished:0', at: 3, roundIndex: 0 });
  assert.deepEqual(state.events.map(event => event.seq), [1, 2]);
  assert.equal(lastEvent(state).type, 'round.finished');
});

test('连续停止两次，事件里只有一条 session.stopped', async () => {
  const h = harness({ delayMs: 30 });
  const started = h.orchestrator.start('一个问题', config({ maxRounds: 3 }));
  h.orchestrator.stop(started.debateId);
  h.orchestrator.stop(started.debateId);
  const state = await h.orchestrator.waitFor(started.debateId, 8000);

  const stopped = eventsOf(state).filter(event => event.type === 'session.stopped');
  assert.equal(stopped.length, 1, '重复停止不该留下第二条');
  assert.equal(state.status, 'stopped');
  h.cleanup();
});

test('恢复会留下 session.resumed，恢复后能继续跑到完成', async () => {
  const h = harness({ delayMs: 40 });
  const started = h.orchestrator.start('一个问题', config({ maxRounds: 2 }));
  h.orchestrator.stop(started.debateId);
  await sleep(10);
  h.orchestrator.resume(started.debateId);
  const state = await h.orchestrator.waitFor(started.debateId, 10_000);

  const events = eventsOf(state);
  assertWellFormed(events);
  assert.equal(events.filter(event => event.type === 'session.resumed').length, 1);
  assert.equal(events.filter(event => event.type === 'session.completed').length, 1);
  assert.ok(events.some(event => event.type === 'verdict.recorded'), '恢复后也要给结论');
  h.cleanup();
});

test('老辩论文件没有 events 字段：读出来是 undefined，写入时自动建', async () => {
  const h = harness();
  const started = h.orchestrator.start('一个问题', config({ maxRounds: 1 }));
  await h.orchestrator.waitFor(started.debateId);

  const stored = h.store.get(started.debateId);
  const legacy = JSON.parse(JSON.stringify(stored));
  delete legacy.events;
  h.store.save(legacy);

  const reloaded = h.store.get(started.debateId);
  assert.equal(reloaded.events, undefined, '没记录过就不补空数组');

  appendEvent(reloaded, { type: 'session.completed', key: 'session.completed', at: 1 });
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.events[0].seq, 1);
  h.cleanup();
});

test('恢复点：已完成的轮次都数得出来', () => {
  const state = {
    debateId: 'd2',
    events: [
      { seq: 1, eventId: 'e1', type: 'round.finished', key: 'round.finished:0', at: 1, roundIndex: 0 },
      { seq: 2, eventId: 'e2', type: 'round.finished', key: 'round.finished:1', at: 2, roundIndex: 1 }
    ]
  };
  assert.equal(resumePointOf(state), 2);
  assert.equal(resumePointOf({ debateId: 'd3', events: [] }), 0);
});

test('轮次内所有成员都失败：这一轮照样收尾，失败原因如实落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-events-fail-'));
  const store = new DebateStore(dir);
  const orchestrator = new DebateOrchestrator(store, {
    // 让编排器在跑轮次时抛错：store.save 失败是可预期的异常路径。
    ask: async () => {
      throw new Error('模型调用失败');
    }
  });
  const started = orchestrator.start('一个问题', config({ maxRounds: 1 }));
  const state = await orchestrator.waitFor(started.debateId, 8000);
  const events = eventsOf(state);
  assert.ok(events.some(event => event.type === 'round.finished'), '失败成员也要给这一轮收尾');
  assert.equal(state.rounds[0].failures.length, 2, '两位都失败，如实记录');
  fs.rmSync(dir, { recursive: true, force: true });
});
