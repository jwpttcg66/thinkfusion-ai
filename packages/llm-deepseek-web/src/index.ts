/**
 * Plugin entry: register the DeepSeek web route with the model-call registry.
 *
 * The host contract is ours (`./host.ts`), three members wide. No plugin
 * framework is imported and none is required: if a host already speaks a
 * different registry shape, the bridge is a few lines, not a dependency.
 *
 * ```ts
 * import { apply, registerPage } from '@desktop-agent/llm-deepseek-web'
 *
 * registerPage('deepseek-web', viewPage)
 * apply({ llm: registry }, { provider: 'deepseek-web', model: 'deepseek-chat' })
 * ```
 *
 * The page may be published before or after `apply()`: it is resolved per
 * request, so an early request fails with `NO_PAGE` and later ones work.
 *
 * @module @desktop-agent/llm-deepseek-web
 */
import { DeepSeekWebAdapter } from './adapter.js'
import type { PluginContext } from './host.js'
import { DEFAULT_PAGE_NAME, resolvePage } from './registry.js'
import type { TransportConfig } from './transport.js'

export const name = 'llm-deepseek-web'
export const inject = ['llm']

/** YAML configuration accepted by {@link apply}. */
export interface PluginConfig {
  /** Provider route to own. Defaults to `deepseek-web`. */
  readonly provider?: string
  /** Model id to advertise. Defaults to `deepseek-chat` — a label, not a page setting. */
  readonly model?: string
  /** Name the shell registered its page under. Defaults to `deepseek-web`. */
  readonly pageName?: string
  /** Delay between page polls, in milliseconds. */
  readonly pollMs?: number
  /** How long two identical settled polls must agree, in milliseconds. */
  readonly settleMs?: number
  /** Upper bound on one send-and-wait, in milliseconds. */
  readonly timeoutMs?: number
}

/**
 * Reject a configuration that cannot work, before any request is served.
 * @param config - the raw plugin configuration.
 * @returns the route and page names it resolved to.
 * @throws Error naming the offending field.
 */
function validate(config: PluginConfig): { provider: string; model: string; pageName: string } {
  const provider = config.provider ?? 'deepseek-web'
  const model = config.model ?? 'deepseek-chat'
  const pageName = config.pageName ?? DEFAULT_PAGE_NAME
  if (provider.trim().length === 0) throw new Error('llm-deepseek-web: config.provider must not be empty')
  if (model.trim().length === 0) throw new Error('llm-deepseek-web: config.model must not be empty')
  if (pageName.trim().length === 0) throw new Error('llm-deepseek-web: config.pageName must not be empty')
  return { provider, model, pageName }
}

/**
 * Build the transport overrides the configuration actually set.
 *
 * Built by assignment rather than by spreading an object with `undefined`
 * values: an explicit `undefined` would override a default with nothing.
 * @param config - the raw plugin configuration.
 * @returns only the tunables the caller set.
 */
function transportOf(config: PluginConfig): Partial<TransportConfig> {
  const transport: { pollMs?: number; settleMs?: number; timeoutMs?: number } = {}
  const fields = ['pollMs', 'settleMs', 'timeoutMs'] as const
  for (const field of fields) {
    const value = config[field]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`llm-deepseek-web: config.${field} must be a positive number`)
    }
    transport[field] = value
  }
  return transport
}

/**
 * Mount the route.
 * @param ctx - host context carrying the model-call registry.
 * @param config - plugin configuration; see {@link PluginConfig}.
 */
export function apply(ctx: PluginContext, config: PluginConfig = {}): void {
  const { provider, model, pageName } = validate(config)
  const adapter = new DeepSeekWebAdapter({
    provider,
    model,
    providerName: 'DeepSeek (web)',
    resolvePage: () => resolvePage(pageName),
    transport: transportOf(config),
  })
  ctx.llm.registerAdapter([provider], adapter)
}

export { DeepSeekWebAdapter } from './adapter.js'
export type { DeepSeekWebAdapterOptions } from './adapter.js'
export { FAILURE } from './failures.js'
export type { FailureCode } from './failures.js'
export type { AdapterRegistrationHandle, LlmRegistry, PluginContext, PluginLogger } from './host.js'
export { InMemoryLlmRegistry } from './llm-registry.js'
export type { PageProbe, WebPage } from './page.js'
export { DEFAULT_PAGE_NAME, registerPage, resolvePage, unregisterPage } from './registry.js'
export { parseAnswer } from './parse.js'
export type { ParsedAnswer, ParsedCall } from './parse.js'
export { answerChunks, failureChunk, abortedChunk } from './chunks.js'
export { buildWebPrompt } from './prompt.js'
export type { ReplyContract } from './prompt.js'
export {
  LlmAdapter,
  LlmError,
  toolCallId,
} from './protocol.js'
export type {
  AssistantMessage,
  ContentBlock,
  ContentBlockType,
  DeveloperMessage,
  FinishReason,
  GenerateOptions,
  ImageBlock,
  LlmFailure,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningBlock,
  RequestMessage,
  StreamChunk,
  SystemMessage,
  TextBlock,
  TokenUsage,
  ToolAdditionBlock,
  ToolCallBlock,
  ToolCallId,
  ToolRemovalBlock,
  ToolResultMessage,
  ToolSchema,
  UserMessage,
  FileBlock,
} from './protocol.js'
export { DEFAULT_TRANSPORT_CONFIG, PageTransport } from './transport.js'
export type { TransportConfig } from './transport.js'
