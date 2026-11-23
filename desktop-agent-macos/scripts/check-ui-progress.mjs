/**
 * 「界面像卡住」的两个可测面：方案评审心跳的阶段归属与对话流噪音控制。
 *
 * Run with: npm run test:ui-progress
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTimeline } from '../out-test/shared/execution-timeline.js';
import { phaseOfEvent } from '../out-test/shared/task-events.js';
import { applyTaskViewEvent, EMPTY_TASK_VIEW } from '../out-test/shared/task-view.js';

function progress(at, state, extra = {}) {
  return {
    type: 'plan.review.progress', at, taskId: 't1', roundId: 'r1', planId: 'p1',
    state, topics: 2, elapsedMs: at - 1000, message: '评审心跳', ...extra
  };
}

test('方案评审心跳算在审批阶段，不再默认落到执行', () => {
  assert.equal(phaseOfEvent('plan.review.progress'), 'approval');
});

test('评审开始与结束留节点，10 秒心跳不刷屏', () => {
  const items = buildTimeline([
    progress(1000, 'started'),
    progress(11000, 'waiting'),
    progress(21000, 'waiting'),
    progress(22000, 'done')
  ]).filter(item => item.kind === 'milestone' && item.text.includes('方案评审'));

  assert.deepEqual(items.map(item => item.text), [
    '方案评审开始：2 个议题',
    '方案评审等待结束'
  ]);
});

test('评审心跳不会伪造计划审批状态', () => {
  const view = applyTaskViewEvent(EMPTY_TASK_VIEW, progress(1000, 'started'));
  assert.equal(view.plan, null);
});
