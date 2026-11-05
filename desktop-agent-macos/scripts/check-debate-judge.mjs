/**
 * Phase 3 · 三维裁判与终审（任务书 AC-11 / AC-12 / AC-13）。
 *
 * 钉住的红线：
 * 1. 逻辑、证据、反例各自给结论，不压成一个平均分；
 * 2. 结论不读票数——三个模型一起说错，一个模型拿出官方源码，少数派胜出；
 * 3. `insufficient_evidence` 与 `unsupported` 是两个判断，证据拿不到时不许硬判；
 * 4. 两条链接指向同一份官方文档 = 一个来源，不是两个（TF-D-012）。
 *
 * Run with: npm run test:debate-judge
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildEvidence, dedupeEvidence, independentSourceCount, sameOrigin } from '../out-test/main/debate/evidence.js';
import { judgeDebate } from '../out-test/main/debate/judges.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

function claim(agentId, text, overrides = {}) {
  const messageId = overrides.messageId ?? `m-${agentId}`;
  return {
    claimId: `${messageId}#0`,
    messageId,
    agentId,
    roundIndex: 0,
    text,
    kind: 'fact',
    kindCue: '陈述句',
    span: { messageId, start: 0, end: text.length },
    assumptions: [],
    evidenceDrafts: [],
    status: 'proposed',
    ...overrides
  };
}

function evidence(id, claimIds, overrides = {}) {
  return {
    evidenceId: id,
    claimIds,
    kind: 'official-doc',
    excerpt: '官方文档',
    span: { messageId: 'm', start: 0, end: 4 },
    sourceId: 'a',
    messageId: 'm',
    roundIndex: 0,
    fingerprint: `fp-${id}`,
    originKey: `url:https://docs.example.com/${id}`,
    independent: true,
    verified: 'page-link',
    assessment: '页面给出的链接',
    ...overrides
  };
}

function stateOf(claims, evidenceList, overrides = {}) {
  return {
    debateId: 'debate-judge',
    question: '这个库支持并发写入吗？',
    config: { strategy: 'standard', maxRounds: 3, participants: [...new Set(claims.map(item => item.agentId))], convergenceStop: false },
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
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

const dimension = (judgment, name) => judgment.dimensions.find(item => item.dimension === name);

// ---------------------------------------------------------------------------
// 三个维度分别输出
// ---------------------------------------------------------------------------

test('三个维度都在，各给各的结论，不压成平均分', () => {
  const single = claim('a', '这个库支持并发写入，因为官方文档写明了多线程写入。', {
    kind: 'inference',
    evidenceDrafts: [{ excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }]
  });
  const run = judgeDebate(stateOf([single], [evidence('ev-1', [single.claimId])]));

  const judged = run.judgments[0];
  assert.deepEqual(judged.dimensions.map(item => item.dimension), ['logic', 'evidence', 'counterexample']);
  assert.equal(dimension(judged, 'logic').outcome, 'valid');
  assert.equal(dimension(judged, 'evidence').outcome, 'sufficient');
  assert.equal(dimension(judged, 'counterexample').outcome, 'none');
  assert.equal(judged.verdict, 'supported');

  // 没有「总分」这种字段：分数一出现，三个维度就又会被压回一个数。
  assert.equal(judged.score, undefined);
  assert.equal(run.verdict.score, undefined);
  for (const item of judged.dimensions) {
    assert.ok(item.rationale.length > 0, `${item.dimension} 必须留理由`);
  }
});

test('逻辑对但证据拿不到 → insufficient_evidence，不是 unsupported（TF-D-013）', () => {
  const reasoned = claim('a', '因为命令执行是单线程的，所以并发写入会互相阻塞。', { kind: 'inference' });
  const run = judgeDebate(stateOf([reasoned], []));

  const judged = run.judgments[0];
  assert.equal(dimension(judged, 'logic').outcome, 'valid', '推理链本身成立');
  assert.equal(dimension(judged, 'evidence').outcome, 'absent');
  assert.equal(judged.verdict, 'insufficient_evidence', '判不了就是判不了，不能说成「错」');
  assert.match(judged.rationale, /证据不足|判不了/);
  assert.equal(run.verdict.verdict, 'insufficient_evidence');
  assert.equal(run.verdict.conclusion, null, '没有结论时不许挑一句顶上');
});

test('只有「官方文档说」这句说法、没有链接 → 仍然判不了', () => {
  const reported = claim('a', '官方文档写明了这个接口支持并发调用。', {
    evidenceDrafts: [{ excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }]
  });
  const run = judgeDebate(stateOf([reported], [evidence('ev-r', [reported.claimId], { verified: 'reported', originKey: null })]));
  assert.equal(dimension(run.judgments[0], 'evidence').outcome, 'unverifiable');
  assert.equal(run.judgments[0].verdict, 'insufficient_evidence');
});

test('证据充分但推理不成立 → 最多 partially_supported', () => {
  const shaky = claim('a', '绝对可以肯定所有版本都能并发写入，因为官方文档写明了从来如此。', {
    kind: 'inference',
    evidenceDrafts: [{ excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }]
  });
  const run = judgeDebate(stateOf([shaky], [evidence('ev-s', [shaky.claimId])]));
  const judged = run.judgments[0];
  assert.equal(dimension(judged, 'evidence').outcome, 'sufficient');
  assert.equal(dimension(judged, 'logic').outcome, 'questionable');
  assert.equal(judged.verdict, 'partially_supported');
});

test('对方拿出可核验的官方材料 → contradicted，由反例维度决定', () => {
  const mine = claim('a', '这个库在所有版本都支持并发写入。');
  const other = claim('b', '这个库在 6.0 之前不支持并发写入，旧版本会丢数据。');
  const counterEvidence = evidence('ev-b', [other.claimId], {
    kind: 'official-doc',
    excerpt: 'release notes',
    sourceId: 'b',
    messageId: other.messageId,
    originKey: 'url:https://docs.example.com/release-notes'
  });
  const run = judgeDebate(stateOf([mine, other], [counterEvidence], {
    disputes: [{
      disputeId: 'd1',
      roundIndex: 0,
      claimIds: [mine.claimId, other.claimId],
      agents: ['a', 'b'],
      type: 'factual',
      priority: 0.9,
      reason: '两句直接矛盾',
      status: 'open'
    }]
  }));

  const judged = run.judgments.find(item => item.claimId === mine.claimId);
  assert.equal(dimension(judged, 'counterexample').outcome, 'refuted');
  assert.equal(judged.verdict, 'contradicted');
  assert.ok(judged.decidedBy.includes('counterexample'));
});

test('仅仅有人不同意，不构成反例', () => {
  const mine = claim('a', '这个库支持并发写入，因为官方文档写明了。', { kind: 'inference' });
  const other = claim('b', '我觉得这个库不支持并发写入，用起来很卡。');
  const run = judgeDebate(stateOf([mine, other], [evidence('ev-a', [mine.claimId])], {
    disputes: [{
      disputeId: 'd2',
      roundIndex: 0,
      claimIds: [mine.claimId, other.claimId],
      agents: ['a', 'b'],
      type: 'factual',
      priority: 0.7,
      reason: '两句矛盾',
      status: 'open'
    }]
  }));

  const judged = run.judgments.find(item => item.claimId === mine.claimId);
  assert.equal(dimension(judged, 'counterexample').outcome, 'none');
  assert.equal(judged.verdict, 'supported');
});

test('两份证据互相冲突 → insufficient_evidence', () => {
  const mine = claim('a', '这个接口的默认连接数是 100。');
  const other = claim('b', '这个接口的默认连接数是 10000。');
  const run = judgeDebate(stateOf([mine, other], [
    evidence('ev-100', [mine.claimId], { excerpt: '默认连接数是 100' }),
    evidence('ev-10000', [other.claimId], { excerpt: '默认连接数是 10000', sourceId: 'b', messageId: other.messageId })
  ], {
    disputes: [{
      disputeId: 'd3',
      roundIndex: 0,
      claimIds: [mine.claimId, other.claimId],
      agents: ['a', 'b'],
      type: 'evidence_conflict',
      priority: 0.8,
      reason: '两边给的数字对不上',
      status: 'open'
    }]
  }));

  for (const judged of run.judgments) {
    assert.equal(dimension(judged, 'evidence').outcome, 'conflicting');
    assert.equal(judged.verdict, 'insufficient_evidence');
  }
  assert.equal(run.verdict.verdict, 'insufficient_evidence');
  assert.ok(run.verdict.unresolved.length > 0);
});

// ---------------------------------------------------------------------------
// 不多数投票
// ---------------------------------------------------------------------------

test('TF-D-011：三个模型说错、一个模型拿出官方依据，少数派胜出', () => {
  const majority = [
    claim('a', '这个库支持并发写入，可以放心用。'),
    claim('b', '这个库支持并发写入，我一直在用。'),
    claim('c', '这个库支持并发写入，没有问题。')
  ];
  const minority = claim('d', '这个库在 6.0 之前不支持并发写入，官方 release notes 写明了这一点。', {
    evidenceDrafts: [{ excerpt: 'release notes', kind: 'official-doc', start: 0, end: 12, cue: '官方文档' }]
  });
  const minorityEvidence = evidence('ev-minority', [minority.claimId], {
    kind: 'official-doc',
    excerpt: 'release notes',
    sourceId: 'd',
    messageId: minority.messageId,
    originKey: 'url:https://docs.example.com/release-notes'
  });

  const run = judgeDebate(stateOf([...majority, minority], [minorityEvidence], {
    minorities: [{
      messageId: minority.messageId,
      agentId: 'd',
      roundIndex: 0,
      role: 'peer',
      kind: 'position',
      text: minority.text,
      createdAt: 1
    }],
    disputes: majority.map((item, index) => ({
      disputeId: `dm-${String(index)}`,
      roundIndex: 0,
      claimIds: [item.claimId, minority.claimId],
      agents: ['a', 'd'],
      type: 'factual',
      priority: 0.8,
      reason: '一个说有、一个说没有',
      status: 'open'
    }))
  }));

  assert.equal(run.verdict.conclusion, minority.text, '结论应当是被证据支持的那一句');
  assert.equal(run.verdict.verdict, 'supported');
  assert.equal(run.verdict.minorityWins, true);
  assert.match(run.verdict.minorityReason ?? '', /少数派/);

  // 再多三个人说同一句错话，结论不变：人数只描述分布，不参与判断。
  const bigger = [
    ...majority,
    claim('e', '这个库支持并发写入，放心。'),
    claim('f', '这个库支持并发写入，没问题。'),
    claim('g', '这个库支持并发写入，真的。')
  ];
  const again = judgeDebate(stateOf([...bigger, minority], [minorityEvidence], {
    minorities: [{
      messageId: minority.messageId,
      agentId: 'd',
      roundIndex: 0,
      role: 'peer',
      kind: 'position',
      text: minority.text,
      createdAt: 1
    }]
  }));
  assert.equal(again.verdict.conclusion, run.verdict.conclusion);
  assert.equal(again.verdict.verdict, 'supported');
});

test('整场结论里没有任何票数字段', () => {
  const single = claim('a', '这个库支持并发写入。');
  const run = judgeDebate(stateOf([single], [evidence('ev-1', [single.claimId])]));
  const keys = Object.keys(run.verdict);
  for (const forbidden of ['supportCount', 'votes', 'majority', 'score']) {
    assert.ok(!keys.includes(forbidden), `结论里不该有 ${forbidden}`);
  }
  assert.match(run.verdict.note, /没有用模型数量或票数/);
});

// ---------------------------------------------------------------------------
// 同源识别（TF-D-012）
// ---------------------------------------------------------------------------

test('TF-D-012：两个网站引用同一份官方文档，只算一个来源', () => {
  const fromA = claim('a', '默认连接数是 1024，官方文档写明了。', {
    evidenceDrafts: [{ excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }]
  });
  const fromB = claim('b', '默认连接数应该是 1024，我看到官方文档是这么写的。', {
    evidenceDrafts: [{ excerpt: '官方文档', kind: 'official-doc', start: 0, end: 4, cue: '官方文档' }]
  });
  const list = dedupeEvidence([
    evidence('ev-a', [fromA.claimId], {
      sourceId: 'a',
      messageId: fromA.messageId,
      url: 'https://docs.example.com/config?utm_source=chatgpt',
      finalUrl: 'https://docs.example.com/config'
    }),
    evidence('ev-b', [fromB.claimId], {
      sourceId: 'b',
      messageId: fromB.messageId,
      url: 'https://www.google.com/url?q=https://docs.example.com/config',
      finalUrl: 'https://docs.example.com/config'
    })
  ]);

  const second = list.find(item => item.evidenceId === 'ev-b');
  assert.equal(second.independent, false, '第二条是转载/重复，不是第二个独立来源');
  assert.equal(second.duplicateOf, 'ev-a');
  assert.equal(sameOrigin(list[0], list[1]), true);
  assert.equal(independentSourceCount(list, fromA.claimId), 1);
  assert.equal(independentSourceCount(list, fromB.claimId), 1, '两份记录，一个来源');

  // 证据维度据此只认一个来源——不会因为「两个网站都这么说」变成充分证据。
  const run = judgeDebate(stateOf([fromA, fromB], list));
  const judged = run.judgments.find(item => item.claimId === fromA.claimId);
  assert.equal(dimension(judged, 'evidence').outcome, 'sufficient', '一个官方来源仍可判充分');
  assert.ok(dimension(judged, 'evidence').signals.some(text => text.includes('独立来源 1')));
});

// ---------------------------------------------------------------------------
// 页面链接 → 证据
// ---------------------------------------------------------------------------

test('页面给出的链接变成可核验证据，跳转包装会被展开', () => {
  const message = {
    messageId: 'm-page',
    roundIndex: 0,
    agentId: 'kimi',
    role: 'peer',
    kind: 'position',
    text: '默认连接数是 1024，官方文档写明了。',
    citations: [{
      url: 'https://www.google.com/url?q=https://docs.example.com/config&sa=U',
      anchorText: '官方文档',
      title: 'Configuration',
      pageUrl: 'https://kimi.com/chat/1',
      fetchedAt: 1700000000000
    }],
    createdAt: 1700000000000
  };
  const single = claim('kimi', message.text, { messageId: 'm-page' });
  const built = buildEvidence({
    rounds: [{
      index: 0,
      messages: [message],
      startedAt: 1,
      endedAt: 2,
      converged: false,
      failures: [],
      claims: [single]
    }]
  });

  const fromPage = built.find(item => item.verified === 'page-link');
  assert.ok(fromPage, '页面链接要变成证据');
  assert.equal(fromPage.finalUrl, 'https://docs.example.com/config');
  assert.equal(fromPage.fetchedAt, 1700000000000);
  assert.equal(fromPage.pageTitle, 'Configuration');
  assert.ok(fromPage.fingerprint.length > 0);
  assert.deepEqual(fromPage.claimIds, [single.claimId], '链接要挂到自称有出处的那句上');

  const run = judgeDebate(stateOf([single], built));
  assert.equal(run.judgments[0].verdict, 'supported');
});

// ---------------------------------------------------------------------------
// 端到端：真跑三轮，证据、图、结论都落盘
// ---------------------------------------------------------------------------

test('真跑三轮辩论：页面引用落成证据，收尾给出三维结论', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-judge-'));
  const store = new DebateStore(dir);
  let call = 0;
  const ask = async (agentId, task) => {
    call += 1;
    if (call <= 2) {
      const text = agentId === 'a'
        ? '这个库在 6.0 之前不支持并发写入，官方 release notes 写明了这一点。'
        : '这个库支持并发写入，可以放心用。';
      // 只有 a 的页面给了链接：b 只是断言。
      const citations = agentId === 'a'
        ? [{ url: 'https://www.google.com/url?q=https://docs.example.com/release-notes&utm_source=web', anchorText: 'release notes', title: 'Release notes', fetchedAt: 1700000000000 }]
        : undefined;
      return { agentId, text, receivedAt: Date.now(), citations, attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
    }
    const text = `决策：defend\n${agentId} 坚持原来的判断，理由同上。`;
    return { agentId, text, receivedAt: Date.now(), attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
  };

  const orchestrator = new DebateOrchestrator(store, { ask });
  const started = orchestrator.start('这个库支持并发写入吗？', {
    strategy: 'standard',
    maxRounds: 3,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await orchestrator.waitFor(started.debateId, 10_000);

  assert.deepEqual(state.rounds.map(round => round.phase), ['analysis', 'challenge', 'response']);

  // 页面链接跟着发言一起落盘，然后变成带地址与指纹的证据。
  const firstRound = state.rounds[0].messages.find(message => message.agentId === 'a');
  assert.equal(firstRound.citations.length, 1);
  const fromPage = (state.evidence ?? []).find(item => item.verified === 'page-link');
  assert.ok(fromPage, '页面链接要变成证据');
  assert.equal(fromPage.finalUrl, 'https://docs.example.com/release-notes');
  assert.ok(fromPage.fingerprint.length > 0);

  // 图里有判断节点，结论是五档之一，三维都在。
  assert.ok(state.graph.nodes.some(node => node.type === 'judgment'), '结论要进图');
  assert.ok(state.graph.edges.some(edge => edge.relation === 'supports'), '证据要连到主张');
  assert.equal(state.verdict.dimensions.length, 3);
  assert.ok(state.judgments.length > 0);
  assert.equal(
    ['supported', 'partially_supported', 'unsupported', 'contradicted', 'insufficient_evidence']
      .includes(state.verdict.verdict),
    true
  );

  // 读盘回来一致：证据、图、结论都在同一个文件里。
  const reloaded = store.get(started.debateId);
  assert.equal(reloaded.verdict.verdict, state.verdict.verdict);
  assert.equal(reloaded.evidence.length, state.evidence.length);
  assert.equal(reloaded.graph.nodes.length, state.graph.nodes.length);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('范围争议只限制「没写范围」的那一句', () => {
  const qualified = claim('a', '在 6.0 之前，这个库不支持并发写入，官方 release notes 写明了。', {
    assumptions: ['在 6.0 之前'],
    evidenceDrafts: [{ excerpt: 'release notes', kind: 'official-doc', start: 0, end: 12, cue: '官方文档' }]
  });
  const absolute = claim('b', '这个库支持并发写入，任何版本都可以。');
  const docs = evidence('ev-scope', [qualified.claimId], {
    excerpt: 'release notes',
    sourceId: 'a',
    messageId: qualified.messageId,
    originKey: 'url:https://docs.example.com/release-notes'
  });
  const run = judgeDebate(stateOf([qualified, absolute], [docs], {
    disputes: [{
      disputeId: 'd-scope',
      roundIndex: 0,
      claimIds: [qualified.claimId, absolute.claimId],
      agents: ['a', 'b'],
      type: 'scope',
      priority: 0.7,
      reason: '一句带版本范围，一句是绝对表述',
      status: 'open'
    }]
  }));

  const mine = run.judgments.find(item => item.claimId === qualified.claimId);
  const other = run.judgments.find(item => item.claimId === absolute.claimId);
  assert.equal(dimension(mine, 'counterexample').outcome, 'none', '已经写明范围的那句不受范围限制');
  assert.equal(mine.verdict, 'supported');
  assert.equal(dimension(other, 'counterexample').outcome, 'limited', '绝对表述那句才受限制');
});

// ---------------------------------------------------------------------------
// 前后矛盾的判据（真机跑出来的误判）
// ---------------------------------------------------------------------------

const logicOutcome = (judgment) =>
  judgment.dimensions.find(item => item.dimension === 'logic').outcome;

test('说的不是同一个范围，不算前后矛盾', () => {
  const narrow = claim('a', 'SQLite 不适合作为高并发写入的主数据库，写入会串行化。', { messageId: 'm-a1' });
  const other = claim('a', 'SQLite 适合读多写少的场景，比如本地缓存。', { messageId: 'm-a2' });
  const run = judgeDebate(stateOf([narrow, other], []));
  for (const item of run.judgments) {
    assert.notEqual(logicOutcome(item), 'invalid', `不该判成前后矛盾：${item.claimText}`);
  }
});

test('真正改口仍然判 invalid', () => {
  const before = claim('a', '这个库支持并发写入，可以放心用。', { messageId: 'm-b1' });
  const after = claim('a', '这个库不支持并发写入，会丢数据。', { messageId: 'm-b2' });
  const run = judgeDebate(stateOf([before, after], []));
  for (const item of run.judgments) {
    assert.equal(logicOutcome(item), 'invalid', `改口没判出来：${item.claimText}`);
  }
});

test('写了适用范围的判断，不按改口处理', () => {
  const before = claim('a', '在 6.0 之前，这个库不支持并发写入。', {
    messageId: 'm-c1',
    assumptions: ['在 6.0 之前']
  });
  const after = claim('a', '在 6.0 之后，这个库支持并发写入。', {
    messageId: 'm-c2',
    assumptions: ['在 6.0 之后']
  });
  const run = judgeDebate(stateOf([before, after], []));
  for (const item of run.judgments) {
    assert.notEqual(logicOutcome(item), 'invalid', `范围不同被判成改口：${item.claimText}`);
  }
});

test('同一条发言里把两种说法都写出来，不算前后矛盾', () => {
  // 质疑者常见的写法：先复述对方，再给自己的判断。
  const quoted = claim('a', '有人说这个库支持并发写入，可以放心用。', { messageId: 'm-d1' });
  const mine = claim('a', '但它不支持并发写入，会丢数据。', { messageId: 'm-d1' });
  const run = judgeDebate(stateOf([quoted, mine], []));
  for (const item of run.judgments) {
    assert.notEqual(logicOutcome(item), 'invalid', `同一条发言内的两种说法被判成改口：${item.claimText}`);
  }
});

test('少数几句推理不成立，不把整场判成「不成立」', () => {
  const flipA = claim('a', '这个库支持并发写入，可以放心用。', { messageId: 'm-e1' });
  const flipB = claim('a', '这个库不支持并发写入，会丢数据。', { messageId: 'm-e2' });
  const plain = claim('b', '连接池大小取决于并发量。', { messageId: 'm-f1' });
  const run = judgeDebate(stateOf([flipA, flipB, plain], []));
  assert.equal(run.verdict.verdict, 'insufficient_evidence', '不能因为两句吵架就说整场不成立');
  assert.match(run.verdict.rationale, /推理不成立/);
  assert.match(run.verdict.rationale, /证据不足/);
});

test('每条主张都推理不成立时，整场才是「不成立」', () => {
  const flipA = claim('a', '这个库支持并发写入，可以放心用。', { messageId: 'm-g1' });
  const flipB = claim('a', '这个库不支持并发写入，会丢数据。', { messageId: 'm-g2' });
  const run = judgeDebate(stateOf([flipA, flipB], []));
  assert.equal(run.verdict.verdict, 'unsupported');
});

// ---------------------------------------------------------------------------
// 质量诊断里发现的判据缺陷：每一条都先复现过误判，再修
// ---------------------------------------------------------------------------

test('规范陈述里的全称量词不是「绝对化断言」', () => {
  for (const text of [
    '所有 HTTP/1.1 请求都必须带 Host 头。',
    '任何情况下都不应该在生产环境关闭校验。',
    '所有请求一律要求带签名。'
  ]) {
    const run = judgeDebate(stateOf([claim('a', text, { messageId: `m-${text.length}` })], []));
    assert.equal(logicOutcome(run.judgments[0]), 'valid', `规范句被误伤：${text}`);
  }
  // 没有规范标记的全称概括照旧提示，别把判据放宽成什么都不管。
  const overclaim = judgeDebate(stateOf([claim('b', '这个库支持并发写入，任何版本都可以。')], []));
  assert.equal(logicOutcome(overclaim.judgments[0]), 'questionable');
});

test('「因为」不等于有依据：诉诸众人与循环论证都要抓', () => {
  const hollow = [
    '这个库支持并发写入，因为大家都这么说。',
    '它很可靠，因为它是可靠的。',
    '这个方案没问题，因为众所周知它没问题。'
  ];
  for (const [index, text] of hollow.entries()) {
    const run = judgeDebate(stateOf([claim('a', text, { messageId: `m-h${index}`, kind: 'inference' })], []));
    assert.equal(logicOutcome(run.judgments[0]), 'questionable', `空洞理由没抓住：${text}`);
    // combine 里「证据不足」优先于逻辑瑕疵，所以要看逻辑维度自己的理由。
    assert.match(dimension(run.judgments[0], 'logic').rationale, /大家都这么说|循环论证/);
  }
  // 真推理链不能误伤（TF-D-013 靠这条）。
  const real = judgeDebate(stateOf([
    claim('b', '因为命令执行是单线程的，所以并发写入会互相阻塞。', { messageId: 'm-real', kind: 'inference' })
  ], []));
  assert.equal(logicOutcome(real.judgments[0]), 'valid');
});

test('版本对不上：归档的 v1.0 材料不能撑起「7.0 里」的主张', () => {
  const fresh = claim('a', '在 7.0 里默认值改成了 2048。', { assumptions: ['在 7.0 里'] });
  const old = evidence('ev-old', [fresh.claimId], {
    excerpt: '默认值改成了 2048',
    pageTitle: 'v1.0 配置手册（已归档）',
    fetchedAt: Date.UTC(2018, 0, 1)
  });
  const run = judgeDebate(stateOf([fresh], [old]));
  assert.equal(dimension(run.judgments[0], 'evidence').outcome, 'partial');
  assert.match(run.judgments[0].rationale, /版本对不上|时效性/);
  assert.equal(run.verdict.verdict, 'partially_supported', '不能判成有充分证据支持');
});

test('标题写明归档、主张问当前版本，也要判时效性不足', () => {
  const fresh = claim('a', '当前版本的默认值是 2048。');
  const old = evidence('ev-arch', [fresh.claimId], {
    excerpt: '默认值是 2048', pageTitle: '旧版配置手册（归档）'
  });
  assert.match(judgeDebate(stateOf([fresh], [old])).judgments[0].rationale, /时效性|归档/);
});

test('引文里恰好出现主张版本，不算「来源版本匹配」', () => {
  const fresh = claim('a', '在 7.0 里默认值改成了 2048。', { assumptions: ['在 7.0 里'] });
  const mismatched = evidence('ev-mix', [fresh.claimId], {
    excerpt: '在 7.0 里默认值改成了 2048', pageTitle: 'v2.0 手册'
  });
  assert.equal(dimension(judgeDebate(stateOf([fresh], [mismatched])).judgments[0], 'evidence').outcome, 'partial');
});

test('没写版本就不猜：不拿抓取时间当发布时间', () => {
  const plain = claim('a', '官方 release notes 写明了这个行为。');
  const oldButUnmarked = evidence('ev-old2', [plain.claimId], {
    excerpt: 'release notes', pageTitle: 'Release notes', fetchedAt: Date.UTC(2015, 0, 1)
  });
  assert.equal(dimension(judgeDebate(stateOf([plain], [oldButUnmarked])).judgments[0], 'evidence').outcome, 'sufficient');
});

test('协议版本与 RFC 章节号不是「版本冲突」', () => {
  const spec = claim('a', '所有 HTTP/1.1 请求都必须带 Host 头。');
  const rfc = evidence('ev-rfc', [spec.claimId], {
    excerpt: 'RFC 7230', pageTitle: 'RFC 7230 Section 5.4',
    url: 'https://www.rfc-editor.org/rfc/rfc7230',
    soleAttribution: true
  });
  const run = judgeDebate(stateOf([spec], [rfc]));
  assert.equal(dimension(run.judgments[0], 'evidence').outcome, 'sufficient');
  assert.equal(run.judgments[0].verdict, 'supported');
});

test('「在一定程度上」不是绝对化断言', () => {
  const text = 'WAL 模式在一定程度上可以提高并发读取性能。';
  const run = judgeDebate(stateOf([claim('a', text, { messageId: 'm-degree' })], []));
  assert.equal(logicOutcome(run.judgments[0]), 'valid', '限定程度的措辞不该被当成强断言');
  // 真正的强断言照旧标记。
  const strong = judgeDebate(stateOf([claim('b', 'WAL 模式一定可以解决所有并发写入问题。', { messageId: 'm-strong' })], []));
  assert.equal(logicOutcome(strong.judgments[0]), 'questionable');
});
