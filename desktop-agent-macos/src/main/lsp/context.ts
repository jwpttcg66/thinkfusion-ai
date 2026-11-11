/**
 * ContextBuilder：把一个「位置或文件」整理成有证据的上下文包。
 *
 * 只做组装，不猜：符号、定义、引用、hover、可能相关的测试，全部来自
 * tsserver；每条都带 `source: 'tsserver'`。拿不到语言服务时上层会抛出
 * LSP_UNAVAILABLE，这里不返回半真半假的结果。
 */

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodeHover, CodeLocation, CodeSymbol, TsServerClient } from './tsserver';

export interface CodeContextPack {
  root: string;
  file: string;
  source: 'tsserver';
  sha256?: string;
  totalLines?: number;
  symbols: CodeSymbol[];
  definitions: CodeLocation[];
  references: CodeLocation[];
  hover: CodeHover | null;
  /** 引用位置里看起来像测试的文件；只是候选，标 heuristic。 */
  relatedTests: Array<{ path: string; line: number; heuristic: true }>;
}

const TEST_PATH = /(\.(test|spec)\.[cm]?[jt]sx?$)|([/\\](__tests__|test|tests)[/\\])/i;

export async function buildCodeContext(
  client: TsServerClient,
  root: string,
  file: string,
  position?: { line: number; character: number },
  max = 200
): Promise<CodeContextPack> {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const symbols = await client.symbols(file, max);
  let definitions: CodeLocation[] = [];
  let references: CodeLocation[] = [];
  let hover: CodeHover | null = null;
  if (position) {
    [definitions, references, hover] = await Promise.all([
      client.definition({ file, ...position }),
      client.references({ file, ...position }),
      client.hover({ file, ...position })
    ]);
  }
  const relatedTests = references
    .filter(item => TEST_PATH.test(item.path))
    .slice(0, 20)
    .map(item => ({ path: item.path, line: item.line, heuristic: true as const }));

  let sha256: string | undefined;
  let totalLines: number | undefined;
  try {
    const text = fs.readFileSync(file, 'utf8');
    sha256 = createHash('sha256').update(text).digest('hex');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    totalLines = lines.length;
  } catch {
    // 读不到就不填：上下文包不做伪装。
  }

  return {
    root,
    file: relative,
    source: 'tsserver',
    ...(sha256 ? { sha256 } : {}),
    ...(totalLines === undefined ? {} : { totalLines }),
    symbols,
    definitions,
    references,
    hover,
    relatedTests
  };
}
