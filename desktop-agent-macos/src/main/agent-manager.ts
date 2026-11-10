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
/** 正在等用户回答的提问；报告到达或取消时清掉，避免界面留下死卡片。 */
const pendingQuestions = new Map<string, { taskId: string; stepId: string }>();

function stepKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

function clearTaskApprovals(taskId: string) {
  for (const [key, value] of pendingSteps) {
    if (value.taskId === taskId) pendingSteps.delete(key);
  }
  for (const [key, value] of pendingQuestions) {
    if (value.taskId === taskId) {
      pendingQuestions.delete(key);
      sendToUi?.({ type: 'step.question-resolved', at: Date.now(), taskId, stepId: value.stepId, answered: false, reason: '任务已结束' });
    }
  }
  remembered.delete(taskId);
}

export function setAgentEventSink(sink: (event: AgentEvent) => void) {
  sendToUi = sink;
}

/**
 * 只读主进程能力的桥。
 *
 * Runtime 拿不到会话库与设置状态，`session.search` / `plugin.inspect` 这类
 * 「查」的能力只能由主进程执行。这里只放行显式登记的处理函数，不是通用后门：
 * 没有登记就明确报错，不会把 Runtime 的任意 id 转成一次主进程调用。
 */
type MainCallHandler = (
  id: string,
  args: unknown,
  context: { taskId?: string; conversationId?: string }
) => Promise<unknown>;
let mainCallHandler: MainCallHandler | null = null;

export function setMainCallHandler(handler: MainCallHandler | null) {
  mainCallHandler = handler;
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
    if (typed.type === 'main.call.request') {
      const runner = child;
      const requestId = String(typed.requestId);
      const id = String(typed.id);
      if (!runner) return;
      const reply = (payload: { ok: boolean; result?: unknown; error?: string }) => {
        runner.postMessage({ type: 'main.call.result', requestId, ...payload });
      };
      if (!mainCallHandler) {
        reply({ ok: false, error: '主进程还没有接入只读能力桥' });
        return;
      }
      const context = {
        ...(typeof typed.taskId === 'string' ? { taskId: typed.taskId } : {}),
        ...(typeof typed.conversationId === 'string' ? { conversationId: typed.conversationId } : {})
      };
      void mainCallHandler(id, typed.args, context)
        .then(result => reply({ ok: true, result }))
        .catch((error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    /**
     * 执行中提问：原样转给界面，等 answerStepQuestion 回包。
     * 不做「自动回答」，也不在无人时默认选第一项——那等于替用户做决定。
     */
    if (typed.type === 'step.question') {
      const taskId = String(typed.taskId);
      const stepId = String(typed.stepId);
      pendingQuestions.set(stepKey(taskId, stepId), { taskId, stepId });
      sendToUi?.(typed as unknown as AgentEvent);
      return;
    }

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
  ids: { roundId: string; planId: string; conversationId?: string }
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
      ...(ids.conversationId ? { conversationId: ids.conversationId } : {}),
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

/**
 * 回答执行中的提问。回包一定发：Runtime 在等这一个 key，没有回包它只能等到
 * 超时，界面就会把「已经回答」显示成「超时」。
 */
export function answerStepQuestion(input: {
  taskId: string;
  stepId: string;
  answer?: string;
  cancelled?: boolean;
}): { ok: true } {
  const key = stepKey(input.taskId, input.stepId);
  if (!pendingQuestions.has(key)) {
    throw new Error('这个提问已经不在等待回答（可能已超时或任务已结束）');
  }
  pendingQuestions.delete(key);

  child?.postMessage({
    type: 'step.answer.result',
    taskId: input.taskId,
    stepId: input.stepId,
    ...(input.cancelled === true ? { cancelled: true } : { answer: input.answer ?? '' })
  });

  sendToUi?.({
    type: 'step.question-resolved',
    at: Date.now(),
    taskId: input.taskId,
    stepId: input.stepId,
    answered: input.cancelled !== true,
    ...(input.cancelled === true ? { reason: '用户放弃回答' } : {})
  });

  return { ok: true };
}

export function isRuntimeAlive(): boolean {
  return child !== null;
}
