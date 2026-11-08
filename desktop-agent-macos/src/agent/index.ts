import { randomUUID } from 'node:crypto';
import { openDb } from './db';
import { assertGrant } from './policy';
import { filesystemTools } from './tools/filesystem';
import { projectReadTools } from './tools/project-read';
import { runTest } from './tools/test-run';
import { runShell } from './tools/shell';
import { captureScreen } from './tools/screen';
import { openApp } from './tools/app-open';
import { fsExtraTools } from './tools/fs-extra';
import { systemTools } from './tools/system';
import { webFetch } from './tools/web-fetch';
import { jobOutput, killJob, listJobs } from './tools/jobs';
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
        // 非零退出码是事实，不是异常。但要按「失败」记进报告，否则
        // 「命令跑过了」和「命令挂了」在界面上长得一模一样。
        let stepFailure: string | null = null;

        switch (step.tool) {
          case 'fs.list':
            result = await filesystemTools.list(grant, step.args);
            break;
          case 'fs.readFile':
            result = await filesystemTools.readFile(grant, step.args);
            break;
          case 'fs.mkdir':
            result = await filesystemTools.mkdir(grant, step.args);
            break;
          case 'fs.tree':
            result = await projectReadTools.tree(grant, step.args);
            break;
          case 'fs.search':
            result = await projectReadTools.search(grant, step.args);
            break;
          case 'fs.find':
            result = await projectReadTools.find(grant, step.args);
            break;
          case 'fs.stat':
            result = await fsExtraTools.stat(grant, step.args);
            break;
          case 'fs.edit':
            result = await fsExtraTools.edit(grant, step.args);
            break;
          case 'fs.remove':
            result = await fsExtraTools.remove(grant, step.args);
            break;
          case 'fs.move':
            result = await fsExtraTools.move(grant, step.args);
            break;
          case 'fs.copy':
            result = await fsExtraTools.copy(grant, step.args);
            break;
          case 'fs.readImage':
            result = await fsExtraTools.readImage(grant, step.args);
            break;
          case 'test.run': {
            const run = await runTest(grant, step.args);
            result = run;
            if (run.exitCode !== 0) {
              stepFailure = `命令退出码 ${String(run.exitCode)}${run.timedOut ? '（超时）' : ''}`;
            }
            break;
          }
          case 'shell.run': {
            const run = await runShell(grant, step.args);
            result = run;
            // 后台作业没有退出码：此刻"跑起来了"才是事实，退出码要等 job.output。
            if (!run.job && run.exitCode !== 0) {
              stepFailure = `命令退出码 ${String(run.exitCode)}${run.timedOut ? '（超时）' : ''}`;
            }
            break;
          }
          case 'job.list':
            result = { jobs: await listJobs() };
            break;
          case 'job.output':
            result = await jobOutput(step.args);
            break;
          case 'job.kill':
            result = await killJob(step.args);
            break;
          case 'screen.capture':
            result = await captureScreen(grant, step.args);
            break;
          case 'app.open': {
            const opened = await openApp(grant, step.args);
            result = opened;
            verified = opened.verified;
            break;
          }
          case 'clipboard.read':
            result = await systemTools.clipboardRead(grant);
            break;
          case 'clipboard.write':
            result = await systemTools.clipboardWrite(grant, step.args);
            break;
          case 'notify':
            result = await systemTools.notify(grant, step.args);
            break;
          case 'system.info':
            result = await systemTools.info(grant, step.args);
            break;
          case 'process.list':
            result = await systemTools.processList(grant, step.args);
            break;
          case 'process.kill':
            result = await systemTools.processKill(grant, step.args);
            break;
          case 'web.fetch':
            result = await webFetch(step.args);
            break;
          case 'fs.writeFile': {
            const args = step.args;
            result = args.overwrite
              ? await filesystemTools.overwriteFile(grant, args)
              : await filesystemTools.writeFile(grant, args);
            const verification = await verifyWrittenFile(grant, args.path, { content: args.content });
            verified = verification.ok;
            if (!verified) throw new Error(`写入后验证失败：${verification.reason ?? '内容不一致'}`);
            break;
          }
          default:
            throw new Error(`不支持的工具：${String((step as { tool?: string }).tool)}`);
        }

        const durationMs = Date.now() - stepStarted;
        if (stepFailure) {
          results.push({ stepId: step.id, tool: step.tool, status: 'failed', verified: true, result, error: stepFailure, durationMs });
          errors.push({ stepId: step.id, code: step.tool === 'test.run' ? 'TEST_FAILED' : 'COMMAND_FAILED', message: stepFailure });
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
