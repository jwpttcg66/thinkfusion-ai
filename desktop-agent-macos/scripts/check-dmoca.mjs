/**
 * DMOCA：参与决策、贡献投影、停止条件。
 * Run: npm run test:dmoca
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEcoGateToDecision,
  conversationRiskFromDebate,
  decideParticipation,
  defaultPolicyForRisk,
  dispatchedParticipantIds,
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

test('决策驱动派发：派发名单等于决策名单', () => {
  const base = decideParticipation({
    workId: 'w1',
    stage: 'planning',
    risk: 'L1',
    candidates: [
      { id: 'a', available: true },
      { id: 'b', available: true },
      { id: 'c', available: true }
    ]
  });
  // 非 pinned：L1 上限 2，派发就是这两名，第三人带原因进 excluded
  const dispatched = dispatchedParticipantIds(base, ['a', 'b', 'c']);
  assert.deepEqual(dispatched, base.participants.map(p => p.participantId));
  assert.equal(dispatched.length, 2);
  assert.ok(base.excluded.some(item => item.participantId === 'c' && /最多/.test(item.reason)));

  // ECO insufficient：决策截断为单 lead，派发也只剩一个
  const gated = applyEcoGateToDecision(base, 'insufficient');
  assert.equal(dispatchedParticipantIds(gated, ['a', 'b', 'c']).length, 1);

  // 用户钉住两个人：决策里仍是这两人，派发不改名单
  const pinned = decideParticipation({
    workId: 'w1',
    stage: 'planning',
    risk: 'L2',
    candidates: [{ id: 'a', available: true }, { id: 'b', available: true }, { id: 'x', available: true }],
    selectedIds: ['a', 'b']
  });
  assert.deepEqual(dispatchedParticipantIds(pinned, ['a', 'b']), ['a', 'b']);
  assert.ok(pinned.excluded.some(item => item.participantId === 'x'));

  // 决策无人可用时退回原名单，不把「没人」当成「请全部」
  assert.deepEqual(dispatchedParticipantIds({ ...base, participants: [] }, ['a']), ['a']);
});

test('决策钉住贡献版本：引用最新终稿，不引用 superseded', () => {
  const view = projectDmocaFromEvents({
    workId: 't2',
    status: 'completed',
    summary: '结论',
    events: [
      { type: 'round.started', at: 1, taskId: 't2', roundId: 'r1', roundNumber: 1, inputType: 'user' },
      { type: 'round.answer', at: 2, taskId: 't2', roundId: 'r1', text: '第一版' },
      { type: 'round.started', at: 3, taskId: 't2', roundId: 'r2', roundNumber: 2, inputType: 'user' },
      { type: 'round.answer', at: 4, taskId: 't2', roundId: 'r2', text: '第二版' }
    ]
  });
  const decision = view.decisionSnapshot;
  assert.ok(decision);
  assert.equal(decision.contributions?.length, 1);
  assert.equal(decision.contributions?.[0].version, 2);
  assert.match(decision.contributions?.[0].artifactId ?? '', /r2/);
  // 被 superseded 的第一版不能出现在决策引用里
  assert.ok(!(decision.contributions ?? []).some(item => /r1/.test(item.artifactId)));
});

test('参与事件：回放出的决策沿用当时的 decisionId 与 ECO 门禁', () => {
  const view = projectDmocaFromEvents({
    workId: 't3',
    status: 'running',
    events: [
      { type: 'round.started', at: 1, taskId: 't3', roundId: 'r1', roundNumber: 1, inputType: 'user' },
      {
        type: 'model.participation.selected',
        at: 2,
        taskId: 't3',
        decisionId: 'pd:fixed-1',
        stage: 'planning',
        risk: 'L1',
        participants: [{ participantId: 'a', roles: ['lead'], reason: '默认' }],
        excluded: [{ participantId: 'b', reason: 'L1 默认最多 2 人' }],
        debate: 'on_demand',
        modelReview: 'on_demand',
        maxExtraModels: 1,
        reasons: ['风险 L1'],
        userPinned: false,
        ecoGate: { sufficiency: 'insufficient', formalRolesBlocked: true, reason: 'ECO insufficient' }
      }
    ]
  });
  assert.equal(view.decision?.decisionId, 'pd:fixed-1');
  assert.equal(view.decision?.maxExtraModels, 1);
  assert.equal(view.decision?.ecoGate?.formalRolesBlocked, true);
  assert.equal(view.decision?.excluded[0].participantId, 'b');
});

test('会话风险由证据反推，并且按等级裁剪派发', () => {
  assert.equal(conversationRiskFromDebate({ answers: 1, topics: 0, doubts: 0 }), 'L0');
  assert.equal(conversationRiskFromDebate({ answers: 3, topics: 0, doubts: 0 }), 'L1');
  assert.equal(conversationRiskFromDebate({ answers: 3, topics: 1, doubts: 0 }), 'L2');
  assert.equal(conversationRiskFromDebate({ answers: 3, topics: 2, doubts: 0 }), 'L3');
  assert.equal(conversationRiskFromDebate({ answers: 3, topics: 0, doubts: 1 }), 'L3');

  const decision = decideParticipation({
    workId: 'c1',
    stage: 'debate',
    risk: 'L1',
    candidates: [{ id: 'a', available: true }, { id: 'b', available: true }, { id: 'c', available: true }]
  });
  assert.deepEqual(dispatchedParticipantIds(decision, ['a', 'b', 'c']), decision.participants.map(p => p.participantId));
  assert.ok(decision.excluded.length > 0 && /最多/.test(decision.excluded[0].reason));
});
