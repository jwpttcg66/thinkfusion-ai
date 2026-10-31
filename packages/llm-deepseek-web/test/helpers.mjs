/** Shared fakes for the plugin tests. */

/**
 * A page that replays a fixed probe script, one probe per call, holding the
 * last entry forever once the script runs out.
 * @param {Array<{messageCount:number,lastText:string,generating:boolean,ready:boolean}>} script
 *   probes in call order; the first one is the pre-send snapshot.
 * @returns the fake page, recording what it was asked to do.
 */
export function scriptedPage(script) {
  if (script.length === 0) throw new Error('scriptedPage needs at least one probe')
  let index = 0
  const page = {
    sent: [],
    stops: 0,
    async probe() {
      const probe = script[Math.min(index, script.length - 1)]
      index += 1
      return probe
    },
    async send(text) {
      page.sent.push(text)
    },
    async stop() {
      page.stops += 1
    },
  }
  return page
}

/** One idle page with one prior answer already on screen. */
export const IDLE_WITH_HISTORY = { messageCount: 1, lastText: 'previous answer', generating: false, ready: true }

/**
 * Collect an async iterable into an array.
 * @param {AsyncIterable<unknown>} iterable
 * @returns {Promise<unknown[]>}
 */
export async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** Fast tunables so the wait logic is exercised without real delays. */
export const FAST = { pollMs: 2, settleMs: 8, timeoutMs: 400 }
