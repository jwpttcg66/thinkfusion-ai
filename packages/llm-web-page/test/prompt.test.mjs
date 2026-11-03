import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWebPrompt } from '../lib/prompt.js'

const user = text => ({ role: 'user', content: [{ type: 'text', text }] })

test('the reply contract appears twice so a long transcript cannot bury it', () => {
  const prompt = buildWebPrompt({ provider: 'p', model: 'm', messages: [user('hi')] })
  const hits = prompt.match(/Reply with exactly one JSON object/g) ?? []
  assert.equal(hits.length, 2)
})

test('a system message is hoisted above the transcript as its own section', () => {
  const prompt = buildWebPrompt({
    provider: 'p', model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: 'be terse' }] }, user('hi')],
  })
  assert.match(prompt, /## System instructions\n\nbe terse/)
  assert.doesNotMatch(prompt, /### System/)
})

test('both system forms merge into one instructions section', () => {
  const prompt = buildWebPrompt({
    provider: 'p', model: 'm', system: 'from options',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'from history' }] }, user('hi')],
  })
  assert.match(prompt, /## System instructions\n\nfrom options\n\nfrom history/)
})

test('an absent system prompt adds no empty section', () => {
  const prompt = buildWebPrompt({ provider: 'p', model: 'm', messages: [user('hi')] })
  assert.doesNotMatch(prompt, /System instructions/)
})

test('tool schemas are rendered with their parameters', () => {
  const prompt = buildWebPrompt({
    provider: 'p', model: 'm', messages: [user('hi')],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })
  assert.match(prompt, /## Tools you may call/)
  assert.match(prompt, /"name": "read"/)
  assert.match(prompt, /"path"/)
})

test('a request without tools declares no catalogue', () => {
  const prompt = buildWebPrompt({ provider: 'p', model: 'm', messages: [user('hi')] })
  assert.doesNotMatch(prompt, /Tools you may call/)
})

test('each role is labelled in the transcript', () => {
  const prompt = buildWebPrompt({
    provider: 'p', model: 'm',
    messages: [
      user('find the config'),
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'glob', arguments: '{"pattern":"*.json"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'package.json' }], toolCallId: 'c1', isError: false },
    ],
  })
  assert.match(prompt, /### User\nfind the config/)
  assert.match(prompt, /### Assistant\n\[called glob with \{"pattern":"\*\.json"\}\]/)
  assert.match(prompt, /### Tool result \(succeeded\)\npackage\.json/)
})

test('a failed tool result says so', () => {
  const prompt = buildWebPrompt({
    provider: 'p', model: 'm',
    messages: [{ role: 'tool', content: [{ type: 'text', text: 'denied' }], toolCallId: 'c1', isError: true }],
  })
  assert.match(prompt, /### Tool result \(failed\)/)
})

test('image and file blocks become placeholders rather than silently vanishing', () => {
  const prompt = buildWebPrompt({
    provider: 'p', model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: {} }, { type: 'file', attachment: {} }] }],
  })
  assert.match(prompt, /\[image omitted/)
  assert.match(prompt, /\[file reference omitted/)
})
