/**
 * Building the `StreamChunk` sequence for one answer.
 *
 * The protocol's ordering rules are the whole point of this module, so they are
 * stated once here rather than scattered through the adapter:
 *
 * - every block is `block-start` → deltas → `block-end`, sharing one index;
 * - block indices start at 0 and increase by one;
 * - a tool call's `arguments` on the closing block is the same raw JSON string
 *   its delta carried, because the assembler concatenates deltas and compares;
 * - nothing follows the terminal `finish`.
 *
 * @module @desktop-agent/llm-web-page/chunks
 */
import { toolCallId } from './protocol.js'
import type { LlmFailure, StreamChunk, ToolCallId } from './protocol.js'
import type { ParsedAnswer, ParsedCall } from './parse.js'

/**
 * Build the chunks for one visible text block.
 * @param index - the block index to claim.
 * @param text - the visible answer text.
 * @returns the three chunks that open, fill, and close the block.
 */
function textChunks(index: number, text: string): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

/**
 * Build the chunks for one tool call.
 *
 * The page answers with a complete arguments object, so the delta carries the
 * whole serialization at once. That is legal — the protocol asks for argument
 * *fragments*, and one fragment covering everything is a degenerate split — but
 * it means `text-delta`-style incremental rendering of a call will show the
 * whole call at once. Documented as a channel limitation, not a bug here.
 * @param index - the block index to claim.
 * @param call - the decoded call.
 * @param id - the call identity to correlate the result with.
 * @returns the three chunks that open, fill, and close the block.
 */
function callChunks(index: number, call: ParsedCall, id: ToolCallId): StreamChunk[] {
  const args = JSON.stringify(call.arguments)
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } },
  ]
}

/**
 * Translate one decoded answer into its complete chunk sequence.
 * @param answer - a successfully parsed reply.
 * @param nextCallId - allocates a call identity per tool call, in order.
 * @returns the chunks, ending with the terminal `finish`.
 */
export function answerChunks(
  answer: Extract<ParsedAnswer, { kind: 'answer' }>,
  nextCallId: () => ToolCallId,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let index = 0
  if (answer.text.trim().length > 0) {
    chunks.push(...textChunks(index, answer.text))
    index += 1
  }
  for (const call of answer.calls) {
    chunks.push(...callChunks(index, call, nextCallId()))
    index += 1
  }
  chunks.push({
    type: 'finish',
    reason: { kind: answer.calls.length > 0 ? 'tool-calls' : 'stop' },
  })
  return chunks
}

/**
 * Build the one-chunk stream that reports a failed attempt.
 *
 * No `usage` is emitted: the page exposes no token accounting, and inventing
 * numbers would corrupt the token meter rather than leave it uninformed.
 * @param failure - provider-neutral failure facts.
 * @returns the terminal chunk.
 */
export function failureChunk(failure: LlmFailure): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/**
 * Build the one-chunk stream that reports a cancelled attempt.
 * @param failure - provider-neutral failure facts describing the cancellation.
 * @returns the terminal chunk.
 */
export function abortedChunk(failure: LlmFailure): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure } }
}
