/**
 * P4-01：EvidencePack → EvidenceRef 的唯一映射。
 * 只引用 Pack 内容，不复制正文。
 */
import type { EvidenceKind, EvidenceRef } from './domain/types';
import type { EvidencePackItemKind, EvidencePackManifestItem } from '../evidence-pack/types';

export interface PackOwner {
  ownerType: 'goal' | 'task' | 'debate';
  ownerId: string;
}

/** 旧 Pack 只有 debateId；新数据必须写 ownerType/ownerId。 */
export function normalizePackOwner(input: {
  ownerType?: string;
  ownerId?: string;
  debateId?: string;
}): PackOwner {
  if (input.ownerType === 'goal' || input.ownerType === 'task' || input.ownerType === 'debate') {
    if (!input.ownerId) throw new Error('ownerType 存在但缺少 ownerId');
    return { ownerType: input.ownerType, ownerId: input.ownerId };
  }
  if (input.debateId) return { ownerType: 'debate', ownerId: input.debateId };
  throw new Error('证据包缺少归属');
}

const KIND_MAP: Record<EvidencePackItemKind, EvidenceKind> = {
  'source-file': 'code',
  symbol: 'code',
  'call-edge': 'code',
  dependency: 'code',
  'git-commit': 'code',
  'doc-excerpt': 'knowledge',
  'test-result': 'execution',
  'command-result': 'execution'
};

export function mapPackKind(kind: EvidencePackItemKind): EvidenceKind {
  return KIND_MAP[kind];
}

export function toEvidenceRef(input: {
  packId: string;
  goalId: string;
  taskId?: string;
  item: EvidencePackManifestItem;
}): EvidenceRef {
  const { item } = input;
  return {
    evidenceId: `${input.packId}:${item.itemId}`,
    kind: mapPackKind(item.kind),
    scope: { goalId: input.goalId, ...(input.taskId ? { taskId: input.taskId } : {}) },
    source: {
      commit: item.source.commit,
      ...(item.source.path ? { uri: item.source.path } : {}),
      capturedAt: item.meta.capturedAt
    },
    locator: {
      path: item.locator.path,
      startLine: item.locator.startLine,
      endLine: item.locator.endLine
    },
    hash: item.contentHash,
    trust: item.attestation ? 'verified' : 'unverified',
    summary: `${item.kind} ${item.locator.path}:${String(item.locator.startLine)}-${String(item.locator.endLine)}`,
    legacy: { packId: input.packId, itemId: item.itemId }
  };
}
