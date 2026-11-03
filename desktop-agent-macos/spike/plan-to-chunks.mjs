/**
 * Spike: prove that a DeepSeek web answer becomes a protocol-legal chunk stream.
 *
 * This used to carry its own copy of the translation. It no longer does: the
 * translation now lives in `packages/llm-web-page`, and a second
 * implementation here would only drift away from the one that ships. So this
 * script drives the real adapter through a fake page and checks the chunks it
 * actually produces.
 *
 *   node spike/plan-to-chunks.mjs        # after: cd packages/llm-web-page && npm run build
 */
import assert from 'node:assert/strict'
import { WebPageAdapter, PageTransport } from '../../packages/llm-web-page/lib/index.js'

/** What a page plausibly answers when asked to read and then write a file. */
const TWO_CALLS = `我先看一下项目结构。

\`\`\`json
{
  "calls": [
    { "name": "read", "arguments": { "path": "package.json" } },
    { "name": "write", "arguments": { "path": "reports/a.md", "content": "# report" } }
  ]
}
\`\`\`

以上两步完成后即可汇总。`

/** An answer that needs no tools. */
const TEXT_ONLY = '```json\n{"text":"项目使用 Electron + React。"}\n```'

/** A conversational answer, which the adapter must refuse rather than guess at. */
const CHATTY = '我会调用 read 工具读取文件。'

/**
 * A page holding one prior answer that then renders the given reply.
 * @param {string} reply - the text the page produces for the next request.
 * @returns a {@link import('../../packages/llm-web-page/lib/page.js').WebPage}
 */
function pageAnswering(reply) {
  let polls = 0
  return {
    async probe() {
      polls += 1
      // The first probe is the pre-send snapshot; everything after it is the new message.
      if (polls === 1) return { messageCount: 1, lastText: 'previous answer', generating: false, ready: true }
      return { messageCount: 2, lastText: reply, generating: false, ready: true }
    },
    async send() {},
    async stop() {},
  }
}

/**
 * Run one request through the real adapter.
 * @param {string} reply - the page's answer.
 * @returns {Promise<any[]>} the chunks the adapter emitted.
 */
async function chunksFor(reply) {
  const adapter = new WebPageAdapter({
    provider: 'deepseek-web',
    model: 'deepseek-chat',
    resolvePage: () => pageAnswering(reply),
    transport: { pollMs: 2, settleMs: 8, timeoutMs: 500 },
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'deepseek-web',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: '整理项目结构' }] }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

let passed = 0
/**
 * Run one assertion and report it.
 * @param {string} name - what is being checked.
 * @param {() => Promise<void>} body - the assertions.
 */
async function check(name, body) {
  await body()
  passed += 1
  console.log(`  ok   ${name}`)
}

console.log('page answer -> StreamChunk (real adapter)')

await check('two calls become two tool-call blocks', async () => {
  const chunks = await chunksFor(TWO_CALLS)
  const starts = chunks.filter(c => c.type === 'block-start')
  assert.deepEqual(starts.map(c => c.blockType), ['tool-call', 'tool-call'])
  assert.deepEqual(starts.map(c => c.index), [0, 1])
})

await check('argumentsDelta is a raw JSON string that round-trips', async () => {
  const chunks = await chunksFor(TWO_CALLS)
  const delta = chunks.find(c => c.type === 'tool-call-delta' && c.name === 'write')
  assert.equal(typeof delta.argumentsDelta, 'string')
  const parsed = JSON.parse(delta.argumentsDelta)
  assert.equal(parsed.path, 'reports/a.md')
  assert.equal(parsed.content, '# report')
})

await check('block-end repeats the same raw string, not a parsed object', async () => {
  const chunks = await chunksFor(TWO_CALLS)
  const delta = chunks.find(c => c.type === 'tool-call-delta' && c.index === 0)
  const end = chunks.find(c => c.type === 'block-end' && c.index === 0)
  assert.equal(end.block.type, 'tool-call')
  assert.equal(end.block.arguments, delta.argumentsDelta)
  assert.equal(end.block.id, delta.id)
})

await check('a call stream finishes with reason tool-calls', async () => {
  const chunks = await chunksFor(TWO_CALLS)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

await check('nothing follows finish', async () => {
  const chunks = await chunksFor(TWO_CALLS)
  assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  assert.equal(chunks.at(-1).type, 'finish')
})

await check('a text-only answer is a text block and finish=stop', async () => {
  const chunks = await chunksFor(TEXT_ONLY)
  assert.equal(chunks[0].blockType, 'text')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

await check('prose without a reply object fails the turn instead of inventing calls', async () => {
  const chunks = await chunksFor(CHATTY)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'PROTOCOL')
})

await check('the transport refuses an old message as the answer', async () => {
  // A page that never renders a new message: the count stays at the snapshot.
  const stuck = {
    async probe() { return { messageCount: 1, lastText: 'previous answer', generating: false, ready: true } },
    async send() {},
    async stop() {},
  }
  const transport = new PageTransport(stuck, { pollMs: 2, settleMs: 8, timeoutMs: 60 })
  await assert.rejects(transport.ask('hello'), error => error.code === 'NO_ANSWER')
})

console.log('')
console.log(`${passed} checks passed — the adapter seam is viable.`)
