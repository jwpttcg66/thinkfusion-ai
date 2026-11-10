import { randomUUID } from 'node:crypto';
import { buildEvidenceLedger } from '../shared/engineering-evidence';
import { openDb } from './db';
import { assertGrant } from './policy';
import { localCapabilities, type AskUserInput, type AskUserOutcome, type LocalStepOutcome } from './local-plugins';
import { needsApproval, previewArgs, riskOf } from './step-approval';
import {
  PlanSchema,
  TaskGrantSchema,
  type AgentPlan,
  type ExecutionReport,
  type StepApprovalMode,
  type StepResult,
  type TaskGrant
} from '../shared/contracts';

const port = process.parentPort;
if (!port) throw new Error('Agent must run as Electron UtilityProcess');

/** Tasks the user cancelled while a plan was executing. */
const cancelled = new Set<string>();

/**
 * 逐次审批的等待表。
 *
 * key 是 `taskId:stepId`：题面里两个 id 都来自已批准的计划，Runtime 自己生成
 * 不了，所以这里的 key 不会被伪造。
 */
type ApprovalDecision = { approved: boolean; reason?: string };
const approvalWaiters = new Map<string, (decision: ApprovalDecision) => void>();

/**
 * 等用户点头的上限。
 *
 * 到点按**拒绝**处理，不是放行：一个已经关掉窗口、去开会的人不该因为「没回话」
 * 就让一条命令跑出去。超时原因会写进报告，用户回来能看到为什么停在这儿。
 */
const STEP_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

function approvalKey(taskId: string, stepId: string): string {
  return `${taskId}:${stepId}`;
}

/**
 * 执行中提问的等待表。与逐次审批同一套 key：两个 id 都来自已批准的计划，
 * Runtime 自己伪造不了。
 */
const questionWaiters = new Map<string, (outcome: AskUserOutcome) => void>();
/** 每份计划最多问 3 次：再多就是在拿提问拖住计划。 */
const MAX_QUESTIONS_PER_TASK = 3;
const questionCounts = new Map<string, number>();
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

function rejectPendingQuestions(taskId: string, reason: AskUserOutcome['reason'] = 'cancelled') {
  for (const [key, resolve] of questionWaiters) {
    if (!key.startsWith(`${taskId}:`)) continue;
    questionWaiters.delete(key);
    resolve({ answered: false, reason });
  }
}

function askUser(
  taskId: string,
  stepId: string,
  input: AskUserInput
): Promise<AskUserOutcome> {
  const used = questionCounts.get(taskId) ?? 0;
  if (used >= MAX_QUESTIONS_PER_TASK) {
    return Promise.resolve({ answered: false, reason: 'budget' });
  }
  questionCounts.set(taskId, used + 1);

  const key = approvalKey(taskId, stepId);
  const expiresAt = Date.now() + Math.min(input.timeoutMs ?? QUESTION_TIMEOUT_MS, QUESTION_TIMEOUT_MS);
  return new Promise<AskUserOutcome>(resolve => {
    const timer = setTimeout(() => {
      questionWaiters.delete(key);
      resolve({ answered: false, reason: 'timeout' });
    }, Math.max(1000, expiresAt - Date.now()));

    questionWaiters.set(key, outcome => {
      clearTimeout(timer);
      questionWaiters.delete(key);
      resolve(outcome);
    });

    port.postMessage({
      type: 'step.question',
      at: Date.now(),
      taskId,
      stepId,
      tool: 'ask.user',
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
      ...(input.allowFreeText === undefined ? {} : { allowFreeText: input.allowFreeText }),
      expiresAt
    });
  });
}

/** 拒绝某个任务所有还在等的步骤（用户点了取消）。 */
function rejectPending(taskId: string, reason: string) {
  for (const [key, resolve] of approvalWaiters) {
    if (!key.startsWith(`${taskId}:`)) continue;
    approvalWaiters.delete(key);
    resolve({ approved: false, reason });
  }
}

/** 等到用户答复，或者等到超时（按拒绝处理）。 */
function waitForApproval(input: {
  taskId: string;
  stepId: string;
  tool: string;
  index: number;
  total: number;
  argsPreview: string;
  risk: 'read' | 'write' | 'danger';
}): Promise<ApprovalDecision> {
  const key = approvalKey(input.taskId, input.stepId);
  return new Promise<ApprovalDecision>(resolve => {
    const timer = setTimeout(() => {
      approvalWaiters.delete(key);
      resolve({ approved: false, reason: '等待确认超时（5 分钟无答复），这一步没有执行' });
    }, STEP_APPROVAL_TIMEOUT_MS);

    approvalWaiters.set(key, decision => {
      clearTimeout(timer);
      approvalWaiters.delete(key);
      resolve(decision);
    });

    port.postMessage({
      type: 'step.approval',
      at: Date.now(),
      taskId: input.taskId,
      stepId: input.stepId,
      tool: input.tool,
      index: input.index,
      total: input.total,
      argsPreview: input.argsPreview,
      risk: input.risk,
      expiresAt: Date.now() + STEP_APPROVAL_TIMEOUT_MS
    });
  });
}

port.on('message', (event: { data: unknown }) => {
  const message = event.data as { type?: string; taskId?: string; stepId?: string } | null;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'task.cancel' && typeof message.taskId === 'string') {
    cancelled.add(message.taskId);
    rejectPending(message.taskId, '任务已取消，这一步没有执行');
    rejectPendingQuestions(message.taskId, 'cancelled');
    return;
  }

  if (message.type === 'step.answer.result' && typeof message.taskId === 'string') {
    const key = approvalKey(message.taskId, String(message.stepId ?? ''));
    const resolve = questionWaiters.get(key);
    if (!resolve) return;
    questionWaiters.delete(key);
    const raw = message as { answer?: unknown; cancelled?: unknown; optionIndex?: unknown };
    if (raw.cancelled === true) {
      resolve({ answered: false, reason: 'cancelled' });
      return;
    }
    const value = typeof raw.answer === 'string' ? raw.answer : '';
    resolve({
      answered: true,
      value,
      ...(typeof raw.optionIndex === 'number' ? { optionIndex: raw.optionIndex } : {})
    });
    return;
  }

  if (message.type === 'step.approval.result' && typeof message.taskId === 'string') {
    const key = approvalKey(message.taskId, String(message.stepId ?? ''));
    const resolve = approvalWaiters.get(key);
    if (!resolve) return;
    approvalWaiters.delete(key);
    const approved = (message as { approved?: unknown }).approved === true;
    const reason = (message as { reason?: unknown }).reason;
    resolve({ approved, reason: typeof reason === 'string' ? reason : undefined });
    return;
  }

  if (message.type === 'task.run') {
    const request = message as {
      taskId: string;
      plan: unknown;
      grant: unknown;
      dbPath: string;
      disabledCapabilities?: unknown;
    };
    // 开关从主进程随每次执行下发（Runtime 自己读不到 userData）。缺字段
    // 表示全部启用，老计划、老验收脚本因此不用改。
    localCapabilities.setDisabled(request.disabledCapabilities ?? []);
    void runTask(request);
  }
});

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('授权')) return 'GRANT_INVALID';
  if (message.includes('未授权工具')) return 'TOOL_NOT_ALLOWED';
  if (message.includes('路径')) return 'PATH_DENIED';
  if (message.includes('不存在')) return 'NOT_FOUND';
  if (message.includes('超过')) return 'LIMIT_EXCEEDED';
  return 'TOOL_ERROR';
}

async function runTask(message: { taskId: string; plan: unknown; grant: unknown; dbPath: string }) {
  const { taskId, dbPath } = message;
  const extra = message as { roundId?: string; planId?: string };
  let db: ReturnType<typeof openDb> | null = null;
  // Hoisted so a failure report can still name the round and plan when they are
  // known, instead of always reporting empty ids.
  let roundId = extra.roundId ?? '';
  let planId = extra.planId ?? '';

  try {
    // --- validate -------------------------------------------------------
    const plan = PlanSchema.parse(message.plan) as AgentPlan;
    const grant = TaskGrantSchema.parse(message.grant) as TaskGrant;

    if (grant.taskId !== taskId) throw new Error('授权凭据与任务不匹配');
    if (!grant.rootDir) throw new Error('授权缺少根目录');
    if (grant.approvalPolicy !== 'ask') throw new Error('授权审批策略无效');
    if (plan.taskId !== taskId) throw new Error('计划与任务不匹配');
    if (plan.steps.length > grant.maxSteps) throw new Error('步骤数超过授权上限');

    const usedTools = [...new Set(plan.steps.map(step => step.tool))];
    for (const tool of usedTools) {
      if (!grant.allowedTools.includes(tool)) throw new Error(`未授权工具：${tool}`);
    }
    for (const step of plan.steps) assertGrant(grant, step.tool, plan.steps.length);

    // A report has to be attributable to the plan that was approved, so both ids
    // must exist before anything runs. The round can be taken from the plan it
    // came from; the plan id cannot be invented, and a report without it is
    // rejected by the caller — better to fail here than after doing the work.
    if (extra.roundId && extra.roundId.length > 0) roundId = extra.roundId;
    else roundId = plan.roundId;
    if (!planId) throw new Error('执行请求缺少 planId，无法将结果归属到已批准的计划');
    if (roundId !== plan.roundId) throw new Error('执行请求的 roundId 与计划不匹配');

    // --- execute --------------------------------------------------------
    db = openDb(dbPath);
    const now = Date.now();
    db.insertTask({ id: taskId, title: plan.title, status: 'RUNNING', created_at: now, updated_at: now });
    db.insertGrant({ task_id: taskId, grant_json: JSON.stringify(grant), expires_at: grant.expiresAt });
    port.postMessage({ type: 'task.started', at: Date.now(), taskId });

    const results: StepResult[] = [];
    const errors: ExecutionReport['errors'] = [];
    let aborted = false;
    const approvalMode: StepApprovalMode = grant.stepApproval ?? 'mutating';
    const total = plan.steps.length;

    for (const [index, step] of plan.steps.entries()) {
      if (cancelled.has(taskId)) {
        aborted = true;
        results.push({ stepId: step.id, tool: step.tool, status: 'skipped', verified: false, durationMs: 0, error: '任务已取消' });
        continue;
      }

      // 逐次审批：在「这一步真的动手」之前问，而不是在整份计划提交时问。
      // 用户这时能看到前几步的真实结果与这一刀的参数，判断依据比批准整份计划多。
      if (needsApproval(step.tool, approvalMode)) {
        const decision = await waitForApproval({
          taskId,
          stepId: step.id,
          tool: step.tool,
          index: index + 1,
          total,
          argsPreview: previewArgs(step.args),
          risk: riskOf(step.tool)
        });

        if (!decision.approved) {
          const reason = decision.reason ?? '用户拒绝执行这一步';
          const journalId = `${taskId}:${step.id}:${randomUUID()}`;
          db.insertStep({
            id: journalId,
            task_id: taskId,
            tool: step.tool,
            args_json: JSON.stringify(step.args),
            status: 'FAILED',
            started_at: Date.now(),
            error: reason,
            finished_at: Date.now()
          });
          // 用户主动取消时状态是 cancelled，不该再算成「执行失败」。
          const isCancel = cancelled.has(taskId);
          if (isCancel) aborted = true;
          results.push({
            stepId: step.id,
            tool: step.tool,
            status: isCancel ? 'skipped' : 'failed',
            verified: false,
            durationMs: 0,
            error: reason
          });
          errors.push({ stepId: step.id, code: 'STEP_REJECTED', message: reason });
          port.postMessage({
            type: 'step.failed',
            at: Date.now(),
            taskId,
            stepId: step.id,
            tool: step.tool,
            error: reason
          });
          break;
        }
      }

      const stepStarted = Date.now();
      const journalId = `${taskId}:${step.id}:${randomUUID()}`;
      db.insertStep({ id: journalId, task_id: taskId, tool: step.tool, args_json: JSON.stringify(step.args), status: 'RUNNING', started_at: stepStarted });
      port.postMessage({ type: 'step.started', at: Date.now(), taskId, stepId: step.id, tool: step.tool });

      try {
        // 能力插件是唯一的分派入口：宿主不认识任何具体工具，未装载与已停用
        // 都由注册表明确报错。退出码算不算失败、写文件要不要回读，由插件自己
        // 在 LocalStepOutcome 里交代。
        const outcome = await localCapabilities.execute<LocalStepOutcome>(step.tool, step.args, {
          grant,
          ask: (input: AskUserInput) => askUser(taskId, step.id, input)
        });
        const { result, verified, failure: stepFailure } = outcome;

        const durationMs = Date.now() - stepStarted;
        if (stepFailure) {
          results.push({ stepId: step.id, tool: step.tool, status: 'failed', verified: true, result, error: stepFailure, durationMs });
          errors.push({ stepId: step.id, code: outcome.errorCode, message: stepFailure });
          db.updateStep(journalId, { status: 'FAILED', error: stepFailure, finished_at: Date.now() });
          port.postMessage({ type: 'step.failed', at: Date.now(), taskId, stepId: step.id, tool: step.tool, error: stepFailure });
          break;
        }
        results.push({ stepId: step.id, tool: step.tool, status: 'completed', verified, result, durationMs });
        db.updateStep(journalId, { status: 'COMPLETED', result_json: JSON.stringify(result), finished_at: Date.now() });
        port.postMessage({ type: 'step.completed', at: Date.now(), taskId, stepId: step.id, tool: step.tool, result });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        const durationMs = Date.now() - stepStarted;
        results.push({ stepId: step.id, tool: step.tool, status: 'failed', verified: false, error: messageText, durationMs });
        errors.push({ stepId: step.id, code: errorCode(error), message: messageText });
        db.updateStep(journalId, { status: 'FAILED', error: messageText, finished_at: Date.now() });
        port.postMessage({ type: 'step.failed', at: Date.now(), taskId, stepId: step.id, tool: step.tool, error: messageText });
        break; // Stop the plan; the planner decides whether to retry.
      }
    }

    const executed = results.filter(item => item.status === 'completed');
    const failed = results.filter(item => item.status === 'failed');

    const status: ExecutionReport['status'] = aborted
      ? 'cancelled'
      : failed.length > 0
        ? executed.length > 0
          ? 'partial'
          : 'failed'
        : 'completed';

    // 证据账本从真实步骤结果里抽，不重新描述一遍执行过程：文件读没读到、
    // 命令退出码是什么，都以这里为准。抽不出可核对事实的步骤不记。
    questionCounts.delete(taskId);
    const argsById = new Map(plan.steps.map(step => [step.id, step.args]));
    const ledger = buildEvidenceLedger(
      results.map(item => ({
        tool: item.tool,
        args: argsById.get(item.stepId),
        result: item.result,
        status: item.status
      }))
    );

    const report: ExecutionReport = {
      protocol: 'desktop-agent/v1',
      type: 'execution_report',
      taskId,
      roundId: roundId,
      planId,
      status,
      results,
      errors,
      nextAction: status === 'completed' ? 'continue' : 'stop',
      createdAt: Date.now(),
      ...(ledger.refs.length > 0 ? { evidence: ledger } : {})
    };

    db.updateTask(taskId, { status: status.toUpperCase(), updated_at: Date.now() });
    port.postMessage({ type: 'task.report', taskId, report });
    cancelled.delete(taskId);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const report: ExecutionReport = {
      protocol: 'desktop-agent/v1',
      type: 'execution_report',
      taskId,
      roundId,
      planId,
      status: 'failed',
      results: [],
      errors: [{ code: errorCode(error), message: messageText }],
      nextAction: 'stop',
      createdAt: Date.now()
    };
    port.postMessage({ type: 'task.report', taskId, report });
  } finally {
    db?.close();
  }
}
