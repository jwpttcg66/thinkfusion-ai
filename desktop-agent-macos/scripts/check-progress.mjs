/**
 * 统一进度：阶段是从事件投影出来的，不是第二份状态。
 *
 * Run with: npm run test:progress
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveProgress } from '../out-test/shared/progress.js';

const at = ms => 1_000 + ms;

test('刚开始：判定是当前段', () => {
  const view = deriveProgress({ conversationStatus: 'thinking', events: [], startedAt: at(0) });
  assert.equal(view.current?.stage, 'routing');
  assert.equal(view.stages.find(s => s.stage === 'routing')?.state, 'active');
});

test('第一轮发出：提问成为当前段，判定已完成', () => {
  const view = deriveProgress({
    conversationStatus: 'collecting',
    events: [{ type: 'round.started', at: at(1000) }],
    startedAt: at(0)
  });
  assert.equal(view.current?.stage, 'asking');
  assert.equal(view.stages.find(s => s.stage === 'routing')?.state, 'done');
});

test('进入汇总：提问完成，汇总是当前段', () => {
  const view = deriveProgress({
    conversationStatus: 'synthesizing',
    events: [
      { type: 'round.started', at: at(1000) },
      { type: 'round.answer', at: at(2000) }
    ],
    startedAt: at(0)
  });
  assert.equal(view.current?.stage, 'synthesis');
  assert.equal(view.stages.find(s => s.stage === 'asking')?.state, 'done');
});

test('计划与应用步骤：执行段带「第几步」', () => {
  const view = deriveProgress({
    conversationStatus: 'answered',
    taskStatus: 'executing',
    events: [
      { type: 'round.started', at: at(1000) },
      { type: 'plan.ready', at: at(2000) },
      { type: 'step.started', at: at(3000), tool: 'fs.edit', index: 2, total: 5 }
    ],
    startedAt: at(0)
  });
  assert.equal(view.current?.stage, 'execution');
  assert.match(view.current?.detail ?? '', /2\/5/);
  assert.equal(view.stages.find(s => s.stage === 'synthesis')?.state, 'done');
});

test('报告与评审：评审结束，没有当前段', () => {
  const view = deriveProgress({
    conversationStatus: 'answered',
    taskStatus: 'completed',
    events: [
      { type: 'plan.ready', at: at(1000) },
      { type: 'step.started', at: at(2000), tool: 'fs.edit', index: 1, total: 1 },
      { type: 'report.ready', at: at(3000), report: { status: 'completed' } },
      { type: 'review.ready', at: at(4000), review: { needsFix: false } }
    ],
    startedAt: at(0)
  });
  assert.equal(view.current, null);
  assert.equal(view.stages.find(s => s.stage === 'review')?.state, 'done');
});

test('失败只标当前段，不把后面假装完成', () => {
  const view = deriveProgress({
    conversationStatus: 'failed',
    events: [{ type: 'round.started', at: at(1000) }],
    startedAt: at(0)
  });
  assert.equal(view.stages.find(s => s.stage === 'asking')?.state, 'failed');
  assert.equal(view.stages.find(s => s.stage === 'synthesis')?.state, 'pending');
});
