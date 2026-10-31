/**
 * The adapter: harness request in, harness chunks out.
 *
 * It owns no page and no DOM. It resolves the page per request (so a replaced
 * view is picked up without remounting), flattens the request into one prompt,
 * waits for an answer that is provably new, and translates that answer into the
 * protocol. Everything hard lives next door: {@link PageTransport} decides
 * *which* text is the answer, {@link parseAnswer} decides what it means,
 * {@link answerChunks} decides how it is framed.
 *
 * @module @desktop-agent/llm-deepseek-web/adapter
 */
import { LlmAdapter, LlmError, toolCallId } from './protocol.js'
import type {
  GenerateOptions,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolCallId,
} from './protocol.js'
import { abortedChunk, answerChunks, failureChunk } from './chunks.js'
import { FAILURE } from './failures.js'
import type { WebPage } from './page.js'
import { parseAnswer } from './parse.js'
import { buildWebPrompt } from './prompt.js'
import { PageTransport, type TransportConfig } from './transport.js'

/** Construction facts for one adapter instance. */
export interface DeepSeekWebAdapterOptions {
  /** Provider route this adapter owns; the harness selects it by this name. */
  readonly provider: string
  /** Model id advertised for the route. The page has one model, so this is a label. */
  readonly model: string
  /** Human-readable provider name for selectors. */
  readonly providerName?: string
  /** Resolve the page to drive, per request. `undefined` fails the request with `NO_PAGE`. */
  readonly resolvePage: () => WebPage | undefined
  /** Transport tunables. */
  readonly transport?: Partial<TransportConfig>
}

/**
 * Reduce a thrown value to provider-neutral failure facts.
 * @param error - the caught value.
 * @returns `LlmError.failure` when available, otherwise a transport failure.
 */
function toFailure(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  return {
    message: error instanceof Error ? error.message : `non-error value thrown: ${typeof error}`,
    code: 'TRANSPORT',
  }
}

/** DeepSeek web-page route for the harness LLM seam. */
export class DeepSeekWebAdapter extends LlmAdapter {
  readonly #options: DeepSeekWebAdapterOptions
  /** Monotonic suffix so two calls in one millisecond stay distinct. */
  #calls = 0

  /**
   * @param options - construction facts; see {@link DeepSeekWebAdapterOptions}.
   */
  constructor(options: DeepSeekWebAdapterOptions) {
    super()
    this.#options = options
  }

  /**
   * {@inheritDoc LlmAdapter.providerInfo}
   * @param provider - the route passed to `registerAdapter()`.
   */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.#options.providerName ?? 'DeepSeek (web)' }
  }

  /**
   * Advertise the single model this route offers.
   *
   * The page has no catalogue: the model is whatever the signed-in account is
   * set to. Advertising one stable id keeps the GUI able to select the route
   * without implying a model list we cannot enumerate.
   * @param provider - the route passed to `registerAdapter()`.
   */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: this.#options.model, name: this.#options.model }])
  }

  /**
   * {@inheritDoc LlmAdapter.resolveModel}
   *
   * No context window or output cap is declared: the page does not publish
   * either, and guessing would let the harness plan a request the page cannot
   * accept. Absent means unknown, which callers already handle.
   * @param provider - the route passed to `registerAdapter()`.
   * @param model - the requested model id.
   */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * {@inheritDoc LlmAdapter.stream}
   * @param options - the fully assembled request.
   */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const page = this.#options.resolvePage()
    if (page === undefined) {
      yield failureChunk({
        message: 'deepseek-web: no page is registered; the shell has not attached a view yet',
        code: FAILURE.NO_PAGE,
      })
      return
    }

    const transport = new PageTransport(page, this.#options.transport)

    let raw: string
    try {
      raw = await transport.ask(buildWebPrompt(options), options.signal)
    } catch (error) {
      const failure = toFailure(error)
      if (options.signal?.aborted === true) {
        yield abortedChunk({ ...failure, code: 'ABORTED' })
      } else {
        yield failureChunk(failure)
      }
      return
    }

    const parsed = parseAnswer(raw)
    if (parsed.kind === 'invalid') {
      yield failureChunk({ message: `deepseek-web: ${parsed.reason}`, code: FAILURE.PROTOCOL })
      return
    }

    for (const chunk of answerChunks(parsed, () => this.#nextCallId())) yield chunk
  }

  /**
   * Allocate one tool-call identity.
   *
   * Provider-issued in a real adapter; here it is synthesized, so it only has
   * to be unique within the session and stable across the delta and the block.
   * @returns a fresh branded id.
   */
  #nextCallId(): ToolCallId {
    this.#calls += 1
    return toolCallId(`deepseek-web-${Date.now().toString(36)}-${String(this.#calls)}`)
  }
}
