/**
 * V2.1 Phase E：工程理解的结构关系。
 *
 * 这一组对应产品定义 4.1 里的 Symbol Search / Dependency / Change Impact，
 * 以及任务书「不要未经论证就引入完整 AST」的约束——全是正则与静态 import
 * 解析，结论里必须能看出识别方法。
 *
 * Run with: npm run test:analysis
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisKindsFor,
  analyzeForQuestion,
  architectureOf,
  buildModuleGraph,
  extractSymbols,
  findCallSites,
  guessTarget,
  impactOf,
  resolveSpecifier
} from '../out-test/main/engineering/analysis.js';

const files = [
  {
    rel: 'src/index.ts',
    content: [
      "import { boot } from './service';",
      "import fs from 'node:fs';",
      '',
      'export const virtualThread = { limit: 1024 };',
      'export function connectionPool(size: number): string[] {',
      '  return Array.from({ length: size }, () => "conn");',
      '}',
      ''
    ].join('\n')
  },
  {
    rel: 'src/service.ts',
    content: [
      "import { connectionPool, virtualThread } from './index';",
      "import { helper } from '../lib/helper';",
      '',
      'export class Service {',
      '  boot(): number {',
      '    return connectionPool(virtualThread.limit).length;',
      '  }',
      '}',
      ''
    ].join('\n')
  },
  {
    rel: 'lib/helper.ts',
    content: ['export interface Helper { id: string }', 'export function helper(): Helper { return { id: "x" }; }'].join('\n')
  }
];

test('能从文件里认出函数、类、接口、常量的定义位置', () => {
  const hits = files.flatMap(extractSymbols);
  const names = hits.map(hit => `${hit.kind}:${hit.name}`);
  assert.ok(names.includes('function:connectionPool'), JSON.stringify(names));
  assert.ok(names.includes('class:Service'));
  assert.ok(names.includes('interface:Helper'));
  assert.ok(names.includes('const:virtualThread'));
  const pool = hits.find(hit => hit.name === 'connectionPool');
  assert.equal(pool.path, 'src/index.ts');
  assert.equal(pool.line, 5, '行号要指向定义那一行');
});

test('相对路径能解析成工程内文件，外部包单独计数', () => {
  const known = new Set(files.map(file => file.rel));
  assert.equal(resolveSpecifier('src/service.ts', './index', known), 'src/index.ts');
  assert.equal(resolveSpecifier('src/service.ts', '../lib/helper', known), 'lib/helper.ts');
  assert.equal(resolveSpecifier('src/service.ts', 'node:fs', known), null);

  const graph = buildModuleGraph(files);
  assert.equal(graph.nodes.length, 3);
  const edge = graph.edges.find(item => item.from === 'src/service.ts' && item.to === 'src/index.ts');
  assert.ok(edge, 'service 依赖 index 这条边要有');
  assert.equal(edge.line, 1);
  assert.ok(graph.external.some(item => item.specifier === 'node:fs'));
});

test('改 index.ts 的直接影响是 service.ts，间接波及经由它', () => {
  const graph = buildModuleGraph(files);
  const impact = impactOf(graph, 'src/index.ts');
  assert.deepEqual(impact.direct.map(item => item.from), ['src/service.ts']);
  // 没有文件 import service.ts，所以间接为空——不编造波及面。
  assert.deepEqual(impact.indirect, []);

  const wider = buildModuleGraph([
    ...files,
    { rel: 'src/app.ts', content: "import { Service } from './service';" }
  ]);
  const second = impactOf(wider, 'src/index.ts');
  assert.deepEqual(second.direct.map(item => item.from), ['src/service.ts']);
  assert.ok(second.indirect.some(item => item.path === 'src/app.ts' && item.via === 'src/service.ts'));
});

test('调用点能找出来，但不会把定义本身算成调用', () => {
  const sites = findCallSites(files, 'connectionPool');
  assert.equal(sites.length, 1, JSON.stringify(sites));
  assert.equal(sites[0].path, 'src/service.ts');
  assert.equal(sites[0].line, 6);
});

test('结构概览给顶层目录与可能入口', () => {
  const arch = architectureOf(files);
  assert.ok(arch.directories.some(item => item.path === 'src' && item.files === 2));
  assert.ok(arch.directories.some(item => item.path === 'lib'));
  assert.ok(arch.entries.includes('src/index.ts'));
});

test('问题决定算哪几类关系，至少给符号索引', () => {
  assert.deepEqual(analysisKindsFor('分析这个项目的结构').sort(), ['architecture']);
  assert.ok(analysisKindsFor('帮我改 index.ts 会不会影响别的地方').includes('impact'));
  assert.ok(analysisKindsFor('谁调用了 connectionPool').includes('callers'));
  assert.deepEqual(analysisKindsFor('你好'), ['symbols'], '没命中任何结构词时至少给符号索引');
});

test('目标文件或符号能从问题里认出来', () => {
  const symbols = files.flatMap(extractSymbols);
  assert.equal(guessTarget('改 src/index.ts 会怎样', files, symbols).file, 'src/index.ts');
  assert.equal(guessTarget('connectionPool 在哪里定义', files, symbols).symbol, 'connectionPool');
  assert.deepEqual(guessTarget('这个项目怎么样', files, symbols), {});
});

test('材料里写明识别方法，不把正则结果说成精确结论', () => {
  const text = analyzeForQuestion(files, '分析这个项目结构，并说明谁调用了 connectionPool');
  assert.match(text, /【结构概览】/);
  assert.match(text, /【调用点】/);
  // 问「谁调用」时不硬塞整份符号索引，但必须给出「定义在哪」+「谁在调」。
  assert.match(text, /定义：src\/index\.ts:5/);
  assert.match(text, /src\/service\.ts:6/);

  // 问符号本身时才展开索引，并写明是正则识别的。
  const symbols = analyzeForQuestion(files, '这个工程有哪些函数和接口定义');
  assert.match(symbols, /【符号索引（按正则识别/);
  assert.match(symbols, /src\/index\.ts:5/);
});

test('没指明目标时不硬编影响面，直接说清缺什么', () => {
  const text = analyzeForQuestion(files, '这个改动会影响什么');
  assert.match(text, /没有指明具体文件/);
  assert.doesNotMatch(text, /直接依赖：/);
});
