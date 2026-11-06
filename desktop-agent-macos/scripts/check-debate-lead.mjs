/**
 * 归属规则下的辩论主导方式：本地 / 网页 / 云端 / 混合。
 *
 * 2026-11-06 用户裁决（见 docs/implementation/DEBATE_LEAD_MODES.md 开头）：
 * 一种方式只用一类成员；只有一个成员也照常开；混合先综合决定采用哪一种。
 *
 * 最该钉住的四件事：
 *
 * 1. 可用性来自 health()，不是「注册表里有这个名字」。没配 Key 的云端模型
 *    过去被算成可用成员，界面能发起、每轮都失败，双边辩论静默变单边。
 * 2. 网页主导**只用网页**：本地/云端成员一个都不进；网页成员第一轮只收
 *    用户原话，后续轮次的交锋材料拼进同一条用户消息，仍不收 context/system。
 * 3. 主导者、选人理由、被排除的成员都落盘，历史里查得到「这一场谁主导、
 *    怎么选的」，不是靠数组下标心算。
 * 4. 单成员自辩如实写进 warnings，不再拿「不足两位」跳过整场。
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

/** 配好 Key 的形态，用来验证云端主导与混合择一。 */
const WITH_CLOUD = [
  ...CANDIDATES,
  { id: 'deepseek:chat', label: 'DeepSeek', type: 'cloud', available: true }
];

const plan = (mode, overrides = {}) => planLead({
  mode, strategy: 'standard', candidates: CANDIDATES, ...overrides
});

// ---------------------------------------------------------------------------
// planLead：归属方式决定用哪一类成员
// ---------------------------------------------------------------------------

test('模式收敛：非法值退回 hybrid，四种合法值原样保留', () => {
  assert.equal(normalizeLeadMode('local'), 'local');
  assert.equal(normalizeLeadMode('web'), 'web');
  assert.equal(normalizeLeadMode('cloud'), 'cloud');
  assert.equal(normalizeLeadMode('hybrid'), 'hybrid');
  assert.equal(normalizeLeadMode('nope'), 'hybrid');
  assert.equal(normalizeLeadMode(undefined), 'hybrid');
});

test('本地主导：只用本地模型，网页和云端一个都不进', () => {
  const p = plan('local', { candidates: WITH_CLOUD });
  assert.equal(p.lead.agentId, 'ollama:qwen2.5:7b');
  assert.equal(p.lead.drivenBy, 'orchestrator');
  assert.deepEqual(p.participants, ['ollama:qwen2.5:7b']);
  assert.deepEqual(p.debaters, ['ollama:qwen2.5:7b']);
  assert.deepEqual(p.webOnly, []);
  assert.match(p.reason, /只用本地模型/);
  assert.ok(p.excluded.some(item => item.id === 'chatgpt' && /只使用本地模型成员/.test(item.reason)));
  assert.ok(p.excluded.some(item => item.id === 'deepseek:chat' && /只使用本地模型成员/.test(item.reason)));
  assert.ok(p.warnings.some(line => /只有一个可用成员/.test(line)));
});

test('网页主导：只用网页通道，本地/云端一个都不进', () => {
  const p = plan('web');
  assert.equal(p.lead.agentId, 'chatgpt');
  assert.deepEqual(p.openingSpeakers, ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(p.debaters, ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(p.webOnly, ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(speakersFor(p, 0), ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(speakersFor(p, 1), ['chatgpt', 'kimi', 'gemini']);
  assert.deepEqual(speakersFor(p, 2), ['chatgpt', 'kimi', 'gemini']);
  assert.match(p.reason, /只用网页通道/);
  assert.ok(!p.participants.includes('ollama:qwen2.5:7b'), '网页主导不得引入本地模型');
  assert.ok(p.excluded.some(item => item.id === 'ollama:qwen2.5:7b' && /只使用网页通道成员/.test(item.reason)));
});

test('云端主导：只用远程 API；没有可用云端时明确报错', () => {
  const p = planLead({ mode: 'cloud', strategy: 'standard', candidates: WITH_CLOUD });
  assert.equal(p.lead.agentId, 'deepseek:chat');
  assert.deepEqual(p.participants, ['deepseek:chat']);
  assert.deepEqual(p.debaters, ['deepseek:chat']);
  assert.deepEqual(p.webOnly, []);
  assert.ok(!p.participants.includes('ollama:qwen2.5:7b'), '云端主导不得掺本地模型');
  assert.throws(() => plan('cloud'), /云端主导需要至少一个可用的远程 API 模型成员/);
});

test('混合：先综合决定采用一种方式，再严格只用那一类', () => {
  const p = plan('hybrid');
  assert.equal(p.lead.mode, 'hybrid');
  assert.ok(p.lead.agentId, '混合也要有一位主导');
  assert.match(p.reason, /混合先综合决定采用/);
  // 本机形态：云端没 Key，选本地，绝不把网页混进来。
  assert.match(p.reason, /本地主导/);
  assert.deepEqual(p.participants, ['ollama:qwen2.5:7b']);
  assert.ok(p.warnings.some(line => /混合综合决定/.test(line)));
  // 有可用云端时优先云端，仍然只用那一类。
  const cloud = planLead({ mode: 'hybrid', strategy: 'standard', candidates: WITH_CLOUD });
  assert.match(cloud.reason, /云端主导/);
  assert.deepEqual(cloud.participants, ['deepseek:chat']);
});

test('关键回归：没有 Key 的云端模型不能被算作可用成员', () => {
  for (const mode of ['local', 'web', 'hybrid']) {
    const p = plan(mode);
    assert.ok(!p.participants.includes('openai:gpt-4o-mini'), `${mode} 把没 Key 的云端算进来了`);
    assert.ok(p.excluded.some(item => item.id === 'openai:gpt-4o-mini' && /API Key/.test(item.reason)));
    assert.ok(p.warnings.some(line => /当前不可用/.test(line)));
  }
  assert.throws(() => plan('cloud'), /云端主导/);
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
  const p = plan('web', { selected: ['chatgpt', 'kimi', 'ollama:qwen2.5:7b'] });
  assert.deepEqual(p.openingSpeakers, ['chatgpt', 'kimi']);
  assert.ok(!p.participants.includes('ollama:qwen2.5:7b'), '归属规则把本地模型挡在网页主导之外');
  assert.ok(!p.excluded.some(item => item.id === 'gemini'));
});

test('归属规则：只有一个可用成员也照常开，如实写明自辩', () => {
  const onlyWeb = [{ id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true }];
  const web = planLead({ mode: 'web', strategy: 'standard', candidates: onlyWeb });
  assert.deepEqual(web.participants, ['chatgpt']);
  assert.deepEqual(web.debaters, ['chatgpt']);
  assert.ok(web.warnings.some(line => /只有一个可用成员/.test(line)));

  const oneLocal = [{ id: 'ollama:qwen2.5:7b', label: 'Ollama', type: 'local', available: true }];
  const local = planLead({ mode: 'local', strategy: 'standard', candidates: oneLocal });
  assert.deepEqual(local.participants, ['ollama:qwen2.5:7b']);
  assert.ok(local.warnings.some(line => /只有一个可用成员/.test(line)));

  assert.throws(() => planLead({ mode: 'cloud', strategy: 'standard', candidates: onlyWeb }), /云端主导/);
  assert.throws(() => planLead({ mode: 'local', strategy: 'standard', candidates: onlyWeb }), /本地主导/);
});

test('轮次与角色：第一轮建立观点、第二轮质疑、之后修正；只有对抗策略分正反', () => {
  assert.equal(kindFor(0), 'position');
  assert.equal(kindFor(1), 'question');
  assert.equal(kindFor(2), 'revision');
  const p = plan('web');
  assert.equal(roleFor(p, 'chatgpt', 0, 'standard'), 'proposer');
  assert.equal(roleFor(p, 'kimi', 0, 'standard'), 'peer');
  const adversarial = plan('web', { strategy: 'adversarial' });
  assert.equal(roleFor(adversarial, 'chatgpt', 1, 'adversarial'), 'proposer');
});

// ---------------------------------------------------------------------------
// orchestrator：按计划跑，网页只收用户消息（第一轮是原话）
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

test('网页主导真跑：两轮全由网页，第一轮原话、后续拼接材料，本地模型零调用', async () => {
  const h = harness({ threadUrls: { chatgpt: 'https://chatgpt.com/c/1', kimi: 'https://kimi.com/c/2', gemini: 'https://gemini.google.com/app/3' } });
  try {
    const p = plan('web');
    const state = h.orchestrator.start(QUESTION, { strategy: 'standard', maxRounds: 2, leadMode: 'web' }, undefined, p);
    const saved = await finish(h, state);

    assert.equal(saved.lead.agentId, 'chatgpt');
    assert.equal(saved.lead.drivenBy, 'orchestrator');
    assert.equal(saved.rounds.length, 2);
    assert.equal(saved.rounds[0].messages.length, 3, '第一轮三个网页通道都发言');
    assert.equal(saved.rounds[1].messages.length, 3, '第二轮仍是三个网页通道');
    assert.ok(h.seen.every(call => p.webOnly.includes(call.agentId)), '网页主导不得调用本地/云端模型');

    const firstRound = h.seen.filter(call => call.stage === 'initial');
    assert.equal(firstRound.length, 3);
    for (const call of firstRound) {
      assert.equal(call.question, QUESTION, '第一轮页面收到的必须是用户原话');
      assert.deepEqual(call.system, [], '网页成员不得收到 system 指令');
      assert.deepEqual(call.context, [], '网页成员不得收到 context');
    }
    const later = h.seen.filter(call => call.stage === 'followup');
    assert.equal(later.length, 3);
    for (const call of later) {
      assert.match(call.question, /【问题】/, '交锋材料拼进用户消息');
      assert.match(call.question, /【观点】/, '交锋要看到上一轮观点');
      assert.deepEqual(call.system, [], '网页成员仍不收 system');
      assert.deepEqual(call.context, [], '网页成员仍不收 context');
    }
    // 网页地址随发言落盘，清理网页侧会话靠它。
    assert.equal(saved.rounds[0].messages.filter(message => message.threadUrl).length, 3);
  } finally {
    h.cleanup();
  }
});

test('本地主导真跑：不碰网页，同一模型分饰质疑与修正也保留全部发言', async () => {
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
    assert.ok(saved.plan.warnings.some(line => /只有一个可用成员/.test(line)));
    assert.deepEqual(saved.plan.webOnly, []);
  } finally {
    h.cleanup();
  }
});

test('云端主导真跑：只用远程 API 成员', async () => {
  const p = planLead({ mode: 'cloud', strategy: 'standard', candidates: WITH_CLOUD });
  const h = harness();
  try {
    const state = h.orchestrator.start(QUESTION, { strategy: 'standard', maxRounds: 2, leadMode: 'cloud' }, undefined, p);
    const saved = await finish(h, state);
    assert.deepEqual(saved.plan.participants, ['deepseek:chat']);
    assert.ok(h.seen.every(call => call.agentId === 'deepseek:chat'), '云端主导不应掺本地模型或网页');
  } finally {
    h.cleanup();
  }
});

test('混合真跑：先择一方式，全程只用那一类', async () => {
  const h = harness();
  try {
    const p = plan('hybrid');
    const state = h.orchestrator.start(QUESTION, { strategy: 'standard', maxRounds: 2, leadMode: 'hybrid' }, undefined, p);
    const saved = await finish(h, state);
    assert.match(saved.plan.reason, /混合先综合决定/);
    assert.deepEqual(saved.plan.participants, ['ollama:qwen2.5:7b']);
    assert.ok(h.seen.every(call => call.agentId === 'ollama:qwen2.5:7b'), '混合择一后不得混用其他类型');
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
// 不依赖云端：各归属方式只用自己那一类
// ---------------------------------------------------------------------------

test('没有云端 API 时四种方式各自的名单', () => {
  const noCloud = [
    { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
    { id: 'kimi', label: 'Kimi', type: 'web', available: true },
    { id: 'ollama:qwen2.5:7b', label: 'Ollama', type: 'local', available: true }
  ];
  const local = planLead({ mode: 'local', strategy: 'standard', candidates: noCloud });
  assert.deepEqual(local.participants, ['ollama:qwen2.5:7b']);
  const web = planLead({ mode: 'web', strategy: 'standard', candidates: noCloud });
  assert.deepEqual(web.participants, ['chatgpt', 'kimi']);
  assert.deepEqual(web.debaters, ['chatgpt', 'kimi']);
  const hybrid = planLead({ mode: 'hybrid', strategy: 'standard', candidates: noCloud });
  assert.match(hybrid.reason, /本地主导/);
  assert.deepEqual(hybrid.participants, ['ollama:qwen2.5:7b']);
  assert.throws(() => planLead({ mode: 'cloud', strategy: 'standard', candidates: noCloud }), /云端主导/);
});

test('只有网页通道时，网页主导仍跑完整交锋，不降级也不报错', () => {
  const webOnly = [
    { id: 'chatgpt', label: 'ChatGPT', type: 'web', available: true },
    { id: 'kimi', label: 'Kimi', type: 'web', available: true }
  ];
  const p = planLead({ mode: 'web', strategy: 'standard', candidates: webOnly });
  assert.deepEqual(p.openingSpeakers, ['chatgpt', 'kimi']);
  assert.deepEqual(p.debaters, ['chatgpt', 'kimi'], '网页自己交锋，不再等本地模型补位');
  assert.match(p.reason, /只用网页通道/);
  const h = planLead({ mode: 'hybrid', strategy: 'standard', candidates: webOnly });
  assert.match(h.reason, /网页主导/);
  assert.deepEqual(h.participants, ['chatgpt', 'kimi']);
});
