/**
 * GDC-P2/P3/P4/P5：循环派生、产物 supersedes、事件重放恢复、预算摘要。
 * Run: npm run test:gdc-cycle
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectConversationGoalWorkbench,
  projectGoalDrivenWorkbench,
  projectWorkCycleFromEvents
} from '../out-test/shared/goal-driven-cycle.js';

const taskId = 'task-gdc';

const baseEvents = [
  { type: 'round.started', at: 1, taskId, roundId: 'r1', roundNumber: 1, inputType: 'user' },
  {
    type: 'plan.ready',
    at: 2,
    taskId,
    roundId: 'r1',
    plan: {
      planId: 'p1',
      taskId,
      roundId: 'r1',
      title: '列出目录',
      description: 'd',
      completion: '列出文件名',
      steps: [{ id: 's1', tool: 'fs.list', args: {} }]
    }
  },
  {
    type: 'plan.debated',
    at: 3,
    taskId,
    roundId: 'r1',
    planId: 'p1',
    debate: {
      status: 'skipped',
      topics: [],
      participants: [],
      summary: '',
      skippedReason: '无争议',
      at: 3
    }
  },
  { type: 'step.started', at: 5, taskId, stepId: 's1', tool: 'fs.list' },
  { type: 'step.completed', at: 6, taskId, stepId: 's1', tool: 'fs.list', result: { entries: ['a'] } },
  {
    type: 'report.ready',
    at: 7,
    taskId,
    roundId: 'r1',
    report: {
      status: 'completed',
      results: [],
      verification: { verified: true, fullyVerified: true, reasons: [] }
    }
  },
  {
    type: 'review.ready',
    at: 8,
    taskId,
    roundId: 'r1',
    reviewer: 'rules',
    backend: 'rules',
    verdict: '需修复',
    issues: ['缺详情'],
    issueDetails: [{
      issueId: 'iss-1',
      title: '缺详情',
      description: '缺详情',
      severity: 'medium',
      disposition: 'pending'
    }],
    needsFix: true
  }
];

test('循环：无争议辩论标记 skipped；needsFix 回退到实现', () => {
  const cycle = projectWorkCycleFromEvents({ workId: taskId, events: baseEvents });
  assert.equal(cycle.debateSkipped, true);
  assert.ok(cycle.stages.some(item => item.stage === 'design_debate' && item.status === 'skipped'));
  assert.equal(cycle.conclusionType, 'needs_fix');
  assert.ok(cycle.rollback);
  assert.equal(cycle.rollback.to, 'implementation');
  assert.equal(cycle.currentStage, 'implementation');
});

test('产物：第二份计划 supersedes 第一份', () => {
  const events = [
    ...baseEvents,
    {
      type: 'plan.ready',
      at: 20,
      taskId,
      roundId: 'r2',
      plan: {
        planId: 'p2',
        taskId,
        roundId: 'r2',
        title: '修复轮计划',
        description: 'd',
        completion: '补详情',
        steps: [{ id: 's2', tool: 'fs.list', args: {} }]
      }
    }
  ];
  const view = projectGoalDrivenWorkbench({
    workId: taskId,
    originalRequest: '列出文件',
    events,
    summary: '修复中'
  });
  const plans = view.artifacts.filter(item => item.artifactType === 'plan');
  assert.equal(plans.length, 2);
  assert.equal(plans[0].status, 'superseded');
  assert.equal(plans[1].supersedesArtifactId, plans[0].artifactId);
});

test('决策：review.disposition 进入 decisions；同事件重放一致', () => {
  const events = [
    ...baseEvents,
    {
      type: 'review.disposition',
      at: 9,
      taskId,
      roundId: 'r1',
      issueId: 'iss-1',
      disposition: 'accepted',
      reason: '并入修复'
    }
  ];
  const a = projectGoalDrivenWorkbench({
    workId: taskId,
    originalRequest: '列出文件',
    events,
    summary: '修复中'
  });
  const b = projectGoalDrivenWorkbench({
    workId: taskId,
    originalRequest: '列出文件',
    events,
    summary: '修复中'
  });
  assert.equal(a.decisions.length, 1);
  assert.equal(a.decisions[0].decision, 'accepted');
  assert.equal(a.cycle.cycleId, b.cycle.cycleId);
  assert.equal(a.cycle.currentStage, b.cycle.currentStage);
  assert.deepEqual(
    a.artifacts.map(item => item.artifactId),
    b.artifacts.map(item => item.artifactId)
  );
});

test('预算：roundCount 来自 round.started；接近上限时 nextAction 提示', () => {
  const events = Array.from({ length: 7 }, (_, index) => ({
    type: 'round.started',
    at: index + 1,
    taskId,
    roundId: `r${String(index + 1)}`,
    roundNumber: index + 1,
    inputType: 'user'
  }));
  const cycle = projectWorkCycleFromEvents({ workId: taskId, events });
  assert.equal(cycle.budget.roundCount, 7);
  assert.equal(cycle.budget.nearLimit, true);
  assert.match(cycle.nextAction, /接近迭代预算/);
});

test('General：不强制八阶段实现/审核', () => {
  const view = projectConversationGoalWorkbench({
    conversationId: 'c1',
    originalRequest: '1+1等于几？',
    status: 'answered'
  });
  assert.ok(view.cycle.stages.every(item =>
    item.stage !== 'implementation' || item.status === 'skipped'));
  assert.ok(view.cycle.stages.some(item => item.stage === 'planning' && item.status === 'skipped'));
  assert.equal(view.cycle.conclusionType, 'accepted');
});

test('完成：task.completed 后 stage=done 且 accepted', () => {
  const events = [
    ...baseEvents.filter(event => event.type !== 'review.ready'),
    {
      type: 'review.ready',
      at: 8,
      taskId,
      roundId: 'r1',
      reviewer: 'rules',
      backend: 'rules',
      verdict: '通过',
      issues: [],
      needsFix: false
    },
    { type: 'task.completed', at: 10, taskId, summary: '完成' }
  ];
  const cycle = projectWorkCycleFromEvents({ workId: taskId, events, summary: '完成' });
  assert.equal(cycle.status, 'completed');
  assert.equal(cycle.currentStage, 'done');
  assert.equal(cycle.conclusionType, 'accepted');
});
