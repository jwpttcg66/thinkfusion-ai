import { randomUUID } from 'node:crypto';
import { openDb } from './db';
import { assertGrant } from './policy';
import { localCapabilities, type LocalStepOutcome } from './local-plugins';
import {
  PlanSchema,
  TaskGrantSchema,
  type AgentPlan,
  type ExecutionReport,
  type StepResult,
  type TaskGrant
} from '../shared/contracts';

const port = process.parentPort;
if (!port) throw new Error('Agent must run as Electron UtilityProcess');

/** Tasks the user cancelled while a plan was executing. */
const cancelled = new Set<string>();

port.on('message', (event: { data: unknown }) => {
  const message = event.data as { type?: string; taskId?: string } | null;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'task.cancel' && typeof message.taskId === 'string') {
    cancelled.add(message.taskId);
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

    for (const step of plan.steps) {
      if (cancelled.has(taskId)) {
        aborted = true;
        results.push({ stepId: step.id, tool: step.tool, status: 'skipped', verified: false, durationMs: 0, error: '任务已取消' });
        continue;
      }

      const stepStarted = Date.now();
      const journalId = `${taskId}:${step.id}:${randomUUID()}`;
      db.insertStep({ id: journalId, task_id: taskId, tool: step.tool, args_json: JSON.stringify(step.args), status: 'RUNNING', started_at: stepStarted });
      port.postMessage({ type: 'step.started', at: Date.now(), taskId, stepId: step.id, tool: step.tool });

      try {
        // 能力插件是唯一的分派入口：宿主不认识任何具体工具，未装载与已停用
        // 都由注册表明确报错。退出码算不算失败、写文件要不要回读，由插件自己
        // 在 LocalStepOutcome 里交代。
        const outcome = await localCapabilities.execute<LocalStepOutcome>(step.tool, step.args, { grant });
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
      createdAt: Date.now()
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
