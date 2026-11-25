/**
 * GDC-P1：目标投影与变更分类。
 * Run: npm run test:gdc-goal
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGoalFit,
  classifyGoalChange,
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
