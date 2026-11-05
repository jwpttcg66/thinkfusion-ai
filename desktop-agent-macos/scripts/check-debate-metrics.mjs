/**
 * Phase 5：质量指标、成本提前收尾、历史辩论复用。
 *
 * 指标最容易犯的错是「没有分母时给 0」——那会把「没跑起来」显示成「质量差」。
 * 这里专门盯住 `null`。
 *
 * Run with: npm run test:debate-metrics
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { debateMetrics, roundProgress, summarizeMetrics } from '../out-test/main/debate/metrics.js';
import { relatedDebates } from '../out-test/main/debate/history.js';

const QUESTION = '这个库支持并发写入吗？';

function round(index, extra = {}) {
  return {
    index,
    messages: [{ messageId: `m${index}`, roundIndex: index, agentId: 'a', role: 'peer', kind: 'position', text: '一句话', createdAt: 1 }],
    startedAt: 1000,
    endedAt: 2000,
    converged: false,
    failures: [],
    ...extra
  };
}

function state(overrides = {}) {
  return {
    debateId: 'd1',
    question: QUESTION,
    config: { strategy: 'truth', maxRounds: 3, participants: ['a', 'b'], convergenceStop: false },
    lead: { mode: 'hybrid', agentId: null, label: '不设主辩', reason: '', drivenBy: 'orchestrator' },
    plan: { lead: {}, openingSpeakers: ['a', 'b'], debaters: ['a', 'b'], participants: ['a', 'b'], webOnly: [], reason: '', warnings: [], excluded: [] },
    status: 'completed',
    rounds: [round(0), round(1)],
    minorities: [],
    createdAt: 1000,
    updatedAt: 5000,
    ...overrides
  };
}

test('没有可判主张时，可追溯率是 null，不是 0', () => {
  const metrics = debateMetrics(state());
  assert.equal(metrics.traceability.judged, 0);
  assert.equal(metrics.traceability.rate, null);
  // 首轮不算无效轮：它本来就没有「新增证据」这回事。
  assert.equal(metrics.invalidRounds.total, 1);
  assert.equal(metrics.minority.rate, null);
});

test('有页面来源的那条算可追溯，只有断言的不算', () => {
  const metrics = debateMetrics(state({
    evidence: [
      { evidenceId: 'e1', claimIds: ['c1'], kind: 'official-doc', excerpt: 'x', span: { messageId: 'm0', start: 0, end: 1 }, sourceId: 'a', messageId: 'm0', roundIndex: 0, fingerprint: 'f', originKey: 'url:https://x', independent: true, verified: 'page-link', assessment: 'ok' },
      { evidenceId: 'e2', claimIds: ['c2'], kind: 'official-doc', excerpt: 'y', span: { messageId: 'm0', start: 0, end: 1 }, sourceId: 'a', messageId: 'm0', roundIndex: 0, fingerprint: 'g', originKey: null, independent: true, verified: 'reported', assessment: '自称' }
    ],
    judgments: [
      { judgmentId: 'j1', claimId: 'c1', agentId: 'a', claimText: 'x', dimensions: [], verdict: 'supported', decidedBy: [], rationale: '', evidenceIds: ['e1'], minority: false, createdAt: 1 },
      { judgmentId: 'j2', claimId: 'c2', agentId: 'b', claimText: 'y', dimensions: [], verdict: 'insufficient_evidence', decidedBy: [], rationale: '', evidenceIds: [], minority: false, createdAt: 1 }
    ]
  }));
  assert.equal(metrics.traceability.judged, 2);
  assert.equal(metrics.traceability.traceable, 1);
  assert.equal(metrics.traceability.rate, 0.5);
});

test('同源转载不算第二条可追溯证据', () => {
  const metrics = debateMetrics(state({
    evidence: [
      { evidenceId: 'e1', claimIds: ['c1'], kind: 'official-doc', excerpt: 'x', span: { messageId: 'm0', start: 0, end: 1 }, sourceId: 'a', messageId: 'm0', roundIndex: 0, fingerprint: 'f', originKey: 'url:https://x', independent: true, verified: 'page-link', assessment: 'ok' },
      { evidenceId: 'e2', claimIds: ['c1'], kind: 'official-doc', excerpt: 'x', span: { messageId: 'm0', start: 0, end: 1 }, sourceId: 'b', messageId: 'm1', roundIndex: 1, fingerprint: 'f', originKey: 'url:https://x', independent: false, duplicateOf: 'e1', verified: 'page-link', assessment: '同源' }
    ],
    judgments: [{ judgmentId: 'j1', claimId: 'c1', agentId: 'a', claimText: 'x', dimensions: [], verdict: 'supported', decidedBy: [], rationale: '', evidenceIds: ['e1'], minority: false, createdAt: 1 }]
  }));
  assert.equal(metrics.traceability.traceable, 1);
  assert.equal(metrics.traceability.rate, 1);
});

test('无效轮：既没新证据、也没有实质修订和新争议', () => {
  const base = state({ rounds: [round(0), round(1), round(2)] });
  assert.equal(roundProgress(base, base.rounds[1]).stalled, true);

  const withRevision = {
    ...base,
    revisions: [{ revisionId: 'r1', messageId: 'm2', agentId: 'a', roundIndex: 1, decision: 'accept', source: 'stated', reason: '', before: '', after: '', targetClaimIds: [], createdAt: 1 }]
  };
  assert.equal(roundProgress(withRevision, withRevision.rounds[1]).stalled, false);

  // 只「坚持」不改口，不算进展。
  const defended = {
    ...base,
    revisions: [{ revisionId: 'r2', messageId: 'm2', agentId: 'a', roundIndex: 1, decision: 'defend', source: 'stated', reason: '', before: '', after: '', targetClaimIds: [], createdAt: 1 }]
  };
  assert.equal(roundProgress(defended, defended.rounds[1]).stalled, true);

  const metrics = debateMetrics(base);
  assert.equal(metrics.invalidRounds.total, 2);
  assert.equal(metrics.invalidRounds.invalid, 2);
  assert.equal(metrics.invalidRounds.rate, 1);
});

test('少数派原文完整保留才计数，丢了一条就是回归', () => {
  const messages = [{ messageId: 'm0' }, { messageId: 'm1' }];
  const metrics = debateMetrics(state({
    rounds: [round(0), round(1, { messages })],
    minorities: [
      { messageId: 'm0', roundIndex: 0, agentId: 'a', role: 'peer', kind: 'position', text: '少数派一', createdAt: 1 },
      { messageId: 'gone', roundIndex: 0, agentId: 'b', role: 'peer', kind: 'position', text: '被覆盖了', createdAt: 1 }
    ]
  }));
  assert.equal(metrics.minority.count, 2);
  assert.equal(metrics.minority.preserved, 1);
  assert.equal(metrics.minority.rate, 0.5);
});

test('汇总指标只做算术，不合成一个总分', () => {
  const one = debateMetrics(state({
    verdict: { verdictId: 'v', debateId: 'd1', createdAt: 1, verdict: 'supported', conclusion: 'x', claimJudgments: [], dimensions: [], rationale: '', minorityWins: false, unresolved: [], backend: 'rules', note: '' },
    judgments: [{ judgmentId: 'j1', claimId: 'c1', agentId: 'a', claimText: 'x', dimensions: [], verdict: 'supported', decidedBy: [], rationale: '', evidenceIds: [], minority: false, createdAt: 1 }]
  }));
  const two = debateMetrics(state({ debateId: 'd2', verdict: { verdictId: 'v2', debateId: 'd2', createdAt: 1, verdict: 'insufficient_evidence', conclusion: null, claimJudgments: [], dimensions: [], rationale: '', minorityWins: false, unresolved: [], backend: 'rules', note: '' } }));
  const summary = summarizeMetrics([one, two]);
  assert.equal(summary.debates, 2);
  assert.deepEqual(summary.byVerdict, { supported: 1, insufficient_evidence: 1 });
  assert.equal(summary.traceability.judged, 1);
  assert.equal(summary.traceability.rate, 0);
  assert.equal('score' in summary, false, '没有综合分这个东西');
});

// ---------------------------------------------------------------------------
// 成本优化 + 历史复用（真跑）
// ---------------------------------------------------------------------------

function harness(responder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-metrics-'));
  const store = new DebateStore(dir);
  let call = 0;
  const ask = async (agentId, task) => {
    call += 1;
    return {
      agentId,
      text: responder(agentId, call),
      receivedAt: Date.now(),
      attribution: { requestId: 'r', note: 'test' },
      stage: task.stage
    };
  };
  return { dir, store, orchestrator: new DebateOrchestrator(store, { ask }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('打开「没进展就收尾」：连续两轮空转后提前停，不跑满 5 轮', async () => {
  const h = harness(agentId => `${agentId} 还是那句话：取决于版本。`);
  const started = h.orchestrator.start(QUESTION, {
    strategy: 'truth',
    maxRounds: 5,
    participants: ['a', 'b'],
    convergenceStop: false,
    earlyStopOnStall: true
  });
  const state = await h.orchestrator.waitFor(started.debateId, 10_000);
  h.cleanup();
  assert.equal(state.rounds.length, 3, '第 2、3 轮都空转，停在 3 轮');
  assert.match(state.stopReason ?? '', /连续两轮/);
});

test('默认不提前收尾：该跑几轮就跑几轮', async () => {
  const h = harness(agentId => `${agentId} 还是那句话：取决于版本。`);
  const started = h.orchestrator.start(QUESTION, {
    strategy: 'truth',
    maxRounds: 4,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await h.orchestrator.waitFor(started.debateId, 10_000);
  h.cleanup();
  assert.equal(state.rounds.length, 4);
});

test('历史复用：只提示相似的历史辩论，不自动跳过', async () => {
  const h = harness(agentId => `${agentId} 的观点。`);
  const first = h.orchestrator.start('Redis 连接复用应该用连接池还是多路复用？', {
    strategy: 'truth', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false
  });
  await h.orchestrator.waitFor(first.debateId, 10_000);
  const second = h.orchestrator.start('Kubernetes 滚动更新怎么做？', {
    strategy: 'truth', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false
  });
  await h.orchestrator.waitFor(second.debateId, 10_000);

  const related = relatedDebates(h.orchestrator.list(), 'Redis 连接复用用连接池还是多路复用？');
  // exclude：正在看的这一场不要出现在「历史」里。
  const excluded = relatedDebates(h.orchestrator.list(), 'Redis 连接复用用连接池还是多路复用？', {
    exclude: first.debateId
  });
  h.cleanup();
  assert.ok(related.length >= 1, '同一类问题要能找到');
  assert.equal(related[0].debateId, first.debateId);
  assert.ok(related[0].similarity >= 0.45);
  assert.equal(related.some(item => item.debateId === second.debateId), false, '不相关的问题不该混进来');
  assert.equal(excluded.length, 0);
});
