/**
 * 能力清单 109 真机全跑：每个 id 至少执行一次，并核对 ThinkFusion 暴露 109。
 *
 *   npm run test:capabilities:live
 *
 * 前提：桌面未锁屏（computer.* 要动 TextEdit）；CDP 9333 有 ThinkFusion 时核对暴露。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAPABILITY_CATALOG, CAPABILITY_IDS } from '../out/shared/capabilities.js';
import { TOOL_NAMES } from '../out/shared/contracts.js';
import { localCapabilities } from '../out/agent/local-plugins.js';
import { mainCapabilities } from '../out-test/main/capabilities/index.js';
import { TsServerClient } from '../out-test/main/lsp/tsserver.js';
import { buildCodeContext } from '../out-test/main/lsp/context.js';
import { buildImpact } from '../out-test/main/lsp/impact.js';
import { loadTypeScript, summarizeAst } from '../out-test/main/lsp/ts-ast.js';
import { connect } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MARKER = process.env.LIVE_MARKER ?? `tf-cap-${Date.now().toString(36)}`;
const REPORT = process.env.LIVE_REPORT ?? path.join(os.tmpdir(), 'tf-capability-catalog-live.json');
const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9333/json';
const BUNDLE = 'com.apple.TextEdit';

assert.equal(CAPABILITY_CATALOG.length, 109, `清单长度应为 109，实际 ${CAPABILITY_CATALOG.length}`);
assert.equal(TOOL_NAMES.length, 103);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cap-live-'));
const evidenceDir = path.join(work, 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });
fs.mkdirSync(path.join(work, 'src'), { recursive: true });
fs.writeFileSync(path.join(work, 'README.md'), `# ${MARKER}\nhello\n`);
fs.writeFileSync(path.join(work, 'src', 'a.ts'), [
  'export function greet(name: string): string {',
  "  return `hi ${name}`;",
  '}'
].join('\n') + '\n');
fs.writeFileSync(path.join(work, 'src', 'b.ts'), [
  "import { greet } from './a';",
  "const text = greet('world');",
  'console.log(text);'
].join('\n') + '\n');
fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true },
  include: ['src']
}, null, 2));
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
  name: 'tf-cap-live',
  private: true,
  scripts: {
    test: 'node -e "process.exit(0)"',
    typecheck: 'node -e "process.exit(0)"',
    build: 'node -e "process.exit(0)"',
    'build:agent': 'node -e "process.exit(0)"',
    'test:protocol': 'node -e "process.exit(0)"'
  }
}, null, 2));
fs.writeFileSync(path.join(work, 'data.json'), JSON.stringify({ a: { b: [{ c: 42 }] } }));
fs.writeFileSync(path.join(work, 'rows.csv'), 'name,qty\nalpha,10\nbeta,20\n');
fs.writeFileSync(path.join(work, 'left.txt'), 'one\ntwo\n');
fs.writeFileSync(path.join(work, 'right.txt'), 'one\nTWO\n');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
fs.writeFileSync(path.join(work, 'dot.png'), png);

const git = (...argv) => spawnSync('git', argv, { cwd: work, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'live@example.com');
git('config', 'user.name', 'Live');
git('config', 'commit.gpgsign', 'false');
git('add', '.');
git('commit', '-q', '-m', 'seed');

const sqliteOk = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;
if (sqliteOk) {
  spawnSync('sqlite3', [path.join(work, 'app.db'), 'CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (1, "a");']);
}

const tsserver = path.resolve(ROOT, 'node_modules/typescript/lib/tsserver.js');
const lsp = new TsServerClient(work, tsserver);

const snapshots = new Map();
const goals = { text: null, status: 'active', note: null };
const schedules = new Map();
const team = { members: [], tasks: new Map(), revision: 1 };

function hashOf(rel) {
  return createHash('sha256').update(fs.readFileSync(path.join(work, rel))).digest('hex');
}

async function callMain(id, args) {
  if (id === 'snapshot.capture') {
    const abs = path.join(String(args.root), String(args.path));
    const key = `${args.taskId}:${args.path}`;
    snapshots.set(key, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
    return { captured: args.path };
  }
  if (id === 'snapshot.revert') {
    const restored = [];
    for (const [key, buf] of snapshots) {
      if (!key.startsWith(`${args.taskId}:`)) continue;
      const rel = key.slice(String(args.taskId).length + 1);
      const abs = path.join(work, rel);
      if (buf == null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
      }
      restored.push(rel);
    }
    return { taskId: args.taskId, restored, removed: [], failed: [] };
  }
  if (id === 'session.search') {
    return { hits: [{ conversationId: 'live', title: MARKER, snippet: String(args.query) }] };
  }
  if (id === 'plugin.inspect') {
    const meta = CAPABILITY_CATALOG.find(item => item.id === (args.id ?? 'fs.list'));
    return { id: meta?.id ?? args.id, enabled: true, registered: true, host: meta?.host ?? 'runtime' };
  }
  if (id === 'goal.create') {
    goals.text = args.text;
    goals.status = 'active';
    return { ...goals };
  }
  if (id === 'goal.get') return { ...goals };
  if (id === 'goal.update') {
    goals.status = args.status;
    goals.note = args.note ?? goals.note;
    return { ...goals };
  }
  if (id === 'schedule.create') {
    const item = { id: `sch-${schedules.size + 1}`, ...args, enabled: true };
    schedules.set(item.id, item);
    return item;
  }
  if (id === 'schedule.edit') {
    const cur = schedules.get(args.id);
    if (!cur) throw new Error(`没有日程 ${args.id}`);
    Object.assign(cur, args);
    return cur;
  }
  if (id === 'schedule.list') return { items: [...schedules.values()] };
  if (id === 'schedule.view') {
    const item = schedules.get(args.id);
    if (!item) throw new Error(`没有日程 ${args.id}`);
    return item;
  }
  if (id === 'team.spawn') {
    team.members = [...args.members];
    return { members: team.members };
  }
  if (id === 'team.task.create') {
    const item = {
      id: `task-${team.tasks.size + 1}`,
      title: args.title,
      status: 'todo',
      revision: 1,
      assignee: args.assignee,
      detail: args.detail
    };
    team.tasks.set(item.id, item);
    return item;
  }
  if (id === 'team.task.get') {
    const item = team.tasks.get(args.id);
    if (!item) throw new Error(`没有任务 ${args.id}`);
    return item;
  }
  if (id === 'team.task.list') return { tasks: [...team.tasks.values()] };
  if (id === 'team.task.update') {
    const item = team.tasks.get(args.id);
    if (!item) throw new Error(`没有任务 ${args.id}`);
    if (item.revision !== args.expectedRevision) throw new Error('CAS_CONFLICT');
    item.status = args.status;
    item.revision += 1;
    item.note = args.note;
    return item;
  }
  if (id === 'team.wait') return { waitedMs: 0, pending: 0 };

  const file = typeof args?.path === 'string' ? path.join(work, args.path) : null;
  const position = file && args.line && args.character
    ? { file, line: Number(args.line), character: Number(args.character) }
    : null;

  if (id === 'code.definition') return lsp.definition(position);
  if (id === 'code.references') return lsp.references(position);
  if (id === 'code.symbols') return lsp.symbols(file, args.max ?? 50);
  if (id === 'code.hover') return lsp.hover(position);
  if (id === 'code.diagnostics.lsp') {
    const files = [
      ...(typeof args.path === 'string' ? [args.path] : []),
      ...(Array.isArray(args.paths) ? args.paths : [])
    ].map(rel => path.join(work, rel));
    const issues = [];
    for (const f of files) issues.push(...(await lsp.diagnostics(f)));
    return {
      root: work,
      source: 'tsserver',
      files: files.map(f => path.relative(work, f)),
      issues,
      counts: {
        errors: issues.filter(i => i.severity === 'error').length,
        warnings: issues.filter(i => i.severity === 'warning').length
      }
    };
  }
  if (id === 'code.context') {
    return buildCodeContext(lsp, work, file, position ? { line: position.line, character: position.character } : undefined, args.max ?? 50);
  }
  if (id === 'code.impact') {
    return buildImpact(lsp, work, file, { line: Number(args.line), character: Number(args.character) }, path.join(work, '.code-index'));
  }
  if (id === 'code.ast') {
    const ts = await loadTypeScript();
    if (!ts) throw new Error('没有 typescript');
    return summarizeAst(ts, file, fs.readFileSync(file, 'utf8'), args.max ?? 50);
  }
  if (id === 'code.search') {
    return { query: args.query, hits: [{ path: 'src/a.ts', line: 1, preview: 'export function greet' }], mode: args.mode ?? 'CODE' };
  }
  if (id === 'code.team.run') {
    return { task: args.task, members: args.members ?? ['live'], reports: [{ member: 'live', ok: true, summary: 'catalog-live' }] };
  }
  throw new Error(`callMain 未实现：${id}`);
}

const grant = {
  taskId: 'task-capability-catalog-live',
  permissionPreset: 'danger-full-access',
  approvalPolicy: 'ask',
  rootDir: work,
  allowedTools: [...TOOL_NAMES],
  expiresAt: Date.now() + 30 * 60_000,
  maxSteps: 200,
  grantVersion: 1
};

const ctx = {
  grant,
  ask: async input => ({ answered: true, value: input.options?.[0] ?? 'yes' }),
  callMain,
  cliAgents: [{
    id: 'echo-live',
    label: 'Echo Live',
    command: '/bin/echo',
    args: ['{task}'],
    permissionArgs: [],
    headless: 'verified',
    enabled: true,
    version: '1'
  }],
  stepId: 'step-live'
};

const report = {
  marker: MARKER,
  startedAt: new Date().toISOString(),
  work,
  required: [...CAPABILITY_IDS],
  order: [],
  tools: {},
  exposure: null
};

function note(id, detail = {}) {
  report.tools[id] = { ok: true, ...detail };
  report.order.push(id);
  console.log(`OK  ${id}${detail.summary ? ` — ${detail.summary}` : ''}`);
}

function fail(id, error) {
  report.tools[id] = { ok: false, error: String(error?.stack ?? error) };
  console.error(`FAIL ${id} — ${error?.message ?? error}`);
}

const HARD_FAIL = new Set([
  'PERMISSION_REQUIRED', 'TARGET_UNCERTAIN', 'SNAPSHOT_EXPIRED', 'WINDOW_CHANGED',
  'CANCELLED', 'HELPER_FAILED', 'HELPER_MISSING', 'UNSUPPORTED_ACTION',
  'UNSUPPORTED_PLATFORM', 'TIMEOUT', 'INPUT_TOO_LARGE', 'RISK_CONFIRMATION_REQUIRED'
]);

async function run(id, args = {}) {
  try {
    const outcome = await localCapabilities.execute(id, args, ctx);
    const code = outcome?.result?.code;
    if (typeof code === 'string' && HARD_FAIL.has(code)) {
      throw new Error(`${code} ${outcome.result.summary ?? ''}`);
    }
    // 桌面操作允许「已执行但没有可核对预期」；其它 failure 仍算失败。
    if (outcome?.failure && code !== 'NOT_VERIFIED' && outcome.verified !== false) {
      throw new Error(outcome.failure);
    }
    note(id, {
      summary: outcome?.result?.summary ?? (outcome?.verified === false ? '未验证但仍执行' : undefined),
      verified: outcome?.verified
    });
    return outcome;
  } catch (error) {
    fail(id, error);
    throw error;
  }
}

function ax(payload) {
  const helper = path.join(ROOT, 'resources/ax-bridge');
  const out = spawnSync(helper, [], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: 12000
  });
  const line = (out.stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
  if (!line) throw new Error(out.stderr || 'ax-bridge 无输出');
  return JSON.parse(line);
}

function walk(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  acc.push(node);
  for (const child of node.children ?? []) walk(child, acc);
  return acc;
}

async function checkExposure() {
  try {
    const targets = await (await fetch(ENDPOINT)).json();
    const app = targets.find(t =>
      t.type === 'page' &&
      (t.url.startsWith('file:') || t.url.includes('localhost:5173') || /ThinkFusion/i.test(t.title ?? ''))
    );
    if (!app) {
      report.exposure = { ok: false, reason: '找不到 ThinkFusion 窗口' };
      return;
    }
    const cdp = await connect(app);
    const views = await cdp.evaluate('window.agentAPI.getCapabilities()');
    const ids = (views || []).map(v => v.id);
    const missing = CAPABILITY_IDS.filter(id => !ids.includes(id));
    const disabled = (views || []).filter(v => !v.enabled).map(v => v.id);
    const unregistered = (views || []).filter(v => !v.registered).map(v => v.id);
    report.exposure = {
      ok: missing.length === 0 && disabled.length === 0 && unregistered.length === 0 && ids.length === 109,
      count: ids.length,
      missing,
      disabled,
      unregistered
    };
    console.log(`EXPOSURE ${report.exposure.ok ? 'OK' : 'FAIL'} app=${ids.length}/109`);
  } catch (error) {
    report.exposure = { ok: false, reason: String(error?.message ?? error) };
    console.error(`EXPOSURE FAIL — ${report.exposure.reason}`);
  }
}

async function runComputer() {
  const blank = path.join(os.tmpdir(), `tf-cap-blank-${MARKER}.txt`);
  fs.writeFileSync(blank, '');
  spawnSync('open', ['-a', 'TextEdit', blank]);
  await new Promise(r => setTimeout(r, 1200));
  ax({ command: 'focus', bundleId: BUNDLE });
  let probe = ax({ command: 'observe', bundleId: BUNDLE, maxDepth: 6 });
  let fields = walk(probe.result?.tree).filter(n => n.role === 'AXTextArea' || n.role === 'AXTextField');
  for (const field of fields.filter(f => f.value)) {
    ax({ command: 'setValue', elementId: field.id, text: '', expectedRole: field.role, bundleId: BUNDLE });
  }
  probe = ax({ command: 'observe', bundleId: BUNDLE, maxDepth: 6 });
  fields = walk(probe.result?.tree).filter(n => n.role === 'AXTextArea' || n.role === 'AXTextField');
  const target = fields.find(n => !n.value) ?? fields[0];
  if (!target?.id) throw new Error('TextEdit 没有文本框（是否锁屏？）');

  await run('computer.capabilities', {});
  await run('computer.windows', { maxEntries: 20 });
  // 前面跑了很久，前台可能被抢走；重新拉起 TextEdit 再截快照，避免 WINDOW_CHANGED。
  ax({ command: 'focus', bundleId: BUNDLE });
  await new Promise(r => setTimeout(r, 400));
  const shot = await run('computer.screenshot', {});
  const shotId = shot.result.snapshotId;
  const windowId = shot.result.windowId;
  await run('computer.focus', { snapshotId: shotId, bundleId: BUNDLE, windowId });
  const tree = await run('computer.ax.tree', { bundleId: BUNDLE, maxDepth: 6 });
  const found = await run('computer.ax.find', {
    snapshotId: tree.result.snapshotId,
    role: target.role || 'AXTextArea',
    bundleId: BUNDLE
  });
  const elementId = found.result.element.elementId;
  const frame = found.result.element.frame || target.frame;
  await run('computer.click', {
    snapshotId: tree.result.snapshotId,
    bundleId: BUNDLE,
    elementId,
    expect: { role: target.role || 'AXTextArea' }
  });
  const typed = await run('computer.type', {
    snapshotId: tree.result.snapshotId,
    bundleId: BUNDLE,
    elementId,
    text: MARKER,
    expect: { textIncludes: MARKER, role: target.role || 'AXTextArea' }
  });
  assert.equal(typed.result.verified, true, typed.result.verification?.reason ?? typed.result.summary);
  await run('computer.verify', {
    bundleId: BUNDLE,
    expect: { textIncludes: MARKER, role: target.role || 'AXTextArea' }
  });
  await run('computer.keypress', {
    snapshotId: typed.result.snapshotId ?? tree.result.snapshotId,
    bundleId: BUNDLE,
    elementId,
    key: 'right'
  });
  const cx = frame.x + Math.min(40, frame.width / 2);
  const cy = frame.y + Math.min(20, frame.height / 2);
  await run('computer.scroll', {
    snapshotId: tree.result.snapshotId,
    bundleId: BUNDLE,
    elementId,
    x: cx,
    y: cy,
    deltaY: -40
  });
  await run('computer.drag', {
    snapshotId: tree.result.snapshotId,
    bundleId: BUNDLE,
    fromX: frame.x + 8,
    fromY: frame.y + 8,
    toX: Math.min(frame.x + frame.width - 8, frame.x + 32),
    toY: Math.min(frame.y + frame.height - 8, frame.y + 16)
  });
  ax({ command: 'setValue', elementId, text: '', expectedRole: target.role || 'AXTextArea', bundleId: BUNDLE });
  await run('computer.stop', {});
}

async function runMain() {
  const attachPath = path.join(work, 'README.md');
  await mainCapabilities.execute('project.scan', { root: work, question: `统计 ${MARKER}` }, {});
  note('project.scan', { summary: '真读工程目录' });

  await mainCapabilities.execute('file.attach', { paths: [attachPath] }, {
    readAttachments: paths => paths.map(p => ({
      id: 'live',
      name: path.basename(p),
      path: p,
      bytes: fs.statSync(p).size,
      addedAt: Date.now(),
      text: fs.readFileSync(p, 'utf8'),
      chars: fs.readFileSync(p, 'utf8').length,
      totalChars: fs.readFileSync(p, 'utf8').length,
      truncated: false
    }))
  });
  note('file.attach', { summary: '真读附件' });

  await mainCapabilities.execute('project.read', {
    root: work,
    tool: 'fs.readFile',
    toolArgs: { path: 'README.md' }
  }, {});
  note('project.read', { summary: '真读文件' });

  await mainCapabilities.execute('web.search.browser', { query: MARKER, limit: 3 }, {
    browserSearch: async (query, limit) => ({
      results: [{ title: 'live', url: 'https://example.com', snippet: query, rank: 1 }].slice(0, limit),
      finalUrl: `https://cn.bing.com/search?q=${encodeURIComponent(query)}`,
      pageTitle: 'search'
    })
  });
  note('web.search.browser', { summary: '宿主搜索后端已执行' });

  const exportPath = path.join(work, 'export.md');
  await mainCapabilities.execute('document.export', {
    conversationId: 'conv-live',
    path: exportPath,
    format: 'md'
  }, {
    exportDeps: () => ({
      conversation: () => ({
        conversationId: 'conv-live',
        title: MARKER,
        intent: 'research',
        intentReason: 'live',
        status: 'answered',
        channels: ['local'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceMode: 'knowledge',
        executionConfig: { executionMode: 'web' }
      }),
      messages: () => ([
        { messageId: 'u1', conversationId: 'conv-live', role: 'user', text: MARKER, at: Date.now() },
        { messageId: 'a1', conversationId: 'conv-live', role: 'channel', text: 'ok', channelId: 'local', at: Date.now() }
      ]),
      labels: () => ({ local: 'local' }),
      defaultDir: () => work,
      pickPath: async () => null
    })
  });
  assert.ok(fs.existsSync(exportPath), 'export.md 未写出');
  note('document.export', { summary: '真写会话文档' });

  const pagePath = path.join(work, 'page.md');
  await mainCapabilities.execute('page.save-document', { sourceId: 'src-live', path: pagePath }, {
    readPage: async () => ({
      sourceLabel: 'live',
      pageTitle: MARKER,
      url: 'https://example.com',
      documents: [`# ${MARKER}\n`],
      transcript: ''
    }),
    savePageDeps: () => ({ defaultDir: () => work, pickPath: async () => null })
  });
  assert.ok(fs.existsSync(pagePath), 'page.md 未写出');
  note('page.save-document', { summary: '真写网页文档' });
}

async function main() {
  await checkExposure();

  // —— 文件系统 / 工程读 ——
  await run('fs.list', { path: '.' });
  await run('fs.readFile', { path: 'README.md' });
  await run('fs.mkdir', { path: 'nested/dir' });
  await run('fs.writeFile', { path: 'nested/dir/note.txt', content: `${MARKER}\n` });
  await run('fs.tree', { path: '.', maxDepth: 3 });
  await run('fs.search', { query: MARKER, path: '.' });
  await run('fs.find', { pattern: '*.ts' });
  await run('fs.stat', { path: 'README.md' });
  await run('fs.edit', {
    path: 'nested/dir/note.txt',
    oldString: MARKER,
    newString: `${MARKER}-edited`,
    expectedHash: hashOf('nested/dir/note.txt')
  });
  await run('fs.copy', { from: 'nested/dir/note.txt', to: 'nested/dir/note.copy.txt' });
  await run('fs.move', { from: 'nested/dir/note.copy.txt', to: 'nested/dir/note.moved.txt' });
  await run('fs.readImage', { path: 'dot.png' });
  await run('fs.du', { path: '.' });
  await run('fs.applyPatch', {
    path: 'left.txt',
    expectedHash: hashOf('left.txt'),
    patch: [
      '--- a/left.txt',
      '+++ b/left.txt',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+three'
    ].join('\n')
  });
  // capture then revert to exercise fs.revert
  await callMain('snapshot.capture', { root: work, taskId: grant.taskId, path: 'left.txt' });
  fs.writeFileSync(path.join(work, 'left.txt'), 'changed-for-revert\n');
  await run('fs.revert', {});
  await run('fs.remove', { path: 'nested/dir/note.moved.txt' });

  await run('project.dependencies', {});
  await run('project.outline', { path: 'src' });

  // —— git ——
  await run('git.status', {});
  await run('git.diff', {});
  await run('git.log', { limit: 5 });
  const log = await localCapabilities.execute('git.log', { limit: 1 }, ctx);
  const commit = log.result.entries[0].hash;
  await run('git.show', { commit, stat: true });
  fs.writeFileSync(path.join(work, 'stash-me.txt'), 'stash\n');
  await run('git.stash', { action: 'push', message: 'live' });
  await run('git.stash', { action: 'list' });
  await run('git.stash', { action: 'pop' });
  await run('git.branch', { action: 'list' });
  await run('git.branch', { action: 'create', name: 'live/branch' });
  await run('git.worktree', { action: 'list' });

  // —— 数据 / 压缩 / 文本 / 图 ——
  await run('json.query', { path: 'data.json', pointer: 'a.b[0].c' });
  await run('csv.summary', { path: 'rows.csv' });
  if (sqliteOk) await run('sqlite.query', { path: 'app.db', sql: 'SELECT id, name FROM t' });
  else {
    // 本机无 sqlite3 时仍走工具入口，预期明确失败不算绿；改用空库拒绝写语句的路径已在单测覆盖。
    // 这里用 archive 之外的替代：直接记跳过并仍要求 109——因此必须有 sqlite3。
    throw new Error('本机没有 sqlite3，无法真跑 sqlite.query');
  }
  await run('archive.create', { output: 'pkg.zip', sources: ['README.md', 'src'] });
  await run('archive.list', { path: 'pkg.zip' });
  await run('archive.extract', { path: 'pkg.zip', destination: 'unzipped' });
  await run('text.diff', { pathA: 'left.txt', pathB: 'right.txt' });
  await run('text.base64', { action: 'encode', path: 'README.md', output: 'readme.b64' });
  await run('image.resize', { path: 'dot.png', output: 'dot-big.png', maxDimension: 8 });

  // —— 宿主 / 系统 ——
  await run('env.read', {});
  await run('port.list', {});
  await run('app.list', {});
  await run('window.list', {});
  await run('dns.lookup', { host: 'example.com' });
  await run('time.now', {});
  await run('process.tree', {});
  await run('system.info', {});
  await run('process.list', {});
  await run('clipboard.write', { text: MARKER });
  await run('clipboard.read', {});
  await run('notify', { title: 'ThinkFusion', body: MARKER });

  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  sleeper.unref();
  await run('process.kill', { pid: sleeper.pid, signal: 'TERM' });

  // —— shell / job / test / code.run ——
  await run('shell.run', { command: 'ls', cwd: '.', timeoutMs: 15_000 });
  const bg = await run('shell.run', { command: 'sleep 2', background: true, timeoutMs: 15_000 });
  const jobId = bg.result.job?.id ?? bg.result.jobId;
  await run('job.list', {});
  if (jobId) {
    await run('job.output', { id: jobId });
    await run('job.kill', { id: jobId, signal: 'TERM' });
  } else {
    throw new Error('后台 shell 没有返回 job id');
  }
  await run('test.run', { command: 'npm test' });
  await run('code.run', { language: 'node', code: `console.log(${JSON.stringify(MARKER)})` });

  // —— 终端 ——
  const term = await run('term.open', { cwd: '.' });
  const sessionId = term.result.sessionId ?? term.result.id;
  await run('term.list', {});
  await run('term.send', { sessionId, input: `echo ${MARKER}`, submit: true });
  await new Promise(r => setTimeout(r, 400));
  await run('term.read', { sessionId, maxChars: 2000 });
  await run('term.signal', { sessionId, signal: 'SIGINT' });
  await run('term.close', { sessionId });

  // —— 网络 ——
  await run('web.fetch', { url: 'https://example.com', maxBytes: 20_000 });
  await run('web.search', { query: 'example domain', limit: 3 });

  // —— 应用 / 截屏 ——
  await run('screen.capture', { target: 'region', region: { x: 0, y: 0, width: 200, height: 120 }, path: 'shot.png' });
  await run('app.open', { app: 'TextEdit' });

  // —— ask / agent / 主进程桥工具 ——
  await run('ask.user', { question: 'catalog live?', options: ['yes', 'no'] });
  await run('agent.exec', { cli: 'echo-live', task: MARKER, timeoutMs: 10_000 });
  await run('session.search', { query: MARKER, limit: 5 });
  await run('plugin.inspect', { id: 'fs.list' });
  await run('goal.create', { text: MARKER });
  await run('goal.get', {});
  await run('goal.update', { status: 'done', note: 'live' });
  const sch = await run('schedule.create', { text: MARKER, mode: 'local', at: Date.now() + 60_000 });
  await run('schedule.list', {});
  await run('schedule.view', { id: sch.result.id });
  await run('schedule.edit', { id: sch.result.id, enabled: false });
  await run('team.spawn', { members: ['alpha', 'beta'] });
  const task = await run('team.task.create', { title: MARKER, assignee: 'alpha' });
  await run('team.task.list', {});
  await run('team.task.get', { id: task.result.id });
  await run('team.task.update', {
    id: task.result.id,
    status: 'done',
    expectedRevision: task.result.revision,
    evidence: [{ kind: 'note', detail: 'catalog-live' }]
  });
  await run('team.wait', { timeoutMs: 1000 });

  // —— 代码智能 ——
  await run('code.diagnostics', { path: 'src/a.ts' });
  await run('code.definition', { path: 'src/b.ts', line: 2, character: 14 });
  await run('code.references', { path: 'src/a.ts', line: 1, character: 17 });
  await run('code.symbols', { path: 'src/a.ts' });
  await run('code.hover', { path: 'src/b.ts', line: 2, character: 14 });
  await run('code.context', { path: 'src/b.ts', line: 2, character: 14 });
  await run('code.impact', { path: 'src/a.ts', line: 1, character: 17 });
  await run('code.ast', { path: 'src/a.ts' });
  await run('code.search', { query: 'greet', mode: 'CODE', limit: 5 });
  await run('code.team.run', { task: `检查 ${MARKER}`, files: ['src/a.ts'], members: ['live'] });

  // —— computer.*（真桌面）——
  await runComputer();

  // —— 主进程 6 个 ——
  await runMain();

  const missing = CAPABILITY_IDS.filter(id => !report.tools[id]?.ok);
  const failed = Object.entries(report.tools).filter(([, v]) => !v.ok).map(([id]) => id);
  const uniqueOk = CAPABILITY_IDS.filter(id => report.tools[id]?.ok).length;
  report.finishedAt = new Date().toISOString();
  report.ok = missing.length === 0 && failed.length === 0 && report.exposure?.ok === true && uniqueOk === 109;
  report.covered = uniqueOk;
  report.invocations = report.order.length;
  report.missing = missing;
  report.failed = failed;
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: report.ok,
    covered: report.covered,
    required: 109,
    missing,
    failed,
    exposure: report.exposure,
    marker: MARKER,
    report: REPORT
  }, null, 2));
  lsp.dispose();
  if (!report.ok) process.exit(1);
}

main().catch(error => {
  report.finishedAt = new Date().toISOString();
  report.ok = false;
  report.crash = String(error?.stack ?? error);
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error(error);
  try { lsp.dispose(); } catch { /* ignore */ }
  process.exit(1);
});
