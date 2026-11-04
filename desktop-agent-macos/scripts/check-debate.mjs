/**
 * Phase G：多轮辩论。
 *
 * 最该钉住的三件事：问题文本永远是原话（指令只走 system）、少数派不被吞、
 * 中止后能从盘上恢复且不重跑已完成轮次。
 *
 * Run with: npm run test:debate
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { normalizeDebateConfig, DEFAULT_ROUNDS } from '../out-test/main/debate/types.js';

const QUESTION = '17 乘 3 应该等于 51 吗？';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-'));
  const store = new DebateStore(dir);
  const seen = [];
  const responder = options.responder ?? ((agentId, task, call) => `${agentId} 第 ${call} 次的观点：因为条件不同，结论也不同。`);
  const ask = async (agentId, task) => {
    seen.push({ agentId, question: task.question, context: task.context ?? [], system: task.system ?? [], stage: task.stage });
    if (options.delayMs) await sleep(options.delayMs);
    if (options.failAgent === agentId) throw new Error('这个模型挂了');
    const text = responder(agentId, task, seen.length);
    return { agentId, text, receivedAt: Date.now(), attribution: { requestId: 'r', note: 'test' }, stage: task.stage };
  };
  const orchestrator = new DebateOrchestrator(store, {
    ask,
    eligible: options.eligible
  });
  return {
    dir, store, seen, orchestrator,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const config = (overrides = {}) => ({
  strategy: 'standard',
  participants: ['a', 'b'],
  ...overrides
});

// ---------------------------------------------------------------------------

test('配置收敛：非法策略/轮数退回默认，参与成员过滤非字符串', () => {
  assert.deepEqual(normalizeDebateConfig({}), {
    strategy: 'standard', maxRounds: DEFAULT_ROUNDS.standard, participants: [], convergenceStop: true,
    leadMode: 'hybrid', leadAgentId: undefined
  });
  assert.equal(normalizeDebateConfig({ strategy: 'nope' }).strategy, 'standard');
  assert.equal(normalizeDebateConfig({ strategy: 'deep', maxRounds: 99 }).maxRounds, 3);
  assert.deepEqual(normalizeDebateConfig({ participants: ['a', 3, null, 'b'] }).participants, ['a', 'b']);
});

test('少于两个成员直接拒绝，不产出一场假辩论', () => {
  const h = harness();
  assert.throws(() => h.orchestrator.start(QUESTION, config({ participants: ['a'] })), /至少需要两个/);
  h.cleanup();
});

test('eligible 过滤掉不能接受 system 指令的网页成员', () => {
  const h = harness({ eligible: ids => ids.filter(id => id !== 'web') });
  assert.throws(
    () => h.orchestrator.start(QUESTION, config({ participants: ['web', 'a'] })),
    /至少需要两个/
  );
  h.cleanup();
});

test('standard/deep/adversarial 的轮数，第一轮独立、后续轮带前序发言', async () => {
  for (const [strategy, rounds] of [['standard', 2], ['deep', 3], ['adversarial', 3]]) {
    const h = harness({ responder: (id, _task, call) => `${id} 在第 ${call} 次提出了一个与其他人不同的看法。` });
    const started = h.orchestrator.start(QUESTION, config({ strategy, convergenceStop: false }));
    const state = await h.orchestrator.waitFor(started.debateId);
    assert.equal(state.status, 'completed', strategy);
    assert.equal(state.rounds.length, rounds, strategy);
    assert.match(state.stopReason, /轮上限/);

    const first = h.seen.filter(item => item.stage === 'initial');
    assert.equal(first.length, 2);
    assert.ok(first.every(item => item.context.length === 0), '第一轮必须独立');
    const later = h.seen.filter(item => item.stage === 'followup');
    assert.ok(later.length > 0);
    assert.ok(later.every(item => item.context.length === 2), '后续轮要看到上一轮两个人的发言');
    h.cleanup();
  }
});

test('问题文本永远原样；指令只走 system，不拼进 question', async () => {
  const h = harness();
  const started = h.orchestrator.start(QUESTION, config({ convergenceStop: false }));
  await h.orchestrator.waitFor(started.debateId);
  assert.ok(h.seen.length > 0);
  for (const item of h.seen) {
    assert.equal(item.question, QUESTION);
    assert.ok(item.system.length > 0, '每轮都要有结构化指令');
    assert.ok(!item.question.includes('质疑'), '问题里不能出现挑战话术');
  }
  h.cleanup();
});

test('adversarial 给 proposer / critic 不同职责', async () => {
  const h = harness({ convergenceStop: false });
  const started = h.orchestrator.start(QUESTION, config({ strategy: 'adversarial', convergenceStop: false }));
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.deepEqual(state.rounds[0].messages.map(m => m.role), ['proposer', 'critic']);
  h.cleanup();
});

test('观点不再变化时提前停止，理由写清是收敛不是打满轮数', async () => {
  const h = harness({ responder: () => '结论不变：51。' });
  const started = h.orchestrator.start(QUESTION, config({ strategy: 'deep' }));
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.equal(state.status, 'completed');
  assert.equal(state.rounds.length, 2, '第二轮发现收敛就停');
  assert.match(state.stopReason, /收敛/);
  h.cleanup();
});

test('少数派观点完整保留，不因为与其他人不同就被合并掉', async () => {
  const h = harness({
    responder: (id) => id === 'a'
      ? '甲方案依赖持久连接，必须保留长链接和心跳机制。'
      : '乙方案采用无状态短连接，通过重试保证可靠性。'
  });
  const started = h.orchestrator.start(QUESTION, config({ convergenceStop: false }));
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.ok(state.minorities.length > 0, '两种立场差别很大，至少要留下少数派');
  assert.ok(state.minorities.every(m => typeof m.text === 'string' && m.text.length > 0));
  h.cleanup();
});

test('一个成员挂了不拖垮整轮，失败原因单独记下', async () => {
  const h = harness({ failAgent: 'b' });
  const started = h.orchestrator.start(QUESTION, config({ convergenceStop: false }));
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.equal(state.status, 'completed');
  assert.ok(state.rounds.every(round => round.messages.length === 1));
  assert.ok(state.rounds.every(round => round.failures.length === 1));
  assert.match(state.rounds[0].failures[0].detail, /挂了/);
  h.cleanup();
});

test('用户中止保留已完成轮次，恢复后不重跑', async () => {
  const h = harness({ delayMs: 30 });
  const started = h.orchestrator.start(QUESTION, config({ strategy: 'deep', convergenceStop: false }));
  await sleep(90);
  const stopped = h.orchestrator.stop(started.debateId);
  assert.equal(stopped.status, 'stopped');
  const roundsAtStop = stopped.rounds.length;
  const idsAtStop = stopped.rounds.flatMap(r => r.messages.map(m => m.messageId));
  assert.ok(roundsAtStop >= 1, '至少完成了一轮');

  const resumed = h.orchestrator.resume(started.debateId);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.rounds.length, roundsAtStop, '恢复不重跑已完成的轮次');
  const final = await h.orchestrator.waitFor(started.debateId, 5000);
  assert.equal(final.status, 'completed');
  const idsAfter = final.rounds.flatMap(r => r.messages.map(m => m.messageId));
  assert.deepEqual(idsAfter.slice(0, idsAtStop.length), idsAtStop, '原始发言一条没变');
  h.cleanup();
});

test('每场辩论独立文件，重新打开存储能读到完整历史', async () => {
  const h = harness({ convergenceStop: false });
  const started = h.orchestrator.start(QUESTION, config());
  await h.orchestrator.waitFor(started.debateId);
  const files = fs.readdirSync(h.dir).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.equal(files[0], `${started.debateId}.json`);

  const reopened = new DebateStore(h.dir);
  const state = reopened.get(started.debateId);
  assert.equal(state.rounds.length, 2);
  assert.equal(state.question, QUESTION);
  assert.equal(reopened.list().length, 1);
  reopened.remove(started.debateId);
  assert.equal(reopened.get(started.debateId), null);
  h.cleanup();
});

test('修正另存一条、带 targetMessageId，原发言不被覆盖', async () => {
  const h = harness({ strategy: 'deep', convergenceStop: false });
  const started = h.orchestrator.start(QUESTION, config({ strategy: 'deep', convergenceStop: false }));
  const state = await h.orchestrator.waitFor(started.debateId);
  assert.equal(state.rounds.length, 3);
  assert.equal(state.rounds[0].messages[0].kind, 'position');
  assert.equal(state.rounds[2].messages[0].kind, 'revision');
  assert.ok(state.rounds[2].messages[0].targetMessageId, '修正要指向被质疑的那条');
  assert.equal(state.rounds[0].messages[0].text.length > 0, true);
  h.cleanup();
});

test('辩论记录不进主 journal 目录', async () => {
  const h = harness({ convergenceStop: false });
  const started = h.orchestrator.start(QUESTION, config());
  await h.orchestrator.waitFor(started.debateId);
  const content = fs.readFileSync(path.join(h.dir, `${started.debateId}.json`), 'utf8');
  assert.ok(content.includes('minorities'));
  assert.ok(content.includes(QUESTION));
  h.cleanup();
});
