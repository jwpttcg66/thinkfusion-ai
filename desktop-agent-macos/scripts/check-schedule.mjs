/**
 * 目标 / 定时 / 任务板：先把「不能做什么」测死。
 *
 * 最重要的是定时：`mode` 没有 web 这个选项，传 web 必须被拒——无人值守往网页
 * 发提示词会在用户账号里留会话。
 *
 * Run with: npm run test:schedule
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advance,
  computeNextRun,
  isDue,
  normalizeScheduleInput
} from '../out-test/shared/schedule.js';
import { PlanSchema, READ_ONLY_TOOLS } from '../out-test/shared/contracts.js';

const MINUTE = 60_000;

test('定时任务拒绝 web：只能 local 或 cloud', () => {
  assert.throws(
    () => normalizeScheduleInput({ text: '总结一下', mode: 'web', repeatMinutes: 60 }, Date.now()),
    /不碰网页/
  );
  const ok = normalizeScheduleInput({ text: '总结一下', mode: 'cloud', repeatMinutes: 60 }, 0);
  assert.equal(ok.mode, 'cloud');
  assert.equal(ok.nextRunAt, 60 * MINUTE);
});

test('要么给 at，要么给 repeatMinutes；间隔不能太短', () => {
  assert.throws(() => normalizeScheduleInput({ text: 'x', mode: 'local' }, 0), /要么给 at/);
  assert.throws(
    () => normalizeScheduleInput({ text: 'x', mode: 'local', repeatMinutes: 1 }, 0),
    /不能短于 5 分钟/
  );
});

test('一次性任务跑完自动停，重复任务推进到下一次', () => {
  const once = advance(
    { id: 'a', text: 'x', mode: 'local', at: 1000, nextRunAt: 1000, enabled: true, createdAt: 0 },
    2000
  );
  assert.equal(once.enabled, false);
  assert.equal(once.nextRunAt, null);

  const repeat = advance(
    { id: 'b', text: 'x', mode: 'cloud', repeatMinutes: 10, nextRunAt: 0, enabled: true, createdAt: 0 },
    5000
  );
  assert.equal(repeat.enabled, true);
  assert.equal(repeat.nextRunAt, 5000 + 10 * MINUTE);
});

test('isDue 只认启用且到点的', () => {
  const base = { id: 'a', text: 'x', mode: 'local', enabled: true, createdAt: 0 };
  assert.equal(isDue({ ...base, nextRunAt: 100 }, 100), true);
  assert.equal(isDue({ ...base, nextRunAt: 100 }, 99), false);
  assert.equal(isDue({ ...base, nextRunAt: 100, enabled: false }, 100), false);
});

test('computeNextRun：未来 at 原样用，过去 at 立即跑', () => {
  assert.equal(computeNextRun({ at: 5000 }, 1000), 5000);
  assert.equal(computeNextRun({ at: 500 }, 1000), 1000);
  assert.equal(computeNextRun({ repeatMinutes: 30 }, 1000), 1000 + 30 * MINUTE);
});

test('目标 / 定时 / 任务板都能写进计划；读取类工具是只读', () => {
  const steps = [
    { id: 's1', tool: 'goal.create', args: { text: '改成暗色主题' } },
    { id: 's2', tool: 'goal.get', args: {} },
    { id: 's3', tool: 'goal.update', args: { status: 'done' } },
    { id: 's4', tool: 'schedule.create', args: { text: '每天总结', mode: 'cloud', repeatMinutes: 1440 } },
    { id: 's5', tool: 'schedule.list', args: {} },
    { id: 's6', tool: 'team.spawn', args: { members: ['deepseek'] } },
    { id: 's7', tool: 'team.task.create', args: { title: '改文案' } },
    { id: 's8', tool: 'team.task.list', args: {} },
    { id: 's9', tool: 'team.task.update', args: { id: 'task-1', status: 'done' } },
    { id: 's10', tool: 'team.wait', args: {} }
  ];
  const parsed = PlanSchema.safeParse({
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 't1',
    roundId: 'r1',
    title: '治理',
    description: '',
    steps,
    completion: { condition: '都能跑' }
  });
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  for (const tool of ['goal.get', 'schedule.list', 'team.task.list', 'team.wait']) {
    assert.ok(READ_ONLY_TOOLS.includes(tool), `${tool} 应是只读`);
  }
  for (const tool of ['goal.create', 'goal.update', 'schedule.create', 'team.spawn']) {
    assert.equal(READ_ONLY_TOOLS.includes(tool), false, `${tool} 不该是只读`);
  }
});
