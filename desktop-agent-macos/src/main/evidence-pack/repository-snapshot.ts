/**
 * 仓库快照 Pack：工程任务需要时创建一次，记录当时的仓库状态。
 *
 * 它不是「任务开场基线」：没有任何流程围着它转；需要证据时由任务自己调用，
 * 不需要就完全不创建。干净仓库只写 commit/branch（items 为空）；
 * dirty 仓库把实际改动和未跟踪文件切成片段冻结——不能用 `git diff` 代替，
 * 因为 diff 不包含未跟踪文件。
 */
import { snapshotOfResolvedRepository } from './repository';
import type { ResolvedRepository } from './repository';
import type { EvidencePackStore } from './store';
import type { EvidencePackItemDraft } from './types';

export interface RepositorySnapshotInput {
  store: EvidencePackStore | null | undefined;
  /** 谁持有这份快照：工程任务 id，不是辩论 id。 */
  ownerId: string;
  context: ResolvedRepository;
  createdAt: number;
}

export interface RepositorySnapshotResult {
  status: 'complete' | 'partial' | 'unavailable' | 'failed';
  snapshotPackId?: string;
  itemCount: number;
  createdAt: number;
  commit: string;
  branch?: string;
  dirty: boolean;
  reason?: string;
}

export function publishRepositorySnapshot(input: RepositorySnapshotInput): RepositorySnapshotResult {
  const { store, ownerId, context, createdAt } = input;
  const base = {
    createdAt,
    commit: context.commit,
    branch: context.branch,
    dirty: context.dirty
  };
  if (!store) {
    return { ...base, status: 'unavailable', itemCount: 0, reason: 'EvidencePackStore 未配置' };
  }

  const items: EvidencePackItemDraft[] = context.chunks.map(chunk => ({
    kind: 'source-file',
    // 用解析时已经读到的内容，避免发布时重读文件造成指纹与 Pack 不一致。
    content: chunk.content,
    source: { commit: context.commit, path: chunk.path },
    locator: {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine
    },
    meta: {
      tool: 'repository-snapshot',
      capturedAt: createdAt,
      snapshotRole: 'dirty-overlay'
    }
  }));

  const status = context.errors.length > 0 ? 'partial' : 'complete';
  try {
    const published = store.publish({
      repoRoot: context.root,
      idempotencyKey: `snapshot:${ownerId}`,
      repo: { commit: context.commit, dirty: context.dirty, branch: context.branch },
      createdAt,
      context: { kind: 'snapshot', debateId: ownerId },
      snapshot: snapshotOfResolvedRepository(context),
      items
    });
    return {
      ...base,
      status,
      snapshotPackId: published.manifest.packId,
      itemCount: published.manifest.items.length,
      ...(context.errors.length > 0
        ? { reason: context.errors.map(issue => issue.message).join('；') }
        : {})
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      itemCount: 0,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
