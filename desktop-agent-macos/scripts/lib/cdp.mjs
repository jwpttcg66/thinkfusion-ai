/**
 * Minimal Chrome DevTools Protocol client for the live checks.
 *
 * Everything under `scripts/` that talks to a running app needs the same three
 * things: find a target, evaluate an expression in it, and get a plain value
 * back. There is no dependency to add for that — one WebSocket and a message
 * id counter is the whole protocol surface we use.
 *
 * The live checks exist because the interesting failures in this app are not in
 * any single function. Whether the page really accepted a message, whether the
 * native view ended up where the renderer thinks it did, whether a drag reaches
 * the main process — all of it spans DOM, IPC and the main process at once, and
 * only a running app can answer. Screenshots are not available in this
 * environment, so the checks read state instead of pixels.
 */
export const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222/json';

export async function listTargets() {
  const response = await fetch(ENDPOINT);
  if (!response.ok) throw new Error(`CDP endpoint returned ${response.status}; is the app running with --remote-debugging-port=9222?`);
  return response.json();
}

/** The app's own renderer — the window, not the embedded page. */
export function findAppTarget(targets) {
  return targets.find(target => target.type === 'page' && target.url.startsWith('file:')) ?? null;
}

/** The embedded DeepSeek page. */
export function findPageTarget(targets) {
  return targets.find(target => target.type === 'page' && target.url.includes('chat.deepseek.com')) ?? null;
}

export async function connect(target) {
  if (!target) throw new Error('CDP target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot connect to ${target.url}`)), { once: true });
  });

  let nextId = 0;
  const pending = new Map();

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const details = message.result?.exceptionDetails;
    if (details) entry.reject(new Error(details.exception?.description ?? details.text ?? 'evaluation failed'));
    else entry.resolve(message.result?.result?.value);
  });

  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('CDP socket closed'));
    pending.clear();
  });

  return {
    /**
     * Evaluates an expression and returns its value. Promises are awaited, so a
     * call into the preload API resolves to the real reply rather than a handle.
     */
    evaluate(expression, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout after ${timeoutMs}ms: ${expression.slice(0, 80)}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(
          JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })
        );
      });
    },
    close() {
      socket.close();
    }
  };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Waits for a value to settle on what was asked for.
 *
 * Moving the page pane means an IPC call, a `setBounds`, and the embedded
 * page's own layout pass — the page's `window.innerWidth` does not change on
 * the same tick. Reading it once after a fixed sleep is how a correct layout
 * gets reported as a failure, which is worse than useless in a check like this.
 */
export async function waitFor(read, expected, { timeoutMs = 4000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!Object.is(value, expected) && Date.now() < deadline) {
    await sleep(intervalMs);
    value = await read();
  }
  return value;
}

/**
 * A tiny assertion counter. These checks print a line per claim and exit
 * non-zero on any failure, so they can gate a release the same way a test
 * runner would — but they report in terms of what the user would see.
 */
export function createChecks() {
  const tally = { ok: 0, fail: 0 };

  // Plain closures, not methods: every caller destructures these, and a
  // `this.check(...)` inside would arrive with `this` undefined.
  function check(label, actual, expected) {
    const pass = Object.is(actual, expected);
    tally[pass ? 'ok' : 'fail'] += 1;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${pass ? '' : ` (expected ${JSON.stringify(expected)})`}`);
    return pass;
  }

  function checkTrue(label, actual) {
    return check(label, Boolean(actual), true);
  }

  function summary() {
    console.log(`\n${tally.ok} passed, ${tally.fail} failed`);
    return tally;
  }

  return { check, checkTrue, summary };
}
