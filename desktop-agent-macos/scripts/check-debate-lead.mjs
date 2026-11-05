/**
 * 三种辩论主导模式：本地 / 网页 / 混合。
 *
 * 最该钉住的四件事：
 *
 * 1. 可用性来自 health()，不是「注册表里有这个名字」。没配 Key 的云端模型
 *    过去被算成可用成员，界面能发起、每轮都失败，双边辩论静默变单边。
 * 2. 网页成员的 task 里只有 question 原话，没有 context / system——页面
 *    不接收任何包装文字，也不会看到别人的回答。
 * 3. 网页成员只在第一轮发言；后续轮次只有能读上下文的本地/云端成员。
 * 4. 主导者、选人理由、被排除的成员都落盘，历史里查得到「这一场谁主导、
 *    怎么选的」，不是靠数组下标心算。
 *
 * Run with: npm run test:debate-lead
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { LEGACY_LEAD } from '../out-test/main/debate/types.js';
import {
  kindFor,
  normalizeLeadMode,
  planLead,
  roleFor,
  speakersFor
} from '../out-test/main/debate/lead.js';

const QUESTION = '17 乘 3 应该等于 51 吗？';

/** 本机真实形态：3 个网页可用、1 个本地可用、云端没 Key。 */
const CANDIDATES = [
  { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
  { id: 'kimi', label: 'Kimi', type: 'web', available: true },
  { id: 'gemini', label: 'Gemini', type: 'web', available: true },
  { id: 'ollama:qwen2.5:7b', label: 'Ollama · qwen2.5:7b', type: 'local', available: true },
  { id: 'openai:gpt-4o-mini', label: 'OpenAI · gpt-4o-mini', type: 'cloud', available: false, detail: '还没有配置 API Key' }
];

const plan = (mode, overrides = {}) => planLead({
  mode, strategy: 'standard', candidates: CANDIDATES, ...overrides
});

// ---------------------------------------------------------------------------
// planLead：三种模式的成员与主导者
// ---------------------------------------------------------------------------

test('模式收敛：非法值退回 hybrid，三种合法值原样保留', () => {
  assert.equal(normalizeLeadMode('local'), 'local');
  assert.equal(normalizeLeadMode('web'), 'web');
  assert.equal(normalizeLeadMode('hybrid'), 'hybrid');
  assert.equal(normalizeLeadMode('nope'), 'hybrid');
  assert.equal(normalizeLeadMode(undefined), 'hybrid');
});

test('本地主导：网页通道不参与，主辩是第一个可用本地模型，内容不往网页发', () => {
  const p = plan('local');
  assert.equal(p.lead.mode, 'local');
  assert.equal(p.lead.agentId, 'ollama:qwen2.5:7b');
  assert.equal(p.lead.drivenBy, 'orchestrator');
  assert.match(p.reason, /网页通道不参与/);
  assert.deepEqual(p.participants, ['ollama:qwen2.5:7b']);
  assert.deepEqual(p.webOnly, []);
  assert.deepEqual(p.debaters, ['ollama:qwen2.5:7b']);
  assert.ok(p.excluded.every(item => item.reason === '本地主导不向网页通道发送内容' || item.id === 'openai:gpt-4o-mini'));
  // 本机只有一个可用本地模型，必须如实写明是同一模型分饰角色。
  assert.ok(p.warnings.some(line => /同一模型/.test(line)));
});

test('网页主导：网页给基准观点，本地/云端做交锋，主辩是第一个网页通道', () => {
  const p = plan('web');
  assert.equal(p.lead.agentId, 'chatgpt');
  assert.deepEqual(p.openingSpeakers, ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(p.debaters, ['ollama:qwen2.5:7b']);
  assert.deepEqual(p.webOnly, ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(speakersFor(p, 0), ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(speakersFor(p, 1), ['ollama:qwen2.5:7b']);
  assert.deepEqual(speakersFor(p, 2), ['ollama:qwen2.5:7b']);
  assert.match(p.reason, /原话/);
  assert.ok(p.warnings.some(line => /网页通道只在第一轮发言/.test(line)));
});

test('混合：全部成员第一轮独立发言，不设主辩', () => {
  const p = plan('hybrid');
  assert.equal(p.lead.agentId, null);
  assert.equal(p.lead.label, '不设主辩');
  assert.deepEqual(p.openingSpeakers, ['chatgpt', 'kimi', 'gemini', 'ollama:qwen2.5:7b']);
  assert.deepEqual(p.debaters, ['ollama:qwen2.5:7b']);
  assert.deepEqual(speakersFor(p, 1), ['ollama:qwen2.5:7b']);
});

test('关键回归：没有 Key 的云端模型不能被算作可用成员', () => {
  for (const mode of ['local', 'web', 'hybrid']) {
    const p = plan(mode);
    assert.ok(!p.participants.includes('openai:gpt-4o-mini'), `${mode} 把没 Key 的云端算进来了`);
    assert.ok(p.excluded.some(item => item.id === 'openai:gpt-4o-mini' && /API Key/.test(item.reason)));
    assert.ok(p.warnings.some(line => /当前不可用/.test(line)));
  }
});

test('主辩可以由用户指定，理由随之改变；指定了非法 id 时按默认规则挑', () => {
  const p = plan('web', { leadAgentId: 'gemini' });
  assert.equal(p.lead.agentId, 'gemini');
  assert.match(p.lead.reason, /由你指定/);
  const fallback = plan('web', { leadAgentId: 'ollama:qwen2.5:7b' });
  assert.equal(fallback.lead.agentId, 'chatgpt');
  assert.match(fallback.lead.reason, /第一个可用的网页通道/);
});

test('用户只勾选部分成员时，其余的不参与，且不会被记成「不可用」', () => {
  const p = plan('hybrid', { selected: ['chatgpt', 'kimi', 'ollama:qwen2.5:7b'] });
  assert.deepEqual(p.openingSpeakers, ['chatgpt', 'kimi', 'ollama:qwen2.5:7b']);
  assert.ok(!p.excluded.some(item => item.id === 'gemini'));
});

test('成员不够时明确报错，不静默开一场单边辩论', () => {
  const onlyWeb = [{ id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true }];
  assert.throws(() => planLead({ mode: 'web', strategy: 'standard', candidates: onlyWeb }), /本地或云端模型/);
  assert.throws(() => planLead({ mode: 'local', strategy: 'standard', candidates: onlyWeb }), /本地或云端模型/);
  const oneLocal = [{ id: 'ollama:qwen2.5:7b', label: 'Ollama', type: 'local', available: true }];
  assert.throws(() => planLead({ mode: 'hybrid', strategy: 'standard', candidates: oneLocal }), /至少需要两个/);
  // local 模式允许一个模型自辩，但必须写进 warnings。
  assert.doesNotThrow(() => planLead({ mode: 'local', strategy: 'standard', candidates: oneLocal }));
});

test('轮次与角色：第一轮建立观点、第二轮质疑、之后修正；只有对抗策略分正反', () => {
  assert.equal(kindFor(0), 'position');
  assert.equal(kindFor(1), 'question');
  assert.equal(kindFor(2), 'revision');
  const p = plan('web');
  assert.equal(roleFor(p, 'chatgpt', 0, 'standard'), 'proposer');
  assert.equal(roleFor(p, 'kimi', 0, 'standard'), 'peer');
  const adversarial = plan('web', { strategy: 'adversarial' });
  assert.equal(roleFor(adversarial, 'ollama:qwen2.5:7b', 1, 'adversarial'), 'proposer');
});

// ---------------------------------------------------------------------------
// orchestrator：按计划跑，网页只收原话
// ---------------------------------------------------------------------------

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-lead-'));
  const store = new DebateStore(dir);
  const seen = [];
  const ask = async (agentId, task) => {
    seen.push({
      agentId,
      question: task.question,
      context: task.context ?? [],
      system: task.system ?? [],
      stage: task.stage
    });
    return {
      agentId,
      text: `${agentId} 的观点：条件不同，结论也不同。`,
      receivedAt: Date.now(),
      attribution: { requestId: 'r', note: 'test' },
      stage: task.stage,
      threadUrl: options.threadUrls?.[agentId]
    };
  };
  const orchestrator = new DebateOrchestrator(store, { ask });
  return {
    dir, store, seen, orchestrator,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

async function finish(h, state) {
  const saved = await h.orchestrator.waitFor(state.debateId, 8000);
  assert.equal(saved?.status, 'completed', `辩论没有正常结束：${saved?.status} ${saved?.stopReason ?? ''}`);
  return saved;
}

test('网页主导真跑一轮：网页只收原话，本地第二轮拿到全部观点', async () => {
  const h = harness({ threadUrls: { chatgpt: 'https://chatgpt.com/c/1', kimi: 'https://kimi.com/c/2', gemini: 'https://gemini.google.com/app/3' } });
  try {
    const p = plan('web');
    const state = h.orchestrator.start(QUESTION, { strategy: 'standard', maxRounds: 2, leadMode: 'web' }, undefined, p);
    const saved = await finish(h, state);

    assert.equal(saved.lead.agentId, 'chatgpt');
    assert.equal(saved.lead.drivenBy, 'orchestrator');
    assert.equal(saved.config.leadMode, 'web');
    assert.equal(saved.rounds.length, 2);
    assert.equal(saved.rounds[0].messages.length, 3, '第一轮三个网页通道都发言');
    assert.equal(saved.rounds[1].messages.length, 1, '第二轮只有能读上下文的本地模型');

    const webCalls = h.seen.filter(call => p.webOnly.includes(call.agentId));
    assert.equal(webCalls.length, 3);
    for (const call of webCalls) {
      assert.equal(call.question, QUESTION, '页面收到的必须是用户原话');
      assert.deepEqual(call.system, [], '网页成员不得收到 system 指令');
      assert.deepEqual(call.context, [], '网页成员不得收到他人观点');
    }
    const localCall = h.seen.find(call => call.agentId === 'ollama:qwen2.5:7b');
    assert.equal(localCall.question, QUESTION);
    assert.equal(localCall.context.length, 3, '质疑要看到第一轮全部观点');
    assert.ok(localCall.system.length > 0);

    // 网页地址随发言落盘，清理网页侧会话靠它。
    const withAddress = saved.rounds[0].messages.filter(message => message.threadUrl);
    assert.equal(withAddress.length, 3);
    assert.equal(saved.rounds[1].messages[0].threadUrl, undefined);
  } finally {
    h.cleanup();
  }
});

test('本地主导真跑一轮：不碰网页，同一模型分饰质疑与修正也保留全部发言', async () => {
  const h = harness();
  try {
    const p = plan('local');
    // 假回答每轮一样，收敛判据会提前停；这里要验的是三轮都跑完，所以关掉自动收敛。
    const state = h.orchestrator.start(QUESTION, { strategy: 'deep', maxRounds: 3, leadMode: 'local', convergenceStop: false }, undefined, p);
    const saved = await finish(h, state);
    assert.equal(saved.lead.agentId, 'ollama:qwen2.5:7b');
    assert.ok(h.seen.every(call => call.agentId === 'ollama:qwen2.5:7b'), '本地主导不应向网页发送内容');
    assert.equal(saved.rounds.length, 3);
    assert.equal(saved.rounds[2].messages[0].kind, 'revision');
    assert.ok(saved.rounds[2].messages[0].targetMessageId, '自辩也要有明确的质疑对象');
    assert.ok(saved.plan.warnings.some(line => /同一模型/.test(line)));
    assert.deepEqual(saved.plan.webOnly, []);
  } finally {
    h.cleanup();
  }
});

test('混合真跑一轮：第一轮全部独立发言，之后只有交锋成员，主导为 null', async () => {
  const h = harness();
  try {
    const p = plan('hybrid');
    const state = h.orchestrator.start(QUESTION, { strategy: 'standard', maxRounds: 2, leadMode: 'hybrid' }, undefined, p);
    const saved = await finish(h, state);
    assert.equal(saved.lead.agentId, null);
    assert.equal(saved.rounds[0].messages.length, 4);
    assert.equal(saved.rounds[1].messages.length, 1);
    assert.equal(h.seen.filter(call => call.stage === 'initial').length, 4);
  } finally {
    h.cleanup();
  }
});

test('主导信息落盘后重启可读，老文件没有 lead 时如实补成「未记录」', () => {
  const h = harness();
  try {
    const p = plan('web');
    const state = h.orchestrator.start(QUESTION, { strategy: 'standard', maxRounds: 1, leadMode: 'web' }, undefined, p);
    const reread = h.store.get(state.debateId);
    assert.equal(reread.lead.agentId, 'chatgpt');
    assert.equal(reread.plan.reason, p.reason);

    const legacyId = 'legacy-debate-1';
    fs.writeFileSync(path.join(h.dir, `${legacyId}.json`), JSON.stringify({
      debateId: legacyId, question: QUESTION,
      config: { strategy: 'standard', maxRounds: 2, participants: ['a', 'b'], convergenceStop: true },
      status: 'completed', rounds: [], minorities: [], createdAt: 1, updatedAt: 1
    }));
    const legacy = h.store.get(legacyId);
    assert.equal(legacy.lead.label, LEGACY_LEAD.label);
    assert.match(legacy.lead.reason, /上线之前/);
    assert.equal(legacy.config.leadMode, 'hybrid');
    assert.deepEqual(legacy.plan.participants, []);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 生产形态：本地模型撤出辩论候选名单后（debate:start 里 filter(type !== 'local')）
// ---------------------------------------------------------------------------

test('生产形态：本地模型被排除后，离网主导退回云端模型，理由说清本地只做裁判', () => {
  // 模拟 debate:start 里 (await debateCandidates()).filter(item => item.type !== 'local')
  const cloud = [
    { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
    { id: 'deepseek', label: 'DeepSeek', type: 'cloud', available: true }
  ];
  const p = planLead({ mode: 'local', strategy: 'standard', candidates: cloud });
  assert.equal(p.lead.agentId, 'deepseek', '离网主导在没有本地模型时取第一个可用云端模型');
  assert.match(p.lead.reason, /云端模型/);
  assert.match(p.reason, /本地模型只做裁判/);
});

test('生产形态：没有任何可用 API 模型时，离网主导如实报错，不会把本地模型算进来', () => {
  // 用户当前环境：3 个网页 + 1 个本地（无 Key 的云端）。本地模型撤出后只剩网页，
  // 离网主导需要至少一个 API 参与者，应明确报错而不是静默开一场单边辩论。
  const webOnly = [
    { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
    { id: 'openai:gpt-4o-mini', label: 'OpenAI', type: 'cloud', available: false }
  ];
  assert.throws(
    () => planLead({ mode: 'local', strategy: 'standard', candidates: webOnly }),
    /本地或云端模型/
  );
});
