/**
 * 任务恢复（LT-P5-03/04）。
 *
 * 只按 Journal 活动指针恢复；摘要只作为数据交给下一轮，不当作执行事实。
 * 来源归档缺失/hash 不匹配 → stale，任务留在 interrupted 等人处理。
 */

import type { AgentTask, ExecutionReport } from '../../../shared/contracts';
import type {
  ContextCheckpoint,
  ContextCompactionStatus,
  ContextOwner,
  ContextSummary,
  SideEffectLedger
} from '../../../shared/context';
import {
  ContextCheckpointStaleError,
  recoverContext
} from '../checkpoint/commit';
import type { ContextArchiveStore } from '../checkpoint/archive';
import type { ContextCheckpointStore } from '../checkpoint/store';
import {
  collectSideEffects,
  reconcileSideEffects
} from './side-effects';

export type TaskRecoveryStatus = 'none' | 'recovered' | 'stale';

export interface TaskRecoveryResult {
  status: TaskRecoveryStatus;
  checkpointId?: string;
  contextId?: string;
  compactionStatus?: ContextCompactionStatus;
  summary?: ContextSummary;
  ledger?: SideEffectLedger;
  reason?: string;
}

export interface RecoverTaskDeps {
  store: ContextCheckpointStore;
  archive: ContextArchiveStore;
}

export function taskContextOwner(task: AgentTask): ContextOwner {
  const runId = task.runId ?? task.taskId;
  return { ownerType: 'agent-task', ownerId: task.taskId, taskId: task.taskId, runId };
}

/**
 * 恢复任务上下文。
 *
 * - 没有 checkpointId：`none`，调用方保持原行为；
 * - 指针/hash/归档有效：`recovered`；
 * - 检查点损坏或 runId 不一致：`stale`，不返回半可用摘要。
 */
export async function recoverTaskContext(
  task: AgentTask,
  reports: readonly ExecutionReport[],
  deps: RecoverTaskDeps
): Promise<TaskRecoveryResult> {
  const ledger = await reconcileSideEffects(collectSideEffects(reports), {
    workspaceRoot: task.workspaceRoot
  });

  if (!task.checkpointId || !task.contextId) {
    return { status: 'none', ledger };
  }

  const owner = taskContextOwner(task);
  const pointer = {
    contextId: task.contextId,
    checkpointId: task.checkpointId,
    activeRunId: task.activeRunId ?? owner.runId
  };

  try {
    const prepared = await recoverContext(
      { owner, runId: owner.runId, pointer },
      deps
    );
    if (!prepared) {
      return {
        status: 'none',
        ledger,
        reason: '检查点活动指针与当前 runId 不一致'
      };
    }
    const checkpoint = await deps.store.find(owner, pointer.checkpointId);
    return {
      status: 'recovered',
      checkpointId: pointer.checkpointId,
      contextId: pointer.contextId,
      compactionStatus: prepared.compactionStatus,
      ...(checkpoint ? { summary: checkpoint.summary } : {}),
      ledger
    };
  } catch (error) {
    const reason = error instanceof ContextCheckpointStaleError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    return { status: 'stale', checkpointId: pointer.checkpointId, ledger, reason };
  }
}

/** 恢复摘要只作为数据附在继续请求里；明确标注来源与 certainty 限制。 */
export function recoveryPromptData(result: TaskRecoveryResult): string {
  if (result.status !== 'recovered') return '';
  const lines = [
    '上次上下文检查点（模型生成的摘要，不是执行事实；恢复以执行报告与工作区为准）：',
    JSON.stringify(result.summary ?? null, null, 2)
  ];
  const ledger = result.ledger;
  if (ledger) {
    lines.push(
      '',
      `副作用核对：仍存在 ${String(ledger.applied)}，缺失 ${String(ledger.missing)}，需人工核对 ${String(ledger.needsReconciliation)}。`
    );
    for (const entry of ledger.entries.slice(0, 20)) {
      lines.push(`- [${entry.status}] ${entry.stepId} ${entry.tool} ${entry.paths.join(', ')}`);
    }
  }
  return lines.join('\n');
}

export function checkpointOf(
  result: TaskRecoveryResult,
  store: ContextCheckpointStore,
  owner: ContextOwner
): Promise<ContextCheckpoint | null> {
  if (!result.checkpointId) return Promise.resolve(null);
  return store.find(owner, result.checkpointId);
}
