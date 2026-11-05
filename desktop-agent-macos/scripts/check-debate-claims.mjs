/**
 * Phase 1：辩论里的结构化主张与争议。
 *
 * 这一层不新增判据——claim 切句用综合链那一份，争议判据用 relations 那一份。
 * 所以要钉住的不是「判得准不准」，而是这三件事：
 *
 * 1. 只把**跨参与者**的对不上算成争议（同一个人前后两句相反，是它自己在论证）；
 * 2. 挑战指向具体两句，不是「请再想想」；
 * 3. 没有争议时不硬造，第二轮回到通用指令。
 *
 * Run with: npm run test:debate-claims
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyseRound, challengesFor } from '../out-test/main/debate/claims.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

const message = (messageId, agentId, text, roundIndex = 0) => ({
  messageId,
  roundIndex,
  agentId,
  role: 'peer',
  kind: 'position',
  text,
  createdAt: 1
});

const CONTRADICT_A = '这个接口提供了多线程安全保证，可以放心并发调用。';
const CONTRADICT_B = '这个接口没有提供多线程安全保证，不能并发调用。';

function harness(responder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-claims-'));
  const store = new DebateStore(dir);
  const seen = [];
  const ask = async (agentId, task) => {
    seen.push({ agentId, question: task.question, system: task.system ?? [], context: task.context ?? [] });
    const text = responder(agentId, seen.length);
    return { agentId, text, receivedAt: Date.now(), attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
  };
  const orchestrator = new DebateOrchestrator(store, { ask });
  return { store, seen, orchestrator, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------

test('每条发言切成句子，带原话位置和类型', () => {
  const { claims } = analyseRound([message('m1', 'a', 'Redis 6 引入了多线程 IO。所以吞吐比 5 高，但不是所有操作都并行。')], 0);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].messageId, 'm1');
  assert.equal(claims[0].agentId, 'a');
  assert.equal(claims[0].roundIndex, 0);
  assert.equal(claims[0].status, 'proposed');
  // span 能落回原话：切出来的每个字都要能在原文里找到。
  for (const claim of claims) {
    const source = 'Redis 6 引入了多线程 IO。所以吞吐比 5 高，但不是所有操作都并行。';
    assert.equal(source.slice(claim.span.start, claim.span.end).trim(), claim.text);
  }
  // 第二句带「所以」，是推断不是事实——类型不是随便给的。
  assert.equal(claims[1].kind, 'inference');
});

test('直接矛盾判成 factual，并指向两句原话', () => {
  const { claims, disputes } = analyseRound(
    [message('m1', 'a', CONTRADICT_A), message('m2', 'b', CONTRADICT_B)],
    0
  );
  assert.equal(disputes.length, 1);
  assert.equal(disputes[0].type, 'factual');
  assert.deepEqual(disputes[0].agents, ['a', 'b']);
  assert.equal(disputes[0].claimIds.length, 2);
  assert.ok(disputes[0].priority > 0.5, '事实句之间的矛盾该排在前面');
  assert.match(disputes[0].reason, /极性相反/);
  // 被卷进争议的两句标记为 challenged，没卷进的仍是 proposed。
  const status = new Map(claims.map(claim => [claim.claimId, claim.status]));
  for (const id of disputes[0].claimIds) assert.equal(status.get(id), 'challenged');
});

test('数字对不上判成 evidence_conflict，不是「有人说谎」', () => {
  const { disputes } = analyseRound(
    [message('m1', 'a', '连接池默认连接数是 100，够用。'), message('m2', 'b', '连接池默认连接数是 10000，够用。')],
    0
  );
  assert.equal(disputes.length, 1);
  assert.equal(disputes[0].type, 'evidence_conflict');
  assert.match(disputes[0].reason, /100/);
});

test('一句带条件、一句是绝对表述，判成 scope', () => {
  const { disputes } = analyseRound(
    [message('m1', 'a', '如果只在单线程环境里使用，就不需要连接池。'), message('m2', 'b', '任何情况下都必须使用连接池。')],
    0
  );
  assert.equal(disputes.length, 1);
  assert.equal(disputes[0].type, 'scope');
});

test('同一个人前后两句相反，不是「两个人对不上」', () => {
  const { claims, disputes } = analyseRound(
    [
      message('m1', 'a', `${CONTRADICT_A}${CONTRADICT_B}`),
      message('m2', 'b', '这个问题跟并发安全没什么关系。')
    ],
    0
  );
  assert.ok(claims.length >= 2, '两句都被抽出来了');
  assert.deepEqual(disputes, [], '同一个 agentId 之间的冲突不算争议');
});

test('各说各的、没有冲突时不造争议', () => {
  const { disputes } = analyseRound(
    [message('m1', 'a', '金鱼的记忆不止七秒。'), message('m2', 'b', '今天天气不错，适合出门散步。')],
    0
  );
  assert.deepEqual(disputes, []);
});

test('挑战照着具体两句写，最多三条', () => {
  const { claims, disputes } = analyseRound(
    [
      message('m1', 'a', `${CONTRADICT_A}\n连接池默认连接数是 100，够用。`),
      message('m2', 'b', `${CONTRADICT_B}\n连接池默认连接数是 10000，够用。`)
    ],
    0
  );
  assert.ok(disputes.length >= 2);
  const lines = challengesFor(disputes, claims);
  assert.ok(lines.length <= 3);
  assert.ok(lines.every(line => line.startsWith('- ')));
  // 每条都要带上一句原话，否则模型还是不知道在问哪一句。
  assert.ok(lines.every(line => line.includes('「')));
  assert.match(lines.join('\n'), /多线程安全保证|连接数/);

  // 缺 claim、或没有争议时返回空数组，不抛。
  assert.deepEqual(challengesFor([], claims), []);
  assert.deepEqual(challengesFor(disputes, []), []);
});

test('编排器：第一轮不带挑战，第二轮 system 里出现具体冲突', async () => {
  const h = harness((agentId, call) => {
    // 两个参与者第一轮各说一句相反的；第二轮给个普通回应。
    if (call <= 2) return agentId === 'a' ? CONTRADICT_A : CONTRADICT_B;
    return `${agentId} 回应：按文档看，并发安全取决于具体版本。`;
  });
  const started = h.orchestrator.start('这个接口能并发调用吗', {
    strategy: 'standard',
    maxRounds: 2,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await h.orchestrator.waitFor(started.debateId);

  assert.equal(state.rounds.length, 2);
  const firstRound = h.seen.slice(0, 2);
  assert.ok(firstRound.every(item => !item.system.join('\n').includes('具体冲突')), '第一轮没有可挑战的对象');

  const secondRound = h.seen.slice(2);
  const text = secondRound.map(item => item.system.join('\n')).join('\n');
  assert.match(text, /具体冲突/, '第二轮应当带着上一轮算出来的冲突');
  assert.match(text, /直接矛盾/);
  assert.match(text, /多线程安全保证/);

  // 结构化结果落盘：主张与争议都能在读回来的状态里找到。
  assert.ok((state.rounds[0].claims ?? []).length >= 2);
  assert.equal(state.disputes?.length, 1);
  assert.equal(state.disputes[0].type, 'factual');
  h.cleanup();
});

test('编排器：没有争议时第二轮不硬造挑战', async () => {
  const h = harness(agentId => (agentId === 'a' ? '金鱼的记忆不止七秒。' : '今天天气不错，适合出门散步。'));
  const started = h.orchestrator.start('金鱼记忆真的只有七秒吗', {
    strategy: 'standard',
    maxRounds: 2,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await h.orchestrator.waitFor(started.debateId);

  const later = h.seen.slice(2).map(item => item.system.join('\n')).join('\n');
  assert.ok(!later.includes('具体冲突'), '没有冲突就不该出现挑战段');
  assert.deepEqual(state.disputes, []);
  h.cleanup();
});

test('老辩论文件没有 claims/disputes 字段，读出来照样能继续跑', async () => {
  const h = harness(() => '观点不变。');
  const started = h.orchestrator.start('一个问题', {
    strategy: 'standard',
    maxRounds: 2,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  await h.orchestrator.waitFor(started.debateId);

  // 模拟老文件：把两个新字段摘掉再读。
  const stored = h.store.get(started.debateId);
  const legacy = JSON.parse(JSON.stringify(stored));
  delete legacy.disputes;
  for (const round of legacy.rounds) delete round.claims;
  h.store.save(legacy);

  const reloaded = h.store.get(started.debateId);
  assert.equal(reloaded.disputes, undefined);
  assert.equal(reloaded.rounds[0].claims, undefined);
  h.cleanup();
});
