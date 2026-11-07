import { randomUUID } from 'node:crypto';
import { openDb } from './db';
import { assertGrant } from './policy';
import { filesystemTools } from './tools/filesystem';
import { projectReadTools } from './tools/project-read';
import { runTest } from './tools/test-run';
import {
  PlanSchema,
  TaskGrantSchema,
  type AgentPlan,
  type ExecutionReport,
  type StepResult,
  type TaskGrant
} from '../shared/contracts';
import { verifyWrittenFile } from './verify';

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
    void runTask(message as { taskId: string; plan: unknown; grant: unknown; dbPath: string });
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
        let result: unknown;
        let verified = true;
        let testFailure: string | null = null;

        if (step.tool === 'fs.list') {
          result = await filesystemTools.list(grant, step.args as { path: string });
        } else if (step.tool === 'fs.readFile') {
          result = await filesystemTools.readFile(grant, step.args as { path: string; maxBytes?: number });
        } else if (step.tool === 'fs.mkdir') {
          result = await filesystemTools.mkdir(grant, step.args as { path: string });
        } else if (step.tool === 'fs.tree') {
          result = await projectReadTools.tree(grant, step.args as { path: string; maxDepth?: number; maxEntries?: number });
        } else if (step.tool === 'fs.search') {
          result = await projectReadTools.search(grant, step.args as { query: string; path?: string; maxResults?: number });
        } else if (step.tool === 'test.run') {
          result = await runTest(grant, step.args as { command: string });
          const run = result as { exitCode: number | null; timedOut: boolean };
          // 非零退出码是事实，不是异常。但要按「失败」记进报告，否则
          // 「测试跑过了」和「测试挂了」在界面上长得一模一样。
          if (run.exitCode !== 0) {
            testFailure = `命令退出码 ${String(run.exitCode)}${run.timedOut ? '（超时）' : ''}`;
          }
        } else {
          const args = step.args as { path: string; content: string; overwrite?: boolean; expectedHash?: string };
          result = args.overwrite
            ? await filesystemTools.overwriteFile(grant, args as { path: string; content: string; expectedHash?: string })
            : await filesystemTools.writeFile(grant, args);
          const verification = await verifyWrittenFile(grant, args.path, { content: args.content });
          verified = verification.ok;
          if (!verified) throw new Error(`写入后验证失败：${verification.reason ?? '内容不一致'}`);
        }

        const durationMs = Date.now() - stepStarted;
        if (testFailure) {
          results.push({ stepId: step.id, tool: step.tool, status: 'failed', verified: true, result, error: testFailure, durationMs });
          errors.push({ stepId: step.id, code: 'TEST_FAILED', message: testFailure });
          db.updateStep(journalId, { status: 'FAILED', error: testFailure, finished_at: Date.now() });
          port.postMessage({ type: 'step.failed', at: Date.now(), taskId, stepId: step.id, tool: step.tool, error: testFailure });
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
