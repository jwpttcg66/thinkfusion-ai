import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InMemoryLlmRegistry } from '../lib/llm-registry.js'
import { LlmAdapter } from '../lib/protocol.js'

/** An adapter that answers with a fixed text, so dispatch is observable. */
class FixedAdapter extends LlmAdapter {
  constructor(text) {
    super()
    this.text = text
  }

  async *stream() {
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const options = provider => ({ provider, model: 'm', messages: [] })

async function textOf(iterable) {
  let text = ''
  for await (const chunk of iterable) if (chunk.type === 'text-delta') text += chunk.text
  return text
}

test('a registered route is listed and dispatches to its adapter', async () => {
  const registry = new InMemoryLlmRegistry()
  registry.registerAdapter(['a'], new FixedAdapter('from a'))
  assert.deepEqual(registry.listProviders(), ['a'])
  assert.equal(await textOf(registry.stream(options('a'))), 'from a')
})

test('an unregistered route fails with NO_ADAPTER', () => {
  const registry = new InMemoryLlmRegistry()
  assert.throws(() => registry.stream(options('missing')), error => error.code === 'NO_ADAPTER')
})

test('two adapters cannot own the same route', () => {
  const registry = new InMemoryLlmRegistry()
  registry.registerAdapter(['a'], new FixedAdapter('one'))
  assert.throws(
    () => registry.registerAdapter(['a'], new FixedAdapter('two')),
    /already owned by another adapter/,
  )
})

test('the same adapter may re-register its own route', () => {
  const registry = new InMemoryLlmRegistry()
  const adapter = new FixedAdapter('one')
  registry.registerAdapter(['a'], adapter)
  registry.registerAdapter(['a'], adapter)
  assert.deepEqual(registry.listProviders(), ['a'])
})

test('an empty route set is refused', () => {
  const registry = new InMemoryLlmRegistry()
  assert.throws(() => registry.registerAdapter([], new FixedAdapter('x')), /at least one provider/)
})

test('disposing releases every route the registration held', () => {
  const registry = new InMemoryLlmRegistry()
  const dispose = registry.registerAdapter(['a', 'b'], new FixedAdapter('x'))
  dispose()
  assert.deepEqual(registry.listProviders(), [])
})

test('replace swaps the route set on the same adapter', async () => {
  const registry = new InMemoryLlmRegistry()
  const adapter = new FixedAdapter('x')
  const handle = registry.registerAdapter(['a'], adapter)
  handle.replace(['b'])
  assert.deepEqual(registry.listProviders(), ['b'])
  assert.equal(await textOf(registry.stream(options('b'))), 'x')
  assert.throws(() => registry.stream(options('a')), error => error.code === 'NO_ADAPTER')
})

test('a refused replace leaves the previous routes serving', async () => {
  const registry = new InMemoryLlmRegistry()
  const mine = new FixedAdapter('mine')
  const handle = registry.registerAdapter(['a'], mine)
  registry.registerAdapter(['taken'], new FixedAdapter('theirs'))
  assert.throws(() => handle.replace(['a', 'taken']), /already owned/)
  // The old route must still work, and the refused one must not be half-claimed.
  assert.deepEqual(registry.listProviders(), ['a', 'taken'])
  assert.equal(await textOf(registry.stream(options('a'))), 'mine')
  assert.equal(await textOf(registry.stream(options('taken'))), 'theirs')
})

test('an empty replace is legal and leaves the adapter registered for nothing', () => {
  const registry = new InMemoryLlmRegistry()
  const handle = registry.registerAdapter(['a'], new FixedAdapter('x'))
  handle.replace([])
  assert.deepEqual(registry.listProviders(), [])
})
