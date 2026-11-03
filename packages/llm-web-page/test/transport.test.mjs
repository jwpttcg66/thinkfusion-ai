import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PageTransport } from '../lib/transport.js'
import { FAST, IDLE_WITH_HISTORY, scriptedPage } from './helpers.mjs'

const ANSWER = { messageCount: 2, lastText: '{"text":"ok"}', generating: false, ready: true }

test('a new settled message is returned', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, ANSWER])
  const answer = await new PageTransport(page, FAST).ask('hello')
  assert.equal(answer, '{"text":"ok"}')
  assert.deepEqual(page.sent, ['hello'])
})

test('an old message is never mistaken for the answer', async () => {
  // The page renders no new message at all: the count stays at the snapshot.
  const page = scriptedPage([IDLE_WITH_HISTORY])
  const transport = new PageTransport(page, { ...FAST, timeoutMs: 60 })
  await assert.rejects(transport.ask('hello'), error => {
    assert.equal(error.code, 'NO_ANSWER')
    assert.match(error.message, /produced no new message/)
    return true
  })
})

test('a growing message that never stops generating is reported as unsettled', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, { ...ANSWER, generating: true }])
  const transport = new PageTransport(page, { ...FAST, timeoutMs: 60 })
  await assert.rejects(transport.ask('hello'), error => {
    assert.equal(error.code, 'TIMEOUT')
    assert.match(error.message, /never settled/)
    return true
  })
})

test('a message that keeps changing is not returned until it stops changing', async () => {
  const growing = [
    IDLE_WITH_HISTORY,
    { ...ANSWER, lastText: '{"text":"a"' },
    { ...ANSWER, lastText: '{"text":"ab"}' },
  ]
  // The script holds its last entry, so "ab" repeats until the settle window passes.
  const page = scriptedPage(growing)
  const answer = await new PageTransport(page, FAST).ask('hello')
  assert.equal(answer, '{"text":"ab"}')
})

test('generation restarting after a settled poll resets the candidate', async () => {
  const page = scriptedPage([
    IDLE_WITH_HISTORY,
    { ...ANSWER, lastText: '{"text":"partial"}' },
    { ...ANSWER, lastText: '{"text":"partial"}', generating: true },
    { ...ANSWER, lastText: '{"text":"partial"}', generating: true },
    ANSWER,
  ])
  const answer = await new PageTransport(page, FAST).ask('hello')
  assert.equal(answer, '{"text":"ok"}')
})

test('an empty rendered message is not treated as an answer', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, { ...ANSWER, lastText: '   ' }])
  const transport = new PageTransport(page, { ...FAST, timeoutMs: 60 })
  await assert.rejects(transport.ask('hello'), error => {
    assert.equal(error.code, 'TIMEOUT')
    return true
  })
})

test('a page that is not ready is refused before sending anything', async () => {
  const page = scriptedPage([{ ...IDLE_WITH_HISTORY, ready: false }])
  await assert.rejects(new PageTransport(page, FAST).ask('hello'), error => {
    assert.equal(error.code, 'NOT_READY')
    return true
  })
  assert.deepEqual(page.sent, [])
})

test('a failed submit is reported as SEND_FAILED', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY])
  page.send = async () => {
    throw new Error('composer detached')
  }
  await assert.rejects(new PageTransport(page, FAST).ask('hello'), error => {
    assert.equal(error.code, 'SEND_FAILED')
    return true
  })
})

test('a probe failure is reported as PAGE_ERROR', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY])
  page.probe = async () => {
    throw new Error('view destroyed')
  }
  await assert.rejects(new PageTransport(page, FAST).ask('hello'), error => {
    assert.equal(error.code, 'PAGE_ERROR')
    return true
  })
})

test('cancelling presses the page stop control and rejects', async () => {
  const page = scriptedPage([IDLE_WITH_HISTORY, { ...ANSWER, generating: true }])
  const controller = new AbortController()
  const transport = new PageTransport(page, { ...FAST, timeoutMs: 5_000 })
  const pending = transport.ask('hello', controller.signal)
  setTimeout(() => controller.abort(), 15)
  await assert.rejects(pending, error => {
    assert.match(error.message, /cancelled/)
    return true
  })
  assert.equal(page.stops, 1)
})
