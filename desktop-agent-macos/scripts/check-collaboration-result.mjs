/**
 * U1：统一协作结果投影。
 *
 * 钉住三件事：
 * 1. Engineering 能从事件重建 reviews / verifications / conclusion；
 * 2. Review issues 有稳定 id，且 disposition 默认 pending（有评审 ≠ 已处理）；
 * 3. skipped 的计划辩论不制造争议条目；General 综合分歧能投影出来。
 *
 * Run with: npm run test:collaboration-result
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  disputeFromPlanDebate,
  projectConversationCollaborationResult,
  projectEngineeringCollaborationResult
} from '../out-test/shared/collaboration-result.js';

const taskId = 'task-u1';

test('Engineering：review.ready 投影出可追溯问题，默认未决定处理', () => {
  const view = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '改完了并验证通过',
    events: [
      {
        type: 'review.ready',
        at: 10,
        taskId,
        roundId: 'r1',
        reviewer: 'local-reviewer',
        backend: 'rules',
        verdict: '需要补测试',
        issues: ['缺少异常恢复', '测试未覆盖超时路径'],
        needsFix: true
      },
      { type: 'task.completed', at: 20, taskId, summary: '改完了并验证通过' }
    ]
  });

  assert.equal(view.scene, 'engineering');
  assert.ok(view.conclusion?.text.includes('改完了'));
  assert.equal(view.reviews.length, 1);
  assert.equal(view.reviews[0].issues.length, 2);
  assert.equal(view.reviews[0].issues[0].disposition, 'pending');
  assert.equal(view.reviews[0].issues[0].description, '缺少异常恢复');
  assert.ok(view.reviews[0].issues[0].sourceRefs[0]?.kind === 'review');
  // 同输入重建，issueId 不变。
  const again = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '改完了并验证通过',
    events: [
      {
        type: 'review.ready',
        at: 10,
        taskId,
        roundId: 'r1',
        reviewer: 'local-reviewer',
        backend: 'rules',
        verdict: '需要补测试',
        issues: ['缺少异常恢复', '测试未覆盖超时路径'],
        needsFix: true
      },
      { type: 'task.completed', at: 20, taskId, summary: '改完了并验证通过' }
    ]
  });
  assert.equal(again.reviews[0].issues[0].issueId, view.reviews[0].issues[0].issueId);
  assert.deepEqual(
    view.conclusion?.openItems,
    ['缺少异常恢复', '测试未覆盖超时路径']
  );
});

test('Engineering：skipped 计划辩论不进入 disputes', () => {
  const view = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '直接执行',
    events: [
      {
        type: 'plan.debated',
        at: 5,
        taskId,
        roundId: 'r1',
        planId: 'p1',
        debate: {
          status: 'skipped',
          topics: [],
          participants: [],
          summary: '',
          skippedReason: '模式关闭',
          at: 5
        }
      },
      { type: 'task.completed', at: 9, taskId, summary: '直接执行' }
    ]
  });
  assert.equal(view.disputes.length, 0);
  assert.equal(disputeFromPlanDebate(taskId, {
    status: 'skipped', topics: [], participants: [], summary: '', skippedReason: '模式关闭', at: 5
  }, 5), null);
});

test('General：综合分歧与一致观点进入统一投影', () => {
  const view = projectConversationCollaborationResult({
    conversation: {
      conversationId: 'c1',
      title: '测试',
      intent: 'research',
      intentReason: 't',
      status: 'answered',
      channels: ['gemini', 'deepseek'],
      createdAt: 1,
      updatedAt: 2
    },
    messages: [
      {
        messageId: 'm-syn',
        conversationId: 'c1',
        role: 'synthesis',
        at: 3,
        text: '综合',
        synthesis: {
          consensus: [{ text: '答案是 42', sources: [{ channelId: 'gemini', messageId: 'm1' }], evidence: [] }],
          disputed: [{
            topic: '年份',
            positions: [
              { channelId: 'gemini', stance: '2024' },
              { channelId: 'deepseek', stance: '2025' }
            ],
            pivot: '年份数字不一致'
          }],
          unique: [],
          gaps: [{ topic: '出处', why: '两边都没给链接' }],
          recommendation: '年份仍有分歧，先标不确定'
        }
      }
    ]
  });

  assert.equal(view.scene, 'general');
  assert.ok(view.conclusion?.text.includes('分歧'));
  assert.equal(view.keyOpinions.length, 1);
  assert.equal(view.keyOpinions[0].position, 'support');
  assert.equal(view.disputes.length, 1);
  assert.equal(view.disputes[0].claims.length, 2);
  assert.equal(view.disputes[0].status, 'identified');
  assert.ok(view.conclusion?.uncertainties.some(item => item.includes('出处')));
});
