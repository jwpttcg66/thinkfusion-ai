/**
 * Evidence Pack 的 hash 规则（Gate 1 契约 §2.3）。
 *
 * 只有一件事要保证：同样的证据内容，在任何机器、任何时间重算，都得到同一个
 * hash；因此把所有不稳定字段（时间、主机路径、写入顺序）排除在输入之外。
 * 反过来，任何参与判断「证据是什么」的字段都必须进输入——少一个，篡改就
 * 能绕过校验。
 */
import { createHash } from 'node:crypto';
import type { EvidencePackContext, EvidencePackManifestItem, EvidencePackSnapshot } from './types';

export const EVIDENCE_PACK_SCHEMA_VERSION = 1;

/** 键排序、无空白、UTF-8、数字原样；`undefined` 视为未提供。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 同一个逻辑快照只能有一个 packId。内容变了是冲突，不是「再发一个包」——
 * 随机 id 需要额外索引才能发现同键不同内容，派生 id 让冲突在发布时直接暴露。
 */
export function packIdOf(idempotencyKey: string): string {
  return `pack_${sha256Hex(idempotencyKey).slice(0, 16)}`;
}

export function contentHashOf(content: string): string {
  return sha256Hex(`blob\0${content}`);
}

/** 条目 hash：只收「这条证据是什么」的字段，不收 capturedAt / repoRoot。 */
export function itemHashOf(item: Pick<EvidencePackManifestItem, 'kind' | 'source' | 'locator' | 'contentHash'>): string {
  return sha256Hex(
    canonicalJson({
      kind: item.kind,
      commit: item.source.commit,
      path: item.locator.path,
      startLine: item.locator.startLine,
      endLine: item.locator.endLine,
      symbolId: item.locator.symbolId ?? null,
      contentHash: item.contentHash
    })
  );
}

/**
 * manifest hash：条目 hash 排序 + 可选快照元数据。
 * 旧 Pack 没有 snapshot，计算输入与之前完全一致，因此仍能通过校验。
 */
export function manifestHashOf(input: {
  commit: string;
  itemHashes: readonly string[];
  snapshot?: EvidencePackSnapshot;
  context?: EvidencePackContext;
}): string {
  return sha256Hex(
    canonicalJson({
      schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
      commit: input.commit,
      items: [...input.itemHashes].sort(),
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      ...(input.context ? { context: input.context } : {})
    })
  );
}
