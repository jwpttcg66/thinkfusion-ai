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

test('评审心跳原地更新同一行并显示已等秒数，不刷屏也不静默', () => {
  const events = [
    progress(1000, 'started'),
    progress(11000, 'waiting'),
    progress(21000, 'waiting'),
    progress(22000, 'done')
  ];
  const all = events.map(event => buildTimeline([...events.slice(0, events.indexOf(event) + 1)])
    .filter(item => item.kind === 'milestone' && item.text.includes('方案评审')));

  // 任意时刻对话流里只有一条评审节点，不会堆成一排。
  assert.equal(all[0].length, 1);
  assert.equal(all[1].length, 1);
  assert.equal(all[3].length, 1);
  // 文本随心跳滚动，用户能看到「还在跑」；结束时给出实测等待时长。
  assert.match(all[0][0].text, /方案评审开始.*2 个议题/);
  assert.match(all[1][0].text, /已等 10 秒/);
  assert.match(all[2][0].text, /已等 20 秒/);
  assert.match(all[3][0].text, /结束.*已等 21 秒/);
  // 节点位置固定：新增心跳不把这一行挪到对话最底下。
  assert.equal(all[0][0].key, all[3][0].key);
});

test('评审心跳不会伪造计划审批状态', () => {
  const view = applyTaskViewEvent(EMPTY_TASK_VIEW, progress(1000, 'started'));
  assert.equal(view.plan, null);
});
