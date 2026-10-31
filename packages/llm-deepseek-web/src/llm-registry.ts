/**
 * A registry and dispatcher for adapters, in about a hundred lines.
 *
 * This exists so the plugin can be exercised end to end without a framework:
 * register an adapter, call `stream()`, read chunks. It is not a stub — route
 * ownership, duplicate detection, atomic replacement and the `NO_ADAPTER`
 * failure are all real, because those are exactly the behaviours a caller
 * depends on when more than one adapter is mounted.
 *
 * What it deliberately does not do: retry policy, model discovery caching,
 * configuration surfaces, generation pinning. Those are host concerns; adding
 * them here would turn a registry into a framework.
 *
 * @module @desktop-agent/llm-deepseek-web/llm-registry
 */
import type { AdapterRegistrationHandle, LlmRegistry } from './host.js'
import { LlmError } from './protocol.js'
import type { GenerateOptions, LlmAdapter, StreamChunk } from './protocol.js'

/** In-memory adapter registry with provider dispatch. */
export class InMemoryLlmRegistry implements LlmRegistry {
  /** Route → the adapter that owns it. */
  readonly #routes = new Map<string, LlmAdapter>()

  /**
   * Register an adapter for one or more routes.
   * @param providers - route names the adapter serves.
   * @param adapter - the implementation.
   * @returns a handle that releases or replaces these routes.
   * @throws Error when a route is already owned by a *different* adapter.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
    this.#validate(providers, adapter, false)
    for (const provider of providers) this.#routes.set(provider, adapter)

    const handle = (): void => {
      for (const provider of providers) {
        if (this.#routes.get(provider) === adapter) this.#routes.delete(provider)
      }
    }

    handle.replace = (next: string[]): void => {
      // An empty set is legal here — a configuration that emptied holds zero
      // routes while staying registered — but not as an initial registration.
      // Validate the whole candidate set before touching anything: a refused
      // replacement must leave the previous routes serving.
      this.#validate(next, adapter, true)
      for (const provider of [...this.#routes.keys()]) {
        if (this.#routes.get(provider) === adapter && !next.includes(provider)) {
          this.#routes.delete(provider)
        }
      }
      for (const provider of next) this.#routes.set(provider, adapter)
    }

    return handle
  }

  /**
   * Look up the adapter serving one route.
   * @param provider - the route name.
   * @returns the adapter, or `undefined` when nothing owns the route.
   */
  adapterFor(provider: string): LlmAdapter | undefined {
    return this.#routes.get(provider)
  }

  /**
   * List owned routes, in registration order.
   * @returns the route names.
   */
  listProviders(): string[] {
    return [...this.#routes.keys()]
  }

  /**
   * Dispatch one model call.
   * @param options - the assembled request; `options.provider` selects the adapter.
   * @returns the adapter's chunk stream.
   * @throws LlmError with code `NO_ADAPTER` when no adapter owns the route.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const adapter = this.#routes.get(options.provider)
    if (adapter === undefined) {
      throw new LlmError(
        `no adapter is registered for provider route "${options.provider}"`,
        'NO_ADAPTER',
      )
    }
    return adapter.stream(options)
  }

  /**
   * Validate a candidate route set without mutating anything.
   * @param providers - the routes being claimed.
   * @param adapter - the adapter claiming them.
   * @param allowEmpty - whether a zero-route set is acceptable (replacement) or not (registration).
   * @throws Error naming the first route owned by someone else.
   */
  #validate(providers: string[], adapter: LlmAdapter, allowEmpty: boolean): void {
    if (providers.length === 0 && !allowEmpty) {
      throw new Error('registerAdapter needs at least one provider route')
    }
    for (const provider of providers) {
      if (provider.trim().length === 0) throw new Error('provider routes must not be empty')
      const owner = this.#routes.get(provider)
      if (owner !== undefined && owner !== adapter) {
        throw new Error(`provider route "${provider}" is already owned by another adapter`)
      }
    }
  }
}
