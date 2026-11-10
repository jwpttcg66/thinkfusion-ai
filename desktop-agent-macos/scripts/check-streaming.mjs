/**
 * 流式问一次：正文/推理分开收，用量不能丢。
 *
 * 这里用假 Provider，不发真实请求——测的是 ProviderBackedSubAgent 的装配：
 * 增量回调、完整文本、usage、首 token 时间，以及没有流式能力时退回 ask。
 *
 * Run with: npm run test:streaming
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderBackedSubAgent } from '../out-test/main/execution/provider-sub-agent.js';
import { ProviderSubAgent } from '../out-test/main/agents/provider-agent.js';
import { ProviderError } from '../out-test/main/providers/types.js';
import { diffPartial, notToolRequest } from '../out-test/shared/partial-stream.js';

function provider(overrides = {}) {
  return {
    id: 'p1',
    label: '假 Provider',
    type: 'cloud',
    capabilities: async () => ({ streaming: true, cancellation: 'request', models: true }),
    listModels: async () => [],
    health: async () => ({ available: true, checkedAt: Date.now() }),
    generate: async () => ({ text: '整段回答', providerId: 'p1', modelId: 'm1', usage: { inputTokens: 3, outputTokens: 4 }, latencyMs: 1 }),
    cancel: () => {},
    ...overrides
  };
}

test('流式：正文与推理分开回调，返回完整文本与真实用量', async () => {
  const streamChunks = async function* () {
    yield { reasoning: '先想一下。' };
    yield { text: '你好' };
    yield { text: '，世界' };
    yield { usage: { inputTokens: 11, outputTokens: 7 } };
  };
  const agent = new ProviderBackedSubAgent(provider({ streamChunks }), 'm1');
  const seen = [];
  const answer = await agent.askStream(
    { question: '说句话', stage: 'initial' },
    chunk => seen.push(chunk)
  );

  assert.equal(answer.text, '你好，世界');
  assert.equal(answer.reasoning, '先想一下。');
  assert.deepEqual(answer.usage, { inputTokens: 11, outputTokens: 7 });
  assert.ok(answer.firstTokenAt);
  assert.deepEqual(seen.filter(item => item.text).map(item => item.text), ['你好', '，世界']);
});

test('没有流式能力就退回整段 ask，不假装在流', async () => {
  const agent = new ProviderBackedSubAgent(provider(), 'm1');
  const seen = [];
  const answer = await agent.askStream({ question: '问', stage: 'initial' }, chunk => seen.push(chunk));
  assert.equal(answer.text, '整段回答');
  assert.deepEqual(seen, []);
});

test('流式失败原样抛出，不返回半截回答', async () => {
  const streamChunks = async function* () {
    yield { text: '前半段' };
    throw new ProviderError('timeout', '断了', 'p1');
  };
  const agent = new ProviderBackedSubAgent(provider({ streamChunks }), 'm1');
  await assert.rejects(() => agent.askStream({ question: '问', stage: 'initial' }, () => {}), /断了/);
});


test('网页增量：新版本以旧版本开头就是追加，改写了就整段替换', () => {
  assert.deepEqual(diffPartial('第一段', '第一段，第二段'), { append: '，第二段' });
  assert.deepEqual(diffPartial('旧版本', '新版本'), { reset: '新版本' });
  assert.equal(diffPartial('一样', '一样'), null);
});

test('工具请求防护：以 { 开头就按住，出现正文才放行', () => {
  assert.equal(notToolRequest(''), false);
  assert.equal(notToolRequest('   '), false);
  assert.equal(notToolRequest('{"tool":"fs.stat"}'), false);
  assert.equal(notToolRequest('好的，我先读文件'), true);
  assert.equal(notToolRequest('```ts'), true);
});

test('网页 askStream：按增量回调，页面改写时发 reset', async () => {
  const partials = [];
  const adapter = {
    ask: async input => {
      input.onPartial?.('第一段');
      input.onPartial?.('第一段，第二段');
      input.onPartial?.('换了个写法');
      return { agentId: 'web1', text: '换了个写法', receivedAt: 1, attribution: { requestId: 'r', note: 'n' } };
    },
    status: async () => ({ id: 'web1', label: '网页', available: true, loggedIn: true, pageReady: true, generating: false })
  };
  const agent = new ProviderSubAgent({ id: 'web1', label: '网页', role: '测试' }, adapter);
  const seen = [];
  const answer = await agent.askStream({ question: '问', stage: 'initial' }, chunk => seen.push(chunk));
  assert.equal(answer.text, '换了个写法');
  assert.deepEqual(seen, [
    { text: '第一段' },
    { text: '，第二段' },
    { text: '换了个写法', reset: true }
  ]);
});
