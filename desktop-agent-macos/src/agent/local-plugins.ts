/**
 * Runtime 这一半的能力插件：79 个工具（76 个本地 + `web.fetch` / `web.search` /
 * `dns.lookup` 三个联网），逐个注册。
 *
 * 工具的实现函数一个字没动，动的只是「怎么找到它」：以前是 `agent/index.ts`
 * 里一整段 switch，现在是注册表里按 id 查。清单、权限说明、开关都来自
 * shared/capabilities，所以设置页能列出它们、用户也能单独停掉某一个。
 *
 * 每个插件返回 `LocalStepOutcome`，把原来散在 switch 里的后置判断
 * （退出码算不算失败、写文件要不要回读验证）收进插件自己。宿主只负责
 * 记日志和推进计划，不再认识任何具体工具。
 */

import { CapabilityRegistry, capabilityMeta } from '../shared/capabilities';
import type { ToolName } from '../shared/contracts';
import type { TaskGrant } from '../shared/contracts';
import { filesystemTools } from './tools/filesystem';
import { projectReadTools } from './tools/project-read';
import { fsExtraTools } from './tools/fs-extra';
import { extendedTools } from './tools/extended';
import { gitTools } from './tools/git-tools';
import { dataTools } from './tools/data-tools';
import { archiveTools } from './tools/archive';
import { textTools } from './tools/text-tools';
import { imageTools } from './tools/image-tools';
import { hostTools } from './tools/host-tools';
import { runTest } from './tools/test-run';
import { runShell } from './tools/shell';
import { captureScreen } from './tools/screen';
import { openApp } from './tools/app-open';
import { systemTools } from './tools/system';
import { webFetch } from './tools/web-fetch';
import { webSearch } from './tools/web-search';
import { runCode } from './tools/code-run';
import { runDiagnostics } from './tools/diagnostics';
import {
  closeTerminal,
  listTerminals,
  openTerminal,
  readTerminal,
  sendTerminal,
  signalTerminal
} from './tools/terminal';
import { jobOutput, killJob, listJobs } from './tools/jobs';
import { browserSearchCapability } from './browser-search-bridge';
import { verifyWrittenFile } from './verify';
import type { CliAgentConfig } from '../shared/cli-agents';
import { assertUsableCwd, cliAgentConfigError, runCliAgent } from './tools/cli-agent';
import { resolveGrantedPath } from './policy';

export interface AskUserInput {
  question: string;
  options?: string[];
  allowFreeText?: boolean;
  timeoutMs?: number;
}

export interface AskUserOutcome {
  answered: boolean;
  value?: string;
  optionIndex?: number;
  reason?: 'timeout' | 'cancelled' | 'budget';
}

export interface LocalContext {
  grant: TaskGrant;
  /** 执行中提问的通道；没接（例如脚本里直接调插件）就是 undefined。 */
  ask?: (input: AskUserInput) => Promise<AskUserOutcome>;
  /** 只读主进程能力的桥；没接就明确报错。 */
  callMain?: (id: string, args: unknown) => Promise<unknown>;
  /**
   * 本次执行可用的 CLI Agent 配置快照。由主进程随 task.run 下发：
   * Runtime 不读 userData，也不接受模型在参数里指定可执行文件。
   */
  cliAgents?: readonly CliAgentConfig[];
}

/** 第一次动某个文件之前留一份原文；没有桥就不留（脚本里直接调插件时）。 */
async function captureBeforeWrite(ctx: LocalContext, path: string): Promise<void> {
  if (!ctx.callMain) return;
  await ctx.callMain('snapshot.capture', {
    root: ctx.grant.rootDir,
    taskId: ctx.grant.taskId,
    path
  }).catch(() => undefined);
}

/**
 * 写完之后顺手要一次诊断：有语言服务就用 tsserver（快、带位置），
 * 没有就跳过——不自动跑 tsc，避免每次小改都等几秒编译。
 *
 * 结果挂在工具返回值里（`diagnostics`），模型下一步能直接看到错误位置；
 * 语言服务不可用不是失败，只是没有这份附加信息。
 */
async function withPostWriteDiagnostics(
  ctx: LocalContext,
  path: string,
  result: unknown
): Promise<unknown> {
  if (!ctx.callMain) return result;
  try {
    const checked = (await ctx.callMain('code.diagnostics.lsp', {
      root: ctx.grant.rootDir,
      path
    })) as { source?: string; issues?: unknown[]; counts?: { errors?: number; warnings?: number } } | null;
    if (!checked || !Array.isArray(checked.issues)) return result;
    return {
      ...(typeof result === 'object' && result !== null ? result : { result }),
      diagnostics: {
        source: checked.source ?? 'tsserver',
        path,
        counts: { errors: checked.counts?.errors ?? 0, warnings: checked.counts?.warnings ?? 0 },
        issues: checked.issues.slice(0, 20)
      }
    };
  } catch {
    return result;
  }
}

export interface LocalStepOutcome {
  result: unknown;
  /** 写入/打开这类动作要回读确认；其余默认 true。 */
  verified: boolean;
  /** 非零退出码是事实，不是异常，但要按失败记进报告。 */
  failure: string | null;
  errorCode: 'TEST_FAILED' | 'COMMAND_FAILED';
}

function ok(result: unknown): LocalStepOutcome {
  return { result, verified: true, failure: null, errorCode: 'COMMAND_FAILED' };
}

// Tool args are already validated by PlanSchema before they get here; each
// plugin knows its own shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;

function local(
  id: ToolName,
  run: (args: Args, context: LocalContext) => Promise<LocalStepOutcome> | LocalStepOutcome
) {
  const meta = capabilityMeta(id);
  if (!meta) throw new Error(`本地工具不在能力清单里：${id}`);
  return { ...meta, run };
}

function commandFailure(exitCode: number | null, timedOut: boolean, what: string): LocalStepOutcome {
  return {
    result: undefined,
    verified: true,
    failure: `${what}退出码 ${String(exitCode)}${timedOut ? '（超时）' : ''}`,
    errorCode: 'COMMAND_FAILED'
  };
}

const PLUGINS = [
  local('fs.list', async (args, ctx) => ok(await filesystemTools.list(ctx.grant, args))),
  local('fs.readFile', async (args, ctx) => ok(await filesystemTools.readFile(ctx.grant, args))),
  local('fs.mkdir', async (args, ctx) => ok(await filesystemTools.mkdir(ctx.grant, args))),
  local('fs.tree', async (args, ctx) => ok(await projectReadTools.tree(ctx.grant, args))),
  local('fs.search', async (args, ctx) => ok(await projectReadTools.search(ctx.grant, args))),
  local('fs.find', async (args, ctx) => ok(await projectReadTools.find(ctx.grant, args))),
  local('fs.stat', async (args, ctx) => ok(await fsExtraTools.stat(ctx.grant, args))),
  local('fs.edit', async (args, ctx) => {
    await captureBeforeWrite(ctx, args.path);
    const result = await fsExtraTools.edit(ctx.grant, args);
    return ok(await withPostWriteDiagnostics(ctx, args.path, result));
  }),
  local('fs.remove', async (args, ctx) => ok(await fsExtraTools.remove(ctx.grant, args))),
  local('fs.revert', async (_args, ctx) => {
    if (!ctx.callMain) throw new Error('当前执行环境没有接入主进程桥，fs.revert 不可用');
    return ok(await ctx.callMain('snapshot.revert', { taskId: ctx.grant.taskId }));
  }),
  local('fs.move', async (args, ctx) => ok(await fsExtraTools.move(ctx.grant, args))),
  local('fs.copy', async (args, ctx) => ok(await fsExtraTools.copy(ctx.grant, args))),
  local('fs.readImage', async (args, ctx) => ok(await fsExtraTools.readImage(ctx.grant, args))),
  local('screen.capture', async (args, ctx) => ok(await captureScreen(ctx.grant, args))),
  local('clipboard.read', async (_args, ctx) => ok(await systemTools.clipboardRead(ctx.grant))),
  local('clipboard.write', async (args, ctx) => ok(await systemTools.clipboardWrite(ctx.grant, args))),
  local('notify', async (args, ctx) => ok(await systemTools.notify(ctx.grant, args))),
  local('system.info', async (args, ctx) => ok(await systemTools.info(ctx.grant, args))),
  local('process.list', async (args, ctx) => ok(await systemTools.processList(ctx.grant, args))),
  local('process.kill', async (args, ctx) => ok(await systemTools.processKill(ctx.grant, args))),
  local('job.list', async () => ok({ jobs: await listJobs() })),
  local('job.output', async args => ok(await jobOutput(args))),
  local('job.kill', async args => ok(await killJob(args))),
  local('web.fetch', async args => ok(await webFetch(args))),
  // 搜到 0 条不记失败：这是「没资料」，不是「操作失败」。后面的 web.fetch
  // 或换词再搜仍然值得执行，原样把空结果交给模型。
  local('web.search', async (args, _ctx) =>
    ok(await webSearch(args, { browserSearch: browserSearchCapability() ?? undefined }))
  ),
  local('app.open', async (args, ctx) => {
    const opened = await openApp(ctx.grant, args);
    return { ...ok(opened), verified: opened.verified };
  }),
  local('test.run', async (args, ctx) => {
    const run = await runTest(ctx.grant, args);
    if (run.exitCode !== 0) {
      return { ...commandFailure(run.exitCode, run.timedOut, '命令'), result: run, errorCode: 'TEST_FAILED' as const };
    }
    return ok(run);
  }),
  local('shell.run', async (args, ctx) => {
    const run = await runShell(ctx.grant, args);
    // 后台作业没有退出码：此刻「跑起来了」才是事实，退出码要等 job.output。
    if (!run.job && run.exitCode !== 0) {
      return { ...commandFailure(run.exitCode, run.timedOut, '命令'), result: run };
    }
    return ok(run);
  }),
  local('fs.applyPatch', async (args, ctx) => {
    await captureBeforeWrite(ctx, args.path);
    const result = await extendedTools.applyPatch(ctx.grant, args);
    return ok(await withPostWriteDiagnostics(ctx, args.path, result));
  }),
  local('git.worktree', async (args, ctx) => ok(await extendedTools.gitWorktree(ctx.grant, args))),
  local('project.dependencies', async (args, ctx) => ok(await extendedTools.projectDependencies(ctx.grant, args))),
  local('project.outline', async (args, ctx) => ok(await extendedTools.projectOutline(ctx.grant, args))),
  local('git.status', async (args, ctx) => ok(await gitTools.gitStatus(ctx.grant, args))),
  local('git.diff', async (args, ctx) => ok(await gitTools.gitDiff(ctx.grant, args))),
  local('git.log', async (args, ctx) => ok(await gitTools.gitLog(ctx.grant, args))),
  local('git.show', async (args, ctx) => ok(await gitTools.gitShow(ctx.grant, args))),
  local('git.stash', async (args, ctx) => ok(await gitTools.gitStash(ctx.grant, args))),
  local('git.branch', async (args, ctx) => ok(await gitTools.gitBranch(ctx.grant, args))),
  local('json.query', async (args, ctx) => ok(await dataTools.jsonQuery(ctx.grant, args))),
  local('csv.summary', async (args, ctx) => ok(await dataTools.csvSummary(ctx.grant, args))),
  local('sqlite.query', async (args, ctx) => ok(await dataTools.sqliteQuery(ctx.grant, args))),
  local('archive.list', async (args, ctx) => ok(await archiveTools.archiveList(ctx.grant, args))),
  local('archive.extract', async (args, ctx) => ok(await archiveTools.archiveExtract(ctx.grant, args))),
  local('archive.create', async (args, ctx) => ok(await archiveTools.archiveCreate(ctx.grant, args))),
  local('text.diff', async (args, ctx) => ok(await textTools.textDiff(ctx.grant, args))),
  local('text.base64', async (args, ctx) => ok(await textTools.textBase64(ctx.grant, args))),
  local('image.resize', async (args, ctx) => ok(await imageTools.imageResize(ctx.grant, args))),
  local('env.read', async (args, ctx) => ok(await hostTools.envRead(ctx.grant, args))),
  local('port.list', async (args, ctx) => ok(await hostTools.portList(ctx.grant, args))),
  local('app.list', async (args, ctx) => ok(await hostTools.appList(ctx.grant, args))),
  local('window.list', async (_args, ctx) => ok(await hostTools.windowList(ctx.grant))),
  local('dns.lookup', async (args, ctx) => ok(await hostTools.dnsLookup(ctx.grant, args))),
  local('time.now', async () => ok(await hostTools.timeNow())),
  local('process.tree', async (args, ctx) => ok(await systemTools.processTree(ctx.grant, args))),
  local('fs.du', async (args, ctx) => ok(await fsExtraTools.diskUsage(ctx.grant, args))),
  local('code.run', async (args, ctx) => {
    const run = await runCode(ctx.grant, args);
    if (run.exitCode !== 0) {
      return { ...commandFailure(run.exitCode, run.timedOut, '代码'), result: run };
    }
    return ok(run);
  }),

  /**
   * 诊断：先问语言服务（tsserver），拿不到再退回一次性的 tsc / eslint / ruff。
   * 回退不是失败——它只是换一种检查器，结论里会写明 source。
   */
  local('code.diagnostics', async (args, ctx) => {
    if (ctx.callMain) {
      try {
        const lsp = await ctx.callMain('code.diagnostics.lsp', {
          root: ctx.grant.rootDir,
          ...(args.path ? { path: args.path } : {}),
          ...(args.paths ? { paths: args.paths } : {})
        });
        return ok(lsp);
      } catch {
        // 没有 tsserver / 没指定文件：继续走下面的回退，不把「语言服务不可用」
        // 伪装成「没有诊断」。
      }
    }
    return ok(await runDiagnostics(ctx.grant.rootDir, args));
  }),

  // 语义导航（只读）：实现住在主进程（tsserver 是长驻进程），这里只转发。
  ...(['code.definition', 'code.references', 'code.symbols', 'code.hover', 'code.context', 'code.impact', 'code.ast', 'code.search', 'code.team.run'] as const).map(id =>
    local(id, async (args, ctx) => {
      if (!ctx.callMain) throw new Error(`当前执行环境没有接入主进程桥，${id} 不可用`);
      // root 放在展开之后：模型就算在 args 里塞 root，也只能被授权根覆盖。
      return ok(await ctx.callMain(id, { ...(args as Record<string, unknown>), root: ctx.grant.rootDir }));
    })
  ),

  local('term.open', async (args, ctx) => ok(openTerminal(ctx.grant.rootDir, args))),
  local('term.read', async args => ok(readTerminal(args.sessionId, args.maxChars))),
  local('term.send', async args => ok(sendTerminal(args.sessionId, args.input, args.submit !== false))),
  local('term.signal', async args => ok(signalTerminal(args.sessionId, args.signal))),
  local('term.close', async args => ok(closeTerminal(args.sessionId))),
  local('term.list', async () => ok(listTerminals())),

  local('agent.exec', async (args, ctx) => {
    if (!ctx.cliAgents) throw new Error('当前执行环境没有下发 CLI Agent 配置，agent.exec 不可用');
    const config = ctx.cliAgents.find(item => item.id === args.cli);
    const configError = cliAgentConfigError(config);
    if (configError) throw new Error(configError);
    const cwd = assertUsableCwd(await resolveGrantedPath(ctx.grant, args.cwd ?? '.', false));
    const remaining = ctx.grant.expiresAt - Date.now();
    if (remaining <= 1000) throw new Error('任务授权已过期，无法启动外部 Agent');
    const run = await runCliAgent(config as CliAgentConfig, {
      taskId: ctx.grant.taskId,
      cwd,
      task: args.task,
      // 单步上限、授权剩余时间、硬上限三者取小：授权过期后不能再跑。
      timeoutMs: Math.min(args.timeoutMs ?? 600_000, remaining, 1_800_000)
    });
    if (run.cancelled) {
      return { result: run, verified: true, failure: '外部 Agent 被取消（进程组已终止）', errorCode: 'COMMAND_FAILED' as const };
    }
    if (run.timedOut) {
      return { result: run, verified: true, failure: '外部 Agent 执行超时（已终止进程组）', errorCode: 'COMMAND_FAILED' as const };
    }
    if (run.exitCode !== 0) {
      return {
        result: run,
        verified: true,
        failure: `外部 Agent 退出码 ${String(run.exitCode)}`,
        errorCode: 'COMMAND_FAILED' as const
      };
    }
    return ok(run);
  }),

  local('session.search', async (args, ctx) => {
    if (!ctx.callMain) throw new Error('当前执行环境没有接入主进程桥，session.search 不可用');
    return ok(await ctx.callMain('session.search', args));
  }),
  local('plugin.inspect', async (args, ctx) => {
    if (!ctx.callMain) throw new Error('当前执行环境没有接入主进程桥，plugin.inspect 不可用');
    return ok(await ctx.callMain('plugin.inspect', args));
  }),

  ...(['goal.create', 'goal.get', 'goal.update',
    'schedule.create', 'schedule.edit', 'schedule.list', 'schedule.view',
    'team.spawn', 'team.task.create', 'team.task.get', 'team.task.list', 'team.task.update', 'team.wait'] as const)
    .map(id => local(id, async (args, ctx) => {
      if (!ctx.callMain) throw new Error(`当前执行环境没有接入主进程桥，${id} 不可用`);
      return ok(await ctx.callMain(id, args));
    })),

  local('ask.user', async (args: AskUserInput, ctx) => {
    if (!ctx.ask) throw new Error('当前执行环境没有接入提问通道，ask.user 不可用');
    const outcome = await ctx.ask(args);
    // 没回答不是工具失败：这是一条事实，模型必须按未回答处理。
    return { result: outcome, verified: true, failure: null, errorCode: 'COMMAND_FAILED' };
  }),

  local('fs.writeFile', async (args, ctx) => {
    await captureBeforeWrite(ctx, args.path);
    const result = args.overwrite
      ? await filesystemTools.overwriteFile(ctx.grant, args)
      : await filesystemTools.writeFile(ctx.grant, args);
    const verification = await verifyWrittenFile(ctx.grant, args.path, { content: args.content });
    if (!verification.ok) throw new Error(`写入后验证失败：${verification.reason ?? '内容不一致'}`);
    return ok(await withPostWriteDiagnostics(ctx, args.path, result));
  })
];

export const localCapabilities = new CapabilityRegistry<LocalContext>();
for (const plugin of PLUGINS) localCapabilities.register(plugin);
