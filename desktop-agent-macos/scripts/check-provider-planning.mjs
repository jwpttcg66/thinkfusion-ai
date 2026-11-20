/** 云端/本地 Provider 规划适配器：不依赖网页登录。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderPlanningAdapter } from '../out-test/main/execution/provider-planning-adapter.js';

function agent(available = true) {
  return {
    id: 'cloud', label: 'Cloud', sourceType: 'cloud',
    health: async () => ({ available, detail: available ? undefined : 'no key' }),
    ask: async () => ({ text: '{"type":"plan"}' }),
    cancel: () => {}
  };
}

test('Provider 规划：status 可用；send/wait 返回计划文本', async () => {
  const adapter = new ProviderPlanningAdapter(agent());
  const status = await adapter.getStatus();
  assert.equal(status.loggedIn, true);
  assert.equal(status.pageReady, true);
  const sent = await adapter.sendMessage('plan this', 'r1');
  assert.equal(sent.submitted, true);
  const text = await adapter.waitForAnswer('r1', sent.snapshotBefore, 1000);
  assert.match(text, /plan/);
});

test('Provider 不可用时 status 明确', async () => {
  const adapter = new ProviderPlanningAdapter(agent(false));
  const status = await adapter.getStatus();
  assert.equal(status.loggedIn, false);
  assert.match(status.detail, /no key/);
});
