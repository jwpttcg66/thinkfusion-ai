/**
 * LT-P2 工具历史配对与确定性裁剪。
 *
 * Run with: npm run test:context-pruner
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { toToolHistory } from '../out-test/main/context/adapters/tool-history.js';
import { pruneToolHistory } from '../out-test/main/context/compaction/pruner.js';

const at = n => 1_000 + n;

test('工具历史：started/completed 配对，保留 resultRef', () => {
  const entries = toToolHistory([
    { type: 'step.started', at: at(1), taskId: 't', stepId: 's1', callId: 'c1', tool: 'shell.run', args: { command: 'go run main.go' } },
    { type: 'step.completed', at: at(2), taskId: 't', stepId: 's1', callId: 'c1', tool: 'shell.run', result: { stdout: 'hello' } }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'completed');
  assert.equal(entries[0].resultRef, 'step:s1');
  assert.match(entries[0].argsText ?? '', /go run main.go/);
  assert.match(entries[0].resultText ?? '', /hello/);
});

test('工具历史：失败调用保留错误，未完成调用不丢', () => {
  const entries = toToolHistory([
    { type: 'step.started', at: at(1), taskId: 't', stepId: 's1', tool: 'shell.run' },
    { type: 'step.failed', at: at(2), taskId: 't', stepId: 's1', tool: 'shell.run', error: 'exit 1' },
    { type: 'step.preparing', at: at(3), taskId: 't', stepId: 's2', callId: 'c2', tool: 'fs.readFile', args: { path: 'a.go' } }
  ]);
  const failed = entries.find(item => item.stepId === 's1');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.error, 'exit 1');
  const pending = entries.find(item => item.stepId === 's2');
  assert.equal(pending?.status, 'running');
});

test('工具历史：同一 stepId 不同 attemptId 不合并', () => {
  const entries = toToolHistory([
    { type: 'step.started', at: at(1), taskId: 't', stepId: 's1', callId: 'c1', attemptId: 'a1', tool: 'shell.run' },
    { type: 'step.failed', at: at(2), taskId: 't', stepId: 's1', callId: 'c1', attemptId: 'a1', tool: 'shell.run', error: 'fail' },
    { type: 'step.started', at: at(3), taskId: 't', stepId: 's1', callId: 'c1', attemptId: 'a2', tool: 'shell.run' },
    { type: 'step.completed', at: at(4), taskId: 't', stepId: 's1', callId: 'c1', attemptId: 'a2', tool: 'shell.run', result: { stdout: 'ok' } }
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(item => item.attemptId), ['a1', 'a2']);
});

test('裁剪：大输出保留头尾与原文引用，失败错误不丢', () => {
  const long = 'x'.repeat(10_000);
  const entries = toToolHistory([
    { type: 'step.started', at: at(1), taskId: 't', stepId: 's1', tool: 'shell.run', args: { command: 'mvn test' } },
    { type: 'step.completed', at: at(2), taskId: 't', stepId: 's1', tool: 'shell.run', result: { stdout: long, exitCode: 0 } },
    { type: 'step.started', at: at(3), taskId: 't', stepId: 's2', tool: 'shell.run' },
    { type: 'step.failed', at: at(4), taskId: 't', stepId: 's2', tool: 'shell.run', error: 'boom', args: { command: 'bad' } }
  ]);
  const pruned = pruneToolHistory(entries, { maxResultChars: 400 });
  const s1 = pruned.find(item => item.stepId === 's1');
  assert.equal(s1?.pruned, true);
  assert.match(s1?.resultText ?? '', /完整内容见 step:s1/);
  assert.match(s1?.resultText ?? '', /原始 \d+ 字符/);
  const s2 = pruned.find(item => item.stepId === 's2');
  assert.equal(s2?.status, 'failed');
  assert.equal(s2?.error, 'boom');
});

test('裁剪：运行中的调用不裁，避免破坏配对', () => {
  const entries = toToolHistory([
    { type: 'step.preparing', at: at(1), taskId: 't', stepId: 's1', callId: 'c1', tool: 'shell.run', args: { command: 'long' } }
  ]);
  const pruned = pruneToolHistory(entries, { maxResultChars: 10 });
  assert.equal(pruned[0].pruned, undefined);
});
