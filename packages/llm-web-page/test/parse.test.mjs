import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAnswer } from '../lib/parse.js'

test('a bare reply object is read', () => {
  const result = parseAnswer('{"text":"done"}')
  assert.deepEqual(result, { kind: 'answer', text: 'done', calls: [] })
})

test('a fenced reply object is read', () => {
  const raw = '```json\n{"text":"done","calls":[]}\n```'
  assert.equal(parseAnswer(raw).kind, 'answer')
})

test('prose before and after the object is ignored', () => {
  const raw = 'Sure, here you go:\n{"text":"two files"}\nLet me know if you need more.'
  assert.deepEqual(parseAnswer(raw), { kind: 'answer', text: 'two files', calls: [] })
})

test('tool calls decode with object arguments', () => {
  const raw = '{"calls":[{"name":"read","arguments":{"path":"a.txt"}}]}'
  const result = parseAnswer(raw)
  assert.equal(result.kind, 'answer')
  assert.deepEqual(result.calls, [{ name: 'read', arguments: { path: 'a.txt' } }])
})

test('tool call arguments sent as a JSON string are decoded', () => {
  const raw = '{"calls":[{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}]}'
  const result = parseAnswer(raw)
  assert.deepEqual(result.calls, [{ name: 'read', arguments: { path: 'a.txt' } }])
})

test('a bare single call without the envelope is accepted', () => {
  const raw = '{"name":"read","arguments":{"path":"b.txt"}}'
  assert.deepEqual(parseAnswer(raw).calls, [{ name: 'read', arguments: { path: 'b.txt' } }])
})

test('the last fenced block wins over an earlier example', () => {
  const raw = '```json\n{"text":"example"}\n```\nand the real one:\n```json\n{"text":"real"}\n```'
  assert.deepEqual(parseAnswer(raw), { kind: 'answer', text: 'real', calls: [] })
})

test('braces inside strings do not split the object', () => {
  const raw = '{"text":"a } b { c"}'
  assert.deepEqual(parseAnswer(raw), { kind: 'answer', text: 'a } b { c', calls: [] })
})

test('a conversational answer is rejected, not coerced', () => {
  const result = parseAnswer('I would suggest reading a.txt first.')
  assert.equal(result.kind, 'invalid')
  assert.match(result.reason, /no JSON object/)
})

test('JSON that is not a reply object is rejected', () => {
  const result = parseAnswer('{"foo":"bar"}')
  assert.equal(result.kind, 'invalid')
  assert.match(result.reason, /not a reply object/)
})

test('an empty reply object is rejected', () => {
  assert.equal(parseAnswer('{"text":"   "}').kind, 'invalid')
})

test('a call without a name is rejected', () => {
  assert.equal(parseAnswer('{"calls":[{"arguments":{}}]}').kind, 'invalid')
})

test('a non-array calls field is rejected', () => {
  assert.equal(parseAnswer('{"text":"x","calls":"read"}').kind, 'invalid')
})

test('an empty answer is rejected', () => {
  assert.equal(parseAnswer('   ').kind, 'invalid')
})
