/**
 * 检查点提交事务（LT-P3-03）。
 *
 * 顺序：归档 → prepared 文件 → Journal 单次指针+事件 → 校验 → 返回。
 * Journal 指针是唯一提交权威；文件 status=prepared 不代表活动检查点。
 */

import type { AgentEvent } from '../../../shared/contracts';
import type {
  ContextCheckpoint,
  ContextOwner,
  PreparedContext
} from '../../../shared/context';
import { hashContextSummary } from '../compaction/summary';
import type { ContextArchiveStore } from './archive';
import type { ContextCheckpointStore } from './store';

export interface ContextJournalPointer {
  contextId: string;
  checkpointId: string;
  activeRunId: string;
}

export interface ContextCheckpointJournal {
  /** 一次持久化更新 owner 指针 + committed 事件。 */
  commitContextCheckpoint(input: {
    owner: ContextOwner;
    contextId: string;
    checkpointId: string;
    activeRunId: string;
    event?: AgentEvent;
  }): void;
}

export interface CommitCheckpointInput {
  owner: ContextOwner;
  runId: string;
  contextId: string;
  checkpoint: ContextCheckpoint;
  /** 被压缩的原始事件；非空时必须先归档。 */
  sourceEvents: readonly unknown[];
  sourceStream?: 'events' | 'runEvents';
  event?: AgentEvent;
}

export interface CommitCheckpointDeps {
  store: ContextCheckpointStore;
  archive: ContextArchiveStore;
  journal: ContextCheckpointJournal;
}

export class CheckpointCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCommitError';
  }
}

export async function commitContextCheckpoint(
  input: CommitCheckpointInput,
  deps: CommitCheckpointDeps
): Promise<ContextCheckpoint> {
  const checkpoint: ContextCheckpoint = {
    ...input.checkpoint,
    owner: input.owner,
    runId: input.runId,
    contextId: input.contextId,
    status: 'prepared'
  };

  if (checkpoint.summaryHash !== hashContextSummary(checkpoint.summary)) {
    throw new CheckpointCommitError('摘要 hash 与内容不一致');
  }

  if (input.sourceEvents.length > 0) {
    const archive = await deps.archive.write({
      owner: input.owner,
      checkpointId: checkpoint.checkpointId,
      sourceStream: input.sourceStream ?? 'events',
      events: input.sourceEvents
    });
    checkpoint.archiveRef = archive.archiveRef;
  } else if (checkpoint.sourceEventIds.length > 0 && !checkpoint.archiveRef) {
    throw new CheckpointCommitError('检查点引用了来源事件，但没有归档段');
  }

  await deps.store.write(input.owner, checkpoint);

  deps.journal.commitContextCheckpoint({
    owner: input.owner,
    contextId: input.contextId,
    checkpointId: checkpoint.checkpointId,
    activeRunId: input.runId,
    ...(input.event ? { event: input.event } : {})
  });

  const stored = await deps.store.find(input.owner, checkpoint.checkpointId);
  if (!stored) throw new CheckpointCommitError('Journal 已提交，但检查点文件不存在');
  if (stored.summaryHash !== checkpoint.summaryHash) {
    throw new CheckpointCommitError('Journal 已提交，但检查点 hash 不一致');
  }
  return stored;
}

export class ContextCheckpointStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextCheckpointStaleError';
  }
}

export interface RecoverContextInput {
  owner: ContextOwner;
  runId: string;
  pointer: ContextJournalPointer | null;
}

export interface RecoverContextDeps {
  store: ContextCheckpointStore;
  archive: ContextArchiveStore;
}

/**
 * 只按 Journal 活动指针恢复；activeCache 不参与决策。
 * 来源归档缺失/hash 不匹配 → stale，不返回半可用上下文。
 */
export async function recoverContext(
  input: RecoverContextInput,
  deps: RecoverContextDeps
): Promise<PreparedContext | null> {
  const pointer = input.pointer;
  if (!pointer || pointer.activeRunId !== input.runId) return null;
  const checkpoint = await deps.store.find(input.owner, pointer.checkpointId);
  if (!checkpoint) throw new ContextCheckpointStaleError('活动检查点文件不存在');
  if (checkpoint.runId !== input.runId) {
    throw new ContextCheckpointStaleError('检查点 runId 与当前运行不一致');
  }
  if (checkpoint.summaryHash !== hashContextSummary(checkpoint.summary)) {
    throw new ContextCheckpointStaleError('检查点摘要 hash 不匹配');
  }
  if (checkpoint.sourceEventIds.length > 0) {
    if (!checkpoint.archiveRef) throw new ContextCheckpointStaleError('检查点缺少来源归档');
    const valid = await deps.archive.verify(checkpoint.archiveRef);
    if (!valid) throw new ContextCheckpointStaleError('来源归档缺失或 hash 不匹配');
  }
  return {
    contextId: pointer.contextId,
    owner: input.owner,
    ...(input.owner.ownerType === 'agent-task'
      ? { taskId: input.owner.taskId }
      : { conversationId: input.owner.conversationId }),
    runId: input.runId,
    checkpointId: checkpoint.checkpointId,
    includedEventIds: checkpoint.sourceEventIds,
    retainedEventIds: checkpoint.retainedEventIds,
    evidenceRefs: checkpoint.evidenceRefs,
    estimatedTokens: 0,
    contextWindow: null,
    compactionStatus: 'committed'
  };
}
