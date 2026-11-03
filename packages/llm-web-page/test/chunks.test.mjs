import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolCallId } from '../lib/protocol.js'
import { abortedChunk, answerChunks, failureChunk } from '../lib/chunks.js'

let counter = 0
const nextId = () => toolCallId(`t${String(++counter)}`)

test('a text-only answer opens, fills and closes one block, then finishes', () => {
  const chunks = answerChunks({ kind: 'answer', text: 'hello', calls: [] }, nextId)
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'block-end', 'finish',
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('block indices start at zero and increase by one', () => {
  const chunks = answerChunks({
    kind: 'answer',
    text: 'thinking',
    calls: [{ name: 'read', arguments: { path: 'a' } }, { name: 'read', arguments: { path: 'b' } }],
  }, nextId)
  const starts = chunks.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.index)
  assert.deepEqual(starts, [0, 1, 2])
})

test('a tool call finishes with reason tool-calls', () => {
  const chunks = answerChunks({ kind: 'answer', text: '', calls: [{ name: 'read', arguments: {} }] }, nextId)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('the closing block carries the same raw arguments the delta carried', () => {
  const chunks = answerChunks({
    kind: 'answer', text: '', calls: [{ name: 'read', arguments: { path: 'a', limit: 2 } }],
  }, nextId)
  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(end.block.arguments, delta.argumentsDelta)
  assert.deepEqual(JSON.parse(end.block.arguments), { path: 'a', limit: 2 })
})

test('the call id is the same on the delta and on the block', () => {
  const chunks = answerChunks({ kind: 'answer', text: '', calls: [{ name: 'read', arguments: {} }] }, nextId)
  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.equal(delta.id, end.block.id)
})

test('the tool-call block type is the protocol tag, not tool_use', () => {
  const chunks = answerChunks({ kind: 'answer', text: '', calls: [{ name: 'read', arguments: {} }] }, nextId)
  const start = chunks.find(chunk => chunk.type === 'block-start')
  assert.equal(start.blockType, 'tool-call')
})

test('nothing follows the terminal finish', () => {
  const chunks = answerChunks({
    kind: 'answer', text: 'a', calls: [{ name: 'read', arguments: {} }],
  }, nextId)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
})

test('an empty text is not emitted as a block', () => {
  const chunks = answerChunks({ kind: 'answer', text: '   ', calls: [] }, nextId)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['finish'])
})

test('a failure stream is one error finish and carries no usage', () => {
  const chunk = failureChunk({ message: 'boom', code: 'TRANSPORT' })
  assert.deepEqual(chunk, { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'TRANSPORT' } } })
})

test('a cancelled stream is an aborted finish', () => {
  const chunk = abortedChunk({ message: 'cancelled', code: 'ABORTED' })
  assert.equal(chunk.reason.kind, 'aborted')
})
