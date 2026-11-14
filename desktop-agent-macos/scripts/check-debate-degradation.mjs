/**
 * P0 缺口测试：模型失败后的动态降级。
 *
 * 预期失败：当前只写 round.failures，没有 degradation 记录，
 * 不重算实际参与者、角色、Judge 独立性和 modelIndependence。
 *
 * 这里定义的是未来契约，不是当前实现。Run with:
 *   npm run test:debate-degradation
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { planLead } from '../out-test/main/debate/lead.js';

const QUESTION = '三模型中一个失败时，系统应如何降级？';
const CANDIDATES = [
  { id: 'a', label: 'A', type: 'cloud', available: true },
  { id: 'b', label: 'B', type: 'cloud', available: true },
  { id: 'c', label: 'C', type: 'cloud', available: true }
];

async function runWithFailures(failedIds, maxRounds = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-degradation-'));
  const store = new DebateStore(dir);
  const ask = async (agentId, task) => {
    if (failedIds.includes(agentId)) throw new Error(`${agentId} 不可用`);
    return {
      agentId,
      text: `${agentId} 的发言：有条件成立，反例是条件不满足时。`,
      receivedAt: Date.now(),
      attribution: { requestId: 'degradation', note: 'test' },
      stage: task.stage
    };
  };
  try {
    const plan = planLead({ mode: 'cloud', strategy: 'adversarial', candidates: CANDIDATES, selected: ['a', 'b', 'c'] });
    const orchestrator = new DebateOrchestrator(store, { ask });
    const started = orchestrator.start(QUESTION, {
      strategy: 'adversarial',
      maxRounds,
      participants: ['a', 'b', 'c'],
      convergenceStop: false,
      leadMode: 'cloud'
    }, undefined, plan);
    const state = await orchestrator.waitFor(started.debateId, 10_000);
    assert.ok(state, '辩论没有返回状态');
    return state;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertDegradationShape(state) {
  assert.ok(state.degradation, '缺少 state.degradation 降级记录');
  assert.ok(Array.isArray(state.degradation.actualParticipants), '缺少实际参与者');
  assert.ok(Array.isArray(state.degradation.failedAgents), '缺少失败成员');
  assert.equal(typeof state.degradation.judgeIndependent, 'boolean', '缺少 judgeIndependent');
  assert.equal(typeof state.degradation.modelIndependence, 'boolean', '缺少 modelIndependence');
  assert.ok(state.degradation.reason, '缺少降级原因');
}

test('正方/a 失败：保留 b、c，不自动降成单模型', async () => {
  const state = await runWithFailures(['a']);
  assertDegradationShape(state);
  assert.ok(state.degradation.failedAgents.includes('a'));
  assert.ok(state.degradation.actualParticipants.includes('b'));
  assert.ok(state.degradation.actualParticipants.includes('c'));
  assert.equal(state.degradation.actualParticipants.length >= 2, true);
});

test('反方/b 失败：重新计算角色与独立性', async () => {
  const state = await runWithFailures(['b']);
  assertDegradationShape(state);
  assert.ok(state.degradation.failedAgents.includes('b'));
  assert.ok(state.degradation.actualParticipants.includes('a'));
  assert.ok(state.degradation.actualParticipants.includes('c'));
  assert.ok(state.degradation.roleChanges || state.degradation.actualRoles, '缺少角色重分配记录');
});

test('Judge 候选/c 失败：必须重算 Judge 独立性，不能沿用旧标签', async () => {
  const state = await runWithFailures(['c']);
  assertDegradationShape(state);
  assert.ok(state.degradation.failedAgents.includes('c'));
  assert.ok(state.degradation.actualParticipants.includes('a'));
  assert.ok(state.degradation.actualParticipants.includes('b'));
  assert.equal(state.degradation.judgeIndependent, false, 'c 失败后不能继续声称独立 Judge');
});

test('两个成员失败：只剩一个时标记单模型自评', async () => {
  const state = await runWithFailures(['a', 'b']);
  assertDegradationShape(state);
  assert.deepEqual(state.degradation.failedAgents.sort(), ['a', 'b']);
  assert.deepEqual(state.degradation.actualParticipants, ['c']);
  assert.equal(state.degradation.judgeIndependent, false);
  assert.equal(state.degradation.modelIndependence, false);
});
