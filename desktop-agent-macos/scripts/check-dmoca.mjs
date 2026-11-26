/**
 * DMOCA：参与决策、贡献投影、停止条件。
 * Run: npm run test:dmoca
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEcoGateToDecision,
  assertDecisionSnapshotIntegrity,
  checkConversationDecision,
  conversationDecisionSnapshot,
  conversationRiskFromDebate,
  decideParticipation,
  defaultPolicyForRisk,
  dispatchedParticipantIds,
  formalRoleHolders,
  projectDmocaFromConversationEvents,
  projectDmocaFromEvents,
  roleEligibility,
  riskFromPlanTools,
  shouldStopCollaboration,
  snapshotFromExchanges,
  transitionParticipationLife
} from '../out-test/shared/dmoca.js';

test('L0 策略：on_demand（模型定是否辩/审），最多 1 人', () => {
  const policy = defaultPolicyForRisk('L0');
  assert.equal(policy.debate, 'on_demand');
  assert.equal(policy.modelReview, 'on_demand');
  assert.equal(policy.maxParticipants, 1);
  assert.equal(policy.maxExtraModels, 0);
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
  assert.equal(decision.debate, 'on_demand');
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

// ---------------------------------------------------------------------------
// P0-01：参与资格 ≠ 正式职责资格
// ---------------------------------------------------------------------------

const pinnedDecision = (roles, risk = 'L2') => ({
  decisionId: 'pd:gate',
  workId: 'w1',
  stage: 'planning',
  risk,
  participants: roles.map(([participantId, list]) => ({
    participantId,
    roles: list,
    reason: '用户指定参与'
  })),
  excluded: [],
  debate: 'on_demand',
  modelReview: 'on_demand',
  maxExtraModels: 1,
  reasons: [],
  userPinned: true,
  at: 1
});

test('ECO insufficient：钉住的 architect 仍参与，但正式角色被摘除', () => {
  const decision = pinnedDecision([['ds', ['lead', 'architect']], ['gpt', ['reviewer']]]);
  const gated = applyEcoGateToDecision(decision, 'insufficient', { contextVersion: 3 });

  // 参与权保留：不能因为上下文不足就把用户选的人换掉
  assert.deepEqual(gated.participants.map(item => item.participantId), ['ds', 'gpt']);
  // 正式职责摘除：architect / reviewer 都不再挂在角色上
  const ds = gated.participants[0];
  assert.deepEqual(ds.roles, ['lead']);
  assert.deepEqual(ds.blockedRoles, ['architect']);
  assert.deepEqual(gated.participants[1].roles, ['analyst']);
  assert.deepEqual(gated.participants[1].blockedRoles, ['reviewer']);

  assert.equal(gated.ecoGate?.formalRolesBlocked, true);
  assert.equal(gated.ecoGate?.contextVersion, 3);
  assert.equal(gated.ecoGate?.restrictions?.length, 2);

  // 派发前复核：正式角色一律不许派
  assert.equal(roleEligibility(gated, 'ds', 'architect').ok, false);
  assert.equal(roleEligibility(gated, 'gpt', 'reviewer').ok, false);
  // 旁听与协作身份仍然可用
  assert.equal(roleEligibility(gated, 'ds', 'lead').ok, true);
  assert.equal(roleEligibility(gated, 'gpt', 'analyst').ok, true);
  assert.deepEqual(formalRoleHolders(gated, 'architect'), []);
  assert.deepEqual(formalRoleHolders(gated, 'reviewer'), []);
});

test('ECO stale：钉住的 adjudicator / verifier 不得正式裁决', () => {
  const decision = pinnedDecision([['claude', ['adjudicator']], ['ds', ['verifier']]], 'L3');
  const gated = applyEcoGateToDecision(decision, 'stale');
  assert.equal(roleEligibility(gated, 'claude', 'adjudicator').ok, false);
  assert.equal(roleEligibility(gated, 'ds', 'verifier').ok, false);
  assert.match(roleEligibility(gated, 'claude', 'adjudicator').reason, /ECO 门禁/);
  assert.match(gated.ecoGate?.reason ?? '', /stale/);
});

test('ECO partial：普通阶段允许辅助分析，高风险仍摘正式角色', () => {
  const normal = applyEcoGateToDecision(pinnedDecision([['ds', ['reviewer']]], 'L2'), 'partial');
  assert.deepEqual(normal.participants[0].roles, ['reviewer']);
  assert.equal(roleEligibility(normal, 'ds', 'reviewer').ok, true);

  const risky = applyEcoGateToDecision(pinnedDecision([['ds', ['reviewer']]], 'L3'), 'partial');
  assert.deepEqual(risky.participants[0].roles, ['analyst']);
  assert.equal(roleEligibility(risky, 'ds', 'reviewer').ok, false);
});

test('ECO sufficient：角色按原样保留，门禁不拦', () => {
  const decision = pinnedDecision([['ds', ['architect']], ['gpt', ['reviewer']]]);
  const gated = applyEcoGateToDecision(decision, 'sufficient');
  assert.deepEqual(gated.participants[0].roles, ['architect']);
  assert.equal(gated.ecoGate?.formalRolesBlocked, false);
  assert.equal(roleEligibility(gated, 'ds', 'architect').ok, true);
  assert.equal(roleEligibility(gated, 'gpt', 'reviewer').ok, true);
});

test('ECO 门禁不只靠 warning：未参与的人拿不到角色', () => {
  const gated = applyEcoGateToDecision(pinnedDecision([['ds', ['lead']]]), 'insufficient');
  assert.equal(roleEligibility(gated, 'other', 'reviewer').ok, false);
  assert.match(roleEligibility(gated, 'other', 'reviewer').reason, /不在本次参与决策/);
});


// ---------------------------------------------------------------------------
// P0-05：正式决策钉住确定版本的贡献
// ---------------------------------------------------------------------------

test('贡献快照：同一人后续发言递增版本并覆盖前一版终稿', () => {
  const result = snapshotFromExchanges({
    workId: 'w1',
    participants: ['lead', 'peer'],
    exchanges: [
      { author: 'lead', kind: 'analysis', text: '第一版结论', roundIndex: 0 },
      { author: 'peer', kind: 'challenge', text: '我不同意第一版', roundIndex: 1 },
      { author: 'lead', kind: 'response', text: '修正后的结论', roundIndex: 2 }
    ],
    conclusion: '按修正后的结论执行',
    at: 10
  });
  assert.equal(result.artifacts.length, 3);
  const leadArts = result.artifacts.filter(item => item.participantId === 'lead');
  assert.deepEqual(leadArts.map(item => item.version), [1, 2]);
  assert.equal(leadArts[0].status, 'superseded');
  assert.equal(leadArts[1].status, 'final');
  assert.equal(leadArts[1].kind, 'revision');
  assert.equal(leadArts[1].supersedesArtifactId, leadArts[0].artifactId);

  // 决策钉的是 v2，不是 v1
  const pinned = result.decision.contributions.find(item => item.participantId === 'lead');
  assert.equal(pinned.version, 2);
  assert.equal(pinned.artifactId, leadArts[1].artifactId);
  assert.equal(result.decision.status, 'accepted');
  assert.equal(assertDecisionSnapshotIntegrity(result.decision, result.artifacts).ok, true);
});

test('贡献快照：缺终稿的参与者不会让决策假装完整', () => {
  const result = snapshotFromExchanges({
    workId: 'w2',
    participants: ['lead', 'silent'],
    exchanges: [{ author: 'lead', kind: 'analysis', text: '只有我说了', roundIndex: 0 }],
    conclusion: '先这样',
    at: 11
  });
  assert.equal(result.snapshot.alignmentStatus, 'partial');
  assert.equal(result.decision.status, 'accepted_with_risks');
  assert.ok(result.decision.unresolvedIssues.length > 0);
  const silent = result.snapshot.participants.find(item => item.participantId === 'silent');
  assert.equal(silent.selectedArtifactId, undefined);
});

test('贡献快照校验：引用不存在 / 版本不符 / 已覆盖 / 未完成都要报出来', () => {
  const result = snapshotFromExchanges({
    workId: 'w3',
    participants: ['a'],
    exchanges: [{ author: 'a', kind: 'analysis', text: 'ok', roundIndex: 0 }],
    conclusion: 'c',
    at: 12
  });
  const [artifact] = result.artifacts;
  assert.equal(assertDecisionSnapshotIntegrity(result.decision, result.artifacts).ok, true);

  const missing = assertDecisionSnapshotIntegrity(
    { ...result.decision, contributions: [{ participantId: 'a', artifactId: 'nope', version: 1 }] },
    result.artifacts
  );
  assert.equal(missing.ok, false);
  assert.match(missing.issues.join(), /不存在/);

  const wrongVersion = assertDecisionSnapshotIntegrity(
    { ...result.decision, contributions: [{ participantId: 'a', artifactId: artifact.artifactId, version: 9 }] },
    result.artifacts
  );
  assert.match(wrongVersion.issues.join(), /版本/);

  const superseded = assertDecisionSnapshotIntegrity(
    { ...result.decision, contributions: [{ participantId: 'a', artifactId: artifact.artifactId, version: 1 }] },
    [{ ...artifact, status: 'superseded' }]
  );
  assert.match(superseded.issues.join(), /已被覆盖/);

  const partial = assertDecisionSnapshotIntegrity(
    { ...result.decision, contributions: [{ participantId: 'a', artifactId: artifact.artifactId, version: 1 }] },
    [{ ...artifact, status: 'partial' }]
  );
  assert.match(partial.issues.join(), /未完成/);

  const empty = assertDecisionSnapshotIntegrity({ ...result.decision, contributions: [] }, result.artifacts);
  assert.match(empty.issues.join(), /没有钉住/);
});

test('贡献快照：没有交锋就不造快照', () => {
  const result = snapshotFromExchanges({
    workId: 'w4',
    participants: [],
    exchanges: [],
    conclusion: '',
    at: 13
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.decision, null);
});

// ---------------------------------------------------------------------------
// P1-03：三场景统一——会话侧也走同一套贡献结构与决策钉版本规则
// ---------------------------------------------------------------------------

test('会话决策：多模型时钉住各自终稿，版本与完整性校验都成立', () => {
  const result = conversationDecisionSnapshot({
    workId: 'conv-1',
    lead: { participantId: 'chatgpt', text: '主导汇总' },
    peers: [
      { participantId: 'gemini', text: '另一份回答', status: 'answered' },
      { participantId: 'ollama:qwen', status: 'timed_out' }
    ],
    conclusion: '综合结论',
    completed: true,
    at: 10
  });
  assert.ok(result.decision);
  assert.equal(result.singleModel, false);
  assert.equal(result.decision.status, 'accepted_with_risks');
  assert.equal(result.decision.contributions.length, 2);
  assert.match(result.decision.unresolvedIssues.join(), /ollama:qwen（timed_out）未给出终稿/);
  assert.equal(result.integrity.ok, true);
  // 超时成员不阻塞结论：仍然给出 decision，而不是 null。
  assert.equal(assertDecisionSnapshotIntegrity(result.decision, result.artifacts).ok, true);
});

test('会话决策：单模型也成立，但不假装有交叉验证', () => {
  const result = conversationDecisionSnapshot({
    workId: 'conv-2',
    lead: { participantId: 'chatgpt', text: '只有一个回答' },
    conclusion: '单源结论',
    completed: true,
    at: 11
  });
  assert.equal(result.singleModel, true);
  assert.ok(result.decision);
  assert.equal(result.decision.contributions.length, 1);
  assert.equal(result.snapshot.alignmentStatus, 'ready');
  assert.equal(result.integrity.ok, true);
});

test('会话决策：没有正文就不造决策，也不写成 blocked 快照', () => {
  const result = conversationDecisionSnapshot({
    workId: 'conv-3',
    lead: { participantId: 'chatgpt', text: '   ' },
    conclusion: '',
    at: 12
  });
  assert.equal(result.snapshot, null);
  assert.equal(result.decision, null);
  assert.equal(result.integrity.ok, false);
  assert.match(result.integrity.issues.join(), /没有可用回答/);
});

test('会话决策：同一成员改口时钉最后一版，旧稿标 superseded', () => {
  const result = conversationDecisionSnapshot({
    workId: 'conv-4',
    lead: { participantId: 'chatgpt', text: '第一版' },
    exchanges: [
      { author: 'chatgpt', text: '第一版', roundIndex: 0, kind: 'summary' },
      { author: 'gemini', text: '辩手发言', roundIndex: 1, kind: 'opening' },
      { author: 'chatgpt', text: '最终意见', roundIndex: 999, kind: 'verdict' }
    ],
    conclusion: '最终意见',
    completed: true,
    at: 13
  });
  assert.ok(result.decision);
  const pinned = result.decision.contributions.find(item => item.participantId === 'chatgpt');
  assert.equal(pinned.version, 2);
  const lead = result.artifacts.filter(item => item.participantId === 'chatgpt');
  assert.equal(lead[0].status, 'superseded');
  assert.equal(lead[1].status, 'final');
  assert.equal(result.integrity.ok, true);
});

test('会话 DMOCA 投影：与工程同一视图结构，决策可从事件复核', () => {
  const recorded = conversationDecisionSnapshot({
    workId: 'conv-5',
    lead: { participantId: 'chatgpt', text: '汇总' },
    peers: [{ participantId: 'gemini', text: '旁听回答', status: 'answered' }],
    conclusion: '结论',
    completed: true,
    at: 14
  });
  const events = [
    {
      type: 'model.participation.observed', at: 9, conversationId: 'conv-5', stage: 'answers',
      risk: 'L1', decisionId: 'obs:conv-5', maxExtraModels: 0,
      participants: [{ participantId: 'chatgpt', kind: 'web' }, { participantId: 'gemini', kind: 'web' }],
      excluded: [], reasons: ['回答收齐即记录'], note: '本轮 2 路回答'
    },
    {
      type: 'model.decision.snapshot', at: 14, conversationId: 'conv-5', stage: 'summary',
      decision: recorded.decision, snapshot: recorded.snapshot,
      artifacts: recorded.artifacts, integrity: recorded.integrity, singleModel: false
    }
  ];
  const view = projectDmocaFromConversationEvents({ conversationId: 'conv-5', events });
  assert.equal(view.decision.participants.length, 2);
  assert.equal(view.decision.risk, 'L1');
  assert.ok(view.decisionSnapshot);
  assert.equal(view.snapshot.snapshotId, recorded.snapshot.snapshotId);
  assert.equal(checkConversationDecision(view).ok, true);

  const empty = projectDmocaFromConversationEvents({ conversationId: 'conv-6', events: [] });
  assert.equal(empty.decisionSnapshot, null);
  assert.equal(checkConversationDecision(empty).ok, false);
});
