import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { AgentEvent, AgentPlan, ExecutionReport, TaskGrant } from '../shared/contracts';
import { ExecutionReportSchema } from '../shared/schemas';
import { searchInBrowser } from './browser-search';

interface PendingRun {
  resolve: (report: ExecutionReport) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let child: UtilityProcess | null = null;
let sendToUi: ((event: AgentEvent) => void) | null = null;
const pendingRuns = new Map<string, PendingRun>();

export function setAgentEventSink(sink: (event: AgentEvent) => void) {
  sendToUi = sink;
}

export function startAgentProcess() {
  if (child) return;
  const entry = path.join(__dirname, '../agent/index.js');
  child = utilityProcess.fork(entry, [], { serviceName: 'desktop-agent-runtime' });

  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const typed = message as { type: string } & Record<string, unknown>;

    if (typed.type === 'task.report') {
      const parsed = ExecutionReportSchema.safeParse(typed.report);
      const pending = pendingRuns.get(String(typed.taskId));
      if (!pending) return;
      pendingRuns.delete(String(typed.taskId));
      clearTimeout(pending.timer);
      if (parsed.success) pending.resolve(parsed.data as ExecutionReport);
      else pending.reject(new Error(`Runtime 返回的执行报告无效：${parsed.error.message}`));
      return;
    }

    /**
     * 搜索要借主进程的浏览器：Runtime 是 UtilityProcess，开不了窗口。
     *
     * 回包一定发（成功或失败都发）：Runtime 那边在等一个 requestId 的答复，
     * 没有答复它只能等到超时——那会让一次「其实立刻失败了」的搜索看起来像
     * 「网络很慢」。
     */
    if (typed.type === 'search.browser.request') {
      const runner = child;
      const requestId = String(typed.requestId);
      const query = typeof typed.query === 'string' ? typed.query : '';
      const limit = Number(typed.limit) || 8;
      if (!runner) return;
      void searchInBrowser(query, limit)
        .then(result => runner.postMessage({ type: 'search.browser.result', requestId, result }))
        .catch(error =>
          runner.postMessage({
            type: 'search.browser.result',
            requestId,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      return;
    }

    sendToUi?.(typed as unknown as AgentEvent);
  });

  child.on('exit', code => {
    child = null;
    for (const [taskId, pending] of pendingRuns) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Agent Runtime 异常退出（code ${code ?? 'unknown'}），任务 ${taskId} 状态未知，需人工对账`));
      pendingRuns.delete(taskId);
    }
  });
}

/**
 * Hand a validated plan to the runtime and wait for its structured report.
 * The runtime re-validates both plan and grant; this function never trusts its
 * own inputs, it only transports them.
 *
 * `roundId` and `planId` travel with the request because the runtime has to
 * echo them back: the report is rejected unless it can be attributed to the
 * exact plan that was approved, and a report with empty ids cannot be.
 */
export function runPlan(
  plan: AgentPlan,
  grant: TaskGrant,
  dbPath: string,
  timeoutMs: number,
  ids: { roundId: string; planId: string }
): Promise<ExecutionReport> {
  if (!child) startAgentProcess();
  if (!child) return Promise.reject(new Error('Agent Runtime 启动失败'));

  const taskId = grant.taskId;
  if (pendingRuns.has(taskId)) return Promise.reject(new Error('同一任务已有执行中的计划'));

  return new Promise<ExecutionReport>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRuns.delete(taskId);
      reject(new Error('Runtime 执行超时，已停止等待'));
    }, timeoutMs);

    pendingRuns.set(taskId, { resolve, reject, timer });
    child?.postMessage({
      type: 'task.run',
      taskId,
      roundId: ids.roundId,
      planId: ids.planId,
      plan,
      grant,
      dbPath
    });
  });
}

export function isRuntimeAlive(): boolean {
  return child !== null;
}
