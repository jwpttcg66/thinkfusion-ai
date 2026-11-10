import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TraceStore } from '../out-test/main/trace/trace-store.js';
import { TraceRecorder } from '../out-test/main/trace/trace-recorder.js';
import { recordExecutionReport } from '../out-test/main/trace/execution-trace.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tf-trace-'));
}

function entry(overrides) {
  return {
    seq: 1,
    at: 1000,
    conversationId: 'c1',
    turn: 1,
    step: 0,
    kind: 'turn',
    phase: 'start',
    status: 'running',
    ...overrides
  };
}

test('追加、读回、分页与 meta', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  for (let seq = 1; seq <= 3; seq += 1) {
    assert.equal(store.append(entry({ seq, at: 1000 + seq })), true);
  }
  const all = store.readAll('c1');
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(item => item.seq), [1, 2, 3]);
  assert.deepEqual(store.meta('c1'), { lastSeq: 3, lastTurn: 1 });
  const page = store.read('c1', { limit: 2 });
  assert.deepEqual(page.entries.map(item => item.seq), [2, 3]);
  assert.equal(page.hasMore, true);
  const older = store.read('c1', { beforeSeq: 2, limit: 2 });
  assert.deepEqual(older.entries.map(item => item.seq), [1]);
  assert.equal(older.hasMore, false);
});

test('半行 JSON 被跳过，前面的记录仍可读', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  store.append(entry({ seq: 1 }));
  store.append(entry({ seq: 2, at: 1001 }));
  fs.appendFileSync(path.join(root, 'c1.jsonl'), '{"seq":3');
  assert.equal(store.readAll('c1').length, 2);
});

test('meta 在新实例里仍能读到', () => {
  const root = tempRoot();
  const first = new TraceStore(root);
  first.append(entry({ seq: 4, turn: 2 }));
  const second = new TraceStore(root);
  assert.deepEqual(second.meta('c1'), { lastSeq: 4, lastTurn: 2 });
});

test('openTurns 与 closeOpenTurns 收尾崩溃留下的轮', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  store.append(entry({ seq: 1, turn: 1, phase: 'start' }));
  store.append(entry({ seq: 2, turn: 1, phase: 'end', status: 'ok' }));
  store.append(entry({ seq: 3, turn: 2, phase: 'start' }));
  assert.deepEqual(store.openTurns('c1'), [2]);
  assert.equal(store.closeOpenTurns('c1', 5000), 1);
  assert.deepEqual(store.openTurns('c1'), []);
  const last = store.readAll('c1').at(-1);
  assert.equal(last.turn, 2);
  assert.equal(last.status, 'interrupted');
});

test('remove 删掉文件，读回空', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  store.append(entry({ seq: 1 }));
  store.remove('c1');
  assert.equal(store.readAll('c1').length, 0);
  assert.equal(fs.existsSync(path.join(root, 'c1.jsonl')), false);
});

test('记录器：join/asking/answered/failed/lead 与幂等 endTurn', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  const events = [];
  let now = 1000;
  const recorder = new TraceRecorder(store, 'c1', event => events.push(event), () => (now += 10));

  const turn = recorder.beginTurn({ inputPreview: '问题', reason: '研究' });
  assert.equal(turn, 1);
  recorder.beginGroup('first', '问题');
  recorder.join({ agentId: 'a', label: 'A', sourceType: 'web' });
  recorder.join({ agentId: 'b', label: 'B', sourceType: 'local' });
  recorder.record({
    agentId: 'a',
    text: '回答',
    receivedAt: now,
    attribution: { requestId: 'r1', note: 'test' },
    stage: 'initial',
    usage: { inputTokens: 10, outputTokens: 5 }
  }, 'm1');
  recorder.phase('a', 'asking');
  recorder.phase('a', 'answered');
  // b 从未 asking：轮结束时应记 skipped，不是 failed。
  recorder.phase('b', 'failed', '本地模型不在线');
  const lead = recorder.beginStep({
    stage: 'lead', group: 'lead', actorId: 'a', actorLabel: 'A', sourceType: 'web', reason: '汇总'
  });
  recorder.endStep(lead, { status: 'ok', outputPreview: '总结' });
  recorder.endTurn({ status: 'ok' });
  recorder.endTurn({ status: 'ok' });

  const entries = store.readAll('c1');
  const turnEnds = entries.filter(item => item.kind === 'turn' && item.phase === 'end');
  assert.equal(turnEnds.length, 1);
  // end 记录只写结束字段；stage/actor 在 start 记录上，靠 foldTrace 合并。
  const answerStart = entries.find(item => item.kind === 'step' && item.phase === 'start' && item.stage === 'answer');
  const answerEnd = entries.find(item => item.kind === 'step' && item.phase === 'end' && item.step === answerStart.step);
  assert.equal(answerEnd.status, 'ok');
  assert.equal(answerEnd.usage.outputTokens, 5);
  const skipped = entries.find(item => item.kind === 'event' && item.status === 'skipped');
  assert.ok(skipped);
  assert.equal(skipped.actorId, 'b');
  const leadStart = entries.find(item => item.stage === 'lead' && item.phase === 'start');
  const leadEnd = entries.find(item => item.kind === 'step' && item.phase === 'end' && item.step === leadStart.step);
  assert.equal(leadEnd.status, 'ok');
  assert.ok(events.length >= entries.length);
});

test('endStep(undefined) 不抛、不写', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  const recorder = new TraceRecorder(store, 'c1', () => undefined);
  recorder.beginTurn({});
  const before = store.readAll('c1').length;
  recorder.endStep(undefined, { status: 'ok' });
  assert.equal(store.readAll('c1').length, before);
});

test('写盘失败：append 返回 false，beginStep 仍返回 handle', () => {
  const blockedRoot = path.join(tempRoot(), 'not-a-directory');
  fs.writeFileSync(blockedRoot, 'x');
  const store = new TraceStore(blockedRoot);
  assert.equal(store.append(entry({ seq: 1 })), false);
  const recorder = new TraceRecorder(store, 'c1', () => undefined);
  recorder.beginTurn({});
  const handle = recorder.beginStep({
    stage: 'answer', group: 'first', actorId: 'a', actorLabel: 'A', sourceType: 'web'
  });
  assert.ok(handle);
  recorder.endStep(handle, { status: 'ok' });
});

test('执行报告落成 execute 步，时长来自 StepResult 而不是重新计时', () => {
  const root = tempRoot();
  const store = new TraceStore(root);
  const now = 10_000;
  recordExecutionReport(
    store,
    { taskId: 't1', conversationId: 'c-exec', title: '改一个文件' },
    {
      createdAt: now,
      status: 'completed',
      results: [
        { stepId: 's1', tool: 'read_file', status: 'completed', verified: true, durationMs: 10 },
        { stepId: 's2', tool: 'write_file', status: 'failed', verified: false, durationMs: 20, error: '权限不足' }
      ]
    },
    () => undefined
  );
  const entries = store.readAll('c-exec');
  const steps = entries.filter(item => item.kind === 'step' && item.phase === 'start');
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map(item => item.actorLabel), ['read_file', 'write_file']);
  assert.equal(steps[0].startedAt, now - 30);
  assert.equal(steps[0].startedAt + 10, steps[1].startedAt);
  const failed = entries.find(item => item.kind === 'step' && item.phase === 'end' && item.status === 'failed');
  assert.equal(failed.error.detail, '权限不足');
});
