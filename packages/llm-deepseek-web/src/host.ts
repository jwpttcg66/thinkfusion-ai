/**
 * The plugin host contract.
 *
 * This is the boundary between "a plugin" and "whatever is running it". We own
 * both sides, so it is three members wide — a registry to register on, and a
 * logger. Nothing here is imported from a plugin framework: the shape is
 * small enough that adopting a framework later is a bridge of a few lines,
 * and shipping one now would be a dependency we cannot justify.
 *
 * @module @desktop-agent/llm-deepseek-web/host
 */
import type { LlmAdapter } from './protocol.js'

/** What registering a set of routes returns. */
export interface AdapterRegistrationHandle {
  /** Release every route this registration holds. */
  (): void
  /**
   * Swap this registration's routes, keeping the same adapter instance.
   * @param providers - the complete new route set.
   */
  replace(providers: string[]): void
}

/** The model-call registry a plugin registers adapters on. */
export interface LlmRegistry {
  /**
   * Register an adapter for one or more routes.
   * @param providers - route names; the adapter serves all of them.
   * @param adapter - the implementation.
   * @returns a handle that can release or replace the routes.
   * @throws Error when a route is already owned by another registration.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
}

/** Diagnostics sink. Optional: a host may have nowhere to log. */
export interface PluginLogger {
  info(message: string): void
  warn(message: string): void
}

/** Everything a plugin may touch on its host. */
export interface PluginContext {
  readonly llm: LlmRegistry
  readonly logger?: PluginLogger
}
