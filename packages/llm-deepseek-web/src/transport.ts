/**
 * Deciding which page text is *this* request's answer.
 *
 * This is the part of the adapter that can go wrong silently. A web chat page
 * has no request ids and no stream framing: it is a list of rendered messages
 * that keeps growing. If the transport returned "the last message" without
 * checking that a new one appeared, a slow page would hand the harness the
 * previous turn's answer — and the harness would act on it.
 *
 * The rule is therefore: snapshot before sending, require the message count to
 * grow, require generation to have stopped, and require two consecutive polls
 * to agree on the text. Only then is the text treated as the answer.
 *
 * @module @desktop-agent/llm-deepseek-web/transport
 */
import { LlmError } from './protocol.js'
import { FAILURE } from './failures.js'
import type { PageProbe, WebPage } from './page.js'

/** Tunables for one wait. */
export interface TransportConfig {
  /** Delay between polls. */
  readonly pollMs: number
  /** How long two identical non-generating polls must agree before the answer is trusted. */
  readonly settleMs: number
  /** Upper bound on the whole send-and-wait, so a stuck page cannot hang a turn. */
  readonly timeoutMs: number
}

/** Defaults sized for a reasoning model on a slow connection. */
export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  pollMs: 250,
  settleMs: 1_200,
  timeoutMs: 10 * 60 * 1_000,
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts.
 *
 * Aborting does not reject: the caller's loop re-checks the signal, so a
 * cancellation surfaces through one code path instead of two.
 * @param ms - delay in milliseconds.
 * @param signal - optional cancellation.
 * @returns a promise that settles either way.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Drive one page through one request.
 *
 * The page is looked up per call by the caller, so a replaced view is picked up
 * without re-mounting the plugin.
 */
export class PageTransport {
  readonly #page: WebPage
  readonly #config: TransportConfig

  /**
   * @param page - the page to drive.
   * @param config - overrides for {@link DEFAULT_TRANSPORT_CONFIG}.
   */
  constructor(page: WebPage, config: Partial<TransportConfig> = {}) {
    this.#page = page
    this.#config = { ...DEFAULT_TRANSPORT_CONFIG, ...config }
  }

  /**
   * Read the page without sending anything.
   * @returns the current probe.
   */
  async status(): Promise<PageProbe> {
    try {
      return await this.#page.probe()
    } catch (error) {
      throw new LlmError(
        `deepseek-web: reading the page failed (${describe(error)})`,
        FAILURE.PAGE_ERROR,
        { cause: error },
      )
    }
  }

  /**
   * Submit one prompt and wait for its answer.
   * @param prompt - the complete prompt text.
   * @param signal - cancellation; a cancelled wait presses the page's stop control.
   * @returns the answer text, once a new settled message has been observed.
   * @throws LlmError with a {@link FAILURE} code.
   */
  async ask(prompt: string, signal?: AbortSignal): Promise<string> {
    const before = await this.status()
    if (!before.ready) {
      throw new LlmError(
        'deepseek-web: the page is not ready — sign in and leave the composer visible',
        FAILURE.NOT_READY,
      )
    }

    try {
      await this.#page.send(prompt)
    } catch (error) {
      throw new LlmError(
        `deepseek-web: submitting the prompt failed (${describe(error)})`,
        FAILURE.SEND_FAILED,
        { cause: error },
      )
    }

    const deadline = Date.now() + this.#config.timeoutMs
    let candidate: string | undefined
    let stableSince = 0
    /** Whether a message beyond the pre-send snapshot has been seen at all. */
    let sawNew = false

    for (;;) {
      if (signal?.aborted === true) {
        await this.#stopQuietly()
        throw new LlmError('deepseek-web: the request was cancelled', FAILURE.TIMEOUT)
      }
      if (Date.now() > deadline) {
        await this.#stopQuietly()
        // Two different problems, two different diagnoses: the page never
        // produced a message (prompt not accepted) versus it produced one that
        // never stopped moving (still generating, or a stuck stream).
        throw new LlmError(
          sawNew
            ? `deepseek-web: the answer never settled within ${String(this.#config.timeoutMs)}ms`
            : `deepseek-web: the page produced no new message within ${String(this.#config.timeoutMs)}ms`,
          sawNew ? FAILURE.TIMEOUT : FAILURE.NO_ANSWER,
        )
      }

      const probe = await this.status()
      // Growth, not "a message exists": the page already had messages before
      // this request, and reusing one of them would answer the wrong question.
      const isNew = probe.messageCount > before.messageCount
      const settled = !probe.generating && probe.lastText.trim().length > 0
      if (isNew) sawNew = true

      if (isNew && settled) {
        if (candidate !== probe.lastText) {
          candidate = probe.lastText
          stableSince = Date.now()
        } else if (Date.now() - stableSince >= this.#config.settleMs) {
          return candidate
        }
      } else {
        // Generation restarted, or the page rewrote the message: start over
        // rather than trusting a text that was still moving.
        candidate = undefined
      }

      await sleep(this.#config.pollMs, signal)
    }
  }

  /**
   * Press stop, ignoring the failures of a page that is already idle.
   * @returns a promise that resolves once the attempt has been made.
   */
  async #stopQuietly(): Promise<void> {
    try {
      await this.#page.stop()
    } catch {
      // Stopping is best-effort: the caller is already on the error path.
    }
  }
}

/**
 * Reduce a thrown value to a short diagnostic without leaking page text.
 * @param error - the caught value.
 * @returns the error message, or the value's type when it is not an Error.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : typeof error
}
