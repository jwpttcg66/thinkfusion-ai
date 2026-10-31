import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, registerPage, unregisterPage } from '../lib/index.js'
import { collect, FAST, IDLE_WITH_HISTORY, scriptedPage } from './helpers.mjs'

/** A context whose only service is the LLM registry, recording what it is given. */
function fakeContext() {
  const registrations = []
  return {
    registrations,
    ctx: {
      llm: {
        registerAdapter(providers, adapter) {
          registrations.push({ providers, adapter })
          return Object.assign(() => {}, { replace() {} })
        },
      },
    },
  }
}

const FAST_TUNING = { pollMs: FAST.pollMs, settleMs: FAST.settleMs, timeoutMs: FAST.timeoutMs }

const request = {
  provider: 'deepseek-web',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

test('apply registers exactly one route on the llm service', () => {
  const { ctx, registrations } = fakeContext()
  apply(ctx, {})
  assert.equal(registrations.length, 1)
  assert.deepEqual(registrations[0].providers, ['deepseek-web'])
})

test('the configured provider name is the registered route', () => {
  const { ctx, registrations } = fakeContext()
  apply(ctx, { provider: 'my-web-route' })
  assert.deepEqual(registrations[0].providers, ['my-web-route'])
})

test('an empty provider is refused at mount time', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { provider: '  ' }), /config\.provider must not be empty/)
})

test('an empty model is refused at mount time', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { model: '' }), /config\.model must not be empty/)
})

test('a non-positive poll interval is refused at mount time', () => {
  const { ctx } = fakeContext()
  assert.throws(() => apply(ctx, { pollMs: 0 }), /config\.pollMs must be a positive number/)
})

test('a page registered after mount is still found at request time', async () => {
  const { ctx, registrations } = fakeContext()
  apply(ctx, FAST_TUNING)
  const adapter = registrations[0].adapter

  // Mount happened with no page attached: the first request fails cleanly.
  const before = await collect(adapter.stream(request))
  assert.equal(before[0].reason.failure.code, 'NO_PAGE')

  registerPage('deepseek-web', scriptedPage([
    IDLE_WITH_HISTORY,
    { messageCount: 2, lastText: '{"text":"attached"}', generating: false, ready: true },
  ]))
  try {
    const after = await collect(adapter.stream(request))
    assert.equal(after[1].text, 'attached')
  } finally {
    unregisterPage('deepseek-web')
  }
})

test('an unregistered page makes later requests fail with NO_PAGE again', async () => {
  const { ctx, registrations } = fakeContext()
  apply(ctx, FAST_TUNING)
  const adapter = registrations[0].adapter
  registerPage('deepseek-web', scriptedPage([IDLE_WITH_HISTORY, { messageCount: 2, lastText: '{"text":"x"}', generating: false, ready: true }]))
  unregisterPage('deepseek-web')
  const chunks = await collect(adapter.stream(request))
  assert.equal(chunks[0].reason.failure.code, 'NO_PAGE')
})

test('a custom page name is honoured', async () => {
  const { ctx, registrations } = fakeContext()
  apply(ctx, { pageName: 'other-view', transport: FAST })
  const adapter = registrations[0].adapter
  registerPage('other-view', scriptedPage([IDLE_WITH_HISTORY, { messageCount: 2, lastText: '{"text":"named"}', generating: false, ready: true }]))
  try {
    const chunks = await collect(adapter.stream(request))
    assert.equal(chunks[1].text, 'named')
  } finally {
    unregisterPage('other-view')
  }
})
