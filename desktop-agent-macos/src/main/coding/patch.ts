/**
 * 多 Agent 编码的补丁安全层：解析、路径、版本、冲突、dry-run。
 *
 * 原则和 `fs.applyPatch` 一样，只是提前到「方案阶段」：
 * - 补丁只能落在授权根目录内，`..`、绝对路径、a//b/ 前缀都要先归一化；
 * - 一个方案不能重复改同一个文件；
 * - 目标文件必须存在（fs.applyPatch 只改已有文件，不负责新建）；
 * - hunk 必须能在**当前**内容上应用；应用不了就是方案过期，不是「大概能行」；
 * - 通过之后把当前文件的 sha256 作为 expectedHash 交给后续落盘步骤，
 *   真正写入时还会再核对一次。
 *
 * 这里只读文件，不写工作区。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyUnifiedHunks, diffStats, parseUnifiedDiff } from '../../shared/unified-diff';

export interface ProposedPatch {
  path: string;
  patch: string;
}

export interface ValidatedPatch {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  /** 通过校验时给出：当前文件的 sha256，落盘时原样传给 expectedHash。 */
  expectedHash?: string;
  valid: boolean;
  /** 不通过时给模型/用户看的具体原因。 */
  reason?: string;
}

export interface PatchRead {
  content: string;
  sha256: string;
}

export interface PatchValidationOptions {
  root: string;
  readFile?: (absolutePath: string) => Promise<PatchRead | null>;
}

/** 把 `a/src/x.ts`、`b/src/x.ts`、`src/x.ts` 统一成根目录内的相对路径。 */
export function normalizePatchPath(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  // diff 头可能带时间戳：`src/x.ts\t2026-...`
  value = value.split('\t')[0].trim();
  value = value.replace(/^[ab]\//, '');
  if (value.startsWith('/') || value.startsWith('\\')) return null;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  return normalized;
}

/** 从回答里的 ```diff/```patch 代码块抽补丁；一个块一个文件。 */
export function extractPatchBlocks(text: string): ProposedPatch[] {
  const out: ProposedPatch[] = [];
  const pattern = /```(?:diff|patch)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const patch = match[1].trim();
    const header = /^\+\+\+\s+(?:b\/)?([^\t\n]+)/m.exec(patch) ?? /^---\s+(?:a\/)?([^\t\n]+)/m.exec(patch);
    if (!patch || !header) continue;
    const normalized = normalizePatchPath(header[1]);
    if (!normalized) continue;
    out.push({ path: normalized, patch });
  }
  return out;
}

async function defaultReadFile(absolutePath: string): Promise<PatchRead | null> {
  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    return { content, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
  } catch {
    return null;
  }
}

/**
 * 逐个补丁校验。任何一项不通过都只标记 `valid:false` 并给出原因，
 * 不把整个方案丢掉——其他文件仍然可以审阅/应用。
 */
export async function validatePatches(
  patches: readonly ProposedPatch[],
  options: PatchValidationOptions
): Promise<ValidatedPatch[]> {
  const readFile = options.readFile ?? defaultReadFile;
  const root = path.resolve(options.root);
  const seen = new Set<string>();

  const out: ValidatedPatch[] = [];
  for (const patch of patches) {
    const normalized = normalizePatchPath(patch.path);
    let additions = 0;
    let deletions = 0;
    try {
      additions = diffStats(parseUnifiedDiff(patch.patch)).additions;
      deletions = diffStats(parseUnifiedDiff(patch.patch)).deletions;
    } catch {
      // 统计失败留给下面的 parse 报具体原因，这里不抢先下结论。
    }

    if (!normalized) {
      out.push({
        path: patch.path,
        patch: patch.patch,
        additions,
        deletions,
        valid: false,
        reason: '补丁路径不合法：必须是工作区内的相对路径'
      });
      continue;
    }
    if (seen.has(normalized)) {
      out.push({
        path: normalized,
        patch: patch.patch,
        additions,
        deletions,
        valid: false,
        reason: '同一个方案里重复修改这个文件；请合并成一个补丁'
      });
      continue;
    }
    seen.add(normalized);

    const fileHeaders = patch.patch.match(/^\+\+\+\s+/gm)?.length ?? 0;
    if (fileHeaders > 1) {
      out.push({
        path: normalized,
        patch: patch.patch,
        additions,
        deletions,
        valid: false,
        reason: '一个 diff 代码块里有多个文件；请每个文件一个代码块，避免把补丁应用到错误的目标'
      });
      continue;
    }

    const absolute = path.resolve(root, normalized);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      out.push({
        path: normalized,
        patch: patch.patch,
        additions,
        deletions,
        valid: false,
        reason: '补丁路径越出工作区'
      });
      continue;
    }

    const file = await readFile(absolute);
    if (!file) {
      out.push({
        path: normalized,
        patch: patch.patch,
        additions,
        deletions,
        valid: false,
        reason: '目标文件不存在；fs.applyPatch 只改已有文件，新建请走 fs.writeFile'
      });
      continue;
    }

    try {
      const hunks = parseUnifiedDiff(patch.patch);
      applyUnifiedHunks(file.content, hunks);
      out.push({
        path: normalized,
        patch: patch.patch,
        additions,
        deletions,
        expectedHash: file.sha256,
        valid: true
      });
    } catch (error) {
      out.push({
        path: normalized,
        patch: patch.patch,
        additions,
        deletions,
        valid: false,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return out;
}

/** 跨方案冲突：同一个文件被两个以上 Agent 的**有效**补丁改到。 */
export function detectPatchConflicts(
  proposals: ReadonlyArray<{ agentId: string; patches: readonly ValidatedPatch[] }>
): Array<{ path: string; agents: string[] }> {
  const byFile = new Map<string, string[]>();
  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      if (!patch.valid) continue;
      const agents = byFile.get(patch.path) ?? [];
      if (!agents.includes(proposal.agentId)) agents.push(proposal.agentId);
      byFile.set(patch.path, agents);
    }
  }
  return [...byFile.entries()]
    .filter(([, agents]) => agents.length > 1)
    .map(([path, agents]) => ({ path, agents }));
}
