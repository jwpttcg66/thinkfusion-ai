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

/**
 * 把 `completion` 的几种等价写法收敛成 `{ condition: string }`。
 *
 * 为什么值得容忍：网页里的模型经常把「完成条件」写成一句话、一个数组，
 * 或者一个 `{ criteria: [...] }` 的对象——语义完全一样，都是「怎样算做完」。
 * 严格拒绝的代价不是「让它重写一次」，而是**整条任务直接失败**：实测三次
 * 里有一次就连续写错三遍（`completion: []` → `{criteria: []}` → 再错），
 * 用户看到的是「任务失败」，而不是「搜索和跑代码不能用」。
 *
 * 只做这一处收敛，其它字段一律照旧严格：`steps` 的工具名与参数直接决定
 * 真机要跑什么，容错在那里就是把「模型写错了」变成「机器做错事」。
 */
function normalizePlanShape(value: Record<string, unknown>): Record<string, unknown> {
  const completion = value.completion;
  const asCondition = (raw: unknown): string | null => {
    if (typeof raw === 'string') return raw.trim() || null;
    if (Array.isArray(raw)) {
      const parts = raw.map(item => String(item ?? '').trim()).filter(Boolean);
      return parts.length > 0 ? parts.join('；') : null;
    }
    return null;
  };

  const direct = asCondition(completion);
  if (direct) return { ...value, completion: { condition: direct } };

  if (completion && typeof completion === 'object' && !Array.isArray(completion)) {
    const record = completion as Record<string, unknown>;
    if (typeof record.condition === 'string' && record.condition.trim()) return value;
    for (const key of ['criteria', 'conditions', 'when', 'done']) {
      const alt = asCondition(record[key]);
      if (alt) return { ...value, completion: { condition: alt } };
    }
  }
  return value;
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
      const plan = PlanSchema.parse(normalizePlanShape(value));
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
- fs.readFile:  { "path": string, "offset"?: number, "limit"?: number }
                 按行读文本文件：offset 从 1 开始，limit 默认/上限 2000 行。
                 结果带 totalLines / startLine / endLine / truncated / numbered；
                 content 是不带行号原文，改文件时用它做 oldString。
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
- fs.find:      { "pattern": string, "path"?: string, "maxResults"?: number }
                 按文件名/相对路径通配找文件：* 匹配一段、** 匹配多级、? 匹配一个字符，
                 例如 "*.md"、"src/**/*.ts"。只返回路径，不读内容。
- fs.stat:      { "path": string }
                 文件元数据：类型、字节、权限、修改时间；小文本文件还带 sha256 与 lines（总行数）。
- fs.edit:      { "path": string, "oldString": string, "newString": string, "replaceAll"?: boolean, "expectedHash"?: string }
                 按字面量替换已有文件。oldString 必须逐字一致，默认只允许出现一次；
                 出现多次就补上下文或显式 replaceAll。要严格就带上读到的 sha256。
- fs.remove:    { "path": string, "recursive"?: boolean, "permanent"?: boolean }
                 默认移入废纸篓；目录必须 recursive。permanent 只有完全权限才生效。
- fs.move:      { "from": string, "to": string }      移动/改名；目标已存在会被拒绝。
- fs.copy:      { "from": string, "to": string }      复制文件或目录；目标已存在会被拒绝。
- fs.readImage: { "path": string }
                 读 PNG/JPEG/GIF/WebP，返回 mime、字节、宽高、sha256 与 base64。
- fs.revert:    { }
                 只读之外的动作：把本轮改过的文件恢复到第一次修改前（新建的删除）。
- fs.applyPatch: { "path": string, "patch": string, "expectedHash"?: string }
                 按单文件 unified diff 一次改多处。patch 必须含 @@ hunk 头；
                 上下文与原文件对不上就整份拒绝，不会写入一半。可带读到的 sha256。
- git.worktree: { "action": "list" | "add" | "remove", "path"?: string, "branch"?: string }
                 列出/新增/移除 git 工作树。add 要 path 与 branch，remove 要 path。
                 参数是逐个构造的白名单，不接受 shell 语法与以 - 开头的分支名。
- project.dependencies: { "path"?: string, "maxEntries"?: number }
                 只读。读 package.json，返回包管理器、锁文件、脚本名、各类依赖数量与前若干项。
- project.outline: { "path"?: string, "maxFiles"?: number, "maxSymbols"?: number }
                 只读。扫描 .ts/.tsx/.js/.mjs/.py（跳过 node_modules 等），
                 列出导出符号及行号；超过上限会在 truncated 里说明。
- code.definition: { "path": string, "line": number, "character": number }
                 只读。1-based 行列，跳到符号定义；TypeScript 走 tsserver。
                 没有语言服务时明确报 LSP_UNAVAILABLE，不拿正则结果冒充。
- code.references: { "path": string, "line": number, "character": number }
                 只读。列出引用位置（含声明处）；文本匹配不等于调用。
- code.symbols:  { "path": string, "max"?: number }
                 只读。按文件列出符号与行号（navtree）。
- code.hover:    { "path": string, "line": number, "character": number }
                 只读。取光标处的类型签名与文档。
- code.context:  { "path": string, "line"?: number, "character"?: number, "max"?: number }
                 只读。一次给出该文件的符号、定义、引用、类型签名与候选测试，
                 每条标 source；引用不等于调用，测试只是候选。
- git.status:    { "path"?: string, "maxEntries"?: number }
                 只读。当前分支、与上游的领先/落后提交数、逐文件改动（index/worktree 状态字母）。
- git.diff:      { "path"?: string, "staged"?: boolean, "commit"?: string, "maxBytes"?: number }
                 只读。看工作区/暂存区/某次提交的差异；超过上限时 truncated=true。
- git.log:       { "path"?: string, "limit"?: number }
                 只读。最近若干条提交：hash、作者、ISO 时间、标题。
- git.show:      { "commit": string, "stat"?: boolean, "maxBytes"?: number }
                 只读。看某次提交的说明与改动，stat=true 只看每条文件的增删行数。
- git.stash:     { "action": "list" | "push" | "pop" | "drop", "message"?: string, "index"?: number }
                 列出/暂存/恢复/丢弃。drop 必须给 index 说明丢第几条。
- git.branch:    { "action": "list" | "create" | "switch", "name"?: string }
                 列出/新建/切换分支；name 不能以 - 开头。
- json.query:    { "path": string, "pointer"?: string, "maxChars"?: number }
                 只读。按 "a.b[0].c" 或 JSON Pointer "/a/0/b" 取一个值，不整份读进上下文。
- csv.summary:   { "path": string, "delimiter"?: string, "maxRows"?: number, "samples"?: number }
                 只读。列名、空值数、去重数、样例与纯数字列的 min/max/mean；自动识别分隔符。
- sqlite.query:  { "path": string, "sql": string, "maxRows"?: number }
                 只读。以 -readonly 打开数据库，只放行 SELECT / WITH / PRAGMA / EXPLAIN。
- archive.list:  { "path": string, "maxEntries"?: number }
                 只读。列出 zip / tar.gz / tgz 里的条目名。
- archive.extract: { "path": string, "destination"?: string }
                 解压到授权目录内（默认 extracted/）。条目含绝对路径或 .. 时整包拒绝。
- archive.create: { "output": string, "sources": string[] }
                 打包成 zip / tar.gz / tgz；输出已存在会被拒绝，不会覆盖。
- text.diff:     { "pathA": string, "pathB": string }
                 只读。diff -u 两份文件，输出可直接交给 fs.applyPatch。
- text.base64:   { "action": "encode" | "decode", "path": string, "output"?: string }
                 encode 读文件出 base64；decode 可给 output 落盘，已存在会被拒绝。
- image.resize:  { "path": string, "output": string, "maxDimension"?: number, "width"?: number, "height"?: number, "format"?: "jpeg" | "png" }
                 用系统 sips 缩放；不给宽高就按长边等比。输出不能是原图、不能已存在。
- env.read:      { "names"?: string[], "maxEntries"?: number }
                 只读。读环境变量；KEY/TOKEN/SECRET/PASSWORD 这类名字的值一律打码。
- port.list:     { "port"?: number, "maxEntries"?: number }
                 只读。当前监听端口与占用它的进程、pid。
- app.list:      { "maxEntries"?: number }
                 只读。列出已安装应用名，不启动任何程序。
- window.list:   { }
                 只读。当前可见窗口的应用名与标题；无辅助功能授权时返回 note 说明。
- dns.lookup:    { "host": string }
                 联网。把域名解析成 IP；只接受域名形状的 host。
- time.now:      { }
                 只读。本机时区、ISO 时间、时间戳与星期。
- process.tree:  { "pid"?: number, "filter"?: string, "maxEntries"?: number }
                 只读。按父子关系展开进程，depth 表示层级；不给 pid 就从根进程展开。
- fs.du:         { "path"?: string, "maxEntries"?: number, "maxNodes"?: number }
                 只读。各直接子项占多少字节与文件数，按体积降序；符号链接不跟随。
- test.run:     { "command": "npm test" | "npm run typecheck" | ... }
                 在授权目录里真实执行白名单里的命令，返回退出码与输出。
- shell.run:    { "command": string, "cwd"?: string, "timeoutMs"?: number, "background"?: boolean }
                 在真实 shell 里执行一条命令（/bin/sh -c），返回真实退出码、输出与耗时。
                 · workspace-write：只放行只读与构建类命令（ls、cat、grep、git status、
                   npm run test 之类）。写文件请用 fs.writeFile，那里能核对指纹。
                 · danger-full-access：放行任意命令，但仍会拒绝 sudo / mkfs /
                   rm -rf / 这类不可回收的操作。
                 · background=true 时立刻返回作业 id，用 job.output 读、job.kill 停；
                   适合 dev server、长轮询、watch 这类不会自己结束的命令。
                 · 前台命令退出码非 0 视为这一步失败，后面的步骤不会继续执行。
- job.list:     { }
                 列出后台作业：id、命令、pid、状态（running/exited/killed）。
- job.output:   { "id": string, "tailBytes"?: number }
                 读作业日志尾部（默认 32KB），真实输出，不是转述。
- job.kill:     { "id": string, "signal"?: "TERM" | "KILL" }
                 结束作业的整个进程组。
- screen.capture: { "target"?: "screen" | "region", "region"?: { "x": number, "y": number, "width": number, "height": number }, "path"?: string }
                 真实截屏并落盘，返回文件路径、字节数、尺寸与 sha256。
                 不给 path 时落在应用缓存目录；target=region 时必须给 region。
                 第一次使用可能需要用户在系统设置里允许屏幕录制。
- app.open:     { "app"?: string, "path"?: string }
                 真实打开应用（如 "TextEdit"）或文件/目录路径，两者必须给且只给一个。
                 返回是否已启动，以及进程是否真的存在（running）。
- clipboard.read:  { }
                 读系统剪贴板文本（上限 256KB）。
- clipboard.write: { "text": string }
                 写系统剪贴板文本。
- notify:       { "title": string, "message"?: string, "subtitle"?: string }
                 发一条系统通知。
- system.info:  { "scope"?: "all" | "os" | "cpu" | "memory" | "disk" | "battery" }
                 系统信息：OS/内核、CPU 型号与核数、内存、磁盘占用、电池状态。
- process.list: { "filter"?: string, "limit"?: number }
                 列进程（pid/ppid/cpu/内存/命令），可按关键字过滤。
- process.kill: { "pid": number, "signal"?: "TERM" | "KILL" }
                 结束进程；只有完全权限允许，普通权限用 job.kill 停自己起的作业。
- web.fetch:    { "url": string, "method"?: "GET" | "POST", "headers"?: object, "body"?: string, "maxBytes"?: number }
                 真实抓取 http/https：返回状态码、content-type、字节、sha256 与正文
                 （HTML 会去标签）。拒环回/私网/元数据地址，重定向逐跳校验，10s 超时。
- web.search:   { "query": string, "maxResults"?: number, "site"?: string }
                 真实联网搜索，返回 title / url / snippet 列表（已按地址去重）。
                 需要先查资料、找官网、确认版本或新闻时用它，不要用 web.fetch 去抓
                 搜索页——搜索页返回的是给人看的 HTML 或人机验证，不是结果。
                 · 引用结果时必须带上它返回的 url，不能只写「根据网上资料」。
                 · 结果为空就如实说没查到；不要凭印象补几条看起来合理的链接。
                 · 返回里的 degraded 字段说明这次为什么只有摘要，要一并告诉用户。
- code.run:     { "language": "node" | "python3" | "bash", "code": string, "timeoutMs"?: number, "cwd"?: string }
                 在本地真实解释器里跑一段代码，返回真实退出码、stdout、stderr 与耗时。
                 写完代码要立刻验证、算一段数据、试一个正则，用它；不要用 shell.run
                 拼 node -e 一行命令（引号一错就变成另一段程序）。
                 · 脚本落在工作区 .thinkfusion/tmp/run-*/ 下，路径会出现在结果里。
                 · 退出码非 0 视为失败；失败时先看 stderr 再改，不要连续重跑同样的代码。
- goal.create:  { "text": string }       给这个会话建一个长期目标（仅在用户批准的计划里可用）。
- goal.get:     {}                       读当前目标与状态；没有就如实说没有。
- goal.update:  { "status": "active"|"blocked"|"done", "note"?: string }
                 只能更新状态，不能改目标文字；完成必须带依据。
- schedule.create: { "text": string, "mode": "local"|"cloud", "at"?: number, "repeatMinutes"?: number }
                 到点自动跑；只能本地或云端，**没有 web 选项**（不往用户账号里写会话）。
- schedule.edit: { "id": string, "text"?: string, "mode"?: "local"|"cloud", "at"?: number, "repeatMinutes"?: number, "enabled"?: boolean }
- schedule.list: {}  列出定时任务与下一次运行时间。
- schedule.view: { "id": string }  看单个任务的上次运行与上次错误。
- team.spawn:   { "members": string[] }  从已有参与者里登记协作成员，不新建成员。
- team.task.create: { "title": string, "detail"?: string, "assignee"?: string }
- team.task.get: { "id": string }
- team.task.list: {}
- team.task.update: { "id": string, "status": "todo"|"doing"|"done"|"blocked", "note"?: string }
- team.wait:    { "timeoutMs"?: number }  返回任务板进度；没做完就列出还差哪几条。
- session.search: { "query": string, "limit"?: number, "conversationId"?: string }
                 只读搜索历史会话，返回命中片段、来源会话与时间；0 条不算失败，如实说没搜到。
                 · 跨会话引用必须带上来源会话与时间，不能把别处的话当成这次的事实。
- plugin.inspect: { "id"?: string }
                 查能力清单与开关状态；不给 id 就列全部。只读。
- term.open:    { "cwd"?: string, "cols"?: number, "rows"?: number }
                 开一个持久交互式终端（node-pty，与 dsh 同后端），返回 sessionId。
                 · 一次性命令仍用 shell.run；只有需要 tty 的程序（dev server、ssh、交互式提示）才用它。
                 · 原生模块不可用时明确报 TERMINAL_UNAVAILABLE，不要以为命令跑起来了。
- term.read:    { "sessionId": string, "maxChars"?: number }
                 只返回上次之后的新输出；truncated=true 说明还有没读完的，继续读。
- term.send:    { "sessionId": string, "input": string, "submit"?: boolean }
                 写入终端；submit 默认 true（追加回车）。每份计划里的 send 都要用户逐次批准。
- term.signal:  { "sessionId": string, "signal"?: "SIGINT"|"SIGTERM"|"SIGKILL"|"SIGHUP"|"SIGQUIT" }
- term.close:   { "sessionId": string }  结束会话并回收进程组。
- term.list:    {}  列出还开着的终端、pid、cwd、是否退出。
- code.diagnostics: { "path"?: string, "paths"?: string[], "maxItems"?: number, "timeoutMs"?: number }
                 在工程里跑已安装的 tsc / eslint，返回归一化的问题列表（path / line / severity / message / source）。
                 · 不装依赖、不用 npx；没有检查器时返回 skipped 并说明原因，不要当作「没有问题」。
                 · 退出码非 0 是「有诊断问题」，不是工具失败。
- ask.user:     { "question": string, "options"?: string[], "allowFreeText"?: boolean, "timeoutMs"?: number }
                 执行到一半必须由用户决定时用它：用哪个目录、要不要覆盖、两个方案选哪个。
                 · 每份计划最多 3 次；已经写清楚的事不要再问。
                 · 返回 { "answered": true, "value": ... } 或 { "answered": false, "reason": "timeout" | "cancelled" | "budget" }；
                   没回答时不要替用户选默认值，这一步按未验证处理。

所有 path 都是相对工作区的相对路径，例如 "."、"src"、"notes/todo.md"。
绝对路径只在 danger-full-access 下允许。`;

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
1. 你只负责规划，不负责执行；本地 Runtime 才会真正读写文件、执行命令与代码、截屏、
   启动应用、操作剪贴板、发通知、抓网页、联网搜索、起后台作业。
2. 需要在本机做任何事时（跑命令、跑一段代码、截屏、开应用、改/移/删文件、读剪贴板、
   发通知、抓网页、搜资料、起后台任务），直接把对应工具写进计划——不要因为「可能被拒绝」
   就降级成让用户自己去做，也不要用文字描述代替真实动作。权限不足时 Runtime 会明确拒绝，
   并告诉你原因。
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
11. 需要外部事实（最新版本、官方文档地址、某个库怎么用、最近发生了什么）时，先规划
    web.search；拿到结果后再决定是否 web.fetch 读正文。引用必须带 url。
    搜索返回 0 条就如实说没查到，不要用记忆里的链接凑数——链接失效比没有链接更糟。
12. 写完代码要验证时用 code.run 跑一遍真实的解释器，不要只描述「理论上可行」。

${TOOL_SPEC}

当前权限：${input.permissionPreset}
本次可用工具（不在这个列表里的不要写进计划，审批会被拒绝）：${input.allowedTools.join('、')}
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
  permissionPreset?: PermissionPreset;
  allowedTools?: readonly string[];
}): string {
  const scope = input.allowedTools && input.allowedTools.length > 0
    ? `当前权限：${input.permissionPreset ?? 'workspace-write'}
本次可用工具（不在这个列表里的不要写进计划）：${input.allowedTools.join('、')}

`
    : '';
  return `上一份计划没有通过本地校验，任务没有执行。请修正后重新输出一份计划。

失败原因：
${input.error}

原始任务：
${input.userPrompt}

请只输出一个符合 ${PROTOCOL} 的 JSON 对象（taskId 与 roundId 用下面的新值）。

${TOOL_SPEC}

${scope}taskId：${input.taskId}
roundId：${input.roundId}`;
}

export function buildClarificationAnswerPrompt(input: {  taskId: string;
  roundId: string;
  questions: string[];
  answer: string;
  permissionPreset?: PermissionPreset;
  allowedTools?: readonly string[];
}): string {
  const scope = input.allowedTools && input.allowedTools.length > 0
    ? `当前权限：${input.permissionPreset ?? 'workspace-write'}
本次可用工具（不在这个列表里的不要写进计划）：${input.allowedTools.join('、')}

`
    : '';
  return `用户已回答你的澄清问题，请据此继续规划。

问题：
${input.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}

用户回答：
${input.answer}

请输出符合 ${PROTOCOL} 的下一步计划（taskId 与 roundId 使用下方新值），或 task_complete。

${TOOL_SPEC}

${scope}taskId：${input.taskId}
roundId：${input.roundId}`;
}

export function allowedToolsForPreset(preset: PermissionPreset): readonly string[] {
  if (preset === 'read-only') return READ_ONLY_TOOLS;
  return TOOL_NAMES;
}
