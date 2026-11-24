/**
 * Context Manager 压缩接线（LT-P3/P5）。
 *
 * 验证：
 * - 历史超过阈值时调用摘要并在提交成功后只用摘要 + 最近事件；
 * - 摘要失败时保留未压缩历史，请求不被阻塞；
 * - 未配对工具调用不被压进摘要，保留在最近事件里。
 *
 * Run with: npm run test:context-compaction
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultContextManager } from '../out-test/main/context/manager.js';

const owner = { ownerType: 'agent-task', ownerId: 't1', taskId: 't1', runId: 'r1' };

function historyOf(count) {
  return Array.from({ length: count }, (_, index) => ({
    eventId: `e${index + 1}`,
    kind: 'message',
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `历史 ${index + 1}`,
    at: index
  }));
}

const summary = {
  goal: '原话',
  constraints: [],
  completed: [{ text: '已完成 1', certainty: 'claim', eventIds: ['e1'] }],
  decisions: [],
  evidence: [],
  openIssues: [],
  currentStep: null,
  nextActions: [],
  risks: [],
  stopConditions: []
};

function input(history) {
  return {
    owner,
    runId: 'r1',
    question: '原话',
    context: [],
    system: ['S'],
    history,
    evidenceRefs: [],
    providerId: 'cloud',
    modelId: 'm'
  };
}

test('历史超过阈值：摘要 + 最近事件；检查点提交后状态 committed', async () => {
  const events = [];
  let summarized = null;
  let committed = null;
  const manager = new DefaultContextManager({
    onEvent: event => events.push(event.type),
    compaction: {
      triggerAfter: 10,
      retainRecent: 4,
      summarize: async value => {
        summarized = value;
        return {
          summary,
          summaryHash: 'hash-1',
          sourceEventIds: value.history.map(item => item.eventId),
          modelId: 'm'
        };
      },
      commit: async value => {
        committed = value;
        return { checkpointId: 'cp-1' };
      }
    }
  });

  const prepared = await manager.prepare(input(historyOf(12)));
  assert.equal(prepared.question, '原话');
  assert.equal(prepared.context.compactionStatus, 'committed');
  assert.equal(prepared.context.checkpointId, 'cp-1');
  assert.equal(summarized.history.length, 8);
  assert.deepEqual(committed.retainedEventIds, ['e9', 'e10', 'e11', 'e12']);
  assert.ok(prepared.contextLines.some(line => line.includes('[摘要]')));
  assert.ok(prepared.contextLines.filter(line => line.includes('历史')).length === 4);
  assert.ok(events.includes('context.compaction.started'));
  assert.ok(events.includes('context.compaction.summary.ready'));
  assert.ok(events.includes('context.compaction.committed'));
});

test('摘要失败：保留未压缩历史，标记 failed，不阻塞请求', async () => {
  const events = [];
  const manager = new DefaultContextManager({
    onEvent: event => events.push(event.type),
    compaction: {
      triggerAfter: 5,
      retainRecent: 2,
      summarize: async () => { throw new Error('摘要模型超时'); },
      commit: async () => { throw new Error('不应提交'); }
    }
  });

  const prepared = await manager.prepare(input(historyOf(10)));
  assert.equal(prepared.context.compactionStatus, 'failed');
  assert.equal(prepared.context.checkpointId, undefined);
  assert.equal(prepared.contextLines.filter(line => line.includes('历史')).length, 10);
  assert.ok(events.includes('context.compaction.failed'));
});

test('未配对工具调用不压缩：保留在最近事件里', async () => {
  const history = historyOf(8);
  history.splice(2, 0, { eventId: 'tool-unpaired', kind: 'tool', text: '结果未知', at: 2 });
  let summarized = null;
  const manager = new DefaultContextManager({
    compaction: {
      triggerAfter: 5,
      retainRecent: 2,
      summarize: async value => {
        summarized = value;
        return { summary, summaryHash: 'h', sourceEventIds: value.history.map(item => item.eventId), modelId: 'm' };
      },
      commit: async () => ({ checkpointId: 'cp-2' })
    }
  });
  const prepared = await manager.prepare(input(history));
  assert.ok(!summarized.history.some(item => item.eventId === 'tool-unpaired'));
  assert.ok(prepared.contextLines.some(line => line.includes('结果未知')));
});
