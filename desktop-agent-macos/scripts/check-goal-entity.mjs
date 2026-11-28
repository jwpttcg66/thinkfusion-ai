/**
 * V4 P1 M1-2：目标实体化（同目标多任务、口径归属、懒迁移）。
 * Run: npm run test:goal-entity
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveGoalEntity, tasksUnderGoal } from '../out-test/shared/goal-entity.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function readSource(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/** 两条任务挂在同一个目标下，各自带一份契约快照。 */
function twoTasksOneGoal() {
  return [
    {
      taskId: 'a',
      title: '任务 A',
      status: 'completed',
      goalId: 'goal:a',
      goalVersion: 1,
      updatedAt: 1000,
      goalContract: {
        goalId: 'goal:a',
        originalRequest: '第一版目标原文',
        goalVersion: 1,
        criteria: [{ description: '有测试' }]
      }
    },
    {
      taskId: 'b',
      title: '任务 B',
      status: 'running',
      goalId: 'goal:a',
      goalVersion: 2,
      updatedAt: 2000,
      goalContract: {
        goalId: 'goal:a',
        originalRequest: '第二版目标原文',
        goalVersion: 2,
        criteria: [{ description: '有测试' }, { description: '有文档' }]
      }
    }
  ];
}

test('老数据没有实体时按版本最高的契约快照派生，与侧栏组标题同一口径', () => {
  const entity = resolveGoalEntity({ goalId: 'goal:a', stored: null, tasks: twoTasksOneGoal() });
  assert.equal(entity.source, 'contract');
  assert.equal(entity.version, 2);
  assert.equal(entity.title, '第二版目标原文');
  assert.deepEqual(entity.criteria, ['有测试', '有文档']);
  assert.deepEqual(entity.taskIds, ['a', 'b']);
  assert.equal(entity.updatedAt, 2000);
  // 数组先后不能改变派生结论；任务名单则按任务本身的顺序给。
  const reversed = resolveGoalEntity({ goalId: 'goal:a', stored: null, tasks: twoTasksOneGoal().reverse() });
  assert.deepEqual({ ...reversed, taskIds: [...reversed.taskIds].sort() }, { ...entity, taskIds: [...entity.taskIds].sort() });
  assert.deepEqual(reversed.taskIds, ['b', 'a']);
});

test('落库实体优先于任务快照，但任务名单仍来自任务本身', () => {
  const entity = resolveGoalEntity({
    goalId: 'goal:a',
    stored: { goalId: 'goal:a', title: '落库目标', version: 5, criteria: [' 有测试 ', '', '有CI'], updatedAt: 9000 },
    tasks: twoTasksOneGoal()
  });
  assert.equal(entity.source, 'stored');
  assert.equal(entity.version, 5);
  assert.deepEqual(entity.criteria, ['有测试', '有CI']);
  assert.equal(entity.title, '落库目标');
  assert.deepEqual(entity.taskIds, ['a', 'b']);
});

test('实体版本不是数字时如实给 null，不顶成 v1', () => {
  const entity = resolveGoalEntity({
    goalId: 'goal:a',
    stored: { goalId: 'goal:a', title: '坏数据', version: Number.NaN, criteria: [], updatedAt: 1 },
    tasks: []
  });
  assert.equal(entity.version, null);
});

test('任务没写标准时来源记为 none，版本取任务记过的最高值', () => {
  const entity = resolveGoalEntity({
    goalId: 'goal:c',
    stored: null,
    tasks: [{ taskId: 'c', title: 'C', status: 'running', goalId: 'goal:c', goalVersion: 3, updatedAt: 500 }]
  });
  assert.equal(entity.source, 'none');
  assert.equal(entity.version, 3);
  assert.deepEqual(entity.criteria, []);
  assert.equal(entity.title, '');
});

test('一条任务都没挂在这个目标下时不编版本、不编时间', () => {
  const entity = resolveGoalEntity({
    goalId: 'goal:z',
    stored: null,
    tasks: [{ taskId: 'd', title: 'D', status: 'running', updatedAt: 700 }]
  });
  assert.deepEqual(entity.taskIds, []);
  assert.equal(entity.version, null);
  assert.equal(entity.updatedAt, null);
  assert.equal(entity.source, 'none');
});

test('空输入不报错', () => {
  const entity = resolveGoalEntity({ goalId: 'goal:empty', stored: null, tasks: [] });
  assert.deepEqual(entity, {
    goalId: 'goal:empty',
    title: '',
    version: null,
    criteria: [],
    updatedAt: null,
    source: 'none',
    taskIds: []
  });
});

test('归属判定与侧栏一致：goalId 只写在契约里的任务也算同目标', () => {
  const tasks = [
    { taskId: 'x', title: 'X', status: 'running', goalContract: { goalId: 'goal:x', criteria: [{ description: '甲' }] } },
    { taskId: 'y', title: 'Y', status: 'running', goalId: 'goal:y' }
  ];
  assert.deepEqual(tasksUnderGoal('goal:x', tasks).map(item => item.taskId), ['x']);
  assert.deepEqual(tasksUnderGoal('goal:y', tasks).map(item => item.taskId), ['y']);
  assert.deepEqual(tasksUnderGoal('goal:none', tasks), []);
});

test('源码守卫：修订按目标扇出，新口径落到目标实体', () => {
  const orchestrator = readSource('src/main/orchestrator.ts');
  assert.match(orchestrator, /const entity = resolveGoalEntity\(\{ goalId, stored: this\.deps\.store\.getGoal\(goalId\)/);
  assert.match(orchestrator, /const previousVersion = entity\.version \?\? task\.goalVersion \?\? 1/);
  assert.match(orchestrator, /this\.deps\.store\.upsertGoal\(\{/);
  assert.match(orchestrator, /const targets = tasksUnderGoal\(goalId, allTasks\)\.map/);
  assert.match(orchestrator, /for \(const target of targets\) \{/);
  // 待确认事件必须带上同目标名单，否则卡片说不出「还有谁被带着走」。
  assert.match(orchestrator, /goalTasks,\n          at: Date\.now\(\)/);
  // 兄弟任务不能沿用界面传来的 changedTaskIds，那会漏算影响面。
  assert.doesNotMatch(orchestrator, /tasks: itemWorkTasks,[\s\S]*?changedTaskIds: input\.changedTaskIds/);
});

test('源码守卫：新建任务能把新任务挂到既有目标下', () => {
  const orchestrator = readSource('src/main/orchestrator.ts');
  assert.match(orchestrator, /const boundGoal = boundGoalId\n\s*\? resolveGoalEntity/);
  assert.match(orchestrator, /stored: this\.deps\.store\.getGoal\(boundGoalId\)/);
  assert.match(orchestrator, /\.\.\.\(boundGoalId \? \{ goalId: boundGoalId \} : \{\}\)/);
  assert.match(orchestrator, /goalVersion: boundGoal\.version/);
  const schemas = readSource('src/shared/schemas.ts');
  assert.match(schemas, /goalId: z\.string\(\)\.min\(1\)\.max\(120\)\.optional\(\)/);
});

test('源码守卫：目标表落在同一个 journal 里，老数据读得通', () => {
  const store = readSource('src/main/store.ts');
  assert.match(store, /goals\?: StoredGoal\[\];/);
  assert.match(store, /goals: parsed\.goals \?\? \[\]/);
  assert.match(store, /goals: \[\]/);
  assert.match(store, /upsertGoal\(goal: StoredGoal\) \{/);
});

test('源码守卫：界面有绑定入口，确认卡列出一起生效的同目标任务', () => {
  const card = readSource('src/renderer/src/components/engineering/GoalContractCard.tsx');
  assert.match(card, /onCreateTaskInGoal\?: \(prompt: string\) => Promise<void>/);
  assert.match(card, /在此目标下新建任务/);
  const app = readSource('src/renderer/src/App.tsx');
  assert.match(app, /onCreateTaskInGoal=\{async prompt => \{/);
  assert.match(app, /goalId: activeTask\.goalId \?\? engineeringWorkbench\?\.goal\.goalId/);
  const confirm = readSource('src/renderer/src/components/engineering/GoalRevisionConfirm.tsx');
  assert.match(confirm, /pending\.goalTasks &&/);
  assert.match(confirm, /条任务一起生效：/);
});
