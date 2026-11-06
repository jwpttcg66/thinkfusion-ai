/**
 * Phase 4：协作策略。
 *
 * 钉住的是「策略真的改行为」，不是「策略多了一个下拉项」：
 * 每轮指令不同、角色不同、先问哪类争议不同；旧名字还能读回来。
 *
 * Run with: npm run test:debate-strategies
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { planLead, roleFor } from '../out-test/main/debate/lead.js';
import {
  DEFAULT_ROUNDS,
  normalizeDebateConfig
} from '../out-test/main/debate/types.js';
import {
  SELECTABLE_STRATEGIES,
  STRATEGY_PROFILES,
  isStrategy,
  orderDisputes,
  strategyFocus,
  strategyProfile
} from '../out-test/main/debate/strategies.js';
import { normalizeExecutionConfig } from '../out-test/shared/conversation.js';

const QUESTION = '这个库支持并发写入吗？';
/** 归属规则：一种方式只用一类成员，角色分工要在同一类里凑够多人来验证。 */
const ROLE_CANDIDATES = [
  { id: 'a', label: '本地模型 A', type: 'local', available: true },
  { id: 'b', label: '本地模型 B', type: 'local', available: true },
  { id: 'c', label: '本地模型 C', type: 'local', available: true }
];

function harness(responder = (agentId, task, call) => `${agentId} 第 ${call} 次发言：这个问题取决于版本。`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-strategy-'));
  const store = new DebateStore(dir);
  const seen = [];
  const ask = async (agentId, task) => {
    seen.push({ agentId, question: task.question, system: task.system ?? [], context: task.context ?? [] });
    return {
      agentId,
      text: responder(agentId, task, seen.length),
      receivedAt: Date.now(),
      attribution: { requestId: 'r', note: 'test' },
      stage: task.stage
    };
  };
  return {
    dir, store, seen,
    orchestrator: new DebateOrchestrator(store, { ask }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('六种可选策略，两个旧名字不出现在选择器里', () => {
  assert.deepEqual(SELECTABLE_STRATEGIES, ['truth', 'adversarial', 'expert', 'assumption', 'solution', 'discovery']);
  for (const id of SELECTABLE_STRATEGIES) {
    assert.equal(STRATEGY_PROFILES[id].legacy, undefined, `${id} 不该标成旧策略`);
    assert.ok(STRATEGY_PROFILES[id].summary.length > 6, `${id} 要有一句说明`);
    assert.equal(normalizeDebateConfig({ strategy: id }).strategy, id);
    assert.equal(DEFAULT_ROUNDS[id], STRATEGY_PROFILES[id].rounds);
  }
  assert.equal(STRATEGY_PROFILES.standard.legacy, true);
  assert.equal(isStrategy('standard'), true, '旧文件里的名字仍然要能读');
  assert.equal(isStrategy('truth'), true);
  assert.equal(isStrategy('nope'), false);
  // 未知值退回真理发现，而不是悄悄换成别的已知策略。
  assert.equal(normalizeDebateConfig({ strategy: 'nope' }).strategy, 'truth');
});

test('每种策略的第一轮指令不一样，而且说的是它自己那件事', () => {
  const expectations = {
    truth: '先给结论',
    adversarial: '最可能错在哪',
    expert: '什么算证据',
    assumption: '前提逐条列出来',
    solution: '候选方案',
    discovery: '互相竞争的假设'
  };
  for (const [id, phrase] of Object.entries(expectations)) {
    const lines = strategyFocus(id, 'position').join('\n');
    assert.ok(lines.includes(phrase), `${id} 第一轮要提到「${phrase}」，实际：${lines}`);
  }
  // 质疑轮也要各不相同：不能只有第一轮换了说法。
  const challengeLines = new Set(SELECTABLE_STRATEGIES.map(id => strategyFocus(id, 'challenge').join('|')));
  assert.equal(challengeLines.size, SELECTABLE_STRATEGIES.length, '六种策略的质疑轮指令应当各不相同');
});

test('角色按策略分配：专家都是领域专家，假设审查有人专门核对前提', () => {
  // 归属规则：不混用三类成员，角色分工在同一归属方式内部验证。
  const plan = planLead({ mode: 'local', strategy: 'expert', candidates: ROLE_CANDIDATES });
  assert.ok(plan.participants.length >= 2);
  for (const id of plan.participants) {
    assert.equal(roleFor(plan, id, 0, 'expert'), 'domain_expert');
  }

  const assumption = planLead({ mode: 'local', strategy: 'assumption', candidates: ROLE_CANDIDATES });
  assert.equal(roleFor(assumption, assumption.lead.agentId, 0, 'assumption'), 'proposer');
  const other = assumption.participants.find(id => id !== assumption.lead.agentId);
  assert.equal(roleFor(assumption, other, 0, 'assumption'), 'evidence_reviewer');

  const adversarial = planLead({ mode: 'local', strategy: 'adversarial', candidates: ROLE_CANDIDATES });
  assert.equal(roleFor(adversarial, adversarial.openingSpeakers[0], 0, 'adversarial'), 'proposer');
  assert.equal(roleFor(adversarial, adversarial.openingSpeakers[1], 0, 'adversarial'), 'critic');

  // 平等策略不硬塞立场：归属规则下总有一位主辩，其余成员仍是 peer。
  const truth = planLead({ mode: 'local', strategy: 'truth', candidates: ROLE_CANDIDATES });
  const peer = truth.participants.find(id => id !== truth.lead.agentId);
  assert.equal(roleFor(truth, peer, 0, 'truth'), 'peer');
});

test('争议按策略偏好排序：假设审查先看范围，对抗先看事实', () => {
  const disputes = [
    { type: 'factual', priority: 0.9, id: 'f' },
    { type: 'scope', priority: 0.6, id: 's' },
    { type: 'definitional', priority: 0.8, id: 'd' }
  ];
  assert.deepEqual(orderDisputes(disputes, 'assumption').map(item => item.id), ['s', 'd', 'f']);
  // 对抗策略：事实冲突最优先，其次是「范围不对」（它最像一个可攻击的漏洞），
  // 定义差异排在后面——那更多是各说各话，不是谁站不住。
  assert.deepEqual(orderDisputes(disputes, 'adversarial').map(item => item.id), ['f', 's', 'd']);
  // 同类之间仍按 priority，且不改原数组。
  assert.deepEqual(disputes.map(item => item.id), ['f', 's', 'd']);
});

test('真跑一场假设审查：system 里出现前提清单要求，回应轮写回决策', async () => {
  const h = harness((agentId, task, call) => (call <= 2
    ? '这个库支持并发写入，前提是连接池配置正确。'
    : '决策：defend\n前提仍然成立，我坚持。'));
  const started = h.orchestrator.start(QUESTION, {
    strategy: 'assumption',
    maxRounds: 3,
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await h.orchestrator.waitFor(started.debateId, 10_000);
  h.cleanup();

  assert.equal(state.config.strategy, 'assumption');
  assert.equal(state.rounds.length, 3);
  const firstRound = h.seen.slice(0, 2);
  assert.ok(
    firstRound.every(item => item.system.join('\n').includes('前提逐条列出来')),
    '第一轮应当要求列前提'
  );
  // 用户问题始终是原话，策略指令不进 question。
  assert.ok(h.seen.every(item => item.question === QUESTION));
  assert.ok(state.rounds[0].messages.every(message => message.role === 'proposer' || message.role === 'evidence_reviewer'));
  assert.equal(state.revisions.length, 2);
  assert.ok(state.revisions.every(revision => revision.decision === 'defend'));
});

test('旧策略名还能跑：standard 仍是两轮，行为等同真理发现', async () => {
  const h = harness();
  const started = h.orchestrator.start(QUESTION, {
    strategy: 'standard',
    participants: ['a', 'b'],
    convergenceStop: false
  });
  const state = await h.orchestrator.waitFor(started.debateId, 10_000);
  h.cleanup();
  assert.equal(state.config.strategy, 'standard');
  assert.equal(state.config.maxRounds, 2);
  assert.equal(state.rounds.length, 2);
  assert.ok(h.seen[0].system.join('\n').includes('先给结论'));
});

test('策略不改裁判口径：同一份证据换策略，结论一样', async () => {
  const answer = (agentId, task, call) => {
    if (call <= 2) {
      return agentId === 'a'
        ? '这个库在 6.0 之前不支持并发写入，官方 release notes 写明了这一点。'
        : '这个库支持并发写入，可以放心用。';
    }
    return `决策：defend\n${agentId} 坚持。`;
  };
  const citations = agentId => (agentId === 'a'
    ? [{ url: 'https://docs.example.com/release-notes', anchorText: 'release notes', title: 'Release notes' }]
    : undefined);

  async function runWith(strategy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-strategy-judge-'));
    const store = new DebateStore(dir);
    let call = 0;
    const ask = async (agentId, task) => {
      call += 1;
      const pages = citations(agentId);
      return {
        agentId,
        text: answer(agentId, task, call),
        receivedAt: Date.now(),
        ...(pages ? { citations: pages } : {}),
        attribution: { requestId: 'r', note: 'test' },
        stage: task.stage
      };
    };
    const orchestrator = new DebateOrchestrator(store, { ask });
    const started = orchestrator.start(QUESTION, {
      strategy,
      maxRounds: 3,
      participants: ['a', 'b'],
      convergenceStop: false
    });
    const state = await orchestrator.waitFor(started.debateId, 10_000);
    fs.rmSync(dir, { recursive: true, force: true });
    return state.verdict.verdict;
  }

  const truth = await runWith('truth');
  const adversarial = await runWith('adversarial');
  const assumption = await runWith('assumption');
  assert.equal(adversarial, truth);
  assert.equal(assumption, truth);
  assert.equal(truth, 'supported');
});

test('执行模式与辩论策略独立：四种模式 × 六种策略都能归一', () => {
  for (const executionMode of ['web', 'local', 'cloud', 'hybrid']) {
    for (const debateStrategy of SELECTABLE_STRATEGIES) {
      const config = normalizeExecutionConfig({ executionMode, debateStrategy });
      assert.equal(config.executionMode, executionMode);
      assert.equal(config.debateStrategy, debateStrategy);
    }
  }
  // 旧会话没有这个字段：不补默认值，读出来就是 undefined，由调用方兜。
  assert.equal(normalizeExecutionConfig({ executionMode: 'web' }).debateStrategy, undefined);
  // 非法值不写进去，也不把其他字段带坏。
  assert.equal(normalizeExecutionConfig({ debateStrategy: 'nope' }).debateStrategy, undefined);
});
