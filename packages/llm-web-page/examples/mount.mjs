/**
 * Mount the route and stream one answer, with no framework and no network.
 *
 *   node examples/mount.mjs        # after: npm run build
 *
 * Replace the fake page with the Electron view driver and this is the real
 * wiring: same registry, same adapter, same chunks.
 */
import { InMemoryLlmRegistry, apply, registerPage, unregisterPage } from '../lib/index.js'

/** A page that answers with one tool call, then with a summary. */
function fakePage() {
  const replies = [
    '{"calls":[{"name":"read","arguments":{"path":"package.json"}}]}',
    '{"text":"package.json 里是 Electron + React。"}',
  ]
  // The page already holds every message it has produced: the count *is* the
  // number of prompts submitted so far, so each new send grows it by one.
  let sent = 0
  return {
    async probe() {
      if (sent === 0) return { messageCount: 0, lastText: '', generating: false, ready: true }
      return { messageCount: sent, lastText: replies[sent - 1] ?? '', generating: false, ready: true }
    },
    async send() {
      sent += 1
    },
    async stop() {},
  }
}

const registry = new InMemoryLlmRegistry()
registerPage('web-page', fakePage())
apply({ llm: registry }, { pollMs: 2, settleMs: 8, timeoutMs: 500 })

const base = { provider: 'web-page', model: 'default' }

for (const [label, messages] of [
  ['turn 1 (tool call)', [{ role: 'user', content: [{ type: 'text', text: '看一下 package.json' }] }]],
  ['turn 2 (summary)', [{ role: 'user', content: [{ type: 'text', text: '结论是什么' }] }]],
]) {
  console.log(`\n${label}`)
  for await (const chunk of registry.stream({ ...base, messages })) {
    switch (chunk.type) {
      case 'block-start':
        console.log(`  block-start  #${chunk.index} ${chunk.blockType}`)
        break
      case 'text-delta':
        console.log(`  text-delta   #${chunk.index} ${chunk.text}`)
        break
      case 'tool-call-delta':
        console.log(`  tool-call    #${chunk.index} ${chunk.name}(${chunk.argumentsDelta})`)
        break
      case 'block-end':
        console.log(`  block-end    #${chunk.index} ${chunk.block.type}`)
        break
      case 'finish':
        console.log(`  finish       ${chunk.reason.kind}${chunk.reason.failure === undefined ? '' : ` (${chunk.reason.failure.code}: ${chunk.reason.failure.message})`}`)
        break
      default:
        console.log(`  ${chunk.type}`)
    }
  }
}

unregisterPage('web-page')
