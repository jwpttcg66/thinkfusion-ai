import {
  PROTOCOL,
  PlanSchema,
  ClarificationSchema,
  TaskCompleteSchema,
  TOOL_NAMES,
  READ_ONLY_TOOLS,
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
    return { kind: 'invalid', error: describePlanIssues(error) };
  }
}

/**
 * 把 zod 的校验错误翻成能照着做的话。
 *
 * 真机第一次改已有文件时，模型在同一份计划里给 `expectedHash` 填了占位符，用户
 * 看到的是 `[{"validation":"regex","code":"invalid_string","path":["steps",1,"args","expectedHash"]}]`。
 * 那条消息说不清「该怎么做」，而这里恰好有一个明确的下一步：先读，再写。
 */
export function describePlanIssues(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })?.issues;
  if (!Array.isArray(issues)) return error instanceof Error ? error.message : String(error);
  return issues
    .map(issue => {
      const path = (issue.path ?? []).join('.');
      if (path.endsWith('expectedHash')) {
        return '覆盖已有文件必须带 64 位十六进制的 sha256。同一份计划里拿不到它：先只输出 fs.readFile 的计划，下一轮拿到 sha256 再写';
      }
      if (path.endsWith('overwrite')) return 'overwrite 只能是 true 或 false';
      if (path.endsWith('tool')) return '计划里出现了不受支持的工具名';
      if (path === 'steps') return '计划的步骤格式不对（每步要有 id / tool / args）';
      return `${path || '计划'}：${issue.message ?? '格式不正确'}`;
    })
    .join('；');
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
- fs.writeFile: { "path": string, "content": string, "overwrite"?: boolean, "expectedHash"?: string }
                 默认只创建新文件；要改已有文件必须 overwrite=true 并附上
                 先前 fs.readFile 结果里的 sha256，不匹配会被拒绝。
                 ⚠ 同一份计划里你还没读过文件，所以拿不到 sha256：
                 改已有文件要分两轮——这一轮只输出 fs.readFile（必要时加 fs.list），
                 下一轮看到执行报告里的 sha256 再写。不要填占位值或猜一个哈希。
- fs.tree:      { "path": string, "maxDepth"?: number, "maxEntries"?: number }
                 递归列出工程目录（忽略 node_modules / .git / 构建产物）。
- fs.search:    { "query": string, "path"?: string, "maxResults"?: number }
                 按内容搜索文本，返回 路径:行号 与命中的那一行。
- test.run:     { "command": "npm test" | "npm run typecheck" | ... }
                 在授权目录里真实执行白名单里的命令，返回退出码与输出。

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
10. 要修改已有文件，这一轮**只规划 fs.readFile**（必要时加 fs.list），把 sha256 留到下一轮：
    计划阶段拿不到文件指纹，编一个会被 schema 拒绝，整个任务当场失败。

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

export function buildReportPrompt(input: {
  taskId: string;
  roundId: string;
  report: ExecutionReport;
  /**
   * V2.1 Phase F：执行后的独立评审结论。
   *
   * 任务书要求「发现问题形成修复任务，修复后重新验证」。评审结论不进这条
   * 提示时，下一轮计划只看到执行报告，会把「测试失败」当成「再试一次」，
   * 而不是「先修评审指出的那一条」——两者产出的计划完全不同。
   */
  review?: { verdict: string; issues: string[]; needsFix: boolean; reviewer: string } | null;
}): string {
  const review = input.review;
  const fixSection = review && review.issues.length > 0
    ? `
独立评审${review.needsFix ? '判定需要修复' : '给出了待改进项'}（${review.reviewer}）：
${review.verdict}

这一轮的定位是**修复任务**，不是重新做一遍：
${review.issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

修复要求：
- 逐条对应上面的问题，说清哪一步解决哪一条；解决不了的要说明为什么。
- 不要重做已经成功的步骤，也不要重复写入同样的内容。
- 改动之后必须重新验证（测试或读回文件），验证结果要出现在执行报告里。
`
    : '';
  return `以下是 ThinkFusion 的本地执行报告（真实执行结果，未省略）。${fixSection}
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

/**
 * 计划没通过校验时，把失败原因交回给模型让它改。
 *
 * 不这么做的话，一个占位符就会让整个任务当场失败——真机第一次「改已有文件」
 * 就是这样：模型填了假的 expectedHash，用户看到一串 zod 路径，任务死掉，
 * 而他其实只需要被告知「先读一遍」。
 */
export function buildPlanRepairPrompt(input: {
  taskId: string;
  roundId: string;
  error: string;
  userPrompt: string;
}): string {
  return `上一份计划没有通过本地校验，任务没有执行。请修正后重新输出一份计划。

失败原因：
${input.error}

原始任务：
${input.userPrompt}

请只输出一个符合 ${PROTOCOL} 的 JSON 对象（taskId 与 roundId 用下面的新值）。

${TOOL_SPEC}

taskId：${input.taskId}
roundId：${input.roundId}`;
}

export function buildClarificationAnswerPrompt(input: {  taskId: string;
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
  if (preset === 'read-only') return READ_ONLY_TOOLS;
  return TOOL_NAMES;
}
