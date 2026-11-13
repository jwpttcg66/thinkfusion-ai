/**
 * 本地代码索引：SQLite + FTS5 + AST 图 + 记忆 + Link + 上下文。
 *
 * 这是 V3.0 在没有 CGC/Graphiti/Neo4j 运行环境时的回退实现验收：
 * 真实临时 TS 工程、真实 node:sqlite、真实 FTS5，不用 Mock。
 *
 * Run with: npm run test:code-index
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodeIndexStore, buildFtsQuery } from '../out-test/main/code-index/store.js';
import { indexProject, scanSourceFilesDetailed } from '../out-test/main/code-index/indexer.js';
import { CodeIndexService } from '../out-test/main/code-index/service.js';
import { PlanSchema } from '../out/shared/contracts.js';
import { localCapabilities } from '../out-test/agent/local-plugins.js';
import {
  assembleContext,
  linkSymbolToMemory,
  remember,
  retrieve,
  routeMode
} from '../out-test/main/code-index/retrieval.js';

let root;
let dbFile;
let store;
const projectId = 'test-project';

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-code-index-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.ts'), [
    '/** 用户登录失败时的订单处理；错误码 AUTH_401。 */',
    'export class OrderService {',
    '  processOrder(id: string): number {',
    '    return charge(id);',
    '  }',
    '}',
    'export function charge(id: string): number {',
    '  return id.length;',
    '}'
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/b.ts'), [
    "import { OrderService, charge } from './a';",
    'export function run(): number {',
    "  const service = new OrderService();",
    "  return service.processOrder('x') + charge('y');",
    '}'
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src/notes.md'), '登录 说明：AUTH_401 是错误码。');
  dbFile = path.join(root, 'index.sqlite');
  store = new CodeIndexStore(dbFile);
});

after(() => {
  store?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('索引真实 TS 工程：节点、CONTAINS / IMPORTS / CALLS 都能查', async () => {
  const result = await indexProject(store, root, projectId);
  assert.equal(result.files, 2);
  assert.ok(result.nodes >= 4, JSON.stringify(result));
  assert.ok(result.edges >= 4, JSON.stringify(result));

  const symbols = store.findSymbols(projectId, 'charge');
  assert.ok(symbols.length >= 1);
  const charge = symbols.find(node => node.nodeType === 'Function');
  assert.ok(charge, 'charge 函数节点不存在');

  const incoming = store.getIncoming(projectId, charge.nodeId, ['CALLS']);
  assert.ok(incoming.length >= 1, '没有找到 charge 的调用者');

  const order = store.findSymbols(projectId, 'processOrder')[0];
  assert.ok(order);
  const outgoing = store.getOutgoing(projectId, order.nodeId, ['CALLS']);
  assert.ok(outgoing.some(edge => edge.targetNodeId === charge.nodeId));

  const fileNode = store.findSymbols(projectId, 'a.ts').find(node => node.nodeType === 'File');
  assert.ok(fileNode);
  const imports = store.getOutgoing(projectId, store.findSymbols(projectId, 'b.ts').find(node => node.nodeType === 'File').nodeId, ['IMPORTS']);
  assert.ok(imports.length >= 1, 'b.ts -> a.ts 的 import 边不存在');
});

test('中文两字走 LIKE 回退，三字走 trigram，标识符可查', () => {
  const two = store.search(projectId, '登录', { limit: 10 });
  assert.ok(two.length >= 1, '中文两字没有回退命中');
  assert.equal(two[0].source, 'like');

  const three = store.search(projectId, '登录失败', { limit: 10 });
  assert.ok(three.length >= 1, '中文三字没有命中');

  const ident = store.search(projectId, 'OrderService', { limit: 10 });
  assert.ok(ident.length >= 1, '标识符没有命中');

  const errorCode = store.search(projectId, 'AUTH_401', { limit: 10 });
  assert.ok(errorCode.length >= 1, '错误码没有命中');

  const filtered = store.search(projectId, '登录', { filePatterns: ['src/a.ts'], limit: 10 });
  assert.ok(filtered.every(hit => hit.filePath === 'src/a.ts'));
});

test('FTS 查询被转义，不把用户原文当 MATCH 语法', () => {
  assert.equal(buildFtsQuery('charge" OR *'), '"charge" AND "OR" AND "*"');
  assert.doesNotThrow(() => store.search(projectId, 'charge" OR *', { limit: 5 }));
  assert.doesNotThrow(() => store.search(projectId, '登录'), 'LIKE 回退不应抛');
});

test('影响分析沿 incoming 调用边向上走', () => {
  const charge = store.findSymbols(projectId, 'charge').find(node => node.nodeType === 'Function');
  const impact = store.impact(projectId, charge.nodeId, 3);
  assert.ok(impact.nodes.length >= 2);
  assert.ok(impact.nodes.some(node => node.name === 'processOrder' || node.name === 'run'));
});

test('记忆：candidate 默认、confirmed 有来源、检索按确认状态排序', () => {
  const candidate = remember(store, {
    projectId,
    kind: 'decision',
    title: '订单处理必须幂等',
    content: '历史问题：重复扣款。',
    source: 'debate',
    confidence: 0.6
  });
  assert.equal(candidate.status, 'candidate');

  const confirmed = remember(store, {
    projectId,
    kind: 'constraint',
    title: '错误码 AUTH_401',
    content: '登录失败必须返回 AUTH_401。',
    source: 'user',
    sourceRef: 'message-1',
    status: 'confirmed',
    confidence: 0.95
  });
  assert.equal(confirmed.status, 'confirmed');

  assert.throws(
    () => remember(store, { projectId, kind: 'fact', title: 'x', content: 'x', source: '   ' }),
    /MEMORY_SOURCE_REQUIRED/
  );

  const hits = store.searchMemory(projectId, '登录');
  assert.ok(hits.length >= 1);
});

test('Code-Memory Link：SymbolKey 不含文件路径，移动文件不换 Key', () => {
  const order = store.findSymbols(projectId, 'OrderService')[0];
  assert.ok(order);
  const fact = store.listMemory(projectId, 'confirmed')[0];
  assert.ok(fact);

  const link = linkSymbolToMemory(store, {
    projectId,
    language: order.language,
    filePath: order.filePath,
    qualifiedName: order.qualifiedName,
    kind: order.nodeType,
    startLine: order.startLine,
    endLine: order.endLine,
    fingerprint: 'sig:OrderService',
    memoryEntityId: fact.factId,
    linkType: 'RULE_CONSTRAINS_CODE',
    confidence: 0.8
  });
  assert.ok(!link.symbolKey.includes(order.filePath), 'SymbolKey 不应包含文件路径');
  assert.ok(link.symbolLocator.includes(order.filePath));
  assert.equal(store.linksForMemory(projectId, fact.factId).length, 1);
  assert.equal(store.linksForSymbol(projectId, link.symbolKey).length, 1);
});

test('Generation：pending 不能被当成 READY，旧 READY 保留', () => {
  const current = store.currentGeneration(projectId);
  assert.ok(current);

  const pending = store.beginGeneration(projectId, 'test-pending');
  assert.equal(store.currentGeneration(projectId), current);
  const state = store.generationState(projectId, pending);
  assert.equal(state.status, 'building');

  store.commitGeneration(projectId, pending);
  assert.equal(store.currentGeneration(projectId), pending);
  assert.equal(store.generationState(projectId, current).status, 'superseded');
});

test('删除文件后节点 / 文档 / 文件状态都清理', () => {
  const before = store.findSymbols(projectId, 'charge');
  assert.ok(before.length > 0);
  store.deleteFile(projectId, 'src/a.ts');
  assert.equal(store.findSymbols(projectId, 'charge').length, 0);
  assert.equal(store.search(projectId, '登录失败').filter(hit => hit.filePath === 'src/a.ts').length, 0);
  assert.equal(store.fileHash(projectId, 'src/a.ts'), null);
});

test('KnowledgeRouter 规则与 Context Assembly 预算', () => {
  assert.equal(routeMode('谁调用了 charge'), 'CODE');
  assert.equal(routeMode('为什么以前选择这个方案'), 'MEMORY');
  assert.equal(routeMode('这个历史约束会影响哪些代码'), 'HYBRID');

  const result = retrieve(store, projectId, '为什么订单处理要幂等', { mode: 'HYBRID' });
  const context = assembleContext(result, 1200);
  assert.ok(context.text.length <= 1200 + 200);
  assert.ok(context.text.includes('检索模式'));
  assert.ok(context.used.length >= 0);
});


test('CodeIndexService：索引/摘要/检索/影响/记忆/Link 走同一入口', async () => {
  const service = new CodeIndexService(path.join(root, 'service.sqlite'));
  try {
    const indexed = await service.index(path.join(root, 'src'));
    assert.ok(indexed.files >= 2);
    const summary = await service.summary(path.join(root, 'src'));
    assert.equal(summary.generation, indexed.generation);
    assert.ok(summary.nodes > 0);

    const search = await service.retrieve(path.join(root, 'src'), 'OrderService', { mode: 'CODE' });
    assert.ok(search.items.length > 0);

    const impact = await service.impact(path.join(root, 'src'), 'a.ts', 4, 2);
    assert.ok(impact.node);

    const fact = await service.remember(path.join(root, 'src'), {
      kind: 'constraint',
      title: '订单幂等',
      content: '重试不能重复扣款',
      source: 'user',
      status: 'confirmed'
    });
    assert.equal(fact.status, 'confirmed');
    const memories = await service.memory(path.join(root, 'src'), '订单');
    assert.ok(memories.length >= 1);
    const link = await service.linkMemory(path.join(root, 'src'), {
      filePath: 'a.ts',
      line: 2,
      memoryEntityId: memories[0].factId
    });
    assert.ok(link.symbolKey.startsWith('p_'));
  } finally {
    service.close();
  }
});

test('Outbox：幂等入队、claim、完成、失败重试', () => {
  const input = {
    taskId: 'task-1',
    projectId,
    generation: 1,
    filePath: 'src/a.ts',
    operation: 'upsert',
    payloadHash: 'hash-1'
  };
  assert.equal(store.enqueueOutbox(input), true);
  assert.equal(store.enqueueOutbox(input), false, '同一个 taskId 不应重复入队');
  const claimed = store.claimOutbox(projectId, 10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].taskId, 'task-1');
  store.failOutbox('task-1', 'boom', 2);
  assert.equal(store.listOutbox(projectId)[0].status, 'retry');
  store.failOutbox('task-1', 'boom again', 2);
  assert.equal(store.listOutbox(projectId)[0].status, 'failed');
});


test('code.search 能写进计划，且是只读能力', () => {
  const plan = {
    protocol: 'desktop-agent/v1',
    type: 'plan',
    taskId: 'task-1',
    roundId: 'round-1',
    title: '检索',
    description: '查代码',
    steps: [{ id: 's1', tool: 'code.search', args: { query: 'OrderService', mode: 'CODE', context: true } }],
    completion: { condition: '有结果' }
  };
  assert.equal(PlanSchema.safeParse(plan).success, true);
});


test('code.search Runtime 插件把授权根注入主进程，模型不能自己换根', async () => {
  const calls = [];
  const grant = {
    taskId: 'task-search',
    permissionPreset: 'read-only',
    approvalPolicy: 'ask',
    rootDir: path.join(root, 'src'),
    allowedTools: ['code.search'],
    expiresAt: Date.now() + 60_000,
    maxSteps: 10,
    grantVersion: 1
  };
  const outcome = await localCapabilities.execute(
    'code.search',
    { query: 'OrderService', mode: 'CODE' },
    {
      grant,
      callMain: async (id, args) => {
        calls.push({ id, args });
        return { items: [], sources: { graph: false, fullText: false, memory: false, vector: false }, warnings: [], stale: false };
      }
    }
  );
  assert.equal(outcome.error ?? null, null);
  assert.equal(calls[0].id, 'code.search');
  assert.equal(calls[0].args.root, grant.rootDir);
  assert.equal(calls[0].args.query, 'OrderService');
});


test('ensureFresh：文件改动后下一次检索自动重建，不返回旧结果', async () => {
  const service = new CodeIndexService(path.join(root, 'fresh.sqlite'));
  try {
    await service.index(path.join(root, 'src'));
    assert.equal((await service.retrieve(path.join(root, 'src'), 'AUTH_777', { mode: 'CODE' })).items.length, 0);

    const a = fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8');
    fs.writeFileSync(path.join(root, 'src/a.ts'), `${a}
// 新错误码 AUTH_777\n`);
    const after = await service.retrieve(path.join(root, 'src'), 'AUTH_777', { mode: 'CODE' });
    assert.ok(after.items.length >= 1, '改动后的文件没有自动进入索引');
  } finally {
    service.close();
  }
});


test('Java 部分解析：类/方法节点与 CONTAINS，不生成假 CALLS', async () => {
  const javaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-java-'));
  try {
    fs.writeFileSync(path.join(javaRoot, 'OrderService.java'), [
      'package demo;',
      'import java.util.List;',
      'public class OrderService {',
      '  public int processOrder(String id) {',
      '    return charge(id);',
      '  }',
      '  private int charge(String id) { return 1; }',
      '}'
    ].join('\n'));
    const result = await indexProject(store, javaRoot, 'java-project');
    assert.equal(result.files, 1);
    const cls = store.findSymbols('java-project', 'OrderService')[0];
    assert.ok(cls);
    assert.equal(cls.nodeType, 'Class');
    const method = store.findSymbols('java-project', 'processOrder')[0];
    assert.ok(method);
    assert.equal(method.nodeType, 'Method');
    const contains = store.getOutgoing('java-project', cls.nodeId, ['CONTAINS']);
    assert.ok(contains.some(edge => edge.targetNodeId === method.nodeId));
    assert.equal(store.getIncoming('java-project', method.nodeId, ['CALLS']).length, 0, 'Java 回退不伪造 CALLS');
  } finally {
    fs.rmSync(javaRoot, { recursive: true, force: true });
  }
});


test('VectorStore：建向量后检索结果带 Vector 来源，没有 embedder 明确拒绝', async () => {
  const noEmbed = new CodeIndexService(path.join(root, 'no-embed.sqlite'));
  try {
    await noEmbed.index(path.join(root, 'src'));
    await assert.rejects(() => noEmbed.buildVectors(path.join(root, 'src')), /EMBEDDING_UNAVAILABLE/);
  } finally {
    noEmbed.close();
  }

  const service = new CodeIndexService(path.join(root, 'vector.sqlite'), {
    embedder: {
      embed: async texts => ({
        model: 'fake-minilm',
        vectors: texts.map(text => [text.includes('OrderService') ? 1 : 0, text.includes('登录') ? 1 : 0])
      })
    }
  });
  try {
    await service.index(path.join(root, 'src'));
    const built = await service.buildVectors(path.join(root, 'src'));
    assert.ok(built.count > 0);
    const status = await service.summary(path.join(root, 'src'));
    assert.equal(status.vectors, built.count);
    const result = await service.retrieve(path.join(root, 'src'), 'OrderService', { mode: 'CODE', limit: 10 });
    assert.ok(result.items.some(item => item.source === 'Vector'));
  } finally {
    service.close();
  }
});


test('deleteProject：本地索引/记忆/关联/向量一起清理', async () => {
  const service = new CodeIndexService(path.join(root, 'delete.sqlite'));
  try {
    await service.index(path.join(root, 'src'));
    const fact = await service.remember(path.join(root, 'src'), {
      kind: 'constraint', title: '删除测试', content: '删除测试', source: 'user', status: 'confirmed'
    });
    await service.linkMemory(path.join(root, 'src'), {
      filePath: 'a.ts', line: 2, memoryEntityId: fact.factId
    });
    const before = await service.summary(path.join(root, 'src'));
    assert.ok(before.nodes > 0);
    const result = await service.deleteProject(path.join(root, 'src'));
    assert.ok(result.local.nodes > 0);
    const after = await service.summary(path.join(root, 'src'));
    assert.equal(after.nodes, 0);
    assert.equal(after.files, 0);
    assert.equal(after.vectors, 0);
    assert.equal((await service.memories(path.join(root, 'src'))).length, 0);
  } finally {
    service.close();
  }
});


test('扫描截断时不删除未扫描到的旧索引', async () => {
  const truncRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-trunc-'));
  const truncStore = new CodeIndexStore(path.join(truncRoot, 'index.sqlite'));
  try {
    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      fs.writeFileSync(path.join(truncRoot, name), `export const ${name[0]} = 1;\n`);
    }
    fs.mkdirSync(path.join(truncRoot, 'target'), { recursive: true });
    fs.writeFileSync(path.join(truncRoot, 'target', 'Generated.java'), 'class Generated {}\n');

    const full = await indexProject(truncStore, truncRoot, 'trunc-project', { maxFiles: 10 });
    assert.equal(full.complete, true);
    assert.equal(full.files, 3, 'target/ 不应被当源码');

    const partial = await indexProject(truncStore, truncRoot, 'trunc-project', { maxFiles: 1 });
    assert.equal(partial.complete, false);
    assert.equal(partial.truncated, true);
    assert.ok(partial.warnings.some(item => item.includes('扫描不完整')));

    const files = truncStore.listNodes('trunc-project').filter(node => node.nodeType === 'File');
    assert.ok(files.some(node => node.filePath === 'b.ts'), '截断扫描不能删除 b.ts');
    assert.ok(files.some(node => node.filePath === 'c.ts'), '截断扫描不能删除 c.ts');
    assert.equal(files.some(node => node.filePath.startsWith('target/')), false);
  } finally {
    truncStore.close();
    fs.rmSync(truncRoot, { recursive: true, force: true });
  }
});

test('scanSourceFilesDetailed 如实报告截断', async () => {
  const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-scan-'));
  try {
    for (const name of ['a.ts', 'b.ts']) fs.writeFileSync(path.join(scanRoot, name), 'export const x = 1;\n');
    const full = await scanSourceFilesDetailed(scanRoot, { maxFiles: 10 });
    assert.equal(full.complete, true);
    assert.equal(full.truncated, false);
    assert.equal(full.files.length, 2);

    const partial = await scanSourceFilesDetailed(scanRoot, { maxFiles: 1 });
    assert.equal(partial.complete, false);
    assert.equal(partial.truncated, true);
    assert.equal(partial.files.length, 1);
  } finally {
    fs.rmSync(scanRoot, { recursive: true, force: true });
  }
});
