/**
 * P0-4：暂停/取消时提交可恢复检查点。
 *
 * 复用 ContextCheckpoint 的归档/指针/校验事务，不新写一套存储。这里不做模型
 * 摘要：暂停点的目标是留下可核对的任务状态（目标版本、任务树 revision、
 * 副作用缺口），摘要只能来自已落库事实，不能靠模型猜。
 */

import { randomUUID } from 'node:crypto';
import type { AgentTask, ExecutionReport } from '../../../shared/contracts';
import type { ContextSummary, SideEffectLedger } from '../../../shared/context';
import { hashContextSummary } from './../compaction/summary';
import { commitContextCheckpoint, type CommitCheckpointDeps } from './commit';
import { taskContextOwner } from '../recovery/task-recovery';

export interface PauseCheckpointInput {
  task: AgentTask;
  reason: 'pause' | 'cancel';
  reports: readonly ExecutionReport[];
  taskRevision: number;
  /** 暂停点的副作用账本；只记已落库报告的核对结果，不推断内容一致。 */
  ledger: SideEffectLedger;
  needsReconciliation: number;
}

/** 暂停检查点的提交结果：就是 Journal 指针的三要素，调用方只搬运不再补写。 */
export interface PauseCheckpointOutcome {
  contextId: string;
  checkpointId: string;
  activeRunId: string;
}

export async function commitPauseCheckpoint(
  input: PauseCheckpointInput,
  deps: CommitCheckpointDeps
): Promise<PauseCheckpointOutcome> {
  const owner = taskContextOwner(input.task);
  const runId = input.task.runId ?? input.task.taskId;
  const contextId = `pause:${runId}:${String(Date.now())}`;
  const checkpointId = `cp_${randomUUID()}`;
  const completed = input.reports.flatMap(report => report.results)
    .filter(step => step.status === 'completed')
    .map(step => ({ text: `${step.tool}：${step.stepId}`, certainty: 'verified' as const, eventIds: [] }));
  const ledger = input.ledger;
  const evidence = ledger.entries
    .filter(entry => entry.paths.length > 0)
    .map(entry => ({
      ref: `${entry.stepId}:${entry.tool}:${entry.paths.join('|')}`,
      kind: 'file' as const,
      path: entry.paths[0],
      eventIds: []
    }));
  const openIssues = ledger.entries.map(entry =>
    `[${entry.status}] ${entry.stepId} ${entry.tool}：${entry.detail}`
  );
  const summary: ContextSummary = {
    goal: input.task.userPrompt,
    constraints: [
      `目标版本 v${String(input.task.goalVersion ?? 1)}`,
      `任务树 revision ${String(input.taskRevision)}`,
      `暂停原因：${input.reason}`,
      `工具执行状态：已完成 ${String(completed.length)} 步；副作用核对 applied ${String(ledger.applied)} / missing ${String(ledger.missing)} / needs_reconciliation ${String(ledger.needsReconciliation)}`
    ],
    completed,
    decisions: [],
    evidence,
    openIssues,
    currentStep: null,
    nextActions: ['恢复前重新核对目标契约、任务树、副作用与证据'],
    risks: input.needsReconciliation > 0
      ? [`${String(input.needsReconciliation)} 项写入没有可核对路径，恢复时需要人工核对`]
      : [],
    stopConditions: ['目标版本、任务树 revision 或副作用账本与检查点不一致时停在 blocked 等用户确认']
  };
  const summaryHash = hashContextSummary(summary);
  await commitContextCheckpoint({
    owner,
    runId,
    contextId,
    checkpoint: {
      contractVersion: 1,
      checkpointId,
      owner,
      taskId: input.task.taskId,
      runId,
      contextId,
      sourceStartSeq: 0,
      sourceEndSeq: 0,
      sourceEventIds: [],
      summary,
      summaryHash,
      retainedEventIds: [],
      evidenceRefs: [],
      modelId: 'deterministic-pause-checkpoint',
      inputTokensBefore: null,
      inputTokensAfter: null,
      status: 'prepared',
      createdAt: Date.now()
    },
    sourceEvents: []
  }, deps);
  return { contextId, checkpointId, activeRunId: runId };
}
