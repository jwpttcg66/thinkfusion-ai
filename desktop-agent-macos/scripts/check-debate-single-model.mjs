/**
 * P0 缺口测试：单模型真实角色轮转。
 *
 * 这些用例现在预期失败：
 * - 单模型能启动，但 roleFor 始终返回 lead 角色；
 * - 第二轮 question、第三轮 revision 的 role 不轮转；
 * - 提示词里的角色职责与 message.role 不一致。
 *
 * 修复后，这些用例应全部通过。Run with:
 *   npm run test:debate-single-model
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { planLead } from '../out-test/main/debate/lead.js';
import { STRATEGY_PROFILES } from '../out-test/main/debate/strategies.js';

const QUESTION = '单模型是否也能完成多角色辩论？';
const SOLO = [{ id: 'solo', label: 'Solo', type: 'cloud', available: true }];

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-single-model-'));
  const store = new DebateStore(dir);
  const seen = [];
  const ask = async (agentId, task) => {
    seen.push({ agentId, system: task.system ?? [], stage: task.stage });
    return {
      agentId,
      text: `${agentId} 第 ${seen.length} 次发言：先给结论，再说明条件和反例。`,
      receivedAt: Date.now(),
      attribution: { requestId: 'single-model', note: 'test' },
      stage: task.stage
    };
  };
  return { dir, seen, orchestrator: new DebateOrchestrator(store, { ask }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function runStrategy(strategy) {
  const h = harness();
  try {
    const plan = planLead({ mode: 'cloud', strategy, candidates: SOLO, selected: ['solo'] });
    const started = h.orchestrator.start(QUESTION, {
      strategy,
      maxRounds: 3,
      participants: ['solo'],
      convergenceStop: false,
      leadMode: 'cloud'
    }, undefined, plan);
    const state = await h.orchestrator.waitFor(started.debateId, 10_000);
    assert.ok(state, `${strategy} 没有返回状态`);
    return { state, plan, seen: h.seen };
  } finally {
    h.cleanup();
  }
}

test('单模型 adversarial：proposer -> critic -> responder', async () => {
  const { state } = await runStrategy('adversarial');
  const roles = state.rounds.slice(0, 3).map(round => round.messages[0]?.role);
  assert.equal(roles[0], 'proposer');
  assert.equal(roles[1], 'critic', `第二轮应是 critic，实际 ${roles[1]}`);
  assert.equal(roles[2], 'responder', `第三轮应是 responder，实际 ${roles[2]}`);
  assert.ok(state.rounds.slice(0, 3).every(round => round.messages.every(message => message.agentId === 'solo')));
});

test('单模型六策略：第二轮角色不能仍等于第一轮 lead 角色', async () => {
  for (const strategy of ['truth', 'adversarial', 'expert', 'assumption', 'solution', 'discovery']) {
    const { state } = await runStrategy(strategy);
    const first = state.rounds[0]?.messages[0]?.role;
    const second = state.rounds[1]?.messages[0]?.role;
    assert.notEqual(second, first, `${strategy} 第二轮没有角色轮转：${first} -> ${second}`);
    assert.notEqual(state.rounds[1]?.messages[0]?.kind, 'position', `${strategy} 第二轮不能只是重复 position`);
  }
});

test('单模型角色与提示词职责一致', async () => {
  const { state, seen } = await runStrategy('adversarial');
  const secondRole = state.rounds[1]?.messages[0]?.role;
  assert.ok(['critic', 'opponent'].includes(secondRole), `第二轮角色应为 critic/opponent，实际 ${secondRole}`);
  const questionCall = seen.find(call => call.stage === 'question');
  assert.ok(questionCall, '缺少第二轮 question 调用');
  assert.ok(
    questionCall.system.some(line => line.includes('检验主张的漏洞') || line.includes('核对前提与证据')),
    '第二轮提示词没有使用 critic/evidence reviewer 职责'
  );
  assert.ok(!questionCall.system.some(line => line.includes('提出并维护主张')), '第二轮仍在用 proposer 职责');
});
