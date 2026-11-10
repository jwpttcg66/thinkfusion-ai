import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateTotals,
  foldTrace,
  traceFromMessages
} from '../out-test/shared/trace.js';

function entry(partial) {
  return {
    conversationId: 'c1',
    at: 1000,
    turn: 1,
    step: 0,
    kind: 'step',
    phase: 'start',
    ...partial
  };
}

function turnStart(at = 1000) {
  return entry({
    seq: 1,
    kind: 'turn',
    phase: 'start',
    at,
    startedAt: at,
    status: 'running',
    inputPreview: '问题'
  });
}

function turnEnd(seq, at, status = 'ok') {
  return entry({ seq, kind: 'turn', phase: 'end', at, endedAt: at, status });
}

test('三通道两答一败：第一轮计数与部分失败状态', () => {
  const entries = [
    turnStart(),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1100 }),
    entry({ seq: 3, step: 2, stage: 'answer', group: 'first', status: 'running', actorId: 'b', startedAt: 1100 }),
    entry({ seq: 4, step: 1, phase: 'end', status: 'ok', endedAt: 1500 }),
    entry({ seq: 5, step: 2, phase: 'end', status: 'failed', endedAt: 1300, error: { code: 'auth', detail: '没有 Key' } }),
    turnEnd(6, 1600)
  ];
  const turns = foldTrace(entries);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].first.asked, 2);
  assert.equal(turns[0].first.answered, 1);
  assert.equal(turns[0].first.failed, 1);
  assert.equal(turns[0].status, 'ok');
  const totals = aggregateTotals(turns);
  assert.equal(totals.answered, 1);
  assert.equal(totals.failed, 1);
});

test('网页 usage 是 null：不是 0，覆盖率单独计数', () => {
  const entries = [
    turnStart(),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1100 }),
    entry({
      seq: 3, step: 1, phase: 'end', status: 'ok', endedAt: 1500,
      usage: { inputTokens: null, outputTokens: null }
    }),
    turnEnd(4, 1600)
  ];
  const turns = foldTrace(entries);
  const step = turns[0].steps[0];
  assert.equal(step.contextTokens, null);
  assert.equal(step.outputTokens, null);
  assert.equal(step.cacheHit, null);
  assert.equal(turns[0].coverage.usage, 0);
  assert.equal(aggregateTotals(turns).coverage.total, 1);
});

test('并行步骤：stepMs 可以大于 wallMs，两个都保留', () => {
  const entries = [
    turnStart(1000),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1000 }),
    entry({ seq: 3, step: 2, stage: 'answer', group: 'first', status: 'running', actorId: 'b', startedAt: 1000 }),
    entry({ seq: 4, step: 1, phase: 'end', status: 'ok', endedAt: 3000 }),
    entry({ seq: 5, step: 2, phase: 'end', status: 'ok', endedAt: 3000 }),
    turnEnd(6, 3000)
  ];
  const turn = foldTrace(entries)[0];
  assert.equal(turn.wallMs, 2000);
  assert.equal(turn.stepMs, 4000);
  assert.ok(turn.stepMs > turn.wallMs);
});

test('缓存命中按 token 加权，不是平均命中率', () => {
  const entries = [
    turnStart(),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1000 }),
    entry({ seq: 3, step: 1, phase: 'end', status: 'ok', endedAt: 1100, usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 10 } }),
    entry({ seq: 4, step: 2, stage: 'answer', group: 'first', status: 'running', actorId: 'b', startedAt: 1000 }),
    entry({ seq: 5, step: 2, phase: 'end', status: 'ok', endedAt: 1100, usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 } }),
    turnEnd(6, 1200)
  ];
  const turn = foldTrace(entries)[0];
  assert.equal(turn.cacheHit, 0.4);
});

test('轮结束但尾步没有 end：标 interrupted，墙钟仍可测', () => {
  const entries = [
    turnStart(1000),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1100 }),
    turnEnd(3, 5000, 'failed')
  ];
  const turn = foldTrace(entries)[0];
  assert.equal(turn.steps[0].status, 'interrupted');
  assert.equal(turn.wallMs, 4000);
});

test('只有 start 没有 turn end：保持 running', () => {
  const entries = [
    turnStart(1000),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1100 })
  ];
  const turn = foldTrace(entries)[0];
  assert.equal(turn.status, 'running');
  assert.equal(turn.steps[0].status, 'running');
});

test('事件行不进入步骤求和，但出现在 events', () => {
  const entries = [
    turnStart(),
    entry({ seq: 2, kind: 'event', phase: 'instant', stage: 'route', group: 'prepare', status: 'skipped', reason: '不读工程' }),
    turnEnd(3, 2000)
  ];
  const turn = foldTrace(entries)[0];
  assert.equal(turn.steps.length, 0);
  assert.equal(turn.events.length, 1);
  const totals = aggregateTotals([turn]);
  assert.equal(totals.steps, 0);
});

test('旧会话回退：source=messages，只有 at，无 token', () => {
  const conversation = { conversationId: 'c1', title: 't' };
  const messages = [
    { messageId: 'm1', conversationId: 'c1', role: 'user', text: '问', at: 1000 },
    { messageId: 'm2', conversationId: 'c1', role: 'channel', channelId: 'a', text: '答', at: 2000 }
  ];
  const fallback = traceFromMessages(conversation, messages);
  assert.equal(fallback.source, 'messages');
  const turns = foldTrace(fallback.entries);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].steps[0].status, 'ok');
  assert.equal(turns[0].steps[0].outputTokens, null);
});

test('订阅制 cost 为 null：合计不出现 0 元', () => {
  const entries = [
    turnStart(),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1000 }),
    entry({ seq: 3, step: 1, phase: 'end', status: 'ok', endedAt: 1100, usage: { outputTokens: 10, cost: null } }),
    turnEnd(4, 1200)
  ];
  const totals = aggregateTotals(foldTrace(entries));
  assert.deepEqual(totals.cost, []);
});

test('leading 不产生 answer 步；lead 步单独计数', () => {
  const entries = [
    turnStart(),
    entry({ seq: 2, step: 1, stage: 'answer', group: 'first', status: 'running', actorId: 'a', startedAt: 1000 }),
    entry({ seq: 3, step: 1, phase: 'end', status: 'ok', endedAt: 1500 }),
    entry({ seq: 4, step: 2, stage: 'lead', group: 'lead', status: 'running', actorId: 'a', startedAt: 1600 }),
    entry({ seq: 5, step: 2, phase: 'end', status: 'ok', endedAt: 2600 }),
    turnEnd(6, 2700)
  ];
  const turn = foldTrace(entries)[0];
  assert.equal(turn.first.asked, 1);
  assert.equal(turn.leadMs, 1000);
});
