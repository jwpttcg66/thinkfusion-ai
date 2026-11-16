/**
 * 开场基准 Pack：一场辩论只冻结一次工程状态。
 *
 * 干净仓库只写 commit/branch（items 为空）——它已经能被 Git 还原；
 * dirty 仓库把实际改动和未跟踪文件切成片段冻结，不能用 `git diff` 代替，
 * 因为 diff 不包含未跟踪文件。
 */
import type { DebateEvidencePackState } from '../debate/types';
import type { ResolvedRepository } from './repository';
import type { EvidencePackStore } from './store';
import type { EvidencePackItemDraft } from './types';

export interface BaselinePackInput {
  store: EvidencePackStore | null | undefined;
  debateId: string;
  context: ResolvedRepository;
  createdAt: number;
}

export function publishRepositoryBaseline(input: BaselinePackInput): DebateEvidencePackState {
  const { store, debateId, context, createdAt } = input;
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
      tool: 'repository-baseline',
      capturedAt: createdAt,
      snapshotRole: 'dirty-overlay'
    }
  }));

  const status = context.errors.length > 0 ? 'partial' : 'complete';
  try {
    const published = store.publish({
      repoRoot: context.root,
      idempotencyKey: `debate:${debateId}:baseline`,
      repo: { commit: context.commit, dirty: context.dirty, branch: context.branch },
      createdAt,
      items
    });
    return {
      ...base,
      status,
      baselinePackId: published.manifest.packId,
      itemCount: published.manifest.items.length,
      ...(context.errors.length > 0 ? { reason: context.errors.join('；') } : {})
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
