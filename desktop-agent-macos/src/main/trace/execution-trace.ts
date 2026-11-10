import type { AgentTask, ExecutionReport } from '../../shared/contracts';
import type { ConversationEvent } from '../../shared/conversation';
import { TraceRecorder } from './trace-recorder';
import type { TraceStore } from './trace-store';

/**
 * 执行报告 → 轨迹。
 *
 * 执行由独立 Runtime 跑，不在 ConversationRunner 的调用栈里；报告落库后
 * 用 `task.conversationId` 另起一轮记录。步骤时间来自
 * `StepResult.durationMs`，不是重新计时，所以和左侧执行日志里的数字一致。
 */
export function recordExecutionReport(
  store: TraceStore,
  task: AgentTask,
  report: ExecutionReport,
  emit: (event: ConversationEvent) => void
): void {
  if (!task.conversationId) return;
  const recorder = new TraceRecorder(store, task.conversationId, emit);
  recorder.beginTurn({
    inputPreview: task.title,
    reason: '执行报告',
    meta: { code: 'execution-report' }
  });
  const total = report.results.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
  let cursor = report.createdAt - total;
  for (const result of report.results) {
    const duration = Math.max(0, result.durationMs);
    const startedAt = cursor;
    const endedAt = cursor + duration;
    cursor = endedAt;
    const step = recorder.beginStep({
      stage: 'execute',
      group: 'execute',
      actorId: 'executor',
      actorLabel: result.tool,
      sourceType: 'system',
      reason: `${result.status}${result.verified ? ' · 已验证' : ''}`,
      startedAt
    });
    recorder.endStep(step, {
      status:
        result.status === 'completed'
          ? 'ok'
          : result.status === 'skipped'
            ? 'skipped'
            : 'failed',
      endedAt,
      ...(result.error ? { error: { code: 'unknown', detail: result.error } } : {})
    });
  }
  recorder.endTurn({
    status:
      report.status === 'completed'
        ? 'ok'
        : report.status === 'cancelled'
          ? 'cancelled'
          : report.status === 'failed'
            ? 'failed'
            : 'interrupted',
    reason: report.status
  });
}
