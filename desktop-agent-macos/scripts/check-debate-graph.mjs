/**
 * Phase 3 · 论证图（任务书 AC-08）。
 *
 * 钉住四件事：
 * 1. 四种节点与六种边都能表达，且边只连真实存在的对象；
 * 2. 每条边都带轮次与来源对象——只存最终图就还原不出关系是怎么形成的；
 * 3. 图能整份序列化/反序列化，跟着辩论文件走现有持久化；
 * 4. 同一批输入重建多次结果一致（id 由对象决定，不含随机数）。
 *
 * Run with: npm run test:debate-graph
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGraph, graphSummary } from '../out-test/main/debate/argument-graph.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function claim(overrides) {
  return {
    claimId: 'm1#0',
    messageId: 'm1',
    agentId: 'a',
    roundIndex: 0,
    text: '这句话是一个主张。',
    kind: 'fact',
    kindCue: '陈述句',
    span: { messageId: 'm1', start: 0, end: 10 },
    assumptions: [],
    status: 'proposed',
    ...overrides
  };
}

function stateOf(rounds, extra = {}) {
  return {
    debateId: 'debate-graph',
    question: '测试问题',
    config: { strategy: 'standard', maxRounds: 3, participants: ['a', 'b'], convergenceStop: false },
    rounds,
    createdAt: 1,
    updatedAt: 2,
    ...extra
  };
}

const roundOf = (index, claims, messages = []) => ({
  index,
  phase: index === 0 ? 'analysis' : index === 1 ? 'challenge' : 'response',
  messages,
  startedAt: 100 + index,
  endedAt: 150 + index,
  converged: false,
  failures: [],
  claims
});

// ---------------------------------------------------------------------------

test('四种节点都在：主张、证据、前提、质疑、判断', () => {
  const first = claim({
    claimId: 'm1#0',
    text: '在 Redis 6 之前，命令执行是单线程的，所以不要指望多线程 IO。',
    assumptions: ['在 Redis 6 之前'],
    evidenceDrafts: [
      { excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }
    ]
  });
  const second = claim({
    claimId: 'm2#0',
    messageId: 'm2',
    agentId: 'b',
    text: 'Redis 6 之后命令执行已经多线程，因此可以并发写入。',
    evidenceDrafts: [
      { excerpt: '压测', kind: 'benchmark', start: 0, end: 2, cue: '实测数据' }
    ]
  });

  const graph = buildGraph(
    stateOf([roundOf(0, [first, second])], {
      disputes: [{
        disputeId: 'm1#0~m2#0',
        roundIndex: 0,
        claimIds: ['m1#0', 'm2#0'],
        agents: ['a', 'b'],
        type: 'scope',
        priority: 0.8,
        reason: '两句话的适用范围不同',
        status: 'open'
      }],
      evidence: [
        {
          evidenceId: 'ev:m1#0:d0',
          claimIds: ['m1#0'],
          kind: 'official-doc',
          excerpt: '官方文档',
          span: { messageId: 'm1', start: 0, end: 4 },
          sourceId: 'a',
          messageId: 'm1',
          roundIndex: 0,
          fingerprint: 'f1',
          originKey: null,
          independent: true,
          verified: 'reported',
          assessment: '自称有出处'
        },
        {
          evidenceId: 'ev:m2#0:d0',
          claimIds: ['m2#0'],
          kind: 'benchmark',
          excerpt: '压测',
          span: { messageId: 'm2', start: 0, end: 2 },
          sourceId: 'b',
          messageId: 'm2',
          roundIndex: 0,
          fingerprint: 'f2',
          originKey: null,
          independent: true,
          verified: 'reported',
          assessment: '自称有实测'
        }
      ],
      judgments: [{
        judgmentId: 'j-m1#0',
        claimId: 'm1#0',
        agentId: 'a',
        claimText: first.text,
        dimensions: [],
        verdict: 'insufficient_evidence',
        decidedBy: ['evidence'],
        rationale: '只有说法，没有可核验的链接',
        evidenceIds: ['ev:m1#0:d0'],
        minority: false,
        createdAt: 300
      }]
    })
  );

  const summary = graphSummary(graph);
  assert.equal(summary.nodes.claim, 3, '两句主张 + 一个前提（判断节点单独计数）');
  assert.equal(summary.nodes.evidence, 2, '每句主张各一条证据草稿');
  assert.equal(summary.nodes.challenge, 1);
  assert.equal(summary.nodes.judgment, 1);
  assert.ok(summary.edges.depends_on >= 2, '主张依赖前提 + 判断依赖证据');
  assert.ok(summary.edges.supports >= 2, '证据支持主张');
  assert.ok(summary.edges.qualifies >= 1, '范围争议连成 qualifies');
  assert.ok(summary.edges.derived_from >= 2, '质疑与判断都从主张推导而来');
});

test('每条边都有轮次和来源对象，能还原它是怎么形成的', () => {
  const first = claim({ claimId: 'm1#0', text: '这个接口可以并发调用。' });
  const second = claim({
    claimId: 'm2#0',
    messageId: 'm2',
    agentId: 'b',
    text: '这个接口不能并发调用。'
  });
  const graph = buildGraph(
    stateOf([roundOf(0, [first, second])], {
      disputes: [{
        disputeId: 'd1',
        roundIndex: 0,
        claimIds: ['m1#0', 'm2#0'],
        agents: ['a', 'b'],
        type: 'factual',
        priority: 0.9,
        reason: '两句直接矛盾',
        status: 'open'
      }]
    })
  );

  assert.ok(graph.edges.length > 0);
  for (const edge of graph.edges) {
    assert.equal(typeof edge.roundIndex, 'number', `边 ${edge.edgeId} 缺轮次`);
    assert.ok(edge.rationale.length > 0, `边 ${edge.edgeId} 缺理由`);
    assert.ok(Array.isArray(edge.source.messageIds) && Array.isArray(edge.source.claimIds));
    const hasSource =
      edge.source.claimIds.length > 0 ||
      edge.source.messageIds.length > 0 ||
      Boolean(edge.source.disputeId || edge.source.revisionId || edge.source.evidenceId);
    assert.ok(hasSource, `边 ${edge.edgeId} 没有来源对象`);
  }

  const contradicts = graph.edges.find(edge => edge.relation === 'contradicts');
  assert.ok(contradicts, '直接矛盾要有 contradicts 边');
  assert.equal(contradicts.source.disputeId, 'd1');
  assert.equal(contradicts.roundIndex, 0);

  // 边的两端必须真的存在：悬空边会让图读不出东西。
  const ids = new Set(graph.nodes.map(node => node.nodeId));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.fromId), `起点不存在：${edge.fromId}`);
    assert.ok(ids.has(edge.toId), `终点不存在：${edge.toId}`);
  }
});

test('修订连成 derived_from，带 revisionId 与所在轮次', () => {
  const before = claim({ claimId: 'm1#0', text: '默认连接数是 100。' });
  const after = claim({
    claimId: 'm3#0',
    messageId: 'm3',
    roundIndex: 2,
    text: '默认连接数改成 10000，文档写的是这个数。'
  });
  const graph = buildGraph(
    stateOf([roundOf(0, [before]), roundOf(2, [after])], {
      revisions: [{
        revisionId: 'r1',
        messageId: 'm3',
        agentId: 'a',
        roundIndex: 2,
        decision: 'revise',
        source: 'stated',
        reason: '文档写的是 10000',
        before: before.text,
        after: after.text,
        targetClaimIds: ['m1#0'],
        createdAt: 300
      }]
    })
  );

  const edge = graph.edges.find(item => item.source.revisionId === 'r1');
  assert.ok(edge, '修订要留下一条边');
  assert.equal(edge.relation, 'derived_from');
  assert.equal(edge.fromId, 'claim:m3#0');
  assert.equal(edge.toId, 'claim:m1#0');
  assert.equal(edge.roundIndex, 2);
});

test('同一批输入重建多次，图完全一致（可序列化、可持久化）', () => {
  const first = claim({
    claimId: 'm1#0',
    assumptions: ['在 6.0 之前'],
    evidenceDrafts: [{ excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }]
  });
  const state = stateOf([roundOf(0, [first])], {
    disputes: [],
    evidence: [{
      evidenceId: 'ev:m1#0:d0',
      claimIds: ['m1#0'],
      kind: 'official-doc',
      excerpt: '官方文档',
      span: { messageId: 'm1', start: 0, end: 4 },
      sourceId: 'a',
      messageId: 'm1',
      roundIndex: 0,
      fingerprint: 'abc',
      originKey: null,
      independent: true,
      verified: 'reported',
      assessment: '自称有出处'
    }]
  });

  const one = buildGraph(state);
  const two = buildGraph(state);
  assert.deepEqual(two, one, '重建结果必须一致，否则每次读盘都会改文件');

  const restored = JSON.parse(JSON.stringify(one));
  assert.deepEqual(restored, one, '整份图必须能原样序列化');
  assert.equal(restored.version, 1);
});

test('真跑一场辩论：图跟着轮次长出来，结论落在记录里', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-graph-'));
  const store = new DebateStore(dir);
  let call = 0;
  const ask = async (agentId, task) => {
    call += 1;
    const text = call <= 2
      ? (agentId === 'a'
        ? '在 6.0 之前，这个接口不支持并发调用，因为命令执行是单线程的。'
        : '这个接口支持并发调用，官方文档写明了这一点。')
      : `决策：defend\n${agentId} 坚持原来的判断。`;
    await sleep(5);
    return { agentId, text, receivedAt: Date.now(), attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
  };
  const orchestrator = new DebateOrchestrator(store, { ask });
  const started = orchestrator.start('这个接口能并发调用吗？', {
    strategy: 'standard',
    maxRounds: 2,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await orchestrator.waitFor(started.debateId, 10_000);

  assert.ok(state.graph, '辩论跑完必须有图');
  assert.ok(state.graph.nodes.length > 0);
  assert.ok(state.graph.edges.length > 0);
  assert.ok(state.verdict, '跑完要有结论');
  assert.equal(state.verdict.backend, 'rules');

  // 读盘回来仍然是同一张图：图跟着辩论文件走，没有第二套存储。
  const reloaded = store.get(started.debateId);
  assert.deepEqual(reloaded.graph, state.graph);
  assert.deepEqual(reloaded.verdict.verdict, state.verdict.verdict);

  fs.rmSync(dir, { recursive: true, force: true });
});
