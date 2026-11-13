#!/usr/bin/env node
/**
 * Gate 0 spike：Agentic Search 的协议/预算/证据循环。
 *
 * 这不是产品实现，也不调用真实模型。它用一个确定性的“脚本模型”验证：
 *   - 工具集合和结果形状；
 *   - 多轮搜索、去重、预算、无新增证据停止；
 *   - 每条结论都能回到真实文件和行号；
 *   - 工具路径不能越出工程目录。
 *
 * 真实模型验证（D0.6）仍需单独跑：默认本地模型 + 一个云端模型，
 * 对比“一次性预检索 + 单次回答”的基线。这个脚本只证明协议本身可跑。
 *
 * 运行：
 *   npm run spike:agentic-search
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'fixtures', 'agentic');
const MAX_ROUNDS = 8;
const MAX_RESULTS = 30;

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function listSourceFiles() {
  const out = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile() && /\.(java|ts|js)$/.test(entry.name)) out.push(abs);
    }
  };
  visit(root);
  return out.sort();
}

function resolveInScope(input) {
  const abs = path.resolve(root, input);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${input}`);
  }
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${input}`);
  return abs;
}

function linesOf(abs) {
  return fs.readFileSync(abs, 'utf8').split('\n');
}

function makeTools() {
  const files = listSourceFiles();

  return {
    listFiles(args = {}) {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      const matched = files
        .map(relative)
        .filter(file => !pattern || file.includes(pattern))
        .slice(0, MAX_RESULTS);
      return { data: matched, total: matched.length, truncated: matched.length === MAX_RESULTS };
    },

    findSymbol(args) {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('findSymbol 需要 name');
      const hits = [];
      for (const abs of files) {
        const lines = linesOf(abs);
        lines.forEach((line, index) => {
          if (!line.includes(name)) return;
          const kind = /\b(class|interface|enum|record)\b/.test(line)
            ? 'type'
            : /\b(void|[A-Za-z_]\w*)\s+\w+\s*\(/.test(line)
              ? 'method'
              : 'reference';
          hits.push({ path: relative(abs), line: index + 1, kind, text: line.trim() });
        });
      }
      return { data: hits.slice(0, MAX_RESULTS), total: hits.length, truncated: hits.length > MAX_RESULTS };
    },

    grepSearch(args) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('grepSearch 需要 query');
      let regex;
      try {
        regex = new RegExp(query, 'i');
      } catch {
        throw new Error('grepSearch 的 query 不是合法正则');
      }
      const hits = [];
      for (const abs of files) {
        const lines = linesOf(abs);
        lines.forEach((line, index) => {
          if (!regex.test(line)) return;
          hits.push({ path: relative(abs), line: index + 1, kind: 'match', text: line.trim() });
        });
      }
      return { data: hits.slice(0, MAX_RESULTS), total: hits.length, truncated: hits.length > MAX_RESULTS };
    },

    readRange(args) {
      const input = String(args.path ?? '');
      const abs = resolveInScope(input);
      const start = Math.max(1, Number(args.start ?? 1));
      const end = Math.max(start, Number(args.end ?? start + 40));
      const lines = linesOf(abs);
      const slice = lines.slice(start - 1, end).map((text, index) => ({
        line: start + index,
        text
      }));
      return {
        data: { path: relative(abs), start, end: Math.min(end, lines.length), lines: slice },
        total: lines.length,
        truncated: end < lines.length
      };
    }
  };
}

function evidenceId(pathName, line, text) {
  return createHash('sha256')
    .update(`${pathName}|${String(line)}|${text.trim()}`)
    .digest('hex')
    .slice(0, 16);
}

class Evidence {
  constructor() {
    this.items = [];
    this.keys = new Set();
  }

  addMany(items, why) {
    let added = 0;
    for (const item of items) {
      const key = `${item.path}:${String(item.line)}:${item.text.trim()}`;
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      this.items.push({
        evidenceId: evidenceId(item.path, item.line, item.text),
        path: item.path,
        line: item.line,
        excerpt: item.text.trim(),
        why
      });
      added += 1;
    }
    return added;
  }

  hasPath(pathName) {
    return this.items.some(item => item.path === pathName);
  }
}

function collectHits(result, why, evidence) {
  const data = result?.data;
  if (Array.isArray(data)) {
    return evidence.addMany(
      data.filter(item => item && typeof item.path === 'string' && typeof item.line === 'number'),
      why
    );
  }
  if (data && Array.isArray(data.lines)) {
    return evidence.addMany(
      data.lines
        .filter(line => line.text.trim())
        .map(line => ({ path: data.path, line: line.line, text: line.text })),
      why
    );
  }
  return 0;
}

/**
 * 确定性“脚本模型”：只看当前证据，决定下一步。
 * 它模拟的是协议，不模拟模型能力。
 */
function nextAction(evidence) {
  if (!evidence.hasPath('src/LoginController.java')) {
    return { tool: 'findSymbol', args: { name: 'LoginController' }, why: '定位登录入口' };
  }
  if (!evidence.items.some(item => item.excerpt.includes('loginService.login'))) {
    return {
      tool: 'readRange',
      args: { path: 'src/LoginController.java', start: 1, end: 40 },
      why: '读取 Controller 的登录方法'
    };
  }
  if (!evidence.hasPath('src/LoginService.java')) {
    return { tool: 'grepSearch', args: { query: 'LoginService' }, why: '从 Controller 追到 Service' };
  }
  if (!evidence.items.some(item => item.excerpt.includes('authToken.issue'))) {
    return {
      tool: 'readRange',
      args: { path: 'src/LoginService.java', start: 1, end: 40 },
      why: '读取 Service 的登录流程'
    };
  }
  if (!evidence.hasPath('src/AuthToken.java')) {
    return { tool: 'findSymbol', args: { name: 'AuthToken' }, why: '检查认证/Token 组件' };
  }
  if (!evidence.hasPath('src/UserRepository.java')) {
    return { tool: 'findSymbol', args: { name: 'UserRepository' }, why: '追到数据访问层' };
  }
  if (!evidence.items.some(item => item.excerpt.includes('database.queryOne'))) {
    return {
      tool: 'readRange',
      args: { path: 'src/UserRepository.java', start: 1, end: 40 },
      why: '确认数据库访问'
    };
  }
  return { done: true, why: '证据已覆盖 Controller → Service → Repository → Database' };
}

function run() {
  const tools = makeTools();
  const evidence = new Evidence();
  const trace = [];
  let noNewRounds = 0;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const action = nextAction(evidence);
    if (action.done) {
      trace.push({ round, done: true, why: action.why });
      break;
    }

    const tool = tools[action.tool];
    if (typeof tool !== 'function') throw new Error(`未知工具：${action.tool}`);
    const started = Date.now();
    const result = tool(action.args);
    const added = collectHits(result, action.why, evidence);
    trace.push({
      round,
      tool: action.tool,
      args: action.args,
      why: action.why,
      total: result.total,
      added,
      truncated: Boolean(result.truncated),
      durationMs: Date.now() - started
    });

    noNewRounds = added === 0 ? noNewRounds + 1 : 0;
    if (noNewRounds >= 2) {
      trace.push({ round, stopped: '连续两轮没有新增证据' });
      break;
    }
  }

  return { trace, evidence: evidence.items };
}

function main() {
  const { trace, evidence } = run();
  const expectedPaths = [
    'src/LoginController.java',
    'src/LoginService.java',
    'src/UserRepository.java',
    'src/AuthToken.java'
  ];
  const failures = [];

  for (const file of expectedPaths) {
    if (!evidence.some(item => item.path === file)) failures.push(`缺少证据：${file}`);
  }
  if (!evidence.some(item => item.excerpt.includes('findByEmail'))) {
    failures.push('缺少 findByEmail 的调用/定义证据');
  }
  if (!evidence.some(item => item.excerpt.includes('database.queryOne'))) {
    failures.push('缺少 database.queryOne 证据');
  }
  if (trace.filter(item => 'tool' in item).length > MAX_ROUNDS) {
    failures.push('超过最大轮数');
  }
  if (new Set(evidence.map(item => item.evidenceId)).size !== evidence.length) {
    failures.push('证据 ID 重复');
  }
  for (const item of evidence) {
    const abs = path.join(root, item.path);
    if (!fs.existsSync(abs)) failures.push(`证据路径不存在：${item.path}`);
    const lines = linesOf(abs);
    if (item.line < 1 || item.line > lines.length) failures.push(`证据行号越界：${item.path}:${String(item.line)}`);
    if (!lines[item.line - 1]?.includes(item.excerpt)) {
      failures.push(`证据片段与源码不一致：${item.path}:${String(item.line)}`);
    }
  }

  const report = {
    question: '分析登录流程，从 Controller 到数据库经过哪些组件',
    rounds: trace.filter(item => 'tool' in item).length,
    evidence: evidence.length,
    files: [...new Set(evidence.map(item => item.path))],
    trace,
    failures
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`Agentic Search spike: FAIL（${failures.join('；')}）`);
    process.exitCode = 1;
  } else {
    console.log(`Agentic Search spike: PASS（${String(report.rounds)} 轮，${String(report.evidence)} 条证据）`);
  }
}

main();
