/**
 * `EvidencePackItem` → `DebateEvidence` 的映射层（Gate 1 契约 §2.5）。
 *
 * 这层只做映射，不改写 Pack，也不写任何存储。两个刻意的取舍：
 *
 * 1. `messageId` / `span.messageId` 用合成 id（`pack:<packId>:<itemId>`），
 *    不冒充真实发言；同时写 `origin: 'repo-snapshot'`，消费方能分辨。
 * 2. `roundIndex: -1`，表示不来自任何辩论轮次。Gate 3 定工程证据评分之前，
 *    这些条目只允许展示与持久化，不得传给 `judges.ts` / `quality.ts` 的
 *    证据维度——它们只把 `page-link` 当可核验来源，工程证据会被误判成
 *    「没有可核验的来源」。
 */
import { fingerprintOf } from '../../shared/evidence';
import type { DebateEvidence } from '../debate/types';
import { EvidencePackError, type EvidencePackItem, type EvidencePackRead } from './types';

export interface EvidenceLinkForMapping {
  itemId: string;
  claimId: string;
  relation: 'supports' | 'contradicts' | 'context';
}

export interface MapPackOptions {
  links?: readonly EvidenceLinkForMapping[];
}

export function packEvidenceIdOf(packId: string, itemId: string): string {
  return `pack:${packId}:${itemId}`;
}

/**
 * 映射整个 Pack。独立性按 `originKey`（commit）收敛：同一个 commit 下的
 * 第一条是独立来源，其余标 `independent: false` 并指回第一条——同一份快照
 * 里取几个片段，仍然只有一个来源。
 */
export function mapPackToDebateEvidence(pack: EvidencePackRead, options: MapPackOptions = {}): DebateEvidence[] {
  const firstOfOrigin = new Map<string, string>();
  const linksByItem = new Map<string, string[]>();
  for (const link of options.links ?? []) {
    if (link.relation === 'context') continue;
    const list = linksByItem.get(link.itemId) ?? [];
    if (!list.includes(link.claimId)) list.push(link.claimId);
    linksByItem.set(link.itemId, list);
  }

  return pack.items.map(item => {
    const evidenceId = packEvidenceIdOf(pack.manifest.packId, item.itemId);
    const originKey = `repo:${pack.manifest.repo.commit}`;
    const first = firstOfOrigin.get(originKey);
    if (!first) firstOfOrigin.set(originKey, evidenceId);

    return {
      evidenceId,
      origin: 'repo-snapshot',
      claimIds: linksByItem.get(item.itemId) ?? [],
      kind: debateKindOf(item),
      excerpt: item.content,
      span: { messageId: evidenceId, start: 0, end: item.content.length },
      sourceId: `evidence-pack:${pack.manifest.packId}`,
      messageId: evidenceId,
      roundIndex: -1,
      url: `repo://${pack.manifest.repo.commit}/${item.locator.path}#L${item.locator.startLine}-L${item.locator.endLine}`,
      finalUrl: `repo://${pack.manifest.repo.commit}/${item.locator.path}#L${item.locator.startLine}-L${item.locator.endLine}`,
      fingerprint: fingerprintOf(item.content),
      originKey,
      ...(first ? { duplicateOf: first } : {}),
      independent: !first,
      verified: 'snapshot',
      ...(item.kind === 'test-result' || item.kind === 'command-result'
        ? {
            execution: item.attestation
              ? {
                  kind: item.kind,
                  exitCode: item.attestation.exitCode,
                  assertion: item.attestation.assertion,
                  verifiesClaimIds: [item.attestation.claimId],
                  reference: item.attestation.testId ?? item.attestation.assertionId
                }
              : {
                  kind: item.kind,
                  exitCode: item.meta.exitCode,
                  ...(item.meta.assertion ? { assertion: item.meta.assertion } : {}),
                  ...(item.meta.verifiesClaimIds ? { verifiesClaimIds: item.meta.verifiesClaimIds } : {}),
                  ...(item.meta.reference ? { reference: item.meta.reference } : {})
                }
          }
        : {}),
      assessment: `来自冻结快照 ${pack.manifest.repo.commit.slice(0, 12)} ${item.locator.path}:${item.locator.startLine}-${item.locator.endLine}`,
      soleAttribution: false
    };
  });
}

/**
 * 工程条目收敛到现有的 `EvidenceKind`，不扩展它：
 * 代码/测试/命令/依赖/提交都属于「来源是代码仓库」；`doc-excerpt` 必须
 * 显式给出 `meta.sourceType`，不猜。
 */
function debateKindOf(item: EvidencePackItem): DebateEvidence['kind'] {
  if (item.kind === 'doc-excerpt') {
    const sourceType = item.meta.sourceType;
    if (sourceType === 'official-doc' || sourceType === 'paper' || sourceType === 'blog') return sourceType;
    throw new EvidencePackError('UNMAPPED_ITEM', `doc-excerpt 缺少 sourceType，无法映射：${item.itemId}`);
  }
  return 'source-code';
}
