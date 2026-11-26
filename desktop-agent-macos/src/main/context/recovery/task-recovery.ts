/**
 * 任务恢复（LT-P5-03/04）。
 *
 * 只按 Journal 活动指针恢复；摘要只作为数据交给下一轮，不当作执行事实。
 * 来源归档缺失/hash 不匹配 → stale，任务留在 interrupted 等人处理。
 */

import type { AgentEvent, AgentTask, ExecutionReport } from '../../../shared/contracts';
import { ecoCompatibilityFromEvents, parseEcoEvidenceRef, type EcoCheckpointRef } from '../../../shared/eco';
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

/**
 * 恢复结论。
 *
 * 「检查点有效」不等于「上下文仍然成立」：目标、任务结构、ECO 版本、
 * 贡献快照任何一个变了，都不能拿旧结论继续做正式决策。所以把恢复拆成
 * 可判定的几档，而不是一个 recovered 通吃。
 */
export type TaskRecoveryStatus =
  | 'none'
  | 'recovered'
  /** 检查点能读，但工程上下文已过期：必须重新采集后才能正式裁决。 */
  | 'needs_context_refresh'
  /** 目标或任务结构发生实质变化：要局部重规划，不能接着跑旧步骤。 */
  | 'needs_replan'
  | 'stale'
  | 'blocked';

export interface TaskRecoveryResult {
  status: TaskRecoveryStatus;
  /** 检查点钉住的 ECO 是否仍兼容；缺省表示没有 ECO 引用可核对。 */
  eco?: { ok: boolean; reason: string };
  /** 检查点里钉住的 ECO 引用原文；调用方可以据此做版本链核对（P1-05）。 */
  ecoRef?: EcoCheckpointRef;
  /** 目标/任务版本兼容性；缺省表示检查点里没有对应引用。 */
  goal?: { ok: boolean; reason: string };
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
  /** 读任务事件流：ECO 兼容性靠重放最后的 eco.context.prepared 得到。 */
  eventsForTask?: (taskId: string) => readonly AgentEvent[];
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
    const ecoRefs = (checkpoint?.evidenceRefs ?? [])
      .map(parseEcoEvidenceRef)
      .filter((item): item is EcoCheckpointRef => item !== null);
    const lastEco = ecoRefs.at(-1);
    // 目标版本变了：检查点本身没问题，但它描述的是一份旧目标下的任务，
    // 继续按旧步骤跑只会做错事。这一档必须大于「上下文刷新」——刷新上下文
    // 解决不了「要做的东西变了」。
    const taskGoalVersion = task.goalVersion;
    if (
      lastEco?.goalVersion !== undefined &&
      taskGoalVersion !== undefined &&
      lastEco.goalVersion !== taskGoalVersion
    ) {
      return {
        status: 'needs_replan',
        checkpointId: pointer.checkpointId,
        contextId: pointer.contextId,
        compactionStatus: prepared.compactionStatus,
        ...(checkpoint ? { summary: checkpoint.summary } : {}),
        ...(lastEco ? { ecoRef: lastEco } : {}),
        goal: {
          ok: false,
          reason: `检查点基于目标 v${String(lastEco.goalVersion)}，当前任务目标 v${String(taskGoalVersion)}`
        },
        ledger,
        reason: '目标版本已变化：需要按当前目标重新规划，不能沿用旧分解与旧结论'
      };
    }
    const eco = lastEco && deps.eventsForTask
      ? ecoCompatibilityFromEvents({
          saved: lastEco,
          workId: task.taskId,
          events: deps.eventsForTask(task.taskId)
        })
      : null;
    // 检查点能读，但上下文过期：不假装 recovered。任务可以恢复，前提是
    // 先重新采集工程上下文；正式角色在这之前一律不派。
    if (eco && !eco.ok) {
      return {
        status: 'needs_context_refresh',
        checkpointId: pointer.checkpointId,
        contextId: pointer.contextId,
        compactionStatus: prepared.compactionStatus,
        ...(checkpoint ? { summary: checkpoint.summary } : {}),
        ...(lastEco ? { ecoRef: lastEco } : {}),
        eco: { ok: false, reason: eco.reason },
        ledger,
        reason: `检查点有效，但工程上下文不兼容：${eco.reason}`
      };
    }
    return {
      status: 'recovered',
      checkpointId: pointer.checkpointId,
      contextId: pointer.contextId,
      compactionStatus: prepared.compactionStatus,
      ...(checkpoint ? { summary: checkpoint.summary } : {}),
      ...(lastEco ? { ecoRef: lastEco } : {}),
      ...(eco ? { eco: { ok: eco.ok, reason: eco.reason } } : {}),
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
  if (
    result.status !== 'recovered' &&
    result.status !== 'needs_context_refresh' &&
    result.status !== 'needs_replan'
  ) {
    return '';
  }
  const lines = [
    '上次上下文检查点（模型生成的摘要，不是执行事实；恢复以执行报告与工作区为准）：',
    JSON.stringify(result.summary ?? null, null, 2)
  ];
  if (result.status === 'needs_replan') {
    lines.push(
      '',
      `目标已变化（${result.goal?.reason ?? '版本不一致'}）：按当前目标重新规划，不得沿用旧分解、旧计划或旧结论；已经确认真实存在的产物可以作为现状，但要重新核验。`
    );
  }
  if (result.status === 'needs_context_refresh') {
    lines.push(
      '',
      `工程上下文已过期（${result.eco?.reason ?? 'ECO 版本不兼容'}）：先重新读取相关文件、依赖与配置，再规划；本次不得沿用旧上下文做正式设计或裁决。`
    );
  }
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
