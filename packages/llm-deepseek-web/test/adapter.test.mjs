import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeepSeekWebAdapter } from '../lib/adapter.js'
import { collect, FAST, IDLE_WITH_HISTORY, scriptedPage } from './helpers.mjs'

const request = (extra = {}) => ({
  provider: 'deepseek-web',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'list the config files' }] }],
  ...extra,
})

const answering = text => ({
  messageCount: 2,
  lastText: text,
  generating: false,
  ready: true,
})

test('a full turn becomes a text block and a finish', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, answering('{"text":"found two files"}')])
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => page, transport: FAST })
  const chunks = await collect(adapter.stream(request()))
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('the prompt actually sent carries the transcript', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, answering('{"text":"ok"}')])
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => page, transport: FAST })
  await collect(adapter.stream(request()))
  assert.equal(page.sent.length, 1)
  assert.match(page.sent[0], /list the config files/)
})

test('a tool call becomes a tool-call block and finishes with tool-calls', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, answering('{"calls":[{"name":"glob","arguments":{"pattern":"*.json"}}]}')])
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => page, transport: FAST })
  const chunks = await collect(adapter.stream(request()))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(end.block.name, 'glob')
  assert.deepEqual(JSON.parse(end.block.arguments), { pattern: '*.json' })
})

test('a conversational answer fails the turn instead of guessing', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, answering('You should probably look in package.json.')])
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => page, transport: FAST })
  const chunks = await collect(adapter.stream(request()))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'PROTOCOL')
})

test('a missing page fails with NO_PAGE rather than hanging', async () => {
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => undefined, transport: FAST })
  const chunks = await collect(adapter.stream(request()))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'NO_PAGE')
})

test('a page that never answers fails the turn with NO_ANSWER', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY])
  const adapter = new DeepSeekWebAdapter({
    provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => page,
    transport: { ...FAST, timeoutMs: 60 },
  })
  const chunks = await collect(adapter.stream(request()))
  assert.equal(chunks[0].reason.failure.code, 'NO_ANSWER')
})

test('cancellation reports an aborted finish, not an error', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, { ...answering('partial'), generating: true }])
  const adapter = new DeepSeekWebAdapter({
    provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => page,
    transport: { ...FAST, timeoutMs: 5_000 },
  })
  const controller = new AbortController()
  const pending = collect(adapter.stream(request({ signal: controller.signal })))
  setTimeout(() => controller.abort(), 15)
  const chunks = await pending
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})

test('the route advertises exactly the configured model', async () => {
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => undefined })
  const models = await adapter.listModels('deepseek-web')
  assert.deepEqual(models, [{ provider: 'deepseek-web', id: 'deepseek-chat', name: 'deepseek-chat' }])
  assert.deepEqual(adapter.providerInfo('deepseek-web'), { id: 'deepseek-web', name: 'DeepSeek (web)' })
})

test('the page is resolved per request, so a replaced view is picked up', async () => {
  let current = scriptedPage([IDLE_WITH_HISTORY, answering('{"text":"first"}')])
  const adapter = new DeepSeekWebAdapter({ provider: 'deepseek-web', model: 'deepseek-chat', resolvePage: () => current, transport: FAST })
  const first = await collect(adapter.stream(request()))
  assert.equal(first[1].text, 'first')

  current = scriptedPage([IDLE_WITH_HISTORY, answering('{"text":"second"}')])
  const second = await collect(adapter.stream(request()))
  assert.equal(second[1].text, 'second')
})
