/**
 * V4.1 P1-B：ClaimEvidenceLink 的写入、校验与持久化。
 *
 * 钉住四条：
 * - 作者只说「这句话引用了这条来源」→ context，不能冒充 supports；
 * - 裁判引用证据才给方向：supported→supports、unsupported→contradicts；
 * - 反例维度 refuted → contradicts；
 * - 未知 claim/evidence、跨 debate、重复项会被校验器报出来，不会静默进入状态。
 *
 * Run with: npm run test:claim-evidence-links
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import {
  buildClaimEvidenceLinks,
  refreshClaimEvidenceLinks,
  validateClaimEvidenceLinks
} from '../out-test/main/debate/claim-evidence-links.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';

function claim(id, text = '这句话是一个主张。') {
  return {
    claimId: id,
    messageId: `m-${id}`,
    agentId: 'a',
    roundIndex: 0,
    text,
    kind: 'fact',
    kindCue: '陈述句',
    span: { messageId: `m-${id}`, start: 0, end: text.length },
    assumptions: [],
    evidenceDrafts: [],
    status: 'proposed'
  };
}

function evidence(id, claimIds) {
  return {
    evidenceId: id,
    claimIds,
    kind: 'official-doc',
    excerpt: '官方文档',
    span: { messageId: `m-${claimIds[0] ?? 'none'}`, start: 0, end: 4 },
    sourceId: 'a',
    messageId: `m-${claimIds[0] ?? 'none'}`,
    roundIndex: 0,
    fingerprint: `fp-${id}`,
    originKey: `url:https://docs.example.com/${id}`,
    independent: true,
    verified: 'page-link',
    assessment: '页面给出的链接'
  };
}

function judgment(claimId, verdict, evidenceIds, counterexample = { outcome: 'none', evidenceIds: [] }) {
  return {
    judgmentId: `j-${claimId}`,
    claimId,
    agentId: 'a',
    claimText: '这句话是一个主张。',
    dimensions: [
      { dimension: 'logic', outcome: 'valid', rationale: '', signals: [], evidenceIds: [] },
      { dimension: 'evidence', outcome: verdict === 'insufficient_evidence' ? 'partial' : 'sufficient', rationale: '', signals: [], evidenceIds },
      { dimension: 'counterexample', outcome: counterexample.outcome, rationale: '', signals: [], evidenceIds: counterexample.evidenceIds }
    ],
    verdict,
    rationale: '',
    decidedBy: []
  };
}

function stateOf({ claims, evidenceList, judgments }) {
  return {
    debateId: 'debate-links',
    question: '这个方案可靠吗？',
    config: { strategy: 'standard', maxRounds: 1, participants: ['a', 'b'], convergenceStop: false },
    rounds: [{
      index: 0,
      phase: 'analysis',
      messages: [],
      startedAt: 1,
      endedAt: 2,
      converged: false,
      failures: [],
      claims
    }],
    minorities: [],
    disputes: [],
    evidence: evidenceList,
    judgments,
    createdAt: 1,
    updatedAt: 2
  };
}

test('作者只给 context；裁判引用同一对证据时以裁判方向为准', () => {
  const c = claim('c1');
  const e = evidence('e1', ['c1']);
  const links = buildClaimEvidenceLinks(stateOf({
    claims: [c],
    evidenceList: [e],
    judgments: [judgment('c1', 'supported', ['e1'])]
  }));
  assert.equal(links.length, 1);
  assert.equal(links[0].source, 'judge');
  assert.equal(links[0].relation, 'supports');
  assert.equal(links[0].claimId, 'c1');
  assert.equal(links[0].evidenceId, 'e1');

  const authorOnly = buildClaimEvidenceLinks(stateOf({
    claims: [c],
    evidenceList: [e],
    judgments: []
  }));
  assert.equal(authorOnly.length, 1);
  assert.equal(authorOnly[0].source, 'author');
  assert.equal(authorOnly[0].relation, 'context');
});

test('unsupported → contradicts；insufficient_evidence → context', () => {
  const c1 = claim('c1');
  const c2 = claim('c2');
  const e1 = evidence('e1', ['c1']);
  const e2 = evidence('e2', ['c2']);
  const links = buildClaimEvidenceLinks(stateOf({
    claims: [c1, c2],
    evidenceList: [e1, e2],
    judgments: [judgment('c1', 'unsupported', ['e1']), judgment('c2', 'insufficient_evidence', ['e2'])]
  }));
  const byEvidence = new Map(links.map(link => [link.evidenceId, link]));
  assert.equal(byEvidence.get('e1').relation, 'contradicts');
  assert.equal(byEvidence.get('e2').relation, 'context');
});

test('反例维度 refuted：即使主张 supported，也记 contradicts', () => {
  const c = claim('c1');
  const e = evidence('e1', ['c1']);
  const links = buildClaimEvidenceLinks(stateOf({
    claims: [c],
    evidenceList: [e],
    judgments: [judgment('c1', 'supported', [], { outcome: 'refuted', evidenceIds: ['e1'] })]
  }));
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'contradicts');
  assert.match(links[0].reason, /反例/);
});

test('方向冲突：同一对证据同时 supports 与 contradicts 时，contradicts 优先', () => {
  const c = claim('c1');
  const e = evidence('e1', ['c1']);
  const links = buildClaimEvidenceLinks(stateOf({
    claims: [c],
    evidenceList: [e],
    judgments: [judgment('c1', 'supported', ['e1'], { outcome: 'refuted', evidenceIds: ['e1'] })]
  }));
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'contradicts');
});

test('重复重建是幂等的，且顺序稳定', () => {
  const c1 = claim('c1');
  const c2 = claim('c2');
  const e1 = evidence('e1', ['c1']);
  const e2 = evidence('e2', ['c2']);
  const state = stateOf({
    claims: [c2, c1],
    evidenceList: [e2, e1],
    judgments: [judgment('c1', 'supported', ['e1']), judgment('c2', 'unsupported', ['e2'])]
  });
  const first = buildClaimEvidenceLinks(state);
  const second = buildClaimEvidenceLinks(state);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(link => link.claimId), ['c1', 'c2']);
});

test('Pack 证据不自动标成 author；有规则裁判引用时仍可写 judge 关联', () => {
  const c = claim('c1');
  const packEvidence = {
    ...evidence('e-pack', ['c1']),
    origin: 'repo-snapshot',
    kind: 'source-code',
    verified: 'snapshot',
    originKey: 'repo:c0ffee'
  };
  const authorOnly = buildClaimEvidenceLinks(stateOf({
    claims: [c],
    evidenceList: [packEvidence],
    judgments: []
  }));
  assert.deepEqual(authorOnly, [], 'repo-snapshot 不能冒充作者引用');

  const withJudge = buildClaimEvidenceLinks(stateOf({
    claims: [c],
    evidenceList: [packEvidence],
    judgments: [judgment('c1', 'supported', ['e-pack'])]
  }));
  assert.equal(withJudge.length, 1);
  assert.equal(withJudge[0].source, 'judge');
  assert.equal(withJudge[0].relation, 'supports');
});

test('统一写入入口：refresh 设置 rules-judge，并且不产生非法项', () => {
  const c = claim('c1');
  const e = evidence('e1', ['c1']);
  const state = stateOf({ claims: [c], evidenceList: [e], judgments: [judgment('c1', 'supported', ['e1'])] });
  const refreshed = refreshClaimEvidenceLinks(state);
  assert.equal(refreshed.writer, 'rules-judge');
  assert.deepEqual(refreshed.errors, []);
  assert.equal(state.claimEvidenceLinksSource, 'rules-judge');
  assert.deepEqual(state.claimEvidenceLinks, refreshed.links);
});

test('校验器：未知 claim/evidence、跨 debate、重复项都报错并过滤', () => {
  const c = claim('c1');
  const e = evidence('e1', ['c1']);
  const state = stateOf({ claims: [c], evidenceList: [e], judgments: [] });
  const good = {
    debateId: 'debate-links',
    claimId: 'c1',
    evidenceId: 'e1',
    relation: 'context',
    source: 'author',
    reason: 'ok'
  };
  const result = validateClaimEvidenceLinks(state, [
    good,
    { ...good },
    { ...good, claimId: 'c-missing' },
    { ...good, evidenceId: 'e-missing' },
    { ...good, debateId: 'other' }
  ]);
  assert.equal(result.valid.length, 1);
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some(error => error.includes('同一对证据出现多条关联')));
  assert.ok(result.errors.some(error => error.includes('未知主张')));
  assert.ok(result.errors.some(error => error.includes('未知证据')));
  assert.ok(result.errors.some(error => error.includes('debateId')));
});

test('持久化：关联随 DebateStore 落盘并原样读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-links-'));
  try {
    const store = new DebateStore(dir);
    const c = claim('c1');
    const e = evidence('e1', ['c1']);
    const state = stateOf({
      claims: [c],
      evidenceList: [e],
      judgments: [judgment('c1', 'supported', ['e1'])]
    });
    refreshClaimEvidenceLinks(state);
    store.save(state);
    const read = store.get('debate-links');
    assert.ok(read);
    assert.deepEqual(read.claimEvidenceLinks, state.claimEvidenceLinks);
    assert.equal(read.claimEvidenceLinksSource, 'rules-judge');
    assert.equal(read.claimEvidenceLinks[0].relation, 'supports');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实辩论结束后会写入关联，且没有悬空引用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-links-e2e-'));
  try {
    const store = new DebateStore(dir);
    const ask = async (agentId, task) => ({
      agentId,
      text: `${agentId}：根据官方文档，原子快照能避免读到一半的索引，但清理失败的旧快照会堆积。`,
      receivedAt: Date.now(),
      attribution: { requestId: 'q', note: 'test' },
      stage: task.stage,
      citations: [{
        url: 'https://docs.example.com/snapshot',
        finalUrl: 'https://docs.example.com/snapshot',
        title: '官方文档',
        anchorText: '官方文档',
        fetchedAt: Date.now()
      }]
    });
    const orchestrator = new DebateOrchestrator(store, { ask });
    const started = orchestrator.start('Generation 原子快照的收益和风险是什么？', {
      strategy: 'truth',
      maxRounds: 1,
      participants: ['a', 'b'],
      convergenceStop: false
    });
    const state = await orchestrator.waitFor(started.debateId, 10_000);
    assert.ok(state);
    assert.ok(Array.isArray(state.claimEvidenceLinks));
    const validation = validateClaimEvidenceLinks(state, state.claimEvidenceLinks);
    assert.deepEqual(validation.errors, [], '真实辩论不能产生悬空关联');
    assert.equal(state.claimEvidenceLinksSource, 'rules-judge');
    if ((state.evidence ?? []).length > 0) {
      assert.ok(state.claimEvidenceLinks.length > 0, '有证据就应该有关联记录');
    }
    const read = store.get(started.debateId);
    assert.deepEqual(read.claimEvidenceLinks, state.claimEvidenceLinks);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('校验器：同一对证据两个方向直接报错，不返回两份', () => {
  const c = claim('c1');
  const e = evidence('e1', ['c1']);
  const state = stateOf({ claims: [c], evidenceList: [e], judgments: [] });
  const base = {
    debateId: 'debate-links',
    claimId: 'c1',
    evidenceId: 'e1',
    source: 'judge',
    reason: 'test'
  };
  const result = validateClaimEvidenceLinks(state, [
    { ...base, relation: 'supports' },
    { ...base, relation: 'contradicts' }
  ]);
  assert.equal(result.valid.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /同一对证据出现多条关联/);
});

test('Pack 只给 context；同一对证据被裁判判 supports 时以裁判为准', () => {
  const c = claim('c1');
  const e = evidence('e1', []);
  const state = stateOf({
    claims: [c],
    evidenceList: [e],
    judgments: []
  });
  state.packEvidenceLinks = [{
    debateId: 'debate-links',
    claimId: 'c1',
    evidenceId: 'e1',
    relation: 'context',
    source: 'pack',
    reason: '引用代码'
  }];
  const contextOnly = buildClaimEvidenceLinks(state);
  assert.equal(contextOnly.length, 1);
  assert.equal(contextOnly[0].source, 'pack');
  assert.equal(contextOnly[0].relation, 'context');

  const withJudge = buildClaimEvidenceLinks({
    ...state,
    judgments: [judgment('c1', 'supported', ['e1'])]
  });
  assert.equal(withJudge.length, 1);
  assert.equal(withJudge[0].source, 'judge');
  assert.equal(withJudge[0].relation, 'supports');
});
