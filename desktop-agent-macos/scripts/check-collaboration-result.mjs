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

test('Engineering：PlanDebate.result 有争议才进 disputes，无争议不伪造双方', () => {
  const withDispute = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '计划已评审',
    events: [
      {
        type: 'plan.debated',
        at: 5,
        taskId,
        roundId: 'r1',
        planId: 'p1',
        debate: {
          debateId: 'd1',
          status: 'completed',
          topics: ['步骤顺序'],
          participants: ['a', 'b'],
          summary: '摘要',
          at: 5,
          result: {
            claims: [
              { claimId: 'c1', author: 'a', text: '先编译' },
              { claimId: 'c2', author: 'b', text: '先测试' }
            ],
            disputes: [{
              disputeId: 'dp1',
              type: 'scope',
              reason: '顺序冲突',
              claimIds: ['c1', 'c2'],
              agents: ['a', 'b']
            }],
            exchanges: [
              { author: 'a', kind: 'position', text: '先编译', roundIndex: 0, phase: 'analysis' },
              { author: 'b', kind: 'rebuttal', text: '应先测', roundIndex: 1, phase: 'challenge' }
            ],
            verdict: {
              verdict: 'partially_supported',
              conclusion: '先编译再测',
              rationale: '依赖关系要求编译优先',
              unresolved: [],
              backend: 'rules'
            }
          }
        }
      },
      { type: 'task.completed', at: 9, taskId, summary: '计划已评审' }
    ]
  });
  assert.equal(withDispute.disputes.length, 1);
  assert.equal(withDispute.disputes[0].claims.length, 2);
  assert.ok(withDispute.disputes[0].verdict?.includes('编译'));
  assert.ok(withDispute.keyOpinions.length >= 2);

  const noDispute = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '一致通过',
    events: [
      {
        type: 'plan.debated',
        at: 5,
        taskId,
        roundId: 'r1',
        planId: 'p1',
        debate: {
          debateId: 'd2',
          status: 'completed',
          topics: ['风险'],
          participants: ['a', 'b'],
          summary: '双方同意',
          at: 5,
          result: {
            claims: [
              { claimId: 'c1', author: 'a', text: '可以执行' },
              { claimId: 'c2', author: 'b', text: '同意' }
            ],
            disputes: [],
            exchanges: []
          }
        }
      },
      { type: 'task.completed', at: 9, taskId, summary: '一致通过' }
    ]
  });
  assert.equal(noDispute.disputes.length, 0, '无实质争议时不得伪造争议条目');
  assert.ok(noDispute.keyOpinions.length >= 2);
});

test('Engineering：review.ready 的 issueDetails 优先于字符串 issues', () => {
  const view = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '完成',
    events: [
      {
        type: 'review.ready',
        at: 10,
        taskId,
        roundId: 'r1',
        reviewer: '独立模型',
        backend: 'model',
        verdict: '需修复：缺少超时处理',
        rawVerdict: '【结论】需修复\n1. 缺少超时处理',
        issues: ['缺少超时处理'],
        issueDetails: [{
          issueId: 'iss-1',
          title: '缺少超时处理',
          description: '网络调用没有超时上限',
          severity: 'high',
          disposition: 'pending',
          recommendation: '为 fetch 增加超时'
        }],
        needsFix: true
      },
      { type: 'task.completed', at: 20, taskId, summary: '完成' }
    ]
  });
  assert.equal(view.reviews[0].issues[0].issueId, 'iss-1');
  assert.equal(view.reviews[0].issues[0].severity, 'high');
  assert.equal(view.reviews[0].issues[0].disposition, 'pending');
  assert.equal(view.reviews[0].issues[0].recommendation, '为 fetch 增加超时');
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
  // 一致 1 + 分歧立场 2
  assert.equal(view.keyOpinions.length, 3);
  assert.equal(view.keyOpinions.filter(item => item.position === 'support').length, 1);
  assert.equal(view.keyOpinions.filter(item => item.position === 'oppose').length, 2);
  assert.equal(view.disputes.length, 1);
  assert.equal(view.disputes[0].claims.length, 2);
  assert.equal(view.disputes[0].status, 'identified');
  assert.ok(view.conclusion?.uncertainties.some(item => item.includes('出处')));
});

test('U7：证据引用不得伪造 evidence: 前缀 messageId', () => {
  const view = projectConversationCollaborationResult({
    conversation: {
      conversationId: 'c-ev',
      title: '证据',
      intent: 'research',
      intentReason: 't',
      status: 'answered',
      channels: ['gemini'],
      createdAt: 1,
      updatedAt: 2
    },
    messages: [
      {
        messageId: 'm-syn',
        conversationId: 'c-ev',
        role: 'synthesis',
        at: 3,
        text: '综合',
        synthesis: {
          consensus: [{
            text: '答案是 42',
            sources: [{ channelId: 'gemini', messageId: 'm-real' }],
            evidence: ['gemini: 42']
          }],
          disputed: [],
          unique: [],
          gaps: [],
          recommendation: '答案是 42'
        }
      }
    ]
  });
  const evidence = view.keyOpinions.flatMap(item => item.evidenceRefs);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].messageId, 'm-real');
  assert.ok(!(evidence[0].messageId ?? '').startsWith('evidence:'));
  assert.equal(evidence[0].label, 'gemini: 42');
});

test('U7：DebateSnapshot 投影含主张与裁决', () => {
  const view = projectConversationCollaborationResult({
    conversation: {
      conversationId: 'c-debate',
      title: '辩论',
      intent: 'research',
      intentReason: 't',
      status: 'answered',
      channels: ['a', 'b'],
      createdAt: 1,
      updatedAt: 2
    },
    messages: [
      {
        messageId: 'm-syn',
        conversationId: 'c-debate',
        role: 'synthesis',
        at: 3,
        text: '综合',
        synthesis: {
          consensus: [],
          disputed: [],
          unique: [],
          gaps: [],
          recommendation: '仍有分歧',
          finalOpinion: '采纳 a 的说法'
        },
        debate: {
          status: 'completed',
          rounds: [
            {
              index: 1,
              phase: 'challenge',
              messages: [
                { author: 'a', kind: 'claim', text: '我认为是 2024' },
                { author: 'b', kind: 'rebuttal', text: '不对，是 2025' }
              ]
            }
          ]
        }
      }
    ]
  });
  const debateDispute = view.disputes.find(item => item.disputeClass === 'debate');
  assert.ok(debateDispute);
  assert.equal(debateDispute.claims.length, 2);
  assert.equal(debateDispute.status, 'verdict');
  assert.equal(debateDispute.verdict, '采纳 a 的说法');
  assert.ok(debateDispute.exchanges.length >= 2);
});

test('Engineering：采纳后挂修正轮与验证；验证失败仍算未关闭', () => {
  const issueId = 'iss-timeout';
  const failed = projectEngineeringCollaborationResult({
    taskId,
    status: 'awaiting_next_round',
    summary: '修复中',
    events: [
      {
        type: 'review.ready',
        at: 10,
        taskId,
        roundId: 'r1',
        reviewer: '独立模型',
        backend: 'model',
        verdict: '需修复',
        issues: ['缺少超时'],
        issueDetails: [{
          issueId,
          title: '缺少超时',
          description: '网络调用没有超时',
          severity: 'high',
          disposition: 'pending'
        }],
        needsFix: true
      },
      {
        type: 'review.disposition',
        at: 15,
        taskId,
        roundId: 'r1',
        issueId,
        disposition: 'accepted',
        reason: '已并入下一轮修复计划',
        repairRoundId: 'r2'
      },
      {
        type: 'plan.ready',
        at: 20,
        taskId,
        roundId: 'r2',
        plan: {
          planId: 'p2',
          taskId,
          roundId: 'r2',
          title: '补超时',
          description: '加超时',
          completion: '有超时',
          steps: []
        }
      },
      {
        type: 'report.ready',
        at: 30,
        taskId,
        roundId: 'r2',
        report: {
          protocol: 'desktop-agent/v1',
          type: 'execution_report',
          taskId,
          roundId: 'r2',
          planId: 'p2',
          status: 'failed',
          results: [],
          errors: [],
          nextAction: 'continue',
          createdAt: 30,
          verification: {
            verified: false,
            reasons: ['测试未通过'],
            changedFiles: 1,
            changedPaths: ['src/a.ts']
          }
        }
      }
    ]
  });

  const issue = failed.reviews[0].issues[0];
  assert.equal(issue.disposition, 'accepted');
  assert.match(issue.dispositionReason ?? '', /修复计划/);
  assert.ok(issue.resolutionRefs.length >= 1);
  assert.ok(issue.verificationRefs.some(ref => (ref.label ?? '').includes('未验证')));
  assert.deepEqual(failed.conclusion?.openItems, ['缺少超时']);

  const passed = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '修好了',
    events: [
      {
        type: 'review.ready',
        at: 10,
        taskId,
        roundId: 'r1',
        reviewer: '独立模型',
        backend: 'model',
        verdict: '需修复',
        issues: ['缺少超时'],
        issueDetails: [{
          issueId,
          title: '缺少超时',
          description: '网络调用没有超时',
          severity: 'high',
          disposition: 'pending'
        }],
        needsFix: true
      },
      {
        type: 'review.disposition',
        at: 15,
        taskId,
        issueId,
        disposition: 'accepted',
        reason: '已并入下一轮修复计划',
        repairRoundId: 'r2'
      },
      {
        type: 'report.ready',
        at: 40,
        taskId,
        roundId: 'r2',
        report: {
          protocol: 'desktop-agent/v1',
          type: 'execution_report',
          taskId,
          roundId: 'r2',
          planId: 'p2',
          status: 'completed',
          results: [],
          errors: [],
          nextAction: 'complete',
          createdAt: 40,
          verification: { verified: true, reasons: [], changedFiles: 0 }
        }
      },
      { type: 'task.completed', at: 50, taskId, summary: '修好了' }
    ]
  });
  assert.equal(passed.reviews[0].issues[0].disposition, 'accepted');
  assert.ok(passed.reviews[0].issues[0].verificationRefs.some(ref => (ref.label ?? '').includes('已验证')));
  assert.deepEqual(passed.conclusion?.openItems, []);
});

test('Engineering：拒绝/暂缓必须保留原因；未处理不得消失', () => {
  const view = projectEngineeringCollaborationResult({
    taskId,
    status: 'completed',
    summary: '部分处理',
    events: [
      {
        type: 'review.ready',
        at: 10,
        taskId,
        roundId: 'r1',
        reviewer: 'rules',
        backend: 'rules',
        verdict: '需修复',
        issues: ['A', 'B', 'C'],
        issueDetails: [
          { issueId: 'a', title: 'A', description: 'A', severity: 'medium', disposition: 'pending' },
          { issueId: 'b', title: 'B', description: 'B', severity: 'low', disposition: 'pending' },
          { issueId: 'c', title: 'C', description: 'C', severity: 'high', disposition: 'pending' }
        ],
        needsFix: true
      },
      {
        type: 'review.disposition', at: 11, taskId, issueId: 'a',
        disposition: 'rejected', reason: '误报：测试已覆盖'
      },
      {
        type: 'review.disposition', at: 12, taskId, issueId: 'b',
        disposition: 'deferred', reason: '等下一版本再改'
      },
      { type: 'task.completed', at: 20, taskId, summary: '部分处理' }
    ]
  });

  const byId = Object.fromEntries(view.reviews[0].issues.map(issue => [issue.issueId, issue]));
  assert.equal(byId.a.disposition, 'rejected');
  assert.equal(byId.a.dispositionReason, '误报：测试已覆盖');
  assert.equal(byId.b.disposition, 'deferred');
  assert.equal(byId.b.dispositionReason, '等下一版本再改');
  assert.equal(byId.c.disposition, 'pending');
  // 暂缓与待决定仍算未关闭；拒绝不算未关闭。
  assert.deepEqual(view.conclusion?.openItems, ['B', 'C']);
});
