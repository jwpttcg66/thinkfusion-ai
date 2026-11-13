/**
 * TypeScript/JavaScript 的本地索引器：AST → 节点 / 边 / 全文文档。
 *
 * 这是 V3.0 在没有 CGC/Python/Neo4j 运行环境时的回退实现。它不做类型消歧：
 * - 声明和 CONTAINS 来自 AST，标 AST/HIGH；
 * - 调用只按 AST 里的被调用者名字匹配；唯一命中才标 HIGH，否则不猜；
 * - 导入只解析相对路径，外部包只记 Package / DEPENDS_ON。
 *
 * 不把正则匹配当精确关系，也不假装这是 tsserver 的 Definition/References。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadTypeScript } from '../lsp/ts-ast';
import {
  codeEdgeId,
  codeNodeId,
  type CodeIndexStore
} from './store';
import type { CodeEdge, CodeNode, CodeNodeType, SearchDoc } from './types';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'out', 'out-test', 'build', 'target',
  '.gradle', '.mvn', 'bin', 'obj', 'coverage',
  '.next', '.nuxt', '.cache', '.idea', '.vscode', 'vendor', '__pycache__',
  'DerivedData', 'Pods', '.workbuddy', 'ui-preview', 'release'
]);
/** 索引和 freshness 检查共用一个上限，避免 500/1000 不一致导致反复重建。 */
export const DEFAULT_MAX_FILES = 500;
const GRAPH_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|java)$/i;

export interface IndexProjectOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  /** 不传就索引所有支持的 TS/JS 文件。 */
  include?: (relativePath: string) => boolean;
  /** 默认 true：内容 hash 没变的文件只推进 generation，不重写节点/边。 */
  incremental?: boolean;
}

export interface IndexProjectResult {
  projectId: string;
  generation: number;
  files: number;
  nodes: number;
  edges: number;
  docs: number;
  warnings: string[];
  /** 本次扫描是否覆盖了整个工程。false 时禁止按本次结果删除旧文件。 */
  complete: boolean;
  /** 是否因 maxFiles 截断。 */
  truncated: boolean;
}

interface Declaration {
  name: string;
  kind: string;
  nodeType: CodeNodeType;
  qualifiedName: string;
  parent?: string;
  startLine: number;
  endLine: number;
}

interface FileIndex {
  rel: string;
  language: string;
  text: string;
  hash: string;
  size: number;
  mtimeMs: number;
  declarations: Declaration[];
  imports: Array<{ module: string; line: number }>;
  calls: Array<{ callee: string; line: number; owner?: string }>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function languageOf(rel: string): string {
  if (/\.java$/i.test(rel)) return 'java';
  if (/\.tsx$/i.test(rel)) return 'tsx';
  if (/\.jsx$/i.test(rel)) return 'jsx';
  if (/\.(js|mjs|cjs)$/i.test(rel)) return 'javascript';
  return 'typescript';
}

function lineOf(sourceFile: import('typescript').SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function declarationName(node: import('typescript').Node): string | null {
  const name = (node as { name?: import('typescript').Node }).name;
  return name && (name as unknown as { text?: string }).text ? String((name as unknown as { text: string }).text) : null;
}

function collectDeclarations(
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile
): Declaration[] {
  const out: Declaration[] = [];

  const add = (
    node: import('typescript').Node,
    kind: string,
    nodeType: CodeNodeType,
    parent?: string
  ): string | null => {
    const name = declarationName(node);
    if (!name) return null;
    const qualifiedName = parent ? `${parent}.${name}` : name;
    out.push({
      name,
      kind,
      nodeType,
      qualifiedName,
      ...(parent ? { parent } : {}),
      startLine: lineOf(sourceFile, node.getStart(sourceFile)),
      endLine: lineOf(sourceFile, node.getEnd())
    });
    return qualifiedName;
  };

  const visit = (node: import('typescript').Node, parent?: string): void => {
    if (ts.isFunctionDeclaration(node)) {
      add(node, 'function', 'Function', parent);
    } else if (ts.isClassDeclaration(node)) {
      const q = add(node, 'class', 'Class', parent);
      if (q) for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) add(member, 'method', 'Method', q);
        else if (ts.isPropertyDeclaration(member)) add(member, 'property', 'Variable', q);
      }
      return;
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node, 'interface', 'Interface', parent);
    } else if (ts.isTypeAliasDeclaration(node)) {
      add(node, 'type', 'Type', parent);
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const qualifiedName = parent ? `${parent}.${declaration.name.text}` : declaration.name.text;
          out.push({
            name: declaration.name.text,
            kind: 'variable',
            nodeType: 'Variable',
            qualifiedName,
            ...(parent ? { parent } : {}),
            startLine: lineOf(sourceFile, declaration.getStart(sourceFile)),
            endLine: lineOf(sourceFile, declaration.getEnd())
          });
        }
      }
    }
    ts.forEachChild(node, child => visit(child, parent));
  };

  visit(sourceFile);
  return out;
}

function collectImports(
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile
): Array<{ module: string; line: number }> {
  const out: Array<{ module: string; line: number }> = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      out.push({
        module: statement.moduleSpecifier.text,
        line: lineOf(sourceFile, statement.getStart(sourceFile))
      });
    }
  }
  return out;
}

function collectCalls(
  ts: typeof import('typescript'),
  sourceFile: import('typescript').SourceFile,
  declarations: readonly Declaration[]
): Array<{ callee: string; line: number; owner?: string }> {
  const out: Array<{ callee: string; line: number; owner?: string }> = [];
  const visit = (node: import('typescript').Node, owner?: string): void => {
    let nextOwner = owner;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) nextOwner = owner ? `${owner}.${name}` : name;
    } else if (ts.isClassDeclaration(node)) {
      const name = declarationName(node);
      if (name) nextOwner = name;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile).split('.').pop()?.trim() ?? '';
      if (callee && /^[A-Za-z_$][\w$]*$/.test(callee)) {
        out.push({
          callee,
          line: lineOf(sourceFile, node.getStart(sourceFile)),
          ...(nextOwner ? { owner: nextOwner } : {})
        });
      }
    }
    ts.forEachChild(node, child => visit(child, nextOwner));
  };
  visit(sourceFile);
  return out;
}

function lineAtIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Java 的“部分解析”：Tree-sitter/SCIP 不在本地回退链路里，这里只做结构
 * 提取（package / import / class / interface / enum / 方法签名）。
 *
 * 结果明确是 STATIC_ANALYSIS + POSSIBLE，不生成 CALLS，不把正则匹配
 * 说成编译器级关系。Java Provider 后续通过 Tree-sitter 或独立的语义
 * Provider 验证后再替换；不把任何语义服务当成前置条件。
 */
function collectJava(text: string): {
  declarations: Declaration[];
  imports: Array<{ module: string; line: number }>;
} {
  const declarations: Declaration[] = [];
  const imports: Array<{ module: string; line: number }> = [];
  const lines = text.split('\n');
  let currentClass: string | null = null;
  let braceDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const importMatch = /^\s*import\s+([\w.*]+)\s*;/.exec(line);
    if (importMatch) imports.push({ module: importMatch[1], line: index + 1 });

    const typeMatch = /^\s*(?:public\s+)?(?:abstract\s+|final\s+|static\s+)*(class|interface|enum)\s+([A-Za-z_]\w*)/.exec(line);
    if (typeMatch) {
      const name = typeMatch[2];
      const kind = typeMatch[1] === 'interface' ? 'interface' : 'class';
      const nodeType: CodeNodeType = typeMatch[1] === 'interface' ? 'Interface' : 'Class';
      declarations.push({
        name,
        kind,
        nodeType,
        qualifiedName: name,
        startLine: index + 1,
        endLine: index + 1
      });
      currentClass = name;
      braceDepth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      continue;
    }

    const methodMatch = /^\s*(?:public|private|protected)\s+(?:static\s+|final\s+|synchronized\s+)*[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (methodMatch && currentClass) {
      const name = methodMatch[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'new'].includes(name)) {
        declarations.push({
          name,
          kind: 'method',
          nodeType: 'Method',
          qualifiedName: `${currentClass}.${name}`,
          parent: currentClass,
          startLine: index + 1,
          endLine: index + 1
        });
      }
    }
    braceDepth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (currentClass && braceDepth <= 0) currentClass = null;
  }
  // 方法的 endLine 用文件末尾兜底；不猜精确大括号范围。
  const endLine = Math.max(1, lines.length);
  for (const declaration of declarations) {
    if (declaration.nodeType === 'Class' || declaration.nodeType === 'Interface') declaration.endLine = endLine;
  }
  return { declarations, imports };
}

interface WalkResult {
  files: FileIndex[];
  complete: boolean;
  truncated: boolean;
}

async function walk(
  root: string,
  options: Required<Pick<IndexProjectOptions, 'maxFiles' | 'maxFileBytes'>> & IndexProjectOptions,
  warnings: string[]
): Promise<WalkResult> {
  const ts = await loadTypeScript();
  if (!ts) throw new Error('AST_UNAVAILABLE：没有找到 typescript 包，无法建立代码索引');
  const files: FileIndex[] = [];
  let complete = true;
  let truncated = false;
  const markIncomplete = () => { complete = false; };

  const visit = async (dir: string): Promise<void> => {
    if (files.length >= options.maxFiles) {
      complete = false;
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      markIncomplete();
      warnings.push(`${path.relative(root, dir) || '.'} 读不到，已跳过`);
      return;
    }
    for (const entry of entries) {
      if (files.length >= options.maxFiles) {
        complete = false;
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.git')) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!GRAPH_EXT.test(rel)) continue;
      if (options.include && !options.include(rel)) continue;
      let stat;
      try {
        stat = await fs.lstat(abs);
      } catch {
        markIncomplete();
        warnings.push(`${rel} 状态读不到，已跳过`);
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (stat.size > options.maxFileBytes) {
        warnings.push(`${rel} 超过单文件上限 ${options.maxFileBytes} 字节，已跳过`);
        continue;
      }
      let text: string;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        markIncomplete();
        warnings.push(`${rel} 读不到，已跳过`);
        continue;
      }
      if (/\.java$/i.test(rel)) {
        const java = collectJava(text);
        files.push({
          rel,
          language: 'java',
          text,
          hash: sha256(text),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          declarations: java.declarations,
          imports: java.imports,
          calls: []
        });
        continue;
      }
      const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
      const declarations = collectDeclarations(ts, sourceFile);
      files.push({
        rel,
        language: languageOf(rel),
        text,
        hash: sha256(text),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        declarations,
        imports: collectImports(ts, sourceFile),
        calls: collectCalls(ts, sourceFile, declarations)
      });
    }
  };

  await visit(root);
  return { files, complete, truncated };
}

function resolveImport(fromRel: string, specifier: string, known: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`
  ];
  return candidates.find(candidate => known.has(candidate)) ?? null;
}

export interface SourceFileMeta {
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface SourceScanResult {
  files: SourceFileMeta[];
  complete: boolean;
  truncated: boolean;
  warnings: string[];
}

/**
 * 只看路径/大小/mtime，不读文件内容；用于判断索引是否过期。
 *
 * `complete=false` 表示扫描没有覆盖整个工程（达到上限或目录读失败）。
 * 调用方不得根据不完整结果删除旧索引。
 */
export async function scanSourceFilesDetailed(
  rootInput: string,
  options: { maxFiles?: number; include?: (relativePath: string) => boolean } = {}
): Promise<SourceScanResult> {
  const root = await fs.realpath(rootInput);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const out: SourceFileMeta[] = [];
  const warnings: string[] = [];
  let complete = true;
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    if (out.length >= maxFiles) {
      complete = false;
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      complete = false;
      warnings.push(`${path.relative(root, dir) || '.'} 读不到，已跳过`);
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) {
        complete = false;
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.git')) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(abs);
        continue;
      }
      if (!entry.isFile() || !GRAPH_EXT.test(rel)) continue;
      if (options.include && !options.include(rel)) continue;
      try {
        const stat = await fs.lstat(abs);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        out.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        complete = false;
        warnings.push(`${rel} 状态读不到，已跳过`);
      }
    }
  };

  await visit(root);
  return { files: out, complete, truncated, warnings };
}

/** 兼容旧调用：只返回文件清单。需要完整性时必须用 `scanSourceFilesDetailed`。 */
export async function scanSourceFiles(
  rootInput: string,
  options: { maxFiles?: number; include?: (relativePath: string) => boolean } = {}
): Promise<SourceFileMeta[]> {
  return (await scanSourceFilesDetailed(rootInput, options)).files;
}

export async function indexProject(
  store: CodeIndexStore,
  rootInput: string,
  projectId: string,
  options: IndexProjectOptions = {}
): Promise<IndexProjectResult> {
  const root = await fs.realpath(rootInput);
  const warnings: string[] = [];
  const scanned = await walk(root, {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxFileBytes: options.maxFileBytes ?? 256 * 1024,
    include: options.include
  }, warnings);
  const files = scanned.files;
  if (!scanned.complete) {
    warnings.push(
      `扫描不完整（${String(files.length)} 个文件${scanned.truncated ? '，达到上限' : ''}）；本次不删除未扫描到的旧索引`
    );
  }

  const generation = store.beginGeneration(projectId, `scan:${String(Date.now())}`);
  try {
    const known = new Set(files.map(file => file.rel));
    if (scanned.complete) {
      for (const old of store.listFiles(projectId)) {
        if (!known.has(old.filePath)) store.deleteFile(projectId, old.filePath);
      }
    }
    const byName = new Map<string, CodeNode[]>();
    const fileNodes = new Map<string, CodeNode>();
    const declarationNodes = new Map<string, CodeNode[]>();
    let nodes = 0;
    let edges = 0;
    let docCount = 0;

    const allNodes = new Map<string, CodeNode>();
    const allEdges: CodeEdge[] = [];

    // 第一遍：为每个文件建立节点。
    for (const file of files) {
      const fileNode: CodeNode = {
        projectId,
        nodeId: codeNodeId(projectId, file.language, file.rel, file.rel, 'File'),
        nodeType: 'File',
        name: path.posix.basename(file.rel),
        qualifiedName: file.rel,
        filePath: file.rel,
        startLine: 1,
        endLine: file.text.split('\n').length,
        language: file.language,
        generation,
        ...(file.language === 'java' ? { symbolStatus: 'provisional' as const } : {})
      };
      fileNodes.set(file.rel, fileNode);
      allNodes.set(fileNode.nodeId, fileNode);
      byName.set(fileNode.name, [...(byName.get(fileNode.name) ?? []), fileNode]);

      const localNodes: CodeNode[] = [fileNode];
      const localDeclarations: CodeNode[] = [];
      for (const declaration of file.declarations) {
        const node: CodeNode = {
          projectId,
          nodeId: codeNodeId(projectId, file.language, file.rel, declaration.qualifiedName, declaration.kind),
          nodeType: declaration.nodeType,
          name: declaration.name,
          qualifiedName: declaration.qualifiedName,
          filePath: file.rel,
          startLine: declaration.startLine,
          endLine: declaration.endLine,
          language: file.language,
          generation,
          ...(file.language === 'java' ? { symbolStatus: 'provisional' as const } : {})
        };
        localNodes.push(node);
        localDeclarations.push(node);
        allNodes.set(node.nodeId, node);
        byName.set(node.name, [...(byName.get(node.name) ?? []), node]);
        allEdges.push({
          projectId,
          edgeId: codeEdgeId(projectId, fileNode.nodeId, node.nodeId, 'CONTAINS'),
          sourceNodeId: fileNode.nodeId,
          targetNodeId: node.nodeId,
          relationType: 'CONTAINS',
          confidence: 'EXACT',
          source: 'AST',
          filePath: file.rel,
          line: declaration.startLine,
          generation
        });
      }
      // 类包含方法 / 属性。
      for (const declaration of file.declarations) {
        if (!declaration.parent) continue;
        const parent = localDeclarations.find(node => node.qualifiedName === declaration.parent);
        const child = localDeclarations.find(node => node.qualifiedName === declaration.qualifiedName);
        if (parent && child) {
          allEdges.push({
            projectId,
            edgeId: codeEdgeId(projectId, parent.nodeId, child.nodeId, 'CONTAINS'),
            sourceNodeId: parent.nodeId,
            targetNodeId: child.nodeId,
            relationType: 'CONTAINS',
            confidence: 'EXACT',
            source: 'AST',
            filePath: file.rel,
            line: child.startLine,
            generation
          });
        }
      }
      declarationNodes.set(file.rel, localDeclarations);
      nodes += localNodes.length;
    }

    // 第二遍：导入、外部包、调用。
    for (const file of files) {
      const fileNode = fileNodes.get(file.rel);
      if (!fileNode) continue;
      const local = declarationNodes.get(file.rel) ?? [];
      for (const imported of file.imports) {
        const targetRel = resolveImport(file.rel, imported.module, known);
        if (targetRel) {
          const target = fileNodes.get(targetRel);
          if (target) {
            allEdges.push({
              projectId,
              edgeId: codeEdgeId(projectId, fileNode.nodeId, target.nodeId, 'IMPORTS'),
              sourceNodeId: fileNode.nodeId,
              targetNodeId: target.nodeId,
              relationType: 'IMPORTS',
              confidence: 'EXACT',
              source: 'AST',
              filePath: file.rel,
              line: imported.line,
              generation
            });
          }
        } else if (!imported.module.startsWith('.')) {
          const pkgId = codeNodeId(projectId, 'external', imported.module, imported.module, 'Package');
          if (!allNodes.has(pkgId)) {
            const pkgNode: CodeNode = {
              projectId,
              nodeId: pkgId,
              nodeType: 'Package',
              name: imported.module,
              qualifiedName: imported.module,
              filePath: '',
              startLine: 0,
              endLine: 0,
              language: 'external',
              generation
            };
            allNodes.set(pkgId, pkgNode);
            store.ensureNode(pkgNode);
          }
          allEdges.push({
            projectId,
            edgeId: codeEdgeId(projectId, fileNode.nodeId, pkgId, 'DEPENDS_ON'),
            sourceNodeId: fileNode.nodeId,
            targetNodeId: pkgId,
            relationType: 'DEPENDS_ON',
            confidence: 'HIGH',
            source: 'STATIC_ANALYSIS',
            filePath: file.rel,
            line: imported.line,
            generation
          });
        }
      }

      for (const call of file.calls) {
        const candidates = byName.get(call.callee) ?? [];
        if (candidates.length === 0) continue;
        const owner = call.owner
          ? local.find(node => node.qualifiedName === call.owner) ?? fileNode
          : fileNode;
        for (const target of candidates.slice(0, 5)) {
          if (target.nodeId === owner.nodeId) continue;
          allEdges.push({
            projectId,
            edgeId: codeEdgeId(projectId, owner.nodeId, target.nodeId, 'CALLS'),
            sourceNodeId: owner.nodeId,
            targetNodeId: target.nodeId,
            relationType: 'CALLS',
            confidence: candidates.length === 1 ? 'HIGH' : 'POSSIBLE',
            source: 'AST',
            filePath: file.rel,
            line: call.line,
            generation,
            resolutionStatus: candidates.length === 1 ? 'resolved' : 'ambiguous',
            callSiteId: `cs_${sha256(`${projectId}|${file.rel}|${String(call.line)}|${call.callee}`).slice(0, 16)}`
          });
        }
      }
    }

    // 第三遍：内容没变的文件只推进 generation；变了的才重写。
    for (const file of files) {
      const fileNode = fileNodes.get(file.rel);
      if (!fileNode) continue;
      if (options.incremental !== false && store.fileHash(projectId, file.rel) === file.hash) {
        store.promoteFileGeneration(projectId, file.rel, generation);
        continue;
      }
      const seenNodeIds = new Set<string>();
      const localNodes = [fileNode, ...(declarationNodes.get(file.rel) ?? [])].filter(node => {
        if (seenNodeIds.has(node.nodeId)) return false;
        seenNodeIds.add(node.nodeId);
        return true;
      });
      const localNodeIds = new Set(localNodes.map(node => node.nodeId));
      const localEdges = allEdges.filter(edge => localNodeIds.has(edge.sourceNodeId) && edge.filePath === file.rel);
      const docs: SearchDoc[] = [{
        docId: `doc_file_${sha256(file.rel).slice(0, 20)}`,
        projectId,
        filePath: file.rel,
        nodeId: fileNode.nodeId,
        kind: 'file',
        name: file.rel,
        content: file.text.slice(0, 20_000),
        generation
      }];
      for (const node of localNodes.slice(1)) {
        docs.push({
          docId: `doc_node_${node.nodeId}`,
          projectId,
          filePath: file.rel,
          nodeId: node.nodeId,
          kind: node.nodeType,
          name: node.name,
          content: `${node.qualifiedName}\n${node.nodeType}\n${node.filePath}:${String(node.startLine)}`,
          generation
        });
      }
      store.replaceFileIndex(projectId, generation, file.rel, localNodes, localEdges, docs);
      store.markFile(projectId, file.rel, file.hash, file.size, file.mtimeMs, generation);
      edges += localEdges.length;
      docCount += docs.length;
    }

    store.commitGeneration(projectId, generation);
    return {
      projectId,
      generation,
      files: files.length,
      nodes,
      edges,
      docs: docCount,
      warnings,
      complete: scanned.complete,
      truncated: scanned.truncated
    };
  } catch (error) {
    store.failGeneration(projectId, generation, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
