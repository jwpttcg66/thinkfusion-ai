/**
 * Our own model-call vocabulary.
 *
 * The *design* here is borrowed from DeepSeek Harness's public LLM seam
 * (`@deepseek-ai/dsh-llm`, MIT): the same block tags, the same chunk kinds, the
 * same "provider-neutral contract, adapters own the wire" split, the same
 * "tool arguments stay a raw JSON string" rule. Reading that code is what told
 * us which shapes survive contact with a real agent loop.
 *
 * The *code* is ours. There is no import from `@deepseek-ai/*` anywhere in this
 * package and no entry in `dependencies` or `peerDependencies`, so:
 *
 * - nothing here breaks when dsh ships a breaking change (it says it will);
 * - we can change a field without forking a monorepo;
 * - the shapes still match, so a host that speaks dsh's vocabulary can adopt
 *   this adapter through a thin bridge instead of a rewrite.
 *
 * Where we deliberately keep a *subset*: no retry policy, no image pricing, no
 * `prepareCall` generation binding. We have no use for them, and copying
 * machinery we never exercise is how a "borrowed design" turns into an
 * unmaintained fork.
 *
 * @module @desktop-agent/llm-deepseek-web/protocol
 */

declare const TOOL_CALL_BRAND: unique symbol

/**
 * Correlates a model-issued tool call with its result.
 *
 * A brand, not a plain string: a message id must not be passable where a call
 * id is expected, and the brand costs nothing at runtime.
 */
export type ToolCallId = string & { readonly [TOOL_CALL_BRAND]: 'ToolCallId' }

/**
 * Brand a string as a tool-call identity.
 * @param value - the provider-issued or synthesized id.
 * @returns the same string, branded.
 */
export function toolCallId(value: string): ToolCallId {
  return value as ToolCallId
}

/** Every block tag the vocabulary knows. */
export type ContentBlockType =
  | 'text'
  | 'reasoning'
  | 'image'
  | 'file'
  | 'tool-call'
  | 'tool-addition'
  | 'tool-removal'

/** Visible text. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Thinking content, kept distinct from visible text so a UI can collapse it. */
export interface ReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
}

/** A model-issued tool call. */
export interface ToolCallBlock {
  readonly type: 'tool-call'
  /** Correlates with the matching tool-result message. */
  readonly id: ToolCallId
  readonly name: string
  /**
   * Raw JSON string exactly as the model produced it.
   *
   * A string, not a parsed object: the assembler concatenates argument deltas
   * and must be able to compare the result to this field byte for byte.
   */
  readonly arguments: string
}

/** A raster image reference. Opaque here: this channel never sends image bytes. */
export interface ImageBlock {
  readonly type: 'image'
  readonly attachment: unknown
}

/** A file reference. Opaque here, for the same reason. */
export interface FileBlock {
  readonly type: 'file'
  readonly attachment: unknown
}

/** Activates a tool declaration recorded earlier in the conversation. */
export interface ToolAdditionBlock {
  readonly type: 'tool-addition'
  readonly toolName: string
}

/** Retires a previously declared tool. */
export interface ToolRemovalBlock {
  readonly type: 'tool-removal'
  readonly toolName: string
}

/** Any content block; switch on `type`. */
export type ContentBlock =
  | TextBlock
  | ReasoningBlock
  | ImageBlock
  | FileBlock
  | ToolCallBlock
  | ToolAdditionBlock
  | ToolRemovalBlock

/** Serializable failure facts. Consumers route on `code`, never on `message`. */
export interface LlmFailure {
  readonly message: string
  /** Stable machine code, e.g. `NO_PAGE` / `PROTOCOL` / `TIMEOUT`. */
  readonly code: string
  /** HTTP status, when the failure came from a provider that has one. */
  readonly status?: number
  /** Provider-requested delay before a retry would be sensible. */
  readonly providerRetryAfterMs?: number
}

/**
 * Why a response stopped.
 *
 * An object, not a bare string: `aborted` and `error` must carry the failure,
 * and a caller switching on `kind` cannot forget to read it.
 */
export type FinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure: LlmFailure }
  | { readonly kind: 'error'; readonly failure: LlmFailure }

/** Token accounting for one call. Counts are disjoint: cached input is separate. */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** Full-call total including prompt and output, when the provider reports one. */
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/**
 * One chunk of a streamed model call.
 *
 * Ordering rules, enforced by {@link answerChunks}:
 * every block is `block-start` → deltas → `block-end` sharing one index;
 * indices start at 0 and increase by one; `usage` precedes `finish`;
 * nothing follows the terminal `finish`.
 */
export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: ContentBlockType }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id: ToolCallId
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: FinishReason }

/** A tool as the model sees it. */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  /** JSON Schema object for the arguments. */
  readonly parameters: Record<string, unknown>
}

/** Shared fields of every conversation message. */
interface MessageBase {
  readonly content: readonly ContentBlock[]
}

/** A rendered system prompt. */
export interface SystemMessage extends MessageBase {
  readonly role: 'system'
}

/** Harness bookkeeping shown to the model, currently tool additions and removals. */
export interface DeveloperMessage extends MessageBase {
  readonly role: 'developer'
}

/** User input. */
export interface UserMessage extends MessageBase {
  readonly role: 'user'
}

/** A model-produced message. */
export interface AssistantMessage extends MessageBase {
  readonly role: 'assistant'
}

/** One tool result, answering one call. */
export interface ToolResultMessage extends MessageBase {
  readonly role: 'tool'
  readonly toolCallId: ToolCallId
  readonly isError?: boolean
}

/** Any message a request can carry. */
export type RequestMessage =
  | SystemMessage
  | DeveloperMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage

/** One fully assembled model request. */
export interface GenerateOptions {
  /** Route selecting the adapter instance. */
  readonly provider: string
  readonly model: string
  /** Ordered conversation, exactly as the provider sees it. */
  readonly messages: RequestMessage[]
  /** System text for one-shot callers; a loop-built request carries it as a leading message instead. */
  readonly system?: string
  /** Active tool declarations. */
  readonly tools?: ToolSchema[]
  readonly temperature?: number
  readonly maxTokens?: number
  /** Halt as soon as the model produces any of these strings. */
  readonly stop?: string[]
  /** Cancellation. Implementations must honour it. */
  readonly signal?: AbortSignal
}

/** Display metadata for one provider route. */
export interface LlmProviderInfo {
  /** Route key, equal to the name passed to the registry. */
  readonly id: string
  /** Human-readable name for selectors and diagnostics. */
  readonly name: string
}

/** One model an adapter advertises. */
export interface LlmModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  /** Accepted input modalities; absent means unknown. */
  readonly inputModalities?: readonly ('text' | 'image')[]
}

/**
 * Everything an adapter can say about one exact model.
 *
 * Absent means unknown, which callers already handle — so an adapter that knows
 * nothing (like this one) omits every optional field rather than guessing.
 */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Output cap to materialize when the caller omits one. */
  readonly defaultMaxTokens?: number
}

/**
 * Typed model-call error carrying its own serializable facts.
 *
 * Adapters throw it; the streaming boundary turns it into a terminal `finish`
 * chunk so a consumer never has to parse a message to decide what happened.
 */
export class LlmError extends Error {
  /** Stable machine code, mirrored onto the error itself so a catch can route on it directly. */
  readonly code: string
  /** Serializable facts retained beside this live error. */
  readonly failure: LlmFailure

  /**
   * @param message - non-empty human-readable summary.
   * @param code - stable machine code.
   * @param options - optional cause for the stack trace.
   */
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined)
    this.name = 'LlmError'
    this.code = code
    this.failure = { message, code }
  }
}

/**
 * The provider-wire adapter contract.
 *
 * Only `stream()` is required. Everything else has a default that says "this
 * route knows nothing extra", which is the honest answer for a web page.
 */
export abstract class LlmAdapter {
  /**
   * Describe one owned route.
   * @param provider - a route passed to the registry.
   * @returns display metadata whose id equals `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * List the models this adapter can advertise for one route.
   * @param _provider - an owned route.
   * @returns discoverable models, adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve metadata for one exact model id.
   * @param provider - an owned route.
   * @param model - the requested model id.
   * @returns provider/model identity plus any known capabilities.
   */
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Stream one model call as chunks.
   * @param options - the fully assembled request.
   * @returns the chunk stream, obeying the ordering rules on {@link StreamChunk}.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
