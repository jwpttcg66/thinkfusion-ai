/**
 * Gate 0A / 0B：裁决公共核（选人 → 调用 → 失败换人 → 兜底 → 落盘）。
 *
 * 这些用例钉住的事都是「以前没有」的：
 * - 首选裁判调用失败后**真的换人**，而不是直接退回规则版；
 * - 换人后独立性等七个字段按**新的人**重算，不沿用旧值；
 * - 失败过的人不会再被选中（不然会在「失败 → 又选它」之间打转）；
 * - 「换过都不行」和「本来就没得换」记成两件不同的事；
 * - IPC 层（handler）也走同一条链，并且降级时照样落盘。
 *
 * Run with: npm run test:judge-adjudicate
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adjudicateDebate } from '../out-test/main/judge/adjudicate.js';
import { handleJudgeAdjudicate } from '../out-test/main/judge/handler.js';
import { VerdictStore } from '../out-test/main/judge/store.js';

const JUDGE_JSON = JSON.stringify({
  questionType: 'CONTEXTUAL',
  conclusion: '在写入量大的场景下可行，但要限制并发',
  undetermined: false,
  reason: '条件清楚时成立，超出条件不成立',
  disagreement: '对适用范围的判断不同',
  unresolved: []
});

const answer = text => ({
  agentId: 'judge',
  text,
  receivedAt: Date.now(),
  attribution: { requestId: 'r', note: 'test' },
  stage: 'initial'
});

function message(agentId, text) {
  return {
    messageId: `${agentId}-position`,
    roundIndex: 0,
    agentId,
    role: 'peer',
    kind: 'position',
    text,
    createdAt: 1
  };
}

function state(messages = [message('p1', '根据官方文档，吞吐量达到 1200 QPS，因为批量写入减少了往返。')], overrides = {}) {
  return {
    debateId: 'debate-1',
    question: '这个方案可靠吗？',
    config: { strategy: 'standard', maxRounds: 2, participants: [...new Set(messages.map(item => item.agentId))], convergenceStop: false },
    status: 'completed',
    rounds: [{ index: 0, messages, startedAt: 1, endedAt: 2, converged: false, failures: [] }],
    minorities: [],
    evidence: [],
    disputes: [],
    revisions: [],
    judgments: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

/** 所有模型都参辩（没有独立裁判时才会出现的样子）。 */
const candidate = (id, overrides = {}) => ({
  id,
  label: id,
  type: 'cloud',
  available: true,
  modelId: id,
  providerId: 'opencode-go',
  ...overrides
});

// ---------------------------------------------------------------------------
// 选人与降级
// ---------------------------------------------------------------------------

test('没有候选：如实退回规则版，且不伪造「换过人」的记录', async () => {
  const verdict = await adjudicateDebate(state(), {
    candidates: async () => [],
    ask: async () => {
      throw new Error('没有候选就不该调用模型');
    }
  });
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.judgeMode, 'rules-fallback');
  assert.equal(verdict.judgeReselection, undefined, '没得换 ≠ 换过没换成');
  assert.equal(verdict.rulesConclusion.authority, 'debate.claim-judgments');
  assert.ok(verdict.quality, '规则版也要带质量报告');
  assert.ok(verdict.finalDecision, '规则版也要给出最终决策');
});

test('首选裁判调用失败：换下一个独立候选，七个字段按新人重算', async () => {
  const asked = [];
  const verdict = await adjudicateDebate(state(), {
    candidates: async () => [candidate('j1'), candidate('j2')],
    preferredJudgeId: 'j1',
    ask: async agentId => {
      asked.push(agentId);
      if (agentId === 'j1') throw new Error('网关 502');
      return answer(JUDGE_JSON);
    }
  });

  assert.deepEqual(asked, ['j1', 'j2'], '失败的人不能再被问第二次');
  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.judgeAgentId, 'j2');
  assert.equal(verdict.judgeModelId, 'j2');
  assert.equal(verdict.judgeProviderId, 'opencode-go');
  assert.equal(verdict.judgeMode, 'independent-judge');
  assert.equal(verdict.judgeIndependent, true);
  assert.equal(verdict.modelIndependence, true);
  assert.equal(verdict.sharedWith, undefined);

  assert.equal(verdict.judgeReselection.attempts.length, 1);
  assert.equal(verdict.judgeReselection.attempts[0].agentId, 'j1');
  assert.match(verdict.judgeReselection.attempts[0].reason, /网关 502/);
  assert.deepEqual(verdict.judgeReselection.excludedAgentIds, ['j1']);
  assert.equal(verdict.judgeReselection.exhausted, false);
  assert.equal(verdict.judgeReselection.finalJudgeAgentId, 'j2');
});

test('候选全部失败：每个人都只试一次，最后退回规则版并写明原因', async () => {
  const asked = [];
  const verdict = await adjudicateDebate(state(), {
    candidates: async () => [candidate('j1'), candidate('j2')],
    ask: async agentId => {
      asked.push(agentId);
      throw new Error(`${agentId} 不可用`);
    }
  });

  assert.deepEqual(asked, ['j1', 'j2']);
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.judgeMode, 'rules-fallback');
  assert.equal(verdict.judgeReselection.exhausted, true);
  assert.equal(verdict.judgeReselection.finalJudgeAgentId, null);
  assert.deepEqual([...verdict.judgeReselection.excludedAgentIds].sort(), ['j1', 'j2']);
  assert.match(verdict.fallbackReason, /候选已全部试过/);
});

test('换到的人本身参辩：标 participant-review，独立性按新人重算而不是沿用上一次', async () => {
  const messages = [message('a', '第一种说法'), message('b', '第二种说法')];
  const verdict = await adjudicateDebate(state(messages), {
    candidates: async () => [candidate('a'), candidate('b')],
    preferredJudgeId: 'a',
    ask: async agentId => {
      if (agentId === 'a') throw new Error('a 崩了');
      return answer(JUDGE_JSON);
    }
  });

  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.judgeAgentId, 'b');
  assert.equal(verdict.judgeMode, 'participant-review', '它是参辩者，不能算独立第三方');
  assert.equal(verdict.judgeIndependent, false);
  assert.equal(verdict.modelIndependence, false);
  assert.equal(verdict.sharedWith, 'b');
});

test('两次输出都不是 JSON：也换人，不是直接退回规则版', async () => {
  const asked = [];
  const verdict = await adjudicateDebate(state(), {
    candidates: async () => [candidate('j1'), candidate('j2')],
    preferredJudgeId: 'j1',
    ask: async agentId => {
      asked.push(agentId);
      if (agentId === 'j1') return answer('先分析一下：这个问题要分开看。');
      return answer(JUDGE_JSON);
    }
  });

  // j1 会问两次（解析失败重试一次），然后换 j2。
  assert.deepEqual(asked, ['j1', 'j1', 'j2']);
  assert.equal(verdict.backend, 'model');
  assert.equal(verdict.judgeAgentId, 'j2');
  assert.match(verdict.judgeReselection.attempts[0].reason, /JSON/);
});

test('全部候选都输出不可解析：换完退回规则版，并保留每次失败原因', async () => {
  const verdict = await adjudicateDebate(state(), {
    candidates: async () => [candidate('j1')],
    ask: async () => answer('我不是 JSON，我只是在聊天。')
  });
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.judgeReselection.exhausted, true);
  assert.equal(verdict.judgeReselection.attempts.length, 1);
  assert.match(verdict.fallbackReason, /j1/);
});

// ---------------------------------------------------------------------------
// 规则结论的权威口径
// ---------------------------------------------------------------------------

test('规则版记录权威口径；权威侧没给结论时是「不可比」，不是「一致」', async () => {
  const verdict = await adjudicateDebate(state(), {
    candidates: async () => [],
    ask: async () => answer('')
  });
  assert.equal(verdict.rulesConclusion.authority, 'debate.claim-judgments');
  assert.equal(verdict.rulesConclusion.debateVerdict, 'insufficient_evidence');
  assert.equal(verdict.rulesConclusion.agrees, null, '没有主张可判时两边不可比');
});

test('两套规则给出同一句话：记 agrees=true；不同则记 false，不静默吞掉', async () => {
  const text = '根据官方文档，吞吐量达到 1200 QPS，因为批量写入减少了往返。';
  const same = await adjudicateDebate(
    state([message('p1', text)], { verdict: { verdict: 'supported', conclusion: text } }),
    { candidates: async () => [], ask: async () => answer('') }
  );
  assert.equal(same.rulesConclusion.agrees, true);

  const different = await adjudicateDebate(
    state([message('p1', text)], { verdict: { verdict: 'supported', conclusion: '另一句结论' } }),
    { candidates: async () => [], ask: async () => answer('') }
  );
  assert.equal(different.rulesConclusion.agrees, false);
});

// ---------------------------------------------------------------------------
// IPC 层：和产品走同一条链
// ---------------------------------------------------------------------------

function ipcDeps(overrides = {}) {
  const saved = [];
  const notices = [];
  return {
    saved,
    notices,
    deps: {
      getDebate: id => (id === 'debate-1' ? state() : null),
      saveVerdict: verdict => saved.push(verdict),
      candidates: async () => [candidate('j1')],
      ask: async () => answer(JUDGE_JSON),
      onVerdict: (conversationId, verdict) => notices.push({ conversationId, verdict }),
      ...overrides
    }
  };
}

test('IPC：入参不是字符串一律拒绝，不落盘', async () => {
  const { saved, deps } = ipcDeps();
  await assert.rejects(() => handleJudgeAdjudicate(42, deps), /无效输入/);
  await assert.rejects(() => handleJudgeAdjudicate('', deps), /无效输入/);
  assert.equal(saved.length, 0);
});

test('IPC：找不到这场辩论时报错，不落一份空裁决', async () => {
  const { saved, deps } = ipcDeps();
  await assert.rejects(() => handleJudgeAdjudicate('debate-404', deps), /找不到这场辩论/);
  assert.equal(saved.length, 0);
});

test('IPC：裁决落盘，并按会话广播同一份对象', async () => {
  const { saved, notices, deps } = ipcDeps({
    getDebate: id => (id === 'debate-1' ? state([], { conversationId: 'conv-1' }) : null)
  });
  const verdict = await handleJudgeAdjudicate('debate-1', deps);
  assert.equal(saved.length, 1);
  assert.equal(saved[0], verdict);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].conversationId, 'conv-1');
  assert.equal(notices[0].verdict, verdict);
});

test('IPC：降级也照样落盘，失败原因可追踪', async () => {
  const { saved, deps } = ipcDeps({
    ask: async () => {
      throw new Error('网关超时');
    }
  });
  const verdict = await handleJudgeAdjudicate('debate-1', deps);
  assert.equal(saved.length, 1, '降级不是「什么都不存」');
  assert.equal(verdict.backend, 'rules');
  assert.equal(verdict.judgeReselection.exhausted, true);
  assert.match(verdict.fallbackReason, /网关超时/);
});

// ---------------------------------------------------------------------------
// Gate 0B：质量引擎在真实链路里，而不是测试里单独调一次
// ---------------------------------------------------------------------------

test('IPC → 裁决 → 质量报告 → 落盘 → 读回：读到的是刚生成的那一份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verdict-'));
  try {
    const store = new VerdictStore(dir);
    const { deps } = ipcDeps({ saveVerdict: verdict => store.save(verdict) });
    const verdict = await handleJudgeAdjudicate('debate-1', deps);

    assert.ok(verdict.quality, '裁决必须带质量报告');
    assert.ok(verdict.finalDecision, '裁决必须带最终决策');
    assert.equal(verdict.quality.modelAssessed, true, '模型裁判要学会区分「模型评估过」');

    // judge:get 在产品里就是 `verdicts.get(debateId)`，这里直接走同一个 store。
    const read = store.get('debate-1');
    assert.ok(read, '落盘后必须能按 debateId 读回');
    assert.deepEqual(read.quality, verdict.quality, '读回的质量报告不能是另算一份');
    assert.deepEqual(read.finalDecision, verdict.finalDecision);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('规则版落盘后读回：质量报告仍标 modelAssessed=false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verdict-rules-'));
  try {
    const store = new VerdictStore(dir);
    const { deps } = ipcDeps({
      saveVerdict: verdict => store.save(verdict),
      candidates: async () => [],
      ask: async () => answer('')
    });
    const verdict = await handleJudgeAdjudicate('debate-1', deps);
    const read = store.get('debate-1');

    assert.equal(verdict.backend, 'rules');
    assert.ok(read.quality, '规则版也要有质量报告');
    assert.equal(read.quality.modelAssessed, false, '没有模型评审就不能说模型评估过');
    assert.notEqual(read.quality.dimensions.factualAccuracy.status, 'supported',
      '规则版不能凭空给出「事实已支持」');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧裁决文件没有 quality：读回是 undefined，不补一份假报告', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verdict-legacy-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'debate-old.json'),
      JSON.stringify({ verdictId: 'v-old', debateId: 'debate-old', createdAt: 1, backend: 'rules', conclusion: null }),
      'utf8'
    );
    const read = new VerdictStore(dir).get('debate-old');
    assert.ok(read);
    assert.equal(read.quality, undefined);
    assert.equal(read.finalDecision, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
