/**
 * Provider 层的行为测试。
 *
 * 这一层没有 UI、没有页面，所以能测的东西很具体：名单对不对、能力说得实不实、
 * 错误映射有没有把原始信息丢掉、取消到底做了什么。
 *
 * 最该被钉住的是**诚实性**：网页通道不能被描述成支持流式、支持真取消、知道
 * 上下文长度。这三条一旦写错，上层的成本估算和上下文切分会跟着错，而且错得
 * 很安静。
 *
 * Run with: npm run test:providers
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../out-test/main/providers/registry.js';
import { WebChannelProvider } from '../out-test/main/providers/web-channel.js';
import { ProviderError } from '../out-test/main/providers/types.js';
import { PageBusyError, PageUnavailableError } from '../out-test/main/adapters/browser/types.js';

function fakeAgent(overrides = {}) {
  const id = overrides.id ?? 'alpha';
  const agent = {
    id,
    label: overrides.label ?? 'Alpha',
    identity: { id, label: overrides.label ?? 'Alpha', kind: 'provider', role: 'test' },
    health: overrides.health ?? (async () => ({ id, label: 'Alpha', available: true, loggedIn: true, pageReady: true, generating: false })),
    ask:
      overrides.ask ??
      (async () => ({ agentId: id, text: '答案', receivedAt: Date.now(), stage: 'initial' })),
    cancel: overrides.cancel ?? (() => {}),
    cancelAll: overrides.cancelAll ?? (() => {})
  };
  return agent;
}

function fakeProvider(id, { available = true, models = [], healthThrows = false } = {}) {
  return {
    id,
    label: id,
    type: 'cloud',
    capabilities: async () => ({
      streaming: true,
      cancellation: 'abort',
      modelDiscovery: 'static',
      maxConcurrency: 1,
      structuredOutput: false,
      toolCalling: false
    }),
    listModels: async () => models,
    health: async () => {
      if (healthThrows) throw new Error(`${id} 探测失败`);
      return { available, checkedAt: Date.now() };
    },
    generate: async () => {
      throw new Error('not implemented in fixture');
    },
    cancel: () => {}
  };
}

test('registry 拒绝重复注册', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('a'));
  assert.throws(() => registry.register(fakeProvider('a')), /重复注册/);
});

test('registry.require 对未知 id 抛错，get 返回 undefined', () => {
  const registry = new ProviderRegistry();
  assert.equal(registry.get('nope'), undefined);
  assert.throws(() => registry.require('nope'), /没有这个 Provider/);
});

test('replaceAll 换名单但保留实例', () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('a'));
  registry.replaceAll([fakeProvider('b'), fakeProvider('c')]);
  assert.deepEqual(registry.list().map(item => item.id), ['b', 'c']);
  assert.equal(registry.get('a'), undefined);
});

test('一个 Provider 探测抛错不影响其他', async () => {
  const registry = new ProviderRegistry();
  registry.register(fakeProvider('ok'));
  registry.register(fakeProvider('broken', { healthThrows: true }));

  const health = await registry.health();
  assert.equal(health.ok.available, true);
  assert.equal(health.broken.available, false);
  assert.match(health.broken.detail, /探测失败/);

  const available = await registry.available();
  assert.deepEqual(available.map(item => item.id), ['ok']);
});

test('models 汇总时跳过报错的 Provider', async () => {
  const registry = new ProviderRegistry();
  registry.register(
    fakeProvider('a', { models: [{ id: 'a:1', label: 'A1', providerId: 'a', contextTokens: 8192 }] })
  );
  const broken = fakeProvider('b');
  broken.listModels = async () => {
    throw new Error('列不出来');
  };
  registry.register(broken);

  const models = await registry.models();
  assert.deepEqual(models.map(item => item.id), ['a:1']);
});

test('网页通道的能力描述不许美化', async () => {
  const provider = new WebChannelProvider(fakeAgent());
  const capabilities = await provider.capabilities();

  assert.equal(capabilities.streaming, false, '页面不是流');
  assert.equal(capabilities.cancellation, 'give-up', 'cancelAll 只是不再等，不是真中止');
  assert.equal(capabilities.maxConcurrency, 1, '一个页面只有一个输入框');
  assert.equal(capabilities.modelDiscovery, 'unknown');
});

test('网页通道不编造上下文长度', async () => {
  const provider = new WebChannelProvider(fakeAgent());
  const models = await provider.listModels();

  assert.equal(models.length, 1);
  assert.equal(models[0].contextTokens, null, '问不出来就写 null，不写 8192');
});

test('一次回答没有 token 数，写 null 而不是 0', async () => {
  const provider = new WebChannelProvider(fakeAgent());
  const response = await provider.generate({ question: '你好' });

  assert.equal(response.text, '答案');
  assert.equal(response.usage.inputTokens, null);
  assert.equal(response.usage.outputTokens, null);
  assert.ok(response.latencyMs >= 0);
  assert.equal(response.providerId, 'alpha');
});

test('continuation 走 followup，否则 initial', async () => {
  const stages = [];
  const agent = fakeAgent({
    ask: async task => {
      stages.push(task.stage);
      return { agentId: 'alpha', text: 'ok', receivedAt: Date.now(), stage: task.stage };
    }
  });
  const provider = new WebChannelProvider(agent);

  await provider.generate({ question: '一' });
  await provider.generate({ question: '二', continuation: true });

  assert.deepEqual(stages, ['initial', 'followup']);
});

test('页面忙映射成 busy，原始错误留在 cause 上', async () => {
  const busy = new PageBusyError('alpha');
  const provider = new WebChannelProvider(
    fakeAgent({
      ask: async () => {
        throw busy;
      }
    })
  );

  await assert.rejects(
    provider.generate({ question: 'q' }),
    error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'busy');
      assert.equal(error.cause, busy, '原始错误不能被丢掉');
      return true;
    }
  );
});

test('页面不可用映射成 unavailable', async () => {
  const provider = new WebChannelProvider(
    fakeAgent({
      ask: async () => {
        throw new PageUnavailableError('alpha', '未登录');
      }
    })
  );

  await assert.rejects(provider.generate({ question: 'q' }), error => error.code === 'unavailable');
});

test('超时按文本识别，同时保留原错误', async () => {
  const original = new Error('等待回答超时');
  const provider = new WebChannelProvider(
    fakeAgent({
      ask: async () => {
        throw original;
      }
    })
  );

  await assert.rejects(
    provider.generate({ question: 'q' }),
    error => error.code === 'timeout' && error.cause === original
  );
});

test('取消信号：立即失败，并且确实叫了 cancelAll', async () => {
  let cancelled = 0;
  const provider = new WebChannelProvider(
    fakeAgent({
      ask: () => new Promise(() => {}),
      cancelAll: () => {
        cancelled += 1;
      }
    })
  );

  const controller = new AbortController();
  const pending = provider.generate({ question: 'q' }, controller.signal);
  controller.abort();

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'cancelled');
    return true;
  });
  assert.equal(cancelled, 1, '放弃等待时必须通知页面');
});

test('已经取消的信号，请求根本不发出去', async () => {
  let asked = 0;
  const provider = new WebChannelProvider(
    fakeAgent({
      ask: async () => {
        asked += 1;
        return { agentId: 'alpha', text: 'x', receivedAt: Date.now(), stage: 'initial' };
      }
    })
  );

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(provider.generate({ question: 'q' }, controller.signal), error => error.code === 'cancelled');
  assert.equal(asked, 0);
});

test('health 探测本身失败也是一条状态，不是崩溃', async () => {
  const provider = new WebChannelProvider(
    fakeAgent({
      health: async () => {
        throw new Error('页面已关闭');
      }
    })
  );

  const health = await provider.health();
  assert.equal(health.available, false);
  assert.match(health.detail, /页面已关闭/);
});
