/**
 * Turning a page answer into a reply object.
 *
 * Web models wrap JSON in prose, in code fences, or in both, and the wrapping
 * varies run to run for the same prompt. So the parser is a candidate scan, not
 * a single regex: it collects every plausible JSON object, tries each, and
 * accepts the first one that has the reply shape. Anything else is reported as
 * invalid — never coerced — because a mis-read answer would silently drive
 * tools with the wrong arguments.
 *
 * @module @desktop-agent/llm-web-page/parse
 */

/** One tool call the page asked for. */
export interface ParsedCall {
  /** Tool name, as the page wrote it. */
  readonly name: string
  /** Arguments object, already decoded from JSON when the page sent a string. */
  readonly arguments: Record<string, unknown>
}

/** The outcome of reading one page answer. */
export type ParsedAnswer =
  | { readonly kind: 'answer'; readonly text: string; readonly calls: readonly ParsedCall[] }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Collect the bodies of ```-fenced blocks, last block first.
 *
 * Last-first because a model that first shows an example and then answers puts
 * the real answer at the end.
 * @param text - the raw page answer.
 * @returns fenced bodies in the order worth trying.
 */
function fencedBodies(text: string): string[] {
  const bodies: string[] = []
  const fence = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]
    if (body !== undefined && body.trim().length > 0) bodies.push(body.trim())
  }
  return bodies.reverse()
}

/**
 * Collect every balanced `{...}` run in the text, ignoring braces inside strings.
 *
 * Only top-level runs are returned: an inner object is always reachable as a
 * candidate of its own only if the outer one failed to parse, which cannot
 * happen for well-formed JSON.
 * @param text - the raw page answer.
 * @returns balanced brace runs, in document order.
 */
function balancedObjects(text: string): string[] {
  const found: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, index + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return found
}

/**
 * Decode one call entry.
 * @param value - an element of the reply's `calls` array.
 * @returns the call, or `undefined` when it does not have the shape.
 */
function decodeCall(value: unknown): ParsedCall | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || name.trim().length === 0) return undefined
  const raw = record.arguments
  if (raw === undefined) return { name: name.trim(), arguments: {} }
  if (typeof raw === 'string') {
    try {
      const decoded: unknown = JSON.parse(raw)
      if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
        return { name: name.trim(), arguments: decoded as Record<string, unknown> }
      }
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return { name: name.trim(), arguments: raw as Record<string, unknown> }
  }
  return undefined
}

/**
 * Read one candidate object as a reply.
 * @param value - a parsed JSON value.
 * @returns the reply, or `undefined` when the object is not a reply.
 */
function decodeReply(value: unknown): ParsedAnswer | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>

  const rawText = record.text
  const text = typeof rawText === 'string' ? rawText : ''

  const calls: ParsedCall[] = []
  const rawCalls = record.calls
  if (rawCalls !== undefined) {
    if (!Array.isArray(rawCalls)) return undefined
    for (const entry of rawCalls) {
      const call = decodeCall(entry)
      if (call === undefined) return undefined
      calls.push(call)
    }
  } else if (record.name !== undefined) {
    // A page that answered with one bare call instead of the envelope.
    const call = decodeCall(record)
    if (call === undefined) return undefined
    calls.push(call)
  }

  if (text.trim().length === 0 && calls.length === 0) return undefined
  return { kind: 'answer', text, calls }
}

/**
 * Read the reply object out of a raw page answer.
 * @param raw - the complete text the page produced.
 * @returns a decoded answer, or the reason no reply could be read.
 */
export function parseAnswer(raw: string): ParsedAnswer {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: 'invalid', reason: 'the page returned no text' }

  const candidates = [...fencedBodies(trimmed), ...balancedObjects(trimmed)]
  let sawJson = false
  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    sawJson = true
    const reply = decodeReply(value)
    if (reply !== undefined) return reply
  }

  return {
    kind: 'invalid',
    reason: sawJson
      ? 'the page returned JSON that is not a reply object (needs "text" and/or "calls")'
      : 'the page returned no JSON object',
  }
}
