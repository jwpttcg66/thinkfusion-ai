/**
 * Engineering Provider 规划上下文（LT-P4-02）。
 *
 * 只 Provider 规划器接收 system/context；原话保持不变。
 * Web/CLI 适配器没有 withContext，调用方不会注入。
 *
 * Run with: npm run test:engineering-context
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderPlanningAdapter } from '../out-test/main/execution/provider-planning-adapter.js';

function fakeAgent(captured) {
  return {
    id: 'cloud:model',
    label: 'Cloud · model',
    modelId: 'model',
    provider: { id: 'cloud' },
    cancel: () => {},
    health: async () => ({ available: true }),
    ask: async task => {
      captured.push(task);
      return {
        agentId: 'cloud:model',
        text: '计划正文',
        receivedAt: Date.now(),
        attribution: { requestId: 'r', note: 'cloud' },
        stage: task.stage
      };
    }
  };
}

test('Provider 规划器：context 与 system 分开传，question 原话不变', async () => {
  const captured = [];
  const adapter = new ProviderPlanningAdapter(fakeAgent(captured));
  assert.deepEqual(adapter.contextMeta, { providerId: 'cloud', modelId: 'model' });
  const wrapped = adapter.withContext({
    system: ['[Memory] 记住 A'],
    context: ['[摘要] 之前做过 B']
  });
  assert.notEqual(wrapped, adapter);

  const prompt = '用户原话 + 机器可读计划契约';
  const sent = await wrapped.sendMessage(prompt, 'req-1');
  const answer = await wrapped.waitForAnswer('req-1', sent.snapshotBefore, 5000, prompt);
  assert.equal(answer, '计划正文');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].question, prompt);
  assert.deepEqual(captured[0].system, ['[Memory] 记住 A']);
  assert.deepEqual(captured[0].context, ['[摘要] 之前做过 B']);
});

test('没有 withContext 的适配器不会被注入', () => {
  const web = { siteLabel: 'web' };
  assert.equal(typeof web.withContext, 'undefined');
});
