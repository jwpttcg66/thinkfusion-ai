/**
 * Runtime 这一半的能力插件：29 个本地工具，逐个注册。
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
import { runTest } from './tools/test-run';
import { runShell } from './tools/shell';
import { captureScreen } from './tools/screen';
import { openApp } from './tools/app-open';
import { systemTools } from './tools/system';
import { webFetch } from './tools/web-fetch';
import { webSearch } from './tools/web-search';
import { runCode } from './tools/code-run';
import { jobOutput, killJob, listJobs } from './tools/jobs';
import { browserSearchCapability } from './browser-search-bridge';
import { verifyWrittenFile } from './verify';

export interface LocalContext {
  grant: TaskGrant;
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
  local('fs.edit', async (args, ctx) => ok(await fsExtraTools.edit(ctx.grant, args))),
  local('fs.remove', async (args, ctx) => ok(await fsExtraTools.remove(ctx.grant, args))),
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
  local('code.run', async (args, ctx) => {
    const run = await runCode(ctx.grant, args);
    if (run.exitCode !== 0) {
      return { ...commandFailure(run.exitCode, run.timedOut, '代码'), result: run };
    }
    return ok(run);
  }),
  local('fs.writeFile', async (args, ctx) => {
    const result = args.overwrite
      ? await filesystemTools.overwriteFile(ctx.grant, args)
      : await filesystemTools.writeFile(ctx.grant, args);
    const verification = await verifyWrittenFile(ctx.grant, args.path, { content: args.content });
    if (!verification.ok) throw new Error(`写入后验证失败：${verification.reason ?? '内容不一致'}`);
    return ok(result);
  })
];

export const localCapabilities = new CapabilityRegistry<LocalContext>();
for (const plugin of PLUGINS) localCapabilities.register(plugin);
