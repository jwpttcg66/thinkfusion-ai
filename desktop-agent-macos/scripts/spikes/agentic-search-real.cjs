/**
 * Gate 0 D0.6：Agentic Search 真实模型验证。
 *
 * 这不是产品代码。它在 Electron 主进程里读同一份 safeStorage API Key，
 * 用真实 Ollama 本地模型和云端 OpenAI 兼容模型跑 3 个真实工程问题，
 * 并与“一次性预检索 + 单次回答”的基线对比。
 *
 * 运行：
 *   npm run spike:agentic-search:real
 *   npm run spike:agentic-search:real -- --json
 *
 * 只读：所有工具限定在 TF_SPIKE_ROOT 内，不写工程文件。
 */

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.TF_SPIKE_ROOT ?? path.join(os.homedir(), 'data', 'codeStudy', 'grpc-springboot');
const CLOUD_ID = 'opencode-go';
const CLOUD_MODEL = 'deepseek-v4.1-flash';
const CLOUD_BASE = 'https://opencode.ai/inference/go/openai/v1';
const MAX_ROUNDS = 6;
const MAX_TOOL_CALLS = 10;
const MAX_RESULTS = 24;
const MAX_READ_LINES = 80;

const QUESTIONS = [
  {
    id: 'service-entry',
    question: '这个工程里 gRPC 服务端的入口类是哪个？它注册了哪个 service？',
    expected: ['GreeterGrpcService', 'GreeterGrpc', 'GrpcService']
  },
  {
    id: 'client-config',
    question: 'GreeterClient 如何连接服务端？目标地址来自哪里？',
    expected: ['GreeterClient', 'GrpcClient', 'local-grpc-server', 'application.yml', '50071']
  },
  {
    id: 'runner-condition',
    question: 'ClientRunner 在什么条件下会自动执行客户端调用？',
    expected: ['ClientRunner', 'ApplicationRunner', 'run-on-startup', 'ConditionalOnProperty']
  }
];

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工程内文件，路径相对工程根目录',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，默认工程根目录' },
          pattern: { type: 'string', description: '文件名包含的子串' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: '在工程源码里做大小写不敏感的内容搜索，返回 path:line',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的文本或类名' },
          glob: { type: 'string', description: '可选，文件名包含的子串，例如 .java' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文件的行范围，返回带行号的正文',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工程根目录的文件路径' },
          start: { type: 'number', description: '起始行，1 起' },
          end: { type: 'number', description: '结束行，最多 80 行' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: '按类名/方法名查找声明，返回 path:line',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '类名或方法名' }
        },
        required: ['name']
      }
    }
  }
];

const IGNORED = new Set(['.git', 'node_modules', 'target', 'build', 'out', 'out-test', 'dist', '.gradle', '.idea']);
const SOURCE_EXT = /\.(java|kt|kts|xml|yml|yaml|properties|gradle|proto)$/i;

function listSourceFiles(root) {
  const out = [];
  const visit = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (IGNORED.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
      if (out.length >= 5000) return;
    }
  };
  visit(root);
  return out.sort();
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function matchesPattern(file, pattern) {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return file.includes(pattern);
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${escaped}$`).test(file);
}

function resolveInScope(root, input) {
  const abs = path.resolve(root, input);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`路径越界：${input}`);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${input}`);
  return abs;
}

function linesOf(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}

function makeTools(root) {
  const files = listSourceFiles(root);
  return {
    list_files(args = {}) {
      const dir = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const absDir = resolveInScope(root, dir);
      const relativeDir = rel(root, absDir);
      const prefix = relativeDir === '.' || relativeDir === '' ? '' : `${relativeDir}/`;
      const matched = files
        .map(file => rel(root, file))
        .filter(file => file.startsWith(prefix) && matchesPattern(file, pattern))
        .slice(0, MAX_RESULTS);
      return {
        text: matched.length > 0 ? matched.join('\n') : '（没有匹配文件）',
        evidence: [],
        total: matched.length,
        truncated: matched.length === MAX_RESULTS
      };
    },

    grep_search(args = {}) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('grep_search 需要 query');
      const glob = typeof args.glob === 'string' ? args.glob : '';
      const needle = query.toLowerCase();
      const evidence = [];
      for (const file of files) {
        if (!matchesPattern(rel(root, file), glob)) continue;
        const lines = linesOf(file);
        lines.forEach((line, index) => {
          if (evidence.length >= MAX_RESULTS) return;
          if (!line.toLowerCase().includes(needle)) return;
          evidence.push({ path: rel(root, file), line: index + 1, text: line.trim() });
        });
      }
      return {
        text: evidence.length > 0
          ? evidence.map(item => `${item.path}:${String(item.line)}: ${item.text}`).join('\n')
          : '（没有命中）',
        evidence,
        total: evidence.length,
        truncated: evidence.length >= MAX_RESULTS
      };
    },

    read_file(args = {}) {
      const input = String(args.path ?? '').trim();
      if (!input) throw new Error('read_file 需要 path');
      const abs = resolveInScope(root, input);
      const lines = linesOf(abs);
      const start = Math.max(1, Number(args.start ?? 1));
      const end = Math.min(lines.length, Math.max(start, Number(args.end ?? start + MAX_READ_LINES - 1)), start + MAX_READ_LINES - 1);
      const slice = lines.slice(start - 1, end);
      const evidence = slice
        .map((text, index) => ({ path: rel(root, abs), line: start + index, text: text.trim() }))
        .filter(item => item.text);
      return {
        text: slice.map((text, index) => `${String(start + index)}: ${text}`).join('\n'),
        evidence,
        total: lines.length,
        truncated: end < lines.length
      };
    },

    find_symbol(args = {}) {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('find_symbol 需要 name');
      const evidence = [];
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const decl = new RegExp(`\\b(class|interface|enum|record|@interface)\\s+${escaped}\\b|\\b${escaped}\\s*\\(`, 'i');
      for (const file of files) {
        const lines = linesOf(file);
        lines.forEach((line, index) => {
          if (evidence.length >= MAX_RESULTS) return;
          if (!decl.test(line)) return;
          evidence.push({ path: rel(root, file), line: index + 1, text: line.trim() });
        });
      }
      return {
        text: evidence.length > 0
          ? evidence.map(item => `${item.path}:${String(item.line)}: ${item.text}`).join('\n')
          : '（没有找到声明）',
        evidence,
        total: evidence.length,
        truncated: evidence.length >= MAX_RESULTS
      };
    }
  };
}

function executeTool(tools, name, args) {
  const tool = tools[name];
  if (typeof tool !== 'function') throw new Error(`未知工具：${name}`);
  return tool(args ?? {});
}

async function ollamaTags() {
  const res = await fetch('http://127.0.0.1:11434/api/tags');
  if (!res.ok) throw new Error(`Ollama /api/tags ${String(res.status)}`);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

async function ollamaChat(model, messages, tools) {
  const started = Date.now();
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages, tools, options: { temperature: 0.1 } })
  });
  if (!res.ok) throw new Error(`Ollama /api/chat ${String(res.status)}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return {
    message: data.message ?? { role: 'assistant', content: '' },
    usage: {
      inputTokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null,
      outputTokens: typeof data.eval_count === 'number' ? data.eval_count : null
    },
    durationMs: Date.now() - started
  };
}

function cloudSettings() {
  const userData = path.join(app.getPath('appData'), 'thinkfusion-ai');
  const stored = JSON.parse(fs.readFileSync(path.join(userData, 'api-keys.json'), 'utf8'));
  const entry = stored[CLOUD_ID];
  if (!entry?.cipher) throw new Error('没有 opencode-go API Key');
  let baseUrl = CLOUD_BASE;
  let model = CLOUD_MODEL;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(userData, 'cloud-config.json'), 'utf8'));
    if (typeof config[CLOUD_ID]?.baseUrl === 'string') baseUrl = config[CLOUD_ID].baseUrl;
    if (Array.isArray(config[CLOUD_ID]?.models) && config[CLOUD_ID].models.includes(CLOUD_MODEL)) model = CLOUD_MODEL;
    else if (Array.isArray(config[CLOUD_ID]?.models) && config[CLOUD_ID].models.length > 0) model = config[CLOUD_ID].models[0];
  } catch {
    // 没有云配置时用默认值；Key 仍可用。
  }
  return {
    key: safeStorage.decryptString(Buffer.from(entry.cipher, 'base64')),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model
  };
}

async function cloudChat(key, baseUrl, model, messages, tools) {
  const started = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'User-Agent': 'thinkfusion-spike/0.2.1',
      'x-opencode-session': 'gate0-agentic-spike'
    },
    body: JSON.stringify({ model, messages, tools, stream: false })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloud ${String(res.status)}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const message = data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  return {
    message,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cost: data.opencode?.cost ?? data.usage?.cost ?? null
    },
    durationMs: Date.now() - started
  };
}

function normalizeToolCalls(message) {
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call, index) => {
    const fn = call.function ?? call;
    let args = fn.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    return {
      id: call.id ?? `call_${String(index)}`,
      name: fn.name ?? '',
      args: args && typeof args === 'object' ? args : {}
    };
  }).filter(call => call.name);
}

function answerText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

function coverage(answer, expected) {
  const lower = answer.toLowerCase();
  return expected.filter(term => lower.includes(term.toLowerCase()));
}

function citations(answer) {
  return [...answer.matchAll(/[\w./-]+\.(?:java|kt|xml|yml|yaml|properties|gradle|proto):\d+/gi)].map(match => match[0]);
}

function baselineContext(root, question) {
  const files = listSourceFiles(root);
  const terms = [...new Set(
    question
      .split(/[^\p{L}\p{N}_.-]+/u)
      .map(term => term.trim())
      .filter(term => term.length >= 2 && !/^[这个工程里哪个什么如何来自哪里]/.test(term))
  )];
  const scored = files.map(file => {
    const text = fs.readFileSync(file, 'utf8');
    const lower = text.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term.toLowerCase()) ? 1 : 0), 0);
    return { file, text, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  const picked = scored.length > 0 ? scored.slice(0, 3) : files.slice(0, 3).map(file => ({ file, text: fs.readFileSync(file, 'utf8'), score: 0 }));
  return picked.map(item => {
    const lines = item.text.split('\n');
    const index = Math.max(0, lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term.toLowerCase()))));
    const start = Math.max(0, index - 3);
    const slice = lines.slice(start, start + 50);
    return `### ${rel(root, item.file)}\n${slice.map((line, offset) => `${String(start + offset + 1)}: ${line}`).join('\n')}`;
  }).join('\n\n').slice(0, 9000);
}

async function probeToolCalling(model) {
  try {
    const response = await ollamaChat(
      model,
      [{ role: 'user', content: 'Call the list_files tool with path "." and nothing else.' }],
      [TOOL_SCHEMAS[0]]
    );
    const calls = normalizeToolCalls(response.message);
    return {
      model,
      ok: calls.length > 0,
      toolCalls: calls.map(call => call.name),
      content: answerText(response.message).slice(0, 300),
      durationMs: response.durationMs
    };
  } catch (error) {
    return { model, ok: false, toolCalls: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function runAgent(chat, model, root, question) {
  const tools = makeTools(root);
  const evidence = [];
  const messages = [
    {
      role: 'system',
      content: '你是工程探索代理。只能通过工具读取工程事实，不能凭记忆补全不存在的类、方法或配置。每轮可以调用一个或多个工具；证据足够时直接回答，不要继续调用。回答用中文，每个关键结论后标注 `path:line`；证据不足要明确说“现有证据不足”。'
    },
    { role: 'user', content: question }
  ];
  const trace = [];
  let final = '';
  let toolCalls = 0;
  let usage = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const started = Date.now();

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const response = await chat(model, messages, TOOL_SCHEMAS);
    usage.inputTokens += response.usage.inputTokens ?? 0;
    usage.outputTokens += response.usage.outputTokens ?? 0;
    usage.cost += typeof response.usage.cost === 'number' ? response.usage.cost : 0;
    const calls = normalizeToolCalls(response.message);
    if (calls.length === 0) {
      final = answerText(response.message);
      trace.push({ round, kind: 'answer', durationMs: response.durationMs });
      break;
    }

    messages.push(response.message);
    for (const call of calls) {
      if (toolCalls >= MAX_TOOL_CALLS) {
        if (chat === ollamaChat) {
          messages.push({ role: 'tool', tool_name: call.name, content: '工具预算已用完，请基于已有结果回答。' });
        } else {
          messages.push({ role: 'tool', tool_call_id: call.id, content: '工具预算已用完，请基于已有结果回答。' });
        }
        continue;
      }
      toolCalls += 1;
      let result;
      try {
        result = executeTool(tools, call.name, call.args);
      } catch (error) {
        result = { text: `工具失败：${error instanceof Error ? error.message : String(error)}`, evidence: [], total: 0, truncated: false };
      }
      for (const item of result.evidence) evidence.push({ ...item, why: call.name });
      trace.push({
        round,
        kind: 'tool',
        tool: call.name,
        args: call.args,
        total: result.total,
        evidence: result.evidence.length,
        truncated: Boolean(result.truncated),
        durationMs: response.durationMs
      });
      if (chat === ollamaChat) {
        messages.push({ role: 'tool', tool_name: call.name, content: result.text });
      } else {
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
      }
    }
    if (toolCalls >= MAX_TOOL_CALLS) break;
  }

  if (!final) {
    messages.push({
      role: 'user',
      content: '工具预算已用完。请只基于上面的工具结果回答原问题；每个关键结论标注 `path:line`；证据不足就明确说明。'
    });
    const response = await chat(model, messages, []);
    final = answerText(response.message);
    usage.inputTokens += response.usage.inputTokens ?? 0;
    usage.outputTokens += response.usage.outputTokens ?? 0;
    usage.cost += typeof response.usage.cost === 'number' ? response.usage.cost : 0;
    trace.push({ kind: 'final', durationMs: response.durationMs });
  }
  if (!final) final = '（达到预算，未形成最终回答）';
  return {
    final,
    evidence,
    trace,
    toolCalls,
    usage,
    durationMs: Date.now() - started
  };
}

async function runBaseline(chat, model, root, question) {
  const context = baselineContext(root, question);
  const messages = [
    {
      role: 'system',
      content: '只基于用户给出的代码材料回答。不要补全材料里没有的类、方法或配置。每个关键结论后标注 `path:line`；材料不足时明确说“现有材料不足”。'
    },
    { role: 'user', content: `问题：${question}\n\n可用材料：\n${context}` }
  ];
  const started = Date.now();
  const response = await chat(model, messages, []);
  return {
    final: answerText(response.message),
    usage: response.usage,
    durationMs: Date.now() - started
  };
}

function summarize(label, answer, expected) {
  const covered = coverage(answer, expected);
  return {
    covered,
    missing: expected.filter(term => !covered.includes(term)),
    coverage: expected.length === 0 ? 0 : covered.length / expected.length,
    citations: citations(answer)
  };
}

async function main() {
  if (!fs.existsSync(ROOT)) throw new Error(`工程不存在：${ROOT}`);
  const tags = await ollamaTags();
  const toolCapable = tags.filter(model => Array.isArray(model.capabilities) && model.capabilities.includes('tools'));
  const defaultLocal = toolCapable[0]?.name ?? null;
  const preferred = toolCapable.find(model => model.name === 'gpt-oss:20b')?.name ?? defaultLocal;
  if (!preferred) throw new Error('Ollama 没有工具调用模型');
  const cloud = cloudSettings();
  const defaultProbe = defaultLocal ? await probeToolCalling(defaultLocal) : null;

  const localModel = preferred;
  const results = [];

  for (const item of QUESTIONS) {
    process.stderr.write(`\n[local] ${item.id} ...\n`);
    const localAgent = await runAgent(ollamaChat, localModel, ROOT, item.question);
    process.stderr.write(`[local] baseline ${item.id} ...\n`);
    const localBaseline = await runBaseline(ollamaChat, localModel, ROOT, item.question);

    process.stderr.write(`[cloud] ${item.id} ...\n`);
    const cloudAgent = await runAgent(cloudChat.bind(null, cloud.key, cloud.baseUrl), cloud.model, ROOT, item.question);
    process.stderr.write(`[cloud] baseline ${item.id} ...\n`);
    const cloudBaseline = await runBaseline(cloudChat.bind(null, cloud.key, cloud.baseUrl), cloud.model, ROOT, item.question);

    results.push({
      id: item.id,
      question: item.question,
      expected: item.expected,
      local: {
        model: localModel,
        agent: { ...localAgent, ...summarize('local-agent', localAgent.final, item.expected) },
        baseline: { ...localBaseline, ...summarize('local-baseline', localBaseline.final, item.expected) }
      },
      cloud: {
        model: cloud.model,
        agent: { ...cloudAgent, ...summarize('cloud-agent', cloudAgent.final, item.expected) },
        baseline: { ...cloudBaseline, ...summarize('cloud-baseline', cloudBaseline.final, item.expected) }
      }
    });
  }

  const report = {
    root: ROOT,
    generatedAt: new Date().toISOString(),
    local: {
      defaultLocal,
      defaultProbe,
      toolCapable: toolCapable.map(model => model.name),
      used: localModel,
      note: 'qwen2.5:7b 未安装；defaultLocal 是 Ollama 返回的第一个 tools 模型。defaultProbe 记录它是否能实际发起原生工具调用。'
    },
    cloud: { id: CLOUD_ID, baseUrl: cloud.baseUrl, model: cloud.model },
    questions: results
  };
  console.log(JSON.stringify(report, null, 2));
}

app.setName('ThinkFusion');
app.whenReady().then(main).then(() => app.exit(0)).catch(error => {
  console.error(error);
  app.exit(1);
});
