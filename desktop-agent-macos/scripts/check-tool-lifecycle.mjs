import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeline } from '../out-test/shared/execution-timeline.js';

const base = { taskId: 't', at: 1, eventId: 'e1', sequence: 1, runId: 't', phase: 'execution' };

test('preparing 不是执行：单独出现时状态是准备工具', () => {
  const items = buildTimeline([
    { ...base, type: 'step.preparing', roundId: 'r', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: { path: 'a.txt' } }
  ]);
  const card = items.find(item => item.kind === 'step')?.card;
  assert.equal(card?.stepId, 's1');
  assert.equal(card?.status, 'preparing');
});

test('同一 step 的 preparing/started/completed 合成一张卡，参数和结果都在', () => {
  const items = buildTimeline([
    { ...base, type: 'step.preparing', roundId: 'r', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: { path: 'a.txt' } },
    { ...base, at: 2, type: 'step.started', stepId: 's1', callId: 's1', tool: 'fs.writeFile', args: { path: 'a.txt' } },
    { ...base, at: 3, type: 'step.completed', stepId: 's1', tool: 'fs.writeFile', result: { bytes: 3 }, durationMs: 1 }
  ]);
  const cards = items.filter(item => item.kind === 'step');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card.status, 'completed');
  assert.deepEqual(cards[0].card.args, { path: 'a.txt' });
  assert.deepEqual(cards[0].card.result, { bytes: 3 });
});
