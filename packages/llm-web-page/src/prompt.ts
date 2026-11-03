/**
 * Flattening a harness request into one web-chat prompt.
 *
 * The web page has no system slot, no tool channel, and no per-message roles:
 * it receives one block of text and answers with one block of text. Everything
 * the harness expresses structurally therefore has to be spelled out in prose
 * here, including the reply contract the parser later depends on.
 *
 * @module @desktop-agent/llm-web-page/prompt
 */
import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from './protocol.js'

/** The single JSON object the page is asked to answer with. */
export interface ReplyContract {
  /** Visible answer text; omit when the reply is only tool calls. */
  readonly text?: string
  /** Tool calls to run, in order. */
  readonly calls?: readonly {
    readonly name: string
    /** Arguments object matching the tool's JSON Schema. */
    readonly arguments: Record<string, unknown>
  }[]
}

const REPLY_CONTRACT = `Reply with exactly one JSON object and nothing else — no prose before it, no explanation after it, no markdown fence. The object has two optional fields:

{"text": "<your visible answer, or omit>", "calls": [{"name": "<tool name>", "arguments": { ... }}]}

Rules:
- Use "calls" only with tool names listed above, and make "arguments" satisfy that tool's JSON Schema exactly.
- Put any user-facing prose in "text". Omit "text" when you are only calling tools.
- When the work is finished and nothing is left to call, reply with {"text": "<summary>"} and no "calls".
- Never invent a tool name. Never wrap the object in a code fence.`

/**
 * Render one content block as transcript text.
 * @param block - a model-visible content block.
 * @returns a single-line-or-multiline rendering, never empty.
 */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `[reasoning] ${block.text}`
    case 'image':
      return '[image omitted: this channel is text-only]'
    case 'file':
      return '[file reference omitted: this channel is text-only]'
    case 'tool-call':
      return `[called ${block.name} with ${block.arguments}]`
    case 'tool-addition':
      return `[tool available: ${block.toolName}]`
    case 'tool-removal':
      return `[tool removed: ${block.toolName}]`
    default: {
      const unreachable: never = block
      return `[unrenderable block ${JSON.stringify(unreachable)}]`
    }
  }
}

/**
 * Render one message with a role label the page can follow.
 * @param message - a durable message or a request-only user input.
 * @returns the labelled transcript entry.
 */
function renderMessage(message: RequestMessage): string {
  const body = message.content.map(renderBlock).join('\n').trim()
  switch (message.role) {
    case 'system':
      return `### System\n${body}`
    case 'developer':
      return `### Harness update\n${body}`
    case 'user':
      return `### User\n${body}`
    case 'assistant':
      return `### Assistant\n${body}`
    case 'tool': {
      const status = message.isError === true ? 'failed' : 'succeeded'
      return `### Tool result (${status})\n${body}`
    }
    default: {
      const unreachable: never = message
      return `### Unknown role\n${JSON.stringify(unreachable)}`
    }
  }
}

/**
 * Render the tool catalogue the page must choose from.
 * @param tools - active tool schemas, or `undefined` when the request has none.
 * @returns the catalogue section, or `''` when there is nothing to declare.
 */
function renderTools(tools: readonly ToolSchema[] | undefined): string {
  if (tools === undefined || tools.length === 0) return ''
  const entries = tools.map(tool => JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }, null, 2))
  return `## Tools you may call\n\n${entries.join('\n\n')}`
}

/**
 * Build the single prompt sent to the web page for one harness request.
 *
 * The contract is stated before the transcript and again after it: a web model
 * reading a long transcript drifts toward answering conversationally, and the
 * parser rejects a conversational answer rather than guessing at its intent.
 * @param options - the fully assembled harness request.
 * @returns the prompt text to submit.
 */
export function buildWebPrompt(options: GenerateOptions): string {
  const sections: string[] = [
    'You are answering inside a local desktop agent harness. This chat page is being used as the model channel:',
    'you cannot run tools yourself, and anything you want executed must be requested through the reply object below.',
  ]

  // System text arrives two ways: `options.system` from a hand-built one-shot,
  // and a leading system-role message from the loop's derived history. Both are
  // hoisted above the transcript — a system prompt sitting mid-conversation is
  // exactly the thing a web model skims past.
  const systemParts: string[] = []
  if (options.system !== undefined && options.system.trim().length > 0) {
    systemParts.push(options.system.trim())
  }
  const transcriptMessages: RequestMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      const body = message.content.map(renderBlock).join('\n').trim()
      if (body.length > 0) systemParts.push(body)
      continue
    }
    transcriptMessages.push(message)
  }
  if (systemParts.length > 0) {
    sections.push(`## System instructions\n\n${systemParts.join('\n\n')}`)
  }

  const tools = renderTools(options.tools)
  if (tools.length > 0) sections.push(tools)

  sections.push(`## Reply contract\n\n${REPLY_CONTRACT}`)

  const transcript = transcriptMessages.map(renderMessage).join('\n\n')
  sections.push(`## Conversation\n\n${transcript}`)

  sections.push(`## Now\n\nAnswer the last message above. Reply with exactly one JSON object and nothing else.`)

  return sections.join('\n\n')
}
