/**
 * ECO 证据读取：把「计划里提到的文件」变成可核验的工程事实。
 *
 * 充分度不能靠计划文本自证。这里只做一件事：按计划的步骤参数取相对路径，
 * 在真实工作区里读它、算 sha256、记大小；读不到就如实跳过，不伪造 verified。
 *
 * 刻意不递归扫全仓：ECO 要证明的是「这次任务相关的内容被读过」，不是
 * 「把整个仓库塞进上下文」。读哪些文件由计划决定，因此可追溯。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ContextResourceRef } from '../../shared/eco';

/** 一次最多核验多少个文件；超出部分不读，避免把「读文件」变成扫盘。 */
export const MAX_EVIDENCE_FILES = 24;

/** 单文件上限：与 fs.readFile 的默认 8 MB 对齐。 */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export interface PlanStepLike {
  tool: string;
  args: Record<string, unknown>;
}

export interface SkippedEvidence {
  path: string;
  reason: string;
}

/** 计划步骤里出现过的相对路径（去重、保序）。只认字符串形式的 path/file 参数。 */
export function planEvidencePaths(
  steps: readonly PlanStepLike[],
  limit = MAX_EVIDENCE_FILES
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const key of ['path', 'file'] as const) {
      const raw = step.args?.[key];
      if (typeof raw !== 'string') continue;
      const rel = normalizeRelativePath(raw);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      out.push(rel);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 绝对路径、盘符、`..` 段一律拒绝；返回 posix 风格的相对路径。 */
export function normalizeRelativePath(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * 真实读取并核验这些路径。返回的每个资源都带 digest，能通过 ECO 的工程证据判定；
 * 读不到的文件进 `skipped`，调用方可以把它写进 unknowns，而不是假装读过。
 */
export function readEngineeringEvidence(input: {
  workspaceRoot: string;
  paths: readonly string[];
  now?: number;
}): { resources: ContextResourceRef[]; skipped: SkippedEvidence[] } {
  const root = path.resolve(input.workspaceRoot);
  const at = input.now ?? Date.now();
  const resources: ContextResourceRef[] = [];
  const skipped: SkippedEvidence[] = [];

  for (const raw of input.paths) {
    const rel = normalizeRelativePath(raw);
    if (!rel) {
      skipped.push({ path: raw, reason: '不是工作区内的相对路径' });
      continue;
    }
    const absolute = path.resolve(root, rel);
    const relToRoot = path.relative(root, absolute);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      skipped.push({ path: rel, reason: '越出工作区范围' });
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      skipped.push({ path: rel, reason: '文件不存在' });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: rel, reason: '不是文件' });
      continue;
    }
    if (stat.size > MAX_EVIDENCE_BYTES) {
      skipped.push({ path: rel, reason: `文件超过 ${String(MAX_EVIDENCE_BYTES)} 字节` });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(absolute);
    } catch {
      skipped.push({ path: rel, reason: '读取失败' });
      continue;
    }
    resources.push({
      resourceId: `file:${rel}`,
      kind: 'file',
      pathOrLabel: rel,
      verified: true,
      factClass: 'verified_fact',
      digest: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
      verifiedAt: at
    });
  }

  return { resources, skipped };
}
