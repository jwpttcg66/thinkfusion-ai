/**
 * GDC-P1：目标投影与变更分类。
 * Run: npm run test:gdc-goal
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGoalFit,
  classifyGoalChange,
  planGoalRevision,
  projectEngineeringGoal
} from '../out-test/shared/goal-driven-cycle.js';

test('目标投影：保留原始要求，不擅自改写意图', () => {
  const goal = projectEngineeringGoal({
    workId: 'w1',
    originalRequest: '完善 Java 代码理解能力',
    conversationGoal: {
      text: '让 Agent 能回答 Java 工程结构问题',
      status: 'active',
      updatedBy: 'user',
      updatedAt: 1
    },
    successCriteria: ['能列出主要类与依赖']
  });
  assert.equal(goal.originalRequest, '完善 Java 代码理解能力');
  assert.match(goal.intent, /Java/);
  assert.equal(goal.status, 'active');
  assert.deepEqual(goal.successCriteria, ['能列出主要类与依赖']);
  assert.equal(goal.openQuestions.length, 0);
});

test('变更分类：删减成功标准视为 change，不得当 clarify', () => {
  assert.equal(
    classifyGoalChange({
      previousCriteria: ['支持 Java 21', '跨模块调用图'],
      nextCriteria: ['支持 Java 21']
    }),
    'change'
  );
  assert.equal(
    classifyGoalChange({
      previousCriteria: ['支持 Java 21'],
      nextCriteria: ['支持 Java 21', '给出路径:行号']
    }),
    'clarify'
  );
});

test('符合度：有待修评审则 gap；完全验证且无待修则 met', () => {
  assert.equal(
    assessGoalFit({
      successCriteria: ['列出文件'],
      verified: true,
      fullyVerified: true,
      needsFix: true,
      openReviewIssues: 1
    }).fit,
    'gap'
  );
  assert.equal(
    assessGoalFit({
      successCriteria: ['列出文件'],
      verified: true,
      fullyVerified: true,
      needsFix: false,
      openReviewIssues: 0
    }).fit,
    'met'
  );
});

const task = (workTaskId, status, dependencies = []) => ({
  workTaskId,
  workId: 'w1',
  title: workTaskId,
  dependencies,
  acceptanceCriteria: ['有验收证据'],
  status,
  complexity: 'low',
  collaborationPolicy: { debate: 'auto', review: 'auto' },
  artifacts: [],
  evidence: [],
  revision: 1,
  createdAt: 1,
  updatedAt: 1
});

test('目标绑定：澄清不抬版本、不动任务', () => {
  const plan = planGoalRevision({
    tasks: [task('a', 'completed'), task('b', 'running')],
    previousVersion: 2,
    previousCriteria: ['列出文件'],
    nextCriteria: ['列出文件', '给出路径:行号']
  });
  assert.equal(plan.kind, 'clarify');
  assert.equal(plan.nextVersion, 2);
  assert.equal(plan.versionChanged, false);
  assert.deepEqual(plan.impactedTaskIds, []);
  assert.deepEqual(plan.inheritedTaskIds.sort(), ['a', 'b']);
});

test('目标绑定：重大变更未经确认不生效，受影响任务按闭包给出', () => {
  const tasks = [task('a', 'completed'), task('b', 'running'), task('c', 'pending', ['b'])];
  const blocked = planGoalRevision({
    tasks,
    previousVersion: 1,
    previousCriteria: ['支持 Java 21', '跨模块调用图'],
    nextCriteria: ['支持 Java 21']
  });
  assert.equal(blocked.kind, 'change');
  assert.equal(blocked.nextVersion, 2);
  assert.equal(blocked.requiresUserConfirmation, true);
  assert.deepEqual(blocked.impactedTaskIds.sort(), ['b', 'c']);
  // 已完成且不受影响的成果可继承
  assert.deepEqual(blocked.inheritedTaskIds, ['a']);

  const confirmed = planGoalRevision({
    tasks,
    previousVersion: 1,
    previousCriteria: ['支持 Java 21', '跨模块调用图'],
    nextCriteria: ['支持 Java 21'],
    userConfirmedChange: true
  });
  assert.equal(confirmed.requiresUserConfirmation, false);
  assert.equal(confirmed.nextVersion, 2);
});

test('目标绑定：指定受影响任务时只重规划该闭包，不做全量重来', () => {
  const tasks = [task('a', 'running'), task('b', 'running'), task('c', 'pending', ['a'])];
  const plan = planGoalRevision({
    tasks,
    previousVersion: 3,
    previousCriteria: ['x', 'y'],
    nextCriteria: ['x'],
    userConfirmedChange: true,
    changedTaskIds: ['a']
  });
  assert.deepEqual(plan.impactedTaskIds.sort(), ['a', 'c']);
  assert.deepEqual(plan.inheritedTaskIds, ['b']);
});
