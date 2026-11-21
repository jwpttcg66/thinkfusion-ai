import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentStore } from '../out-test/main/store.js';

test('同一 stream 的 delta 只留最新，且不逐条写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-delta-'));
  const file = path.join(dir, 'agent-store.json');
  const store = new AgentStore(file);
  const base = { type: 'round.delta', at: 1, taskId: 't', roundId: 'r', streamId: 's', eventId: 'e1', sequence: 1, runId: 't', reasoning: 'a' };
  store.appendEvent(base);
  store.appendEvent({ ...base, at: 2, eventId: 'e2', sequence: 2, reasoning: 'ab' });
  store.appendEvent({ ...base, at: 3, eventId: 'e3', sequence: 3, reasoning: 'abc' });
  assert.equal(store.listEvents('t').length, 1, '内存只保留最新 delta');
  assert.equal(fs.existsSync(file), false, 'delta 不应逐条写盘');
  store.appendEvent({ type: 'round.answer', at: 4, taskId: 't', roundId: 'r', text: 'done', eventId: 'e4', sequence: 4, runId: 't' });
  const reloaded = new AgentStore(file);
  assert.equal(reloaded.listEvents('t').length, 2, 'answer 落盘时带一条最新 delta');
  fs.rmSync(dir, { recursive: true, force: true });
});
