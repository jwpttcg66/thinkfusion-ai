/**
 * V4 P1 M1-3：目标变更影响面确认（事件投影 + 确认/取消两条路径）。
 * Run: npm run test:goal-revision
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isGoalRevisionPendingEvent,
  partitionImpactedTasks,
  planGoalRevision,
  projectPendingGoalRevision
} from '../out-test/shared/goal-driven-cycle.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function readSource(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function pending(overrides = {}) {
  return {
    type: 'goal.revision.pending',
    taskId: 'task:w1',
    goalId: 'goal:w1',
    fromVersion: 1,
    nextVersion: 2,
    reason: '目标变更影响 2 个未完成任务；已完成且不受影响的成果可继承',
    nextCriteria: ['登录接口有回归测试'],
    impactedTaskIds: ['wt:2', 'wt:3'],
    impactedTasks: [
      { workTaskId: 'wt:2', title: '补测试', status: 'running' },
      { workTaskId: 'wt:3', title: '接线CI', status: 'pending' }
    ],
    inheritedCount: 1,
    at: 2000,
    ...overrides
  };
}

test('重大变更先返回待确认计划，不落库也不抬版本', () => {
  const plan = planGoalRevision({
    tasks: [
      { workTaskId: 'wt:1', workId: 'w1', title: '已完成', status: 'completed', dependencies: [], acceptanceCriteria: [], complexity: 'low' },
      { workTaskId: 'wt:2', workId: 'w1', title: '在跑', status: 'running', dependencies: [], acceptanceCriteria: [], complexity: 'low' }
    ],
    previousVersion: 1,
    previousCriteria: ['有测试', '有文档'],
    nextCriteria: ['有测试']
  });
  assert.equal(plan.requiresUserConfirmation, true);
  // 未确认时 nextVersion 只是「确认后会是几」，任务上的版本此刻不能动。
  assert.equal(plan.nextVersion, 2);
  assert.deepEqual(plan.impactedTaskIds, ['wt:2']);
});

test('投影出待确认卡片：文案、新标准与受影响任务都取事件原文', () => {
  const event = pending();
  const shown = projectPendingGoalRevision({ events: [event], currentVersion: 1 });
  assert.equal(shown, event);
  assert.deepEqual(shown.nextCriteria, ['登录接口有回归测试']);
  assert.deepEqual(shown.impactedTasks.map(item => item.title), ['补测试', '接线CI']);
});

test('确认路径：版本抬起来后卡片不再出现', () => {
  assert.equal(projectPendingGoalRevision({ events: [pending()], currentVersion: 2 }), null);
  // 后续又改了几版，旧 pending 更不该回来。
  assert.equal(projectPendingGoalRevision({ events: [pending()], currentVersion: 5 }), null);
});

test('取消路径：后端没写任何东西，卡片还得在原地等人', () => {
  const shown = projectPendingGoalRevision({ events: [pending({ at: 1000 })], currentVersion: 1 });
  assert.notEqual(shown, null);
  assert.equal(shown.at, 1000);
});

test('多条待确认只认时间最新的一条，与数组先后无关', () => {
  const older = pending({ at: 1000, nextCriteria: ['旧口径'] });
  const newer = pending({ at: 9000, nextVersion: 3, nextCriteria: ['新口径'] });
  const shown = projectPendingGoalRevision({ events: [newer, older], currentVersion: 1 });
  assert.equal(shown.at, 9000);
  assert.deepEqual(shown.nextCriteria, ['新口径']);
});

test('别的事件不会被当成待确认，非事件类型也能安全过滤', () => {
  const events = [
    { type: 'log', at: 1, taskId: 'task:w1', level: 'warn', message: '目标变更等待用户确认' },
    { type: 'goal.contract.updated', taskId: 'task:w1', contract: { goalId: 'goal:w1' } }
  ];
  assert.deepEqual(events.filter(isGoalRevisionPendingEvent), []);
  assert.equal(projectPendingGoalRevision({ events: events.filter(isGoalRevisionPendingEvent), currentVersion: 1 }), null);
  assert.equal(isGoalRevisionPendingEvent(pending()), true);
});

test('源码守卫：重大变更不再只留一行日志', () => {
  const orchestrator = readSource('src/main/orchestrator.ts');
  assert.match(orchestrator, /type: 'goal\.revision\.pending'/);
  // M1-2 后一次修订按目标扇出：每条待确认事件的影响面取该任务自己的计划，不能是界面传来的那份。
  assert.match(orchestrator, /impactedTaskIds: target\.plan\.impactedTaskIds/);
  assert.match(orchestrator, /inheritedCount: target\.plan\.inheritedTaskIds\.length/);
  // 待确认事件必须活过事件裁剪，否则重启后卡片凭空消失。
  const store = readSource('src/main/store.ts');
  assert.match(store, /'goal\.revision\.pending'\n\]\);/);
});


test('源码守卫：确认走既有 reviseGoal 带 userConfirmedChange，且不再弹原生对话框', () => {
  const app = readSource('src/renderer/src/App.tsx');
  assert.match(app, /<GoalRevisionConfirm/);
  assert.match(app, /await reviseTaskGoal\(criteria, true\)/);
  const card = readSource('src/renderer/src/components/engineering/GoalContractCard.tsx');
  assert.doesNotMatch(card, /window\.confirm/);
  assert.match(card, /props\.onReviseGoal\(next, false\)/);
});

test('任务级节点与可执行步骤分开：折叠只发生在呈现层', () => {
  const { steps, structural } = partitionImpactedTasks([
    { workTaskId: 'wt-work-6a8b9375', title: '执行计划', status: 'ready' },
    { workTaskId: 'wt-group-6a8b9375', title: '执行计划', status: 'ready' },
    { workTaskId: 'wt-must-fail', title: 'shell.run', status: 'failed' },
    { workTaskId: 'wt-task-decomp-1', title: '子任务：查历史', status: 'pending' }
  ]);
  assert.deepEqual(structural.map(item => item.workTaskId), ['wt-work-6a8b9375', 'wt-group-6a8b9375']);
  // L2 子任务是有名字的真实工作，不能跟着汇总节点一起折掉。
  assert.deepEqual(steps.map(item => item.workTaskId), ['wt-must-fail', 'wt-task-decomp-1']);
  assert.equal(steps.length + structural.length, 4);
});

test('空清单不报错，全汇总节点时步骤侧走「没记下标题」以外的分支', () => {
  assert.deepEqual(partitionImpactedTasks([]), { steps: [], structural: [] });
  const onlyStructural = partitionImpactedTasks([{ workTaskId: 'wt-group-a', title: '执行计划', status: 'ready' }]);
  assert.equal(onlyStructural.steps.length, 0);
  assert.equal(onlyStructural.structural.length, 1);
});

test('源码守卫：确认卡按分账后的口径渲染，不直接列事件里的全部条目', () => {
  const card = readSource('src/renderer/src/components/engineering/GoalRevisionConfirm.tsx');
  assert.match(card, /partitionImpactedTasks\(pending\.impactedTasks\)/);
  assert.match(card, /const shown = steps\.slice\(/);
  assert.match(card, /className="grc-structural"/);
  assert.match(card, /className="muted grc-impact-summary"/);
  // 汇总数字必须来自 impactedTaskIds（事件原文），不能是折叠后的步骤数。
  assert.match(card, /受影响 \{String\(pending\.impactedTaskIds\.length/);
});
