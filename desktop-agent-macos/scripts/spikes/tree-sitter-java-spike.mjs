#!/usr/bin/env node
/**
 * Gate 0 spike：Tree-sitter Java 在 Node 中的最小验证。
 *
 * 这个脚本刻意不进入 `src/main/code-index/` 主链路，也不写 SQLite。
 * 它只回答三个问题：
 *   1. grammar 能在当前 Node/Electron 运行时加载；
 *   2. 约定夹具能否被解析成我们需要的结构；
 *   3. 解析失败是否带位置，而不是静默成功。
 *
 * 运行：
 *   npm run spike:tree-sitter
 *   npm run spike:tree-sitter -- --json
 *
 * Electron 主进程验证：
 *   npm run spike:tree-sitter:electron
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'java');
const wasmPath = path.join(
  here,
  '..',
  '..',
  'node_modules',
  '@vscode',
  'tree-sitter-wasm',
  'wasm',
  'tree-sitter-java.wasm'
);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function lineOf(node) {
  return node.startPosition.row + 1;
}

function endLineOf(node) {
  return node.endPosition.row + 1;
}

function nameOf(node) {
  return node.childForFieldName('name')?.text ?? null;
}

function textOf(node) {
  return node.text.replace(/\s+/g, ' ').trim();
}

function collect(root) {
  const declarations = [];
  const calls = [];
  const creations = [];
  let anonymousClasses = 0;
  let lambdas = 0;
  let methodReferences = 0;
  let switchExpressions = 0;
  let annotations = 0;

  const declarationTypes = new Map([
    ['class_declaration', 'Class'],
    ['interface_declaration', 'Interface'],
    ['enum_declaration', 'Enum'],
    ['record_declaration', 'Record'],
    ['annotation_type_declaration', 'Annotation'],
    ['constructor_declaration', 'Constructor'],
    ['method_declaration', 'Method'],
    ['field_declaration', 'Field']
  ]);

  const walk = node => {
    const nodeType = declarationTypes.get(node.type);
    if (nodeType) {
      const name = nameOf(node);
      if (nodeType === 'Field') {
        const declarators = node.descendantsOfType('variable_declarator');
        for (const declarator of declarators) {
          declarations.push({
            nodeType: 'Field',
            name: declarator.childForFieldName('name')?.text ?? '',
            line: lineOf(declarator),
            endLine: endLineOf(declarator),
            modifiers: node.descendantsOfType('modifiers')[0]?.text ?? ''
          });
        }
      } else if (name) {
        declarations.push({
          nodeType,
          name,
          line: lineOf(node),
          endLine: endLineOf(node),
          modifiers: node.descendantsOfType('modifiers')[0]?.text ?? ''
        });
      }
    }

    if (node.type === 'method_invocation') {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        calls.push({
          name,
          object: node.childForFieldName('object')?.text ?? null,
          line: lineOf(node)
        });
      }
    }
    if (node.type === 'object_creation_expression') {
      const type = node.descendantsOfType('type_identifier')[0]?.text ?? null;
      const hasBody = node.namedChildren.some(child => child.type === 'class_body');
      if (hasBody) anonymousClasses += 1;
      creations.push({ type, anonymous: hasBody, line: lineOf(node) });
    }
    if (node.type === 'lambda_expression') lambdas += 1;
    if (node.type === 'method_reference') methodReferences += 1;
    if (node.type === 'switch_expression') switchExpressions += 1;
    if (node.type === 'annotation' || node.type === 'marker_annotation') annotations += 1;

    for (const child of node.namedChildren) walk(child);
  };
  walk(root);

  return {
    declarations,
    calls,
    creations,
    anonymousClasses,
    lambdas,
    methodReferences,
    switchExpressions,
    annotations
  };
}

function parseFile(parser, file) {
  const text = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
  const started = performance.now();
  const tree = parser.parse(text);
  const durationMs = performance.now() - started;
  if (!tree) throw new Error(`${file} 没有返回语法树`);
  if (tree.rootNode.hasError) {
    const error = tree.rootNode.descendantsOfType('ERROR')[0];
    throw new Error(
      `${file} 解析失败${error ? `（第 ${String(lineOf(error))} 行：${textOf(error).slice(0, 120)}）` : ''}`
    );
  }
  return { text, tree, durationMs, ...collect(tree.rootNode) };
}

function hasDeclaration(result, nodeType, name) {
  return result.declarations.some(item => item.nodeType === nodeType && item.name === name);
}

function countDeclarations(result, nodeType, name) {
  return result.declarations.filter(item => item.nodeType === nodeType && item.name === name).length;
}

function hasCall(result, name) {
  return result.calls.some(item => item.name === name);
}

function main() {
  if (!fs.existsSync(wasmPath)) {
    fail(`找不到 Java grammar：${wasmPath}；先运行 npm install`);
    return;
  }

  const started = performance.now();
  const wasm = fs.readFileSync(wasmPath);
  return Parser.init()
    .then(async () => {
      const language = await Language.load(wasm);
      const parser = new Parser();
      parser.setLanguage(language);

      const results = {};
      for (const file of fs.readdirSync(fixtureDir).filter(name => name.endsWith('.java')).sort()) {
        results[file] = parseFile(parser, file);
      }

      const order = results['OrderService.java'];
      assert(order, 'OrderService.java 没有解析结果');
      if (order) {
        assert(order.text.includes('package com.acme.order;'), 'package 应被保留在原文中');
        assert(order.text.includes('import static'), '静态 import 应被保留在原文中');
        assert(hasDeclaration(order, 'Class', 'OrderService'), '应识别 class OrderService');
        assert(order.declarations.filter(item => item.nodeType === 'Field').length === 2, '应识别 2 个字段');
        assert(hasDeclaration(order, 'Constructor', 'OrderService'), '应识别构造方法');
        assert(hasDeclaration(order, 'Method', 'create'), '应识别 create');
        assert(hasDeclaration(order, 'Method', 'validate'), '应识别 validate');
        assert(hasDeclaration(order, 'Method', 'list'), '应识别 list');
        assert(hasCall(order, 'validate'), '应识别 validate() 调用');
        assert(hasCall(order, 'save'), '应识别 repository.save() 调用');
        assert(hasCall(order, 'record'), '应识别 AuditLog.record() 调用');
        assert(order.creations.some(item => item.type === 'AuditLog'), '应识别 new AuditLog()');
      }

      const types = results['Types.java'];
      assert(types, 'Types.java 没有解析结果');
      if (types) {
        assert(hasDeclaration(types, 'Interface', 'Shape'), '应识别 sealed interface Shape');
        assert(hasDeclaration(types, 'Record', 'Circle'), '应识别 record Circle');
        assert(hasDeclaration(types, 'Class', 'Square'), '应识别 final class Square');
        assert(hasDeclaration(types, 'Enum', 'Color'), '应识别 enum Color');
        assert(hasDeclaration(types, 'Annotation', 'Marker'), '应识别 @interface Marker');
        assert(hasDeclaration(types, 'Class', 'Inner'), '应识别嵌套 class Inner');
        assert(types.anonymousClasses === 1, `应识别 1 个匿名类，实际 ${String(types.anonymousClasses)}`);
        assert(types.lambdas === 1, `应识别 1 个 lambda，实际 ${String(types.lambdas)}`);
        assert(types.methodReferences === 1, `应识别 1 个 method reference，实际 ${String(types.methodReferences)}`);
        assert(types.switchExpressions === 1, `应识别 1 个 switch expression，实际 ${String(types.switchExpressions)}`);
      }

      const generic = results['GenericService.java'];
      assert(generic, 'GenericService.java 没有解析结果');
      if (generic) {
        assert(hasDeclaration(generic, 'Class', 'GenericService'), '应识别 GenericService');
        assert(hasDeclaration(generic, 'Method', 'map'), '应识别泛型方法 map');
        assert(countDeclarations(generic, 'Method', 'save') === 2, '应区分两个重载 save');
        assert(hasDeclaration(generic, 'Method', 'identity'), '应识别静态泛型方法 identity');
        assert(hasDeclaration(generic, 'Method', 'varargs'), '应识别 varargs 方法');
        const map = generic.declarations.find(item => item.nodeType === 'Method' && item.name === 'map');
        assert(map && map.endLine > map.line, '多行方法签名应有真实 endLine');
      }

      assert(Object.keys(results).length === 15, `应有 15 个 Java 夹具，实际 ${String(Object.keys(results).length)}`);

      const enumFile = results['Enums.java'];
      assert(enumFile && hasDeclaration(enumFile, 'Enum', 'Enums'), '应识别 enum Enums');
      assert(enumFile && hasDeclaration(enumFile, 'Method', 'run'), '应识别 enum 常量体里的 run');

      const records = results['Records.java'];
      assert(records && hasDeclaration(records, 'Record', 'Records'), '应识别 record Records');
      assert(records && hasDeclaration(records, 'Record', 'Pair'), '应识别嵌套 record Pair');

      const sealed = results['Sealed.java'];
      assert(sealed && hasDeclaration(sealed, 'Interface', 'Sealed'), '应识别 sealed interface Sealed');
      assert(sealed && hasDeclaration(sealed, 'Class', 'C'), '应识别 sealed class C');

      const switches = results['Switches.java'];
      assert(switches && switches.switchExpressions >= 2, '应识别 switch expression / yield');

      const nested = results['Nested.java'];
      assert(nested && hasDeclaration(nested, 'Class', 'StaticNested'), '应识别静态嵌套类');
      assert(nested && hasDeclaration(nested, 'Class', 'Inner'), '应识别内部类');
      assert(nested && hasDeclaration(nested, 'Class', 'Local'), '应识别局部类');
      assert(nested && nested.anonymousClasses === 1, '应识别匿名类');

      const lambdas = results['Lambdas.java'];
      assert(lambdas && lambdas.lambdas >= 1, '应识别 lambda');
      assert(lambdas && lambdas.methodReferences >= 1, '应识别 method reference');

      const modern = results['Modern.java'];
      assert(modern && hasDeclaration(modern, 'Method', 'textBlock'), '应识别 text block 方法');
      assert(modern && hasDeclaration(modern, 'Method', 'varAndPattern'), '应识别 var/pattern 方法');

      const annotations = results['AnnotationUse.java'];
      assert(annotations && hasDeclaration(annotations, 'Annotation', 'Tag'), '应识别 @interface Tag');
      assert(annotations && annotations.annotations >= 2, '应识别重复注解');

      const fields = results['Fields.java'];
      assert(fields && fields.declarations.filter(item => item.nodeType === 'Field').length >= 5, '应识别静态/实例字段');

      const constructors = results['Constructors.java'];
      assert(constructors && constructors.declarations.filter(item => item.nodeType === 'Constructor').length >= 3, '应识别重载构造器');

      const defaults = results['InterfaceDefaults.java'];
      assert(defaults && hasDeclaration(defaults, 'Interface', 'Child'), '应识别嵌套 interface Child');

      const totalMs = performance.now() - started;
      const summary = {
        runtime: `node ${process.version}`,
        grammar: wasmPath.replace(process.cwd() + path.sep, ''),
        files: Object.keys(results).length,
        parseMs: Number(totalMs.toFixed(2)),
        rssMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
        declarations: Object.fromEntries(
          Object.entries(results).map(([file, result]) => [
            file,
            result.declarations.reduce((acc, item) => {
              acc[item.nodeType] = (acc[item.nodeType] ?? 0) + 1;
              return acc;
            }, {})
          ])
        ),
        failures: process.exitCode === 1
      };

      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Tree-sitter Java spike: ${String(summary.files)} files, ${String(summary.parseMs)} ms, ${String(summary.rssMb)} MB RSS`);
        for (const [file, counts] of Object.entries(summary.declarations)) {
          console.log(`  ${file}: ${Object.entries(counts).map(([key, value]) => `${key}=${String(value)}`).join(', ')}`);
        }
        console.log(summary.failures ? '结果：FAIL' : '结果：PASS');
      }

      if (process.exitCode === 1) process.exitCode = 1;
    })
    .catch(error => {
      fail(error instanceof Error ? error.message : String(error));
    });
}

await main();
