import {
  PROTOCOL,
  PlanSchema,
  ClarificationSchema,
  TaskCompleteSchema,
  TOOL_NAMES,
  type AgentPlan,
  type ExecutionReport,
  type PermissionPreset
} from './contracts';

/**
 * Protocol parsing and prompt construction.
 *
 * Deliberately free of Electron and Node APIs so the exact same logic can be
 * unit tested without launching the app.
 */

export type ParseResult =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'conflict'; blocks: number }
  | { kind: 'plan'; plan: AgentPlan }
  | { kind: 'clarification'; questions: string[] }
  | { kind: 'complete'; summary: string };

interface Candidate {
  raw: string;
  value: unknown;
}

/**
 * Find the end of the JSON object starting at `start`, ignoring braces that
 * appear inside string literals.
 * @returns index of the matching `}`, or -1 when the object never closes.
 */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/**
 * Collect every balanced `{...}` span, outermost only.
 *
 * This is what makes the channel work against a rendered chat page: the answer
 * arrives as *displayed* markdown, so the ``` fences are gone and only the JSON
 * body survives. Relying on fences alone made every real answer parse as "no
 * protocol block".
 */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start === -1) break;
    const end = matchBrace(text, start);
    if (end === -1) {
      cursor = start + 1;
      continue;
    }
    found.push(text.slice(start, end + 1));
    cursor = end + 1;
  }

  return found;
}

/**
 * Repair the two JSON mistakes models actually make.
 *
 * Raw newlines and tabs inside a string are illegal JSON but common when the
 * model writes a multi-line summary; trailing commas are the other one. Both
 * are unambiguous repairs — they cannot change the meaning of valid JSON — so
 * fixing them is safer than rejecting a plan the model clearly produced.
 */
export function repairJson(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        out += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        out += char;
        continue;
      }
      if (char === '\n') {
        out += '\\n';
        continue;
      }
      if (char === '\r') {
        out += '\\r';
        continue;
      }
      if (char === '\t') {
        out += '\\t';
        continue;
      }
      out += char;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    // Trailing comma: drop it when the next meaningful character closes a
    // container. Look ahead past whitespace only.
    if (char === ',') {
      let ahead = index + 1;
      while (ahead < raw.length && /\s/.test(raw[ahead])) ahead += 1;
      const next = raw[ahead];
      if (next === '}' || next === ']') continue;
    }

    out += char;
  }

  return out;
}

/** Pull every JSON-looking block out of an answer, in document order. */
export function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const push = (candidate: string) => {
    const body = candidate.trim();
    if (body && !blocks.includes(body)) blocks.push(body);
  };

  // 1. Fenced code blocks (```json ... ``` or ``` ... ```)
  const fence = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) push(match[1]);

  // 2. Legacy explicit wrapper
  const wrapper = /<AGENT_PLAN>\s*([\s\S]*?)\s*<\/AGENT_PLAN>/g;
  while ((match = wrapper.exec(text)) !== null) push(match[1]);

  // 3. Bare objects — the normal case for a rendered page, where the fences are
  //    presentation and never reach innerText.
  for (const candidate of balancedObjects(text)) push(candidate);

  return blocks;
}

function isProtocolMessage(value: unknown): boolean {
  return !!value && typeof value === 'object' && (value as { protocol?: unknown }).protocol === PROTOCOL;
}

/**
 * Interpret one answer.
 *
 * Returns `none` when the answer carries no protocol block at all, and
 * `invalid` when it carries something that claims to be a protocol message but
 * fails validation. Callers must treat both as "do not execute".
 */
/**
 * Remove the prompt we sent from a captured page text.
 *
 * The prompt is full of example protocol blocks — a clarification sample and a
 * completion sample, both carrying the real taskId and roundId. If the capture
 * includes the echoed user bubble, those samples parse as genuine messages and
 * the loop acts on a plan nobody approved (or ends the task on a completion
 * sample).
 *
 * The echo is one *contiguous* region — the user bubble — so it is cut as a
 * region, located by comparing whitespace-normalised text. Stripping line by
 * line was tried first and is wrong: the prompt's own JSON template contains
 * lines such as `"protocol": "desktop-agent/v1",` and `"type": "plan",` that a
 * real answer also contains, so line matching deleted the answer's own fields
 * and turned a valid plan into unparseable text.
 */
export function stripEcho(text: string, echo?: string): string {
  if (!echo || echo.length === 0) return text;
  if (echo.replace(/\s+/g, '').length < 40) return text;

  const whole = findIgnoringWhitespace(text, echo);
  if (whole) return `${text.slice(0, whole.start)}${text.slice(whole.end)}`;

  // Fallback: the page may have altered the middle of the echo (line numbers, a
  // collapsed block). Match a window at each end and cut everything between.
  const head = findIgnoringWhitespace(text, echo.slice(0, 80));
  if (!head) return text;
  const tail = findIgnoringWhitespace(text.slice(head.end), echo.slice(-80));
  if (!tail) return text;

  return `${text.slice(0, head.start)}${text.slice(head.end + tail.end)}`;
}

/**
 * Locate `needle` in `text` while ignoring every whitespace character.
 *
 * Whitespace is *dropped*, not collapsed to a space. A chat page reflows what it
 * is given: a prompt that reads "几点要求：\n1. …" comes back as "几点要求：1. …",
 * because the list item is its own block and `innerText` puts no separator
 * between the two. Collapsing to a single space inserts a character the page
 * never had, and the match fails — which is how the echo check silently stopped
 * working and a prompt was accepted as the answer.
 *
 * Returns offsets into the original string, so the caller cuts the original
 * rather than a normalised copy.
 */
export function findIgnoringWhitespace(text: string, needle: string): { start: number; end: number } | null {
  const squeezedNeedle = needle.replace(/\s+/g, '');
  if (squeezedNeedle.length === 0) return null;

  const chars: string[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) continue;
    chars.push(char);
    offsets.push(index);
  }

  const at = chars.join('').indexOf(squeezedNeedle);
  if (at === -1) return null;
  return { start: offsets[at], end: offsets[at + squeezedNeedle.length - 1] + 1 };
}

/**
 * True when the text still contains the prompt we sent.
 *
 * Used as a guard, not a repair: a candidate that is mostly our own words is not
 * an answer, and accepting it would parse the prompt's own example blocks.
 */
export function containsEcho(text: string, echo?: string): boolean {
  if (!echo) return false;
  const head = echo.slice(0, 80);
  if (head.replace(/\s+/g, '').length < 40) return false;
  return findIgnoringWhitespace(text, head) !== null;
}

export function parseAnswer(
  text: string,
  expected: { taskId: string; roundId: string },
  options: { ignoreEcho?: string } = {}
): ParseResult {
  const blocks = extractJsonBlocks(stripEcho(text, options.ignoreEcho));
  const candidates: Candidate[] = [];
  let parseFailure: string | null = null;

  for (const raw of blocks) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      try {
        value = JSON.parse(repairJson(raw));
      } catch (error) {
        // Only a block that mentions the protocol is worth reporting: prose
        // containing braces would otherwise turn into a bogus parse error.
        if (raw.includes(PROTOCOL) && parseFailure === null) {
          parseFailure = error instanceof Error ? error.message : String(error);
        }
        continue;
      }
    }
    if (isProtocolMessage(value)) candidates.push({ raw, value });
  }

  if (candidates.length === 0) {
    return parseFailure === null ? { kind: 'none' } : { kind: 'invalid', error: `协议块无法解析：${parseFailure}` };
  }

  // Multiple distinct protocol messages means the model contradicted itself.
  const unique = new Set(candidates.map(item => JSON.stringify(item.value)));
  if (unique.size > 1) return { kind: 'conflict', blocks: unique.size };

  const value = candidates[0].value as Record<string, unknown>;
  const type = value.type;

  try {
    if (type === 'plan') {
      const plan = PlanSchema.parse(value);
      if (plan.taskId !== expected.taskId) {
        return { kind: 'invalid', error: `计划 taskId 不匹配（期望 ${expected.taskId}，实际 ${plan.taskId}）` };
      }
      if (plan.roundId !== expected.roundId) {
        return { kind: 'invalid', error: `计划 roundId 不匹配（期望 ${expected.roundId}，实际 ${plan.roundId}）` };
      }
      return { kind: 'plan', plan };
    }

    if (type === 'clarification_required') {
      const message = ClarificationSchema.parse(value);
      if (message.taskId !== expected.taskId || message.roundId !== expected.roundId) {
        return { kind: 'invalid', error: '澄清请求的 taskId / roundId 不匹配' };
      }
      return { kind: 'clarification', questions: message.questions };
    }

    if (type === 'task_complete') {
      const message = TaskCompleteSchema.parse(value);
      if (message.taskId !== expected.taskId || message.roundId !== expected.roundId) {
        return { kind: 'invalid', error: '完成消息的 taskId / roundId 不匹配' };
      }
      return { kind: 'complete', summary: message.summary };
    }

    return { kind: 'invalid', error: `未知的协议 type：${String(type)}` };
  } catch (error) {
    return { kind: 'invalid', error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const PLAN_SHAPE = `{
  "protocol": "${PROTOCOL}",
  "type": "plan",
  "taskId": "<原样回填>",
  "roundId": "<原样回填>",
  "title": "计划标题",
  "description": "计划说明",
  "steps": [
    { "id": "step-1", "tool": "fs.list", "description": "说明", "args": { "path": "." } }
  ],
  "completion": { "condition": "可验证的完成条件" }
}`;

const TOOL_SPEC = `可用工具（只能使用这些，args 必须严格匹配）：
- fs.list:      { "path": string }                                   列出目录
- fs.readFile:  { "path": string, "maxBytes"?: number }              读取文本文件（上限 256KB）
- fs.mkdir:     { "path": string }                                   创建目录
- fs.writeFile: { "path": string, "content": string }                创建新文件（不会覆盖已有文件）

所有 path 都是相对工作区的相对路径，例如 "."、"src"、"notes/todo.md"。`;

export function buildInitialPrompt(input: {
  prompt: string;
  taskId: string;
  roundId: string;
  permissionPreset: PermissionPreset;
  workspaceRoot: string;
  allowedTools: readonly string[];
  maxSteps: number;
}): string {
  return `你是本地 ThinkFusion 的任务规划引擎。

请分析下面的用户任务，并输出一份符合 ${PROTOCOL} 协议的执行计划。

规则：
1. 你只负责规划，不负责执行；本地 Runtime 才会真正操作文件。
2. 不要要求执行任意 Shell 命令，也不存在这样的工具。
3. 只能使用下面列出的工具，参数必须完整且符合格式。
4. 计划最多 ${input.maxSteps} 步。
5. 必须使用指定的 JSON 结构，放在一个 \`\`\`json 代码块中。
6. 不要伪造执行结果；信息不足时返回 clarification_required。
7. 任务已经完成时返回 task_complete。
8. taskId 和 roundId 必须原样回填，不能改写。
9. 所有 path 都是相对工作区的相对路径，不要拼接下面的工作区路径，不要写绝对路径，也不要使用 ".."。
   写绝对路径会被本地 Runtime 直接拒绝，白白浪费一轮。

${TOOL_SPEC}

当前权限：${input.permissionPreset}
工作区（path 的基准目录，本身不要写进 path）：${input.workspaceRoot}
taskId：${input.taskId}
roundId：${input.roundId}

计划 JSON 结构：
${PLAN_SHAPE}

信息不足时的格式：
\`\`\`json
{ "protocol": "${PROTOCOL}", "type": "clarification_required", "taskId": "${input.taskId}", "roundId": "${input.roundId}", "questions": ["问题"] }
\`\`\`

任务已完成时的格式：
\`\`\`json
{ "protocol": "${PROTOCOL}", "type": "task_complete", "taskId": "${input.taskId}", "roundId": "${input.roundId}", "summary": "完成摘要" }
\`\`\`

用户任务：
${input.prompt}`;
}

export function buildReportPrompt(input: { taskId: string; roundId: string; report: ExecutionReport }): string {
  return `以下是 ThinkFusion 的本地执行报告（真实执行结果，未省略）。

请基于实际结果决定下一步：
- 需要继续执行：输出下一轮 ${PROTOCOL} 计划（taskId 与 roundId 使用下方给出的新值）。
- 任务已满足完成条件：输出 task_complete。
- 信息不足：输出 clarification_required。

不要假定未完成的步骤已经成功。不要重复已经成功的写入操作。

执行报告：
\`\`\`json
${JSON.stringify(input.report, null, 2)}
\`\`\`

taskId：${input.taskId}
roundId：${input.roundId}

只输出一个 JSON 对象，taskId 与 roundId 必须逐字使用上面这两个值；不要复用对话历史里其他消息中的 id。`;
}

export function buildClarificationAnswerPrompt(input: {
  taskId: string;
  roundId: string;
  questions: string[];
  answer: string;
}): string {
  return `用户已回答你的澄清问题，请据此继续规划。

问题：
${input.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}

用户回答：
${input.answer}

请输出符合 ${PROTOCOL} 的下一步计划（taskId 与 roundId 使用下方新值），或 task_complete。

${TOOL_SPEC}

taskId：${input.taskId}
roundId：${input.roundId}`;
}

export function allowedToolsForPreset(preset: PermissionPreset): readonly string[] {
  if (preset === 'read-only') return TOOL_NAMES.filter(tool => tool === 'fs.list' || tool === 'fs.readFile');
  return TOOL_NAMES;
}
