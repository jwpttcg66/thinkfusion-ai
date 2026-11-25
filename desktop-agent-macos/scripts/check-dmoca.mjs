/**
 * DMOCA：参与决策、贡献投影、停止条件。
 * Run: npm run test:dmoca
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideParticipation,
  defaultPolicyForRisk,
  projectDmocaFromEvents,
  riskFromPlanTools,
  shouldStopCollaboration,
  transitionParticipationLife
} from '../out-test/shared/dmoca.js';

test('L0 策略：跳过辩论与模型审核，最多 1 人', () => {
  const policy = defaultPolicyForRisk('L0');
  assert.equal(policy.debate, 'skip');
  assert.equal(policy.modelReview, 'skip');
  assert.equal(policy.maxParticipants, 1);
});

test('decideParticipation：用户指定不得擅自换人；超额排除有理由', () => {
  const decision = decideParticipation({
    workId: 'w1',
    stage: 'planning',
    risk: 'L0',
    candidates: [
      { id: 'a', available: true },
      { id: 'b', available: true },
      { id: 'c', available: false, detail: '掉线' }
    ],
    selectedIds: ['a', 'b'],
    userPinned: true,
    now: 10
  });
  assert.equal(decision.participants.length, 1);
  assert.equal(decision.participants[0].participantId, 'a');
  assert.ok(decision.excluded.some(item => item.participantId === 'b' && /最多|预算/.test(item.reason)));
  assert.ok(decision.excluded.some(item => item.participantId === 'c' && /选定列表|不可用|掉线/.test(item.reason)));
  assert.equal(decision.userPinned, true);
  assert.equal(decision.debate, 'skip');
});

test('riskFromPlanTools：只读 L0；写入 L1；设计 L3', () => {
  assert.equal(riskFromPlanTools({ steps: [{ id: '1', tool: 'fs.list', args: {} }] }), 'L0');
  assert.equal(riskFromPlanTools({
    steps: [
      { id: '1', tool: 'fs.writeFile', args: { path: 'a' } },
      { id: '2', tool: 'test.run', args: {} }
    ]
  }), 'L1');
  assert.equal(riskFromPlanTools({ kind: 'design', steps: [] }), 'L3');
});

test('流式不当事终贡献；answer 才是 final', () => {
  const view = projectDmocaFromEvents({
    workId: 't1',
    status: 'running',
    events: [
      { type: 'round.started', at: 1, taskId: 't1', roundId: 'r1', roundNumber: 1, inputType: 'user' },
      {
        type: 'round.delta', at: 2, taskId: 't1', roundId: 'r1',
        text: '中间草稿', mode: 'snapshot', providerId: 'p1'
      },
      { type: 'round.answer', at: 3, taskId: 't1', roundId: 'r1', text: '最终计划正文' }
    ]
  });
  assert.ok(view.contributions.some(item => item.kind === 'stream_snapshot' && item.status === 'partial'));
  assert.ok(view.contributions.some(item => item.kind === 'complete_response' && item.status === 'final'));
  assert.equal(view.snapshot?.alignmentStatus, 'ready');
});

test('无新证据应停止追加协作', () => {
  const stop = shouldStopCollaboration({
    risk: 'L1',
    newEvidence: false,
    newMaterialClaim: false,
    budgetExhausted: false,
    userCancel: false,
    successMet: false
  });
  assert.equal(stop.stop, true);
  assert.match(stop.reason, /no_new_evidence|无新证据/);
});

test('生命周期：选中→活跃→贡献→退出；失败不覆盖旧状态语义', () => {
  assert.equal(transitionParticipationLife('candidate', 'select'), 'selected');
  assert.equal(transitionParticipationLife('selected', 'activate'), 'active');
  assert.equal(transitionParticipationLife('active', 'contribute'), 'contributed');
  assert.equal(transitionParticipationLife('contributed', 'release'), 'released');
  assert.equal(transitionParticipationLife('active', 'fail'), 'failed');
  assert.equal(transitionParticipationLife('released', 'reassess'), 'needs_reassessment');
  assert.equal(transitionParticipationLife('needs_reassessment', 'rejoin'), 'active');
});

test('L3 预算耗尽不得静默跳过门禁', () => {
  const stop = shouldStopCollaboration({
    risk: 'L3',
    newEvidence: true,
    newMaterialClaim: true,
    budgetExhausted: true,
    userCancel: false,
    successMet: false
  });
  assert.equal(stop.stop, false);
  assert.match(stop.reason, /不得静默|暂停/);
});
