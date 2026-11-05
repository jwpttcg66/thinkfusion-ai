/**
 * Phase 2：回应与修订（任务书 AC-06 / 6.1 的「修订回应」、第 10 节的预算）。
 *
 * 钉四件事：
 * 1. 决策能从模型自己的「决策：x」行里读出来；没写时按措辞/相似度推，并标明来源；
 * 2. 修订记录保留前后原文，不覆盖；
 * 3. 决策写回的是「被质疑的那几句」，不是整段话；
 * 4. 预算（单次超时、整场时间）到点就停，已说完的话保留。
 *
 * Run with: npm run test:debate-revision
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';
import { decideRevision, applyDecisions, revisionOf } from '../out-test/main/debate/revision.js';

const QUESTION = '这个接口能并发调用吗？';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-revision-'));
  const store = new DebateStore(dir);
  const seen = [];
  const calls = new Map();
  const state = { concurrent: 0, peak: 0 };
  const ask = async (agentId, task) => {
    seen.push({ agentId, stage: task.stage, system: task.system ?? [], context: task.context ?? [] });
    calls.set(agentId, (calls.get(agentId) ?? 0) + 1);
    state.concurrent += 1;
    state.peak = Math.max(state.peak, state.concurrent);
    try {
      if (options.delayMs) await sleep(options.delayMs);
      const text = options.responder(agentId, calls.get(agentId), task);
      return { agentId, text, receivedAt: Date.now(), attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
    } finally {
      state.concurrent -= 1;
    }
  };
  const orchestrator = new DebateOrchestrator(store, { ask });
  return { dir, store, seen, calls, state, orchestrator, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const config = (overrides = {}) => ({
  strategy: 'standard',
  maxRounds: 3,
  participants: ['a', 'b'],
  convergenceStop: false,
  ...overrides
});

// ---------------------------------------------------------------------------
// 决策解析
// ---------------------------------------------------------------------------

test('决策行写着什么就读什么，中文英文都认', () => {
  const cases = [
    ['决策：revise\n我觉得需要修正一半。', 'revise'],
    ['决策: accept\n你说得对。', 'accept'],
    ['【决策】withdraw\n这条我收回。', 'withdraw'],
    ['决策：defend\n我坚持，因为文档写明了。', 'defend'],
    ['决策：inconclusive\n现有信息判断不了。', 'inconclusive'],
    ['决策：修正\n只改范围那部分。', 'revise'],
    ['决策：不接受你的质疑\n理由是你引用的版本不对。', 'defend']
  ];
  for (const [text, expected] of cases) {
    const result = decideRevision(text, '上一轮说的话。');
    assert.equal(result.decision, expected, text);
    assert.equal(result.source, 'stated', `应当认成模型自己写的：${text}`);
  }
});

test('没写决策行时按措辞或相似度推，并标明是推的', () => {
  assert.equal(decideRevision('我撤回这个说法，之前记错了版本。', '').decision, 'withdraw');
  assert.equal(decideRevision('我撤回这个说法，之前记错了版本。', '').source, 'inferred');
  assert.equal(decideRevision('你说得对，确实是 6 之后才有的。', '').decision, 'accept');
  assert.equal(decideRevision('信息不足，无法判断这个版本的行为。', '').decision, 'inconclusive');

  const before = '连接池能把延迟从 200 毫秒降到 40 毫秒，因为复用连接省去了握手。';
  const same = decideRevision(before, before);
  assert.equal(same.decision, 'defend', '与上一轮一字不差，就是没改');
  assert.equal(same.source, 'inferred');

  // 既没写决策、措辞也没有线索、内容还换了：如实说判不出来。
  const unknown = decideRevision('换个话题，说说连接池的默认大小。', before);
  assert.equal(unknown.decision, null);
  assert.equal(unknown.source, 'unknown');
});

// ---------------------------------------------------------------------------
// 修订记录与状态回写
// ---------------------------------------------------------------------------

test('修订记录保留前后原文，不覆盖', () => {
  const revision = revisionOf({
    messageId: 'm3',
    agentId: 'a',
    roundIndex: 2,
    before: '原话：默认连接数是 100。',
    after: '决策：revise\n改成 10000，文档写的是这个数。',
    targetClaimIds: ['m1#1'],
    now: 123
  });
  assert.equal(revision.before, '原话：默认连接数是 100。');
  assert.ok(revision.after.startsWith('决策：revise'));
  assert.equal(revision.decision, 'revise');
  assert.deepEqual(revision.targetClaimIds, ['m1#1']);
  assert.equal(revision.createdAt, 123);
});

test('决策写回主张状态，只改被质疑的那几句', () => {
  const round = {
    index: 0,
    messages: [],
    startedAt: 0,
    converged: false,
    failures: [],
    claims: [
      { claimId: 'a1', agentId: 'a', status: 'challenged' },
      { claimId: 'a2', agentId: 'a', status: 'challenged' },
      { claimId: 'b1', agentId: 'b', status: 'challenged' }
    ]
  };
  const base = { messageId: 'm', roundIndex: 2, reason: '', before: '', after: '', createdAt: 0, source: 'stated' };

  applyDecisions([round], [
    { ...base, revisionId: 'r1', agentId: 'a', decision: 'withdraw', targetClaimIds: ['a1'] }
  ]);
  assert.equal(round.claims[0].status, 'withdrawn');
  assert.equal(round.claims[1].status, 'challenged', '没被点到的句子不变');
  assert.equal(round.claims[2].status, 'challenged', '别人的主张不变');

  applyDecisions([round], [
    { ...base, revisionId: 'r2', agentId: 'a', decision: 'accept', targetClaimIds: ['a2'] }
  ]);
  assert.equal(round.claims[1].status, 'revised');

  // 坚持：仍然是有争议的，不升成 supported。
  applyDecisions([round], [
    { ...base, revisionId: 'r3', agentId: 'b', decision: 'defend', targetClaimIds: ['b1'] }
  ]);
  assert.equal(round.claims[2].status, 'challenged');

  // 判不了的记 unresolved。
  applyDecisions([round], [
    { ...base, revisionId: 'r4', agentId: 'b', decision: 'inconclusive', targetClaimIds: ['b1'] }
  ]);
  assert.equal(round.claims[2].status, 'unresolved');
});

// ---------------------------------------------------------------------------
// 编排器
// ---------------------------------------------------------------------------

test('三轮的步骤依次是 独立表态 → 质疑 → 回应', async () => {
  const h = harness({ responder: () => '连接池与并发安全无关，要看具体实现。' });
  const started = h.orchestrator.start(QUESTION, config());
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.deepEqual(state.rounds.map(round => round.phase), ['analysis', 'challenge', 'response']);
  h.cleanup();
});

test('回应轮里，模型写的决策变成修订记录，原话都在', async () => {
  const h = harness({
    responder: (agentId, call) => {
      if (call === 1) return `${agentId} 认为这个接口可以并发调用，文档写明了。`;
      if (call === 2) return `${agentId} 质疑：对方没有给出具体版本。`;
      return `决策：revise\n${agentId} 修正：只有 6.0 之后的版本可以。`;
    }
  });
  const started = h.orchestrator.start(QUESTION, config());
  const state = await h.orchestrator.waitFor(started.debateId);

  const revisions = state.revisions ?? [];
  assert.equal(revisions.length, 2, '两位各一条');
  for (const revision of revisions) {
    assert.equal(revision.roundIndex, 2);
    assert.equal(revision.decision, 'revise');
    assert.equal(revision.source, 'stated');
    assert.ok(revision.before.includes('可以并发调用'), '前一次发言原文');
    assert.ok(revision.after.includes('只有 6.0 之后'), '这一次发言原文');
  }

  // 回应轮的 system 里必须有决策行格式，否则模型无从知道该写什么。
  const responseCall = h.seen.find(item => item.system.join('\n').includes('决策：accept'));
  assert.ok(responseCall, '回应轮要说明决策行怎么写');
  h.cleanup();
});

test('被质疑的句子按决策改状态：撤回的不再是「有争议」', async () => {
  const h = harness({
    responder: (agentId, call) => {
      if (call === 1) {
        return agentId === 'a'
          ? '这个接口提供了多线程安全保证，可以放心并发调用。'
          : '这个接口没有提供多线程安全保证，不能并发调用。';
      }
      if (call === 2) return `${agentId} 质疑：证据只对了一半。`;
      return agentId === 'a'
        ? '决策：withdraw\n我撤回「可以放心并发调用」这句。'
        : '决策：accept\n我接受，改成「视版本而定」。';
    }
  });
  const started = h.orchestrator.start(QUESTION, config());
  const state = await h.orchestrator.waitFor(started.debateId);

  // 第一轮的争议还留着，但被质疑的主张已经按决策改了状态。
  assert.ok((state.disputes ?? []).length >= 1);
  const statuses = new Set((state.rounds[0].claims ?? []).map(claim => claim.status));
  assert.ok(statuses.has('withdrawn'), 'a 撤回');
  assert.ok(statuses.has('revised'), 'b 接受');
  h.cleanup();
});

test('单次调用超时算这一位失败，不拖住整轮', async () => {
  const h = harness({ delayMs: 300, responder: () => '回答。' });
  const started = h.orchestrator.start(
    QUESTION,
    config({ maxRounds: 1, budget: { stageTimeoutMs: 60 } })
  );
  const state = await h.orchestrator.waitFor(started.debateId, 5000);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].messages.length, 0);
  assert.equal(state.rounds[0].failures.length, 2);
  assert.match(state.rounds[0].failures[0].detail, /超过单次调用时限/);
  h.cleanup();
});

test('整场时间预算用完就停，已完成的轮保留', async () => {
  const h = harness({ delayMs: 40, responder: () => '观点：需要看具体版本。' });
  const started = h.orchestrator.start(
    QUESTION,
    config({ budget: { totalMs: 30 } })
  );
  const state = await h.orchestrator.waitFor(started.debateId, 8000);
  assert.ok(state.rounds.length >= 1, '第一轮已经跑完的话要留下');
  assert.match(state.stopReason ?? '', /时间预算/);
  h.cleanup();
});

test('并发上限真的限住了', async () => {
  const h = harness({ delayMs: 30, responder: () => '观点。' });
  const started = h.orchestrator.start(
    QUESTION,
    config({
      maxRounds: 1,
      participants: ['a', 'b'],
      budget: { maxConcurrency: 1 }
    })
  );
  await h.orchestrator.waitFor(started.debateId, 8000);
  assert.equal(h.state.peak, 1, '上限 1 时不应该有两次调用重叠');
  h.cleanup();

  const parallel = harness({ delayMs: 30, responder: () => '观点。' });
  const started2 = parallel.orchestrator.start(QUESTION, config({ maxRounds: 1, budget: { maxConcurrency: 2 } }));
  await parallel.orchestrator.waitFor(started2.debateId, 8000);
  assert.equal(parallel.state.peak, 2);
  parallel.cleanup();
});

test('回应阶段没人改口、也没有新争议时提前停，理由说清楚', async () => {
  const h = harness({
    responder: (agentId, call) => {
      if (call === 1) return '接口文档写明了并发安全，这是有依据的判断。';
      if (call === 2) return '决策：defend\n我仍然坚持，文档写明了并发安全，没有必要改口。';
      return '决策：defend\n经过这轮质疑我确认原判断成立：文档确实写明了并发安全，其他说法站不住，理由同上。';
    }
  });
  const started = h.orchestrator.start(QUESTION, config({ convergenceStop: true }));
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.equal(state.rounds.length, 3, '要跑到回应那一轮才判断得出来');
  assert.match(state.stopReason ?? '', /没有新的修订/);
  assert.ok((state.revisions ?? []).every(revision => revision.decision === 'defend'));
  h.cleanup();
});

test('老辩论文件没有 revisions 字段，读回来是 undefined 而不是空数组', async () => {
  const h = harness({ responder: () => '观点。' });
  const started = h.orchestrator.start(QUESTION, config({ maxRounds: 1 }));
  await h.orchestrator.waitFor(started.debateId);

  const stored = h.store.get(started.debateId);
  const legacy = JSON.parse(JSON.stringify(stored));
  delete legacy.revisions;
  for (const round of legacy.rounds) delete round.phase;
  h.store.save(legacy);

  const reloaded = h.store.get(started.debateId);
  assert.equal(reloaded.revisions, undefined);
  assert.equal(reloaded.rounds[0].phase, undefined);
  h.cleanup();
});
