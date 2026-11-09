import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import type { AgentEvent, AgentPlan, ExecutionReport, TaskGrant } from '../shared/contracts';
import { ExecutionReportSchema } from '../shared/schemas';
import { searchInBrowser } from './browser-search';
import { mainCapabilities, type BrowserSearchOutcome } from './capabilities';
import { disabledCapabilities } from './capability-state';

interface PendingRun {
  resolve: (report: ExecutionReport) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let child: UtilityProcess | null = null;
let sendToUi: ((event: AgentEvent) => void) | null = null;
const pendingRuns = new Map<string, PendingRun>();

/**
 * 逐次审批的现场。
 *
 * `pendingSteps` 记住每一步的风险等级与是否还等着答复；`remembered` 记「这个
 * 任务的这一类操作用户说过别再问」。两者都以 taskId 为界，任务报告一到就清空——
 * 上一轮说过「别再问」不代表下一份计划也同意。
 */
const pendingSteps = new Map<string, { taskId: string; risk: 'read' | 'write' | 'danger'; stepId: string }>();
const remembered = new Map<string, Set<'read' | 'write' | 'danger'>>();

function stepKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

function clearTaskApprovals(taskId: string) {
  for (const [key, value] of pendingSteps) {
    if (value.taskId === taskId) pendingSteps.delete(key);
  }
  remembered.delete(taskId);
}

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
      // 报告到了，这一轮就不会再有步骤要点头；记住的「别再问」也要清掉。
      clearTaskApprovals(String(typed.taskId));
      if (!pending) return;
      pendingRuns.delete(String(typed.taskId));
      clearTimeout(pending.timer);
      if (parsed.success) pending.resolve(parsed.data as ExecutionReport);
      else pending.reject(new Error(`Runtime 返回的执行报告无效：${parsed.error.message}`));
      return;
    }

    /**
     * 逐次审批的请求。
     *
     * 用户说过「这一类别再问」的，直接在这里放行——不是偷偷跳过，而是把
     * 一次性授权执行到底，同时**不发新事件**，界面不会闪出一堆卡片。
     */
    if (typed.type === 'step.approval') {
      const taskId = String(typed.taskId);
      const stepId = String(typed.stepId);
      const risk = (typed.risk === 'read' || typed.risk === 'danger' ? typed.risk : 'write') as
        | 'read'
        | 'write'
        | 'danger';
      const runner = child;
      if (!runner) return;

      if (remembered.get(taskId)?.has(risk)) {
        runner.postMessage({ type: 'step.approval.result', taskId, stepId, approved: true, reason: '已记住：同类操作不再询问' });
        return;
      }

      pendingSteps.set(stepKey(taskId, stepId), { taskId, risk, stepId });
      sendToUi?.(typed as unknown as AgentEvent);
      return;
    }

    /**
     * 搜索要借主进程的浏览器：Runtime 是 UtilityProcess，开不了窗口。
     *
     * 这半边也是插件（`web.search.browser`），实现由宿主注入，所以停用开关
     * 在这里就拦得住——抛出的「能力插件已停用」会作为 error 回包，被
     * `webSearch` 记成 browser 这一次失败，再按既有顺序退到 HTTP 兜底。
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
      void mainCapabilities
        .execute<BrowserSearchOutcome>(
          'web.search.browser',
          { query, limit },
          { browserSearch: searchInBrowser }
        )
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
      clearTaskApprovals(taskId);
    }
    // 没有 pendingRun 的等待（理论上不该有）也一并清掉，避免下一次执行复用脏状态。
    pendingSteps.clear();
    remembered.clear();
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
      dbPath,
      // 开关只对这次执行生效；运行中的计划不会被中途改掉。
      disabledCapabilities: disabledCapabilities()
    });
  });
}

/**
 * 用户对某一步的决定。回包一定发（除非该步已不在等待），否则 Runtime 只能
 * 等到 5 分钟超时——那会把「已经点了批准」显示成「超时没执行」。
 */
export function decideStepApproval(input: {
  taskId: string;
  stepId: string;
  approved: boolean;
  reason?: string;
  remember?: boolean;
}): { ok: true } {
  const key = stepKey(input.taskId, input.stepId);
  const pending = pendingSteps.get(key);
  if (!pending) {
    throw new Error('这一步已经不在等待确认（可能已超时或任务已结束），请以执行报告为准');
  }
  pendingSteps.delete(key);

  if (input.approved && input.remember) {
    const set = remembered.get(input.taskId) ?? new Set();
    set.add(pending.risk);
    remembered.set(input.taskId, set);
  }

  child?.postMessage({
    type: 'step.approval.result',
    taskId: input.taskId,
    stepId: input.stepId,
    approved: input.approved,
    reason: input.reason
  });

  sendToUi?.({
    type: 'step.approval-resolved',
    at: Date.now(),
    taskId: input.taskId,
    stepId: input.stepId,
    approved: input.approved,
    ...(input.reason ? { reason: input.reason } : {})
  });

  return { ok: true };
}

export function isRuntimeAlive(): boolean {
  return child !== null;
}
