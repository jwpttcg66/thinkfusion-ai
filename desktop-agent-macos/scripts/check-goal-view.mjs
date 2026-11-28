/**
 * V4 P1 M1-2：目标聚合投影。
 * Run: npm run test:goal-view
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { countBy, goalVersionLabel, groupTasksByGoal } from '../out-test/shared/goal-view.js';

function task(id, overrides = {}) {
  return { taskId: id, title: `任务 ${id}`, status: 'completed', updatedAt: 1000, ...overrides };
}

test('同一目标的几条任务归到一组，组内按时间倒序', () => {
  const groups = groupTasksByGoal([
    task('t1', { goalId: 'goal:a', updatedAt: 1000 }),
    task('t2', { goalId: 'goal:a', updatedAt: 3000 }),
    task('t3', { goalId: 'goal:b', updatedAt: 2000 })
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].goalId, 'goal:a');
  assert.deepEqual(groups[0].items.map(item => item.taskId), ['t2', 't1']);
  assert.equal(groups[0].latestAt, 3000);
});

test('没写目标的老任务落在「未绑定目标」，且永远排最后', () => {
  const groups = groupTasksByGoal([
    task('old1', { updatedAt: 9000 }),
    task('new', { goalId: 'goal:a', updatedAt: 1000 }),
    task('old2', { updatedAt: 8000 })
  ]);
  assert.deepEqual(groups.map(group => group.goalId), ['goal:a', null]);
  assert.equal(groups[1].unbound, true);
  assert.equal(groups[1].label, '未绑定目标');
  assert.deepEqual(groups[1].items.map(item => item.taskId), ['old1', 'old2']);
});

test('版本混排：升序去重，标题取最高版本的契约原文', () => {
  const groups = groupTasksByGoal([
    task('t1', {
      goalId: 'goal:a',
      goalVersion: 1,
      goalContract: { goalId: 'goal:a', goalVersion: 1, originalRequest: '旧口径：加日志' },
      updatedAt: 1000
    }),
    task('t2', {
      goalId: 'goal:a',
      goalVersion: 3,
      goalContract: { goalId: 'goal:a', goalVersion: 3, originalRequest: '新口径：加指标并接线' },
      updatedAt: 2000
    }),
    task('t3', { goalId: 'goal:a', goalVersion: 1, updatedAt: 3000 })
  ]);
  assert.deepEqual(groups[0].versions, [1, 3]);
  assert.equal(groups[0].label, '新口径：加指标并接线');
  assert.equal(goalVersionLabel(groups[0]), 'v1→v3');
});

test('目标只在契约里记着也算同一个目标', () => {
  const groups = groupTasksByGoal([
    task('t1', { goalContract: { goalId: 'goal:a', goalVersion: 2, originalRequest: '契约正文' } }),
    task('t2', { goalId: 'goal:a' })
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
  assert.deepEqual(groups[0].versions, [2]);
});

test('一个都没写版本就不显示版本；没有契约正文才退回任务标题', () => {
  const groups = groupTasksByGoal([task('t1', { goalId: 'goal:a', title: '修一下登录' })]);
  assert.deepEqual(groups[0].versions, []);
  assert.equal(goalVersionLabel(groups[0]), '');
  assert.equal(groups[0].label, '修一下登录');
});

test('任务没时间字段时 latestAt 为 null，不拿当前时间顶替', () => {
  const groups = groupTasksByGoal([
    { taskId: 't1', title: 'a', status: 'executing', goalId: 'goal:a' },
    { taskId: 't2', title: 'b', status: 'completed', goalId: 'goal:b', updatedAt: Number.NaN }
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].latestAt, null);
  assert.equal(groups[1].latestAt, null);
});

test('空列表就是空列表，不造一个空目标组', () => {
  assert.deepEqual(groupTasksByGoal([]), []);
});

test('状态计数按调用方给的口径，缺项不补 0', () => {
  const counts = countBy(
    [task('t1', { status: 'completed' }), task('t2', { status: 'blocked' }), task('t3', { status: 'completed' })],
    item => item.status
  );
  assert.deepEqual(counts, { completed: 2, blocked: 1 });
});

test('源码守卫：侧栏真的按目标分组，并且留了退回开关', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sidebar = fs.readFileSync(path.join(root, 'src/renderer/src/components/TaskSidebar.tsx'), 'utf8');
  assert.match(sidebar, /from '\.\.\/\.\.\/\.\.\/shared\/goal-view'/);
  assert.match(sidebar, /groupTasksByGoal\(goalRows\)/);
  assert.match(sidebar, /const \[groupByGoal, setGroupByGoal\] = React\.useState\(true\)/);
  assert.match(sidebar, /if \(!groupByGoal \|\| props\.workspaceMode !== 'engineering'\) return items\.map\(renderRow\)/);
  // 分组字段只能来自任务上已有的记录，不许在渲染层现编一个 goalId。
  assert.match(sidebar, /if \(!goalId\) return \{\}/);
});
