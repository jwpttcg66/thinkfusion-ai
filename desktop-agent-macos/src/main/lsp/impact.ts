/**
 * 影响分析：给定一个位置，给出定义、引用、调用与候选测试。
 *
 * 分两级置信度，不把推断当事实：
 * - 定义 / 引用来自 tsserver → EXACT；
 * - 引用里被 TypeScript AST 确认是 CallExpression 被调用者 → EXACT(call)；
 *   只是引用、或没有 AST（非 TS/JS）→ POSSIBLE。
 *
 * 结果按「目标文件 mtime + 位置」缓存到 code-index 目录：同一个位置重复问
 * 不重复跑 tsserver。文件变了（mtime/size 变）就重算，缓存不撒谎。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../atomic-write';
import { isCallAt, loadTypeScript, parseSource } from './ts-ast';
import type { CodeLocation, TsServerClient } from './tsserver';

export interface ImpactRelation {
  path: string;
  line: number;
  character: number;
  kind: 'call' | 'reference';
  confidence: 'EXACT' | 'POSSIBLE';
  preview?: string;
}

export interface ImpactPack {
  root: string;
  target: { path: string; line: number; character: number };
  definitions: CodeLocation[];
  relations: ImpactRelation[];
  relatedTests: Array<{ path: string; line: number; confidence: 'POSSIBLE' }>;
  source: 'tsserver+typescript-ast';
  cached: boolean;
}

const TEST_PATH = /(\.(test|spec)\.[cm]?[jt]sx?$)|([/\\](__tests__|test|tests)[/\\])/i;
const AST_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

function cacheKey(root: string, file: string, line: number, character: number): string {
  const stat = fs.statSync(file);
  return createHash('sha256')
    .update(`${root}|${file}|${String(line)}|${String(character)}|${String(stat.mtimeMs)}|${String(stat.size)}`)
    .digest('hex')
    .slice(0, 32);
}

export async function buildImpact(
  client: TsServerClient,
  root: string,
  file: string,
  position: { line: number; character: number },
  cacheDir?: string
): Promise<ImpactPack> {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const key = cacheDir ? cacheKey(root, file, position.line, position.character) : undefined;
  if (cacheDir && key) {
    try {
      const hit = JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8')) as ImpactPack;
      if (hit && hit.target?.path === relative) return { ...hit, cached: true };
    } catch {
      // 缓存坏了当没有，重新算。
    }
  }

  const [definitions, references] = await Promise.all([
    client.definition({ file, ...position }),
    client.references({ file, ...position })
  ]);

  const ts = await loadTypeScript();
  const byFile = new Map<string, CodeLocation[]>();
  for (const reference of references) {
    const list = byFile.get(reference.path) ?? [];
    list.push(reference);
    byFile.set(reference.path, list);
  }

  const relations: ImpactRelation[] = [];
  for (const [relPath, list] of byFile) {
    let sourceFile: import('typescript').SourceFile | null = null;
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, relPath), 'utf8');
      if (ts && AST_EXT.test(relPath)) sourceFile = parseSource(ts, path.join(root, relPath), text);
    } catch {
      sourceFile = null;
    }
    for (const reference of list) {
      const call = Boolean(ts && sourceFile && isCallAt(ts, sourceFile, reference.line, reference.character));
      relations.push({
        path: reference.path,
        line: reference.line,
        character: reference.character,
        kind: call ? 'call' : 'reference',
        // 有 AST 才能真正确认调用；只有引用就标 POSSIBLE。
        confidence: call ? 'EXACT' : 'POSSIBLE',
        ...(reference.preview ? { preview: reference.preview } : {})
      });
    }
  }

  const relatedTests = references
    .filter(item => TEST_PATH.test(item.path))
    .slice(0, 20)
    .map(item => ({ path: item.path, line: item.line, confidence: 'POSSIBLE' as const }));

  const pack: ImpactPack = {
    root,
    target: { path: relative, ...position },
    definitions,
    relations,
    relatedTests,
    source: 'tsserver+typescript-ast',
    cached: false
  };

  if (cacheDir && key) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(path.join(cacheDir, `${key}.json`), JSON.stringify(pack), 0o600);
    } catch {
      // 缓存写失败不影响结果。
    }
  }
  return pack;
}
