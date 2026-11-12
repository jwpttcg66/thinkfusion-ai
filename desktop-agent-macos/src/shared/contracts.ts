import { z } from 'zod';
import type { ConversationAttachment } from './attachments';
import type { CapabilityView } from './capabilities';
import type { EvidenceLedger } from './engineering-evidence';
import type { ExpertiseView } from './expertise';
import type { EmbeddingRequest, EmbeddingResult, EmbeddingStatus } from './embeddings';
import type { CodeIndexLink, CodeIndexLinkInput, CodeIndexMemory, CodeIndexMemoryInput, CodeIndexSearchInput, CodeIndexSearchResult, CodeIndexStatus, CodeIndexVectorResult } from './code-index';
import type { CodeIntelligenceConfig, CodeIntelligenceManagedAction, CodeIntelligenceManagedResult, CodeIntelligencePatch, CodeIntelligenceStatus } from './code-intelligence';
import type { PageSource } from './sources';
import type { IntentKind } from './intent';
import type { EngineeringTaskKind, TaskRouting, WorkspaceEntry, WorkspaceMode, WorkspaceState } from './workspace';
import type { LearnSelectorsReport } from './selectors';
import type { SearchSettingsPatch, SearchSettingsView, SearchTestResult } from './search';
import type {
  ExportConversationInput,
  ExportConversationResult,
  PageExtractPreview,
  SavePageDocumentInput,
  SavePageDocumentResult
} from './export';
import type {
  ChannelStatus,
  Conversation,
  ConversationDeleteOutcome,
  ConversationEvent,
  ConversationExecutionConfig,
  ConversationMessage,
  ExecutionMode,
  FollowupConversationInput,
  SubmitConversationInput
} from './conversation';
import type { TraceEntry, TraceTotals } from './trace';

/**
 * desktop-agent/v1 wire + IPC contracts.
 *
 * Everything that crosses a trust boundary (DeepSeek page -> main, renderer ->
 * main, main -> runtime) is described here or in schemas.ts. Nothing in this
 * file may depend on Electron so the runtime process can import it.
 */

export const PROTOCOL = 'desktop-agent/v1';

/**
 * V2.1 扩展了工具集，但顺序与语义保持兼容：前四个是 v1 原有的，
 * 老计划、老 grant、老 journal 里的工具名一个都没变。
 *
 * - `fs.tree` / `fs.search` / `fs.find`：工程理解要能递归看目录、按内容搜
 *   代码、按文件名/通配符找文件（只读）。
 * - `test.run`：工程实施要能拿到真实退出码，而不是模型自称「测试通过」。
 * - `shell.run`：对齐本地 harness 的 shell 能力。不是「再包一层白名单命令」——
 *   `workspace-write` 只放行只读与构建类命令，`danger-full-access` 才给真
 *   shell（仍然拦 `sudo` / `mkfs` / `rm -rf /` 这类不可回收的操作）。
 * - `screen.capture`：真实调用系统截图，产物落盘并带指纹，不是让模型描述
 *   一张「我想象的屏幕」。
 * - `app.open`：真实启动应用或打开文件，并回读进程是否存在。
 * - `fs.writeFile` 新增 `overwrite` + `expectedHash`：改已有文件必须先证明
 *   它还是当时读到的那一版，否则宁可拒绝，也不覆盖别人刚改的内容。
 */
export const TOOL_NAMES = [
  'fs.list', 'fs.readFile', 'fs.mkdir', 'fs.writeFile',
  'fs.tree', 'fs.search', 'fs.find', 'fs.stat', 'fs.edit', 'fs.remove', 'fs.move', 'fs.copy', 'fs.readImage',
  'fs.applyPatch', 'fs.revert', 'git.worktree', 'project.dependencies', 'project.outline',
  'git.status', 'git.diff', 'git.log', 'git.show', 'git.stash', 'git.branch',
  'json.query', 'csv.summary', 'sqlite.query',
  'archive.list', 'archive.extract', 'archive.create',
  'text.diff', 'text.base64',
  'image.resize',
  'env.read', 'port.list', 'app.list', 'window.list', 'dns.lookup', 'time.now',
  'process.tree',
  'fs.du',
  'test.run', 'shell.run', 'ask.user', 'code.diagnostics',
  'code.definition', 'code.references', 'code.symbols', 'code.hover', 'code.context', 'code.impact', 'code.ast',
  'code.search', 'code.team.run',
  'term.open', 'term.read', 'term.send', 'term.signal', 'term.close', 'term.list',
  'session.search', 'plugin.inspect',
  'goal.create', 'goal.get', 'goal.update',
  'schedule.create', 'schedule.edit', 'schedule.list', 'schedule.view',
  'team.spawn', 'team.task.create', 'team.task.get', 'team.task.list', 'team.task.update', 'team.wait',
  'job.list', 'job.output', 'job.kill',
  'screen.capture', 'app.open',
  'clipboard.read', 'clipboard.write', 'notify', 'system.info', 'process.list', 'process.kill',
  'web.fetch', 'web.search', 'code.run'
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * 只读工具。read-only 预设只允许这些。
 *
 * `test.run` / `shell.run` / `screen.capture` / `app.open` 都会产生副作用
 * （构建产物、系统命令、截图文件、启动进程），一个都不能放进来——只读就是
 * 只读，不能因为「它看起来像查看」就放宽。`web.fetch` 虽然不改本机，但会把
 * 工作区内容发到外网，同样不算只读。
 */
export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'fs.list', 'fs.readFile', 'fs.tree', 'fs.search', 'fs.find', 'fs.stat', 'fs.readImage',
  'project.dependencies', 'project.outline', 'git.status', 'git.diff', 'git.log', 'git.show',
  'json.query', 'csv.summary', 'sqlite.query', 'archive.list', 'text.diff',
  'env.read', 'port.list', 'app.list', 'window.list', 'time.now', 'process.tree', 'fs.du',
  'system.info', 'process.list', 'clipboard.read',
  // 提问不改本机，但会阻塞计划；只读档位下允许，因为它反而是在收敛风险。
  'ask.user',
  // tsc --noEmit 不写盘；eslint 不传 --cache。诊断属于「看」，不属于「改」。
  'code.diagnostics', 'code.definition', 'code.references', 'code.symbols', 'code.hover', 'code.context', 'code.impact', 'code.ast', 'code.search',
  // 只读主进程查询：会话检索、能力清单、目标/任务板读取，都不改任何状态。
  'session.search', 'plugin.inspect',
  'goal.get', 'schedule.list', 'schedule.view',
  'team.task.get', 'team.task.list', 'team.wait'
];

/** 有副作用的工具。审批界面据此提示，Runtime 据此在只读授权下拒绝。 */
export const MUTATING_TOOLS: readonly ToolName[] = [
  'fs.mkdir', 'fs.writeFile', 'fs.edit', 'fs.remove', 'fs.move', 'fs.copy', 'fs.applyPatch', 'fs.revert',
  'git.worktree', 'git.stash', 'git.branch',
  'archive.extract', 'archive.create', 'text.base64', 'image.resize',
  'test.run', 'shell.run', 'job.list', 'job.output', 'job.kill',
  'screen.capture', 'app.open',
  'clipboard.write', 'notify', 'process.kill', 'dns.lookup', 'web.fetch', 'web.search', 'code.run', 'code.team.run',
  'term.open', 'term.read', 'term.send', 'term.signal', 'term.close', 'term.list',
  'goal.create', 'goal.update', 'schedule.create', 'schedule.edit',
  'team.spawn', 'team.task.create', 'team.task.update'
];

/** `code.run` 支持的解释器。三种都是真实的本地解释器，不是伪执行。 */
export const CODE_LANGUAGES = ['node', 'python3', 'bash'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export const TEST_COMMANDS = [
  'npm test',
  'npm run typecheck',
  'npm run build',
  'npm run build:agent',
  'npm run test:protocol'
] as const;
export type TestCommand = (typeof TEST_COMMANDS)[number];

export type PermissionPreset = 'read-only' | 'workspace-write' | 'danger-full-access';

const Id = z.string().min(1).max(80);
const RelativePath = z.string().min(1).max(500);

// ---------------------------------------------------------------------------
// Plan (produced by DeepSeek, never trusted until validated)
// ---------------------------------------------------------------------------

export const StepSchema = z.discriminatedUnion('tool', [
  z.object({ id: Id, tool: z.literal('fs.list'), args: z.object({ path: RelativePath }).strict(), description: z.string().max(500).optional() }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.readFile'),
    args: z.object({
      path: RelativePath,
      /** 载入内存的上限；超过就拒绝，提示改用搜索/分页（默认 8 MB）。 */
      maxBytes: z.number().int().min(1).max(8_388_608).optional(),
      /** 从第几行开始读（1-based）。 */
      offset: z.number().int().min(1).max(1_000_000_000).optional(),
      /** 读多少行；默认 2000，上限 2000。 */
      limit: z.number().int().min(1).max(2000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({ id: Id, tool: z.literal('fs.mkdir'), args: z.object({ path: RelativePath }).strict(), description: z.string().max(500).optional() }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.writeFile'),
    args: z.object({
      path: RelativePath,
      content: z.string().max(1_000_000),
      /** 要改已有文件，必须同时给出当时读到的 sha256。 */
      overwrite: z.boolean().optional(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.tree'),
    args: z.object({
      path: RelativePath,
      maxDepth: z.number().int().min(1).max(6).optional(),
      maxEntries: z.number().int().min(1).max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.search'),
    args: z.object({
      query: z.string().min(1).max(200),
      path: RelativePath.optional(),
      maxResults: z.number().int().min(1).max(100).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.find'),
    args: z.object({
      /** 文件名通配：`*.ts`、`src/**\/*.test.ts`、`README*`。 */
      pattern: z.string().min(1).max(200),
      path: RelativePath.optional(),
      maxResults: z.number().int().min(1).max(200).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.stat'),
    args: z.object({ path: RelativePath }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.edit'),
    args: z.object({
      path: RelativePath,
      /** 必须与文件里的文本逐字一致；默认要求只出现一次。 */
      oldString: z.string().min(1).max(20_000),
      newString: z.string().max(200_000),
      replaceAll: z.boolean().optional(),
      /** 读到的 sha256，用于确认改的是当时那一版。 */
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.remove'),
    args: z.object({
      path: RelativePath,
      /** 目录必须显式声明，避免一次误删整棵树。 */
      recursive: z.boolean().optional(),
      /** 直接删除而不是移到废纸篓；只有完全权限才会执行。 */
      permanent: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.move'),
    args: z.object({ from: RelativePath, to: RelativePath }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.copy'),
    args: z.object({ from: RelativePath, to: RelativePath }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.readImage'),
    args: z.object({ path: RelativePath }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('test.run'),
    args: z.object({ command: z.enum(TEST_COMMANDS) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('shell.run'),
    args: z.object({
      command: z.string().min(1).max(2000),
      /** 相对工作区的目录；不给就是工作区根目录。 */
      cwd: RelativePath.optional(),
      timeoutMs: z.number().int().min(1000).max(300_000).optional(),
      /** 放到后台跑，立刻返回作业 id；后续用 job.output / job.kill。 */
      background: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('job.list'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('job.output'),
    args: z.object({
      id: z.string().min(1).max(120),
      tailBytes: z.number().int().min(1000).max(262_144).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('job.kill'),
    args: z.object({
      id: z.string().min(1).max(120),
      signal: z.enum(['TERM', 'KILL']).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('screen.capture'),
    args: z.object({
      target: z.enum(['screen', 'region']).optional(),
      /** target=region 时必须给，单位是屏幕像素点。 */
      region: z.object({
        x: z.number().int().min(0).max(20_000),
        y: z.number().int().min(0).max(20_000),
        width: z.number().int().min(1).max(20_000),
        height: z.number().int().min(1).max(20_000)
      }).strict().optional(),
      /** 相对工作区（或完全权限下的绝对路径）；不给就落在应用缓存目录。 */
      path: RelativePath.optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('app.open'),
    args: z.object({
      /** 应用名，例如 "TextEdit"、"Safari"。与 path 二选一。 */
      app: z.string().min(1).max(200).optional(),
      /** 要打开的文件/目录。与 app 二选一。 */
      path: RelativePath.optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('clipboard.read'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('clipboard.write'),
    args: z.object({ text: z.string().max(262_144) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('notify'),
    args: z.object({
      title: z.string().min(1).max(120),
      message: z.string().max(1000).optional(),
      subtitle: z.string().max(120).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('system.info'),
    args: z.object({
      scope: z.enum(['all', 'os', 'cpu', 'memory', 'disk', 'battery']).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('process.list'),
    args: z.object({
      filter: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(200).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('process.kill'),
    args: z.object({
      pid: z.number().int().min(1).max(999_999),
      signal: z.enum(['TERM', 'KILL']).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('web.fetch'),
    args: z.object({
      url: z.string().min(1).max(2000),
      method: z.enum(['GET', 'POST']).optional(),
      headers: z.record(z.string().max(200)).optional(),
      body: z.string().max(100_000).optional(),
      maxBytes: z.number().int().min(1024).max(2_000_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('web.search'),
    args: z.object({
      query: z.string().min(1).max(300),
      maxResults: z.number().int().min(1).max(20).optional(),
      /** 限定站点，例如 `github.com`。 */
      site: z.string().min(1).max(120).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.revert'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.applyPatch'),
    args: z.object({
      path: RelativePath,
      /** 单文件 unified diff（含 @@ hunk 头）；上下文对不上就整份拒绝。 */
      patch: z.string().min(1).max(512_000),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.worktree'),
    args: z.object({
      action: z.enum(['list', 'add', 'remove']),
      /** add / remove 必填，相对授权目录。 */
      path: RelativePath.optional(),
      /** add 必填，只允许普通分支名，不接受以 - 开头的选项。 */
      branch: z.string().min(1).max(120).optional(),
      /** add：分支不存在时用 -b 新建。 */
      create: z.boolean().optional(),
      /** remove：工作树有未提交改动时必须显式 force。 */
      force: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('project.dependencies'),
    args: z.object({
      path: RelativePath.optional(),
      maxEntries: z.number().int().min(1).max(200).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('project.outline'),
    args: z.object({
      path: RelativePath.optional(),
      maxFiles: z.number().int().min(1).max(500).optional(),
      maxSymbols: z.number().int().min(1).max(1000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.status'),
    args: z.object({
      path: RelativePath.optional(),
      maxEntries: z.number().int().min(1).max(10_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.diff'),
    args: z.object({
      path: RelativePath.optional(),
      /** true 看暂存区（--cached）。 */
      staged: z.boolean().optional(),
      /** 看某次提交与当前工作区的差异；只接受普通引用名。 */
      commit: z.string().min(1).max(160).optional(),
      maxBytes: z.number().int().min(1024).max(262_144).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.log'),
    args: z.object({
      path: RelativePath.optional(),
      limit: z.number().int().min(1).max(200).optional(),
      maxEntries: z.number().int().min(1).max(200).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.show'),
    args: z.object({
      commit: z.string().min(1).max(160),
      /** true 只看每条文件的增删行数。 */
      stat: z.boolean().optional(),
      maxBytes: z.number().int().min(1024).max(262_144).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.stash'),
    args: z.object({
      action: z.enum(['list', 'push', 'pop', 'drop']),
      message: z.string().max(200).optional(),
      /** drop / pop 指定第几条；drop 必须给。 */
      index: z.number().int().min(0).max(1000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('git.branch'),
    args: z.object({
      action: z.enum(['list', 'create', 'switch']),
      name: z.string().min(1).max(120).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('json.query'),
    args: z.object({
      path: RelativePath,
      /** `a.b[0].c` 或 JSON Pointer `/a/0/b`；不给就是整个文档。 */
      pointer: z.string().max(400).optional(),
      maxChars: z.number().int().min(200).max(20_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('csv.summary'),
    args: z.object({
      path: RelativePath,
      /** 不给就按首行猜（, / 制表符 / ; / |）。 */
      delimiter: z.string().length(1).optional(),
      maxRows: z.number().int().min(1).max(100_000).optional(),
      samples: z.number().int().min(0).max(10).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('sqlite.query'),
    args: z.object({
      path: RelativePath,
      sql: z.string().min(1).max(4000),
      maxRows: z.number().int().min(1).max(2000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('archive.list'),
    args: z.object({
      path: RelativePath,
      maxEntries: z.number().int().min(1).max(5000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('archive.extract'),
    args: z.object({
      path: RelativePath,
      destination: RelativePath.optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('archive.create'),
    args: z.object({
      output: RelativePath,
      sources: z.array(RelativePath).min(1).max(100)
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('text.diff'),
    args: z.object({ pathA: RelativePath, pathB: RelativePath }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('text.base64'),
    args: z.object({
      action: z.enum(['encode', 'decode']),
      path: RelativePath,
      /** decode 时可选：落盘路径，已存在会被拒绝。 */
      output: RelativePath.optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('image.resize'),
    args: z.object({
      path: RelativePath,
      output: RelativePath,
      maxDimension: z.number().int().min(1).max(8192).optional(),
      width: z.number().int().min(1).max(8192).optional(),
      height: z.number().int().min(1).max(8192).optional(),
      format: z.enum(['jpeg', 'png']).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('env.read'),
    args: z.object({
      names: z.array(z.string().min(1).max(200)).max(200).optional(),
      maxEntries: z.number().int().min(1).max(200).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('port.list'),
    args: z.object({
      port: z.number().int().min(1).max(65_535).optional(),
      maxEntries: z.number().int().min(1).max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('app.list'),
    args: z.object({ maxEntries: z.number().int().min(1).max(1000).optional() }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('window.list'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('dns.lookup'),
    args: z.object({ host: z.string().min(3).max(253) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('time.now'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('process.tree'),
    args: z.object({
      pid: z.number().int().min(1).optional(),
      filter: z.string().max(200).optional(),
      maxEntries: z.number().int().min(1).max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('fs.du'),
    args: z.object({
      path: RelativePath.optional(),
      maxEntries: z.number().int().min(1).max(500).optional(),
      maxNodes: z.number().int().min(100).max(200_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.run'),
    args: z.object({
      language: z.enum(CODE_LANGUAGES),
      code: z.string().min(1).max(200_000),
      timeoutMs: z.number().int().min(1000).max(300_000).optional(),
      /** 相对工作区的运行目录；不给就在本次运行自己的临时目录里跑。 */
      cwd: RelativePath.optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('goal.create'),
    args: z.object({ text: z.string().min(1).max(500) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('goal.get'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('goal.update'),
    args: z.object({
      status: z.enum(['active', 'blocked', 'done']),
      note: z.string().max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('schedule.create'),
    args: z.object({
      text: z.string().min(1).max(2000),
      mode: z.enum(['local', 'cloud']),
      at: z.number().int().positive().optional(),
      repeatMinutes: z.number().int().min(5).max(10_080).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('schedule.edit'),
    args: z.object({
      id: z.string().min(1).max(80),
      text: z.string().min(1).max(2000).optional(),
      mode: z.enum(['local', 'cloud']).optional(),
      at: z.number().int().positive().optional(),
      repeatMinutes: z.number().int().min(5).max(10_080).optional(),
      enabled: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('schedule.list'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('schedule.view'),
    args: z.object({ id: z.string().min(1).max(80) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('team.spawn'),
    args: z.object({
      members: z.array(z.string().min(1).max(80)).min(1).max(8),
      /** 可选：这些成员的上级成员 id；只用于记录成员树，不创建新成员。 */
      parent: z.string().min(1).max(80).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('team.task.create'),
    args: z.object({
      title: z.string().min(1).max(200),
      detail: z.string().max(1000).optional(),
      assignee: z.string().min(1).max(80).optional(),
      /** 依赖的任务 id；创建时逐个校验存在。 */
      dependsOn: z.array(z.string().min(1).max(80)).max(20).optional(),
      /** read 可与别人共享工作区；write 同一工作区同时只能有一个 doing。 */
      mode: z.enum(['read', 'write']).optional(),
      /** 允许动的目录；write 任务用它做隔离。 */
      workspace: z.string().min(1).max(2000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('team.task.get'),
    args: z.object({ id: z.string().min(1).max(80) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('team.task.list'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('team.task.update'),
    args: z.object({
      id: z.string().min(1).max(80),
      status: z.enum(['todo', 'doing', 'done', 'blocked']),
      /** 必填：拿旧的 revision 覆盖会得到 CAS_CONFLICT。 */
      expectedRevision: z.number().int().min(1).max(1_000_000),
      note: z.string().max(500).optional(),
      /** done 时至少一条；其他状态可选。 */
      evidence: z.array(z.object({
        kind: z.enum(['execution_report', 'test', 'diagnostic', 'commit', 'note']),
        ref: z.string().max(200).optional(),
        detail: z.string().min(1).max(500)
      }).strict()).max(20).optional(),
      workspace: z.string().min(1).max(2000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('team.wait'),
    args: z.object({ timeoutMs: z.number().int().min(1000).max(120_000).optional() }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('session.search'),
    args: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(20).optional(),
      conversationId: z.string().min(1).max(80).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('plugin.inspect'),
    args: z.object({ id: z.string().min(1).max(80).optional() }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('term.open'),
    args: z.object({
      cwd: RelativePath.optional(),
      cols: z.number().int().min(20).max(400).optional(),
      rows: z.number().int().min(5).max(200).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('term.read'),
    args: z.object({
      sessionId: z.string().min(1).max(80),
      maxChars: z.number().int().min(1).max(40_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('term.send'),
    args: z.object({
      sessionId: z.string().min(1).max(80),
      input: z.string().max(8000),
      submit: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('term.signal'),
    args: z.object({
      sessionId: z.string().min(1).max(80),
      signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT']).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('term.close'),
    args: z.object({ sessionId: z.string().min(1).max(80) }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('term.list'),
    args: z.object({}).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.diagnostics'),
    args: z.object({
      path: RelativePath.optional(),
      /** 只检查这些文件（相对工作区）；不给就按 path/工程根扫。 */
      paths: z.array(RelativePath).min(1).max(50).optional(),
      maxItems: z.number().int().min(1).max(200).optional(),
      timeoutMs: z.number().int().min(1000).max(300_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.definition'),
    args: z.object({
      path: RelativePath,
      /** 1-based 行号。 */
      line: z.number().int().min(1).max(1_000_000),
      /** 1-based 列号（UTF-16 单元）。 */
      character: z.number().int().min(1).max(100_000)
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.references'),
    args: z.object({
      path: RelativePath,
      line: z.number().int().min(1).max(1_000_000),
      character: z.number().int().min(1).max(100_000),
      includeDeclaration: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.symbols'),
    args: z.object({
      path: RelativePath,
      max: z.number().int().min(1).max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.search'),
    args: z.object({
      query: z.string().min(1).max(4000),
      mode: z.enum(['CODE', 'MEMORY', 'HYBRID']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      /** 需要一段可直接放进上下文的文本时置 true。 */
      context: z.boolean().optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.team.run'),
    args: z.object({
      task: z.string().min(1).max(4000),
      files: z.array(RelativePath).max(20).optional(),
      members: z.array(z.string().min(1).max(120)).min(1).max(4).optional(),
      maxParallel: z.number().int().min(1).max(4).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.impact'),
    args: z.object({
      path: RelativePath,
      line: z.number().int().min(1).max(1_000_000),
      character: z.number().int().min(1).max(100_000)
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.ast'),
    args: z.object({
      path: RelativePath,
      max: z.number().int().min(1).max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.context'),
    args: z.object({
      path: RelativePath,
      line: z.number().int().min(1).max(1_000_000).optional(),
      character: z.number().int().min(1).max(100_000).optional(),
      max: z.number().int().min(1).max(500).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('code.hover'),
    args: z.object({
      path: RelativePath,
      line: z.number().int().min(1).max(1_000_000),
      character: z.number().int().min(1).max(100_000)
    }).strict(),
    description: z.string().max(500).optional()
  }).strict(),
  z.object({
    id: Id,
    tool: z.literal('ask.user'),
    args: z.object({
      question: z.string().min(1).max(500),
      /** 给选项就让用户点，不给就是自由文本。 */
      options: z.array(z.string().min(1).max(120)).min(1).max(6).optional(),
      allowFreeText: z.boolean().optional(),
      timeoutMs: z.number().int().min(1000).max(600_000).optional()
    }).strict(),
    description: z.string().max(500).optional()
  }).strict()
]);

export const PlanSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('plan'),
    taskId: Id,
    roundId: Id,
    planId: Id.optional(),
    title: z.string().min(1).max(120),
    description: z.string().max(2000),
    steps: z.array(StepSchema).min(1).max(30),
    completion: z.object({ condition: z.string().min(1).max(1000) }).strict()
  })
  .strict()
  .refine(plan => new Set(plan.steps.map(step => step.id)).size === plan.steps.length, {
    message: 'step id 必须唯一'
  })
  .refine(
    plan => plan.steps.every(step =>
      step.tool !== 'fs.writeFile' || !step.args.overwrite || !!step.args.expectedHash
    ),
    { message: '覆盖已有文件的步骤必须带 expectedHash' }
  )
  .refine(
    plan => plan.steps.every(step => {
      if (step.tool === 'fs.edit' || step.tool === 'fs.applyPatch') return !!step.args.expectedHash;
      return true;
    }),
    { message: '修改已有文件必须先读、并带 expectedHash（fs.edit / fs.applyPatch）' }
  )
  .refine(
    plan => plan.steps.every(step => {
      if (step.tool === 'app.open') return Boolean(step.args.app) !== Boolean(step.args.path);
      if (step.tool === 'screen.capture') return step.args.target !== 'region' || Boolean(step.args.region);
      return true;
    }),
    { message: 'app.open 必须且只能给 app 或 path 之一；截图 target=region 时必须给 region' }
  );

export type AgentPlan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof StepSchema>;

export const ClarificationSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('clarification_required'),
    taskId: Id,
    roundId: Id,
    questions: z.array(z.string().min(1).max(500)).min(1).max(5)
  })
  .strict();

export const TaskCompleteSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('task_complete'),
    taskId: Id,
    roundId: Id,
    summary: z.string().max(2000)
  })
  .strict();

/** Every structured message DeepSeek is allowed to send back. */
export const WireMessageSchema = z.union([PlanSchema, ClarificationSchema, TaskCompleteSchema]);

export type WireMessage = z.infer<typeof WireMessageSchema>;

// ---------------------------------------------------------------------------
// Task / Round / Plan records (local truth, persisted)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'created'
  | 'planning'
  /**
   * DeepSeek asked a question and nothing can proceed until it is answered.
   *
   * Distinct from `planning` on purpose. While it was folded into `planning`,
   * the task sat in a state that reads as "the app is working" while the app
   * was in fact waiting for the user — the pill said 正在规划, the composer was
   * disabled, and the only way forward was a card further up the page. That
   * looks exactly like a hang.
   */
  | 'awaiting_clarification'
  | 'plan_ready'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'report_pending'
  | 'awaiting_next_round'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RoundStatus =
  | 'sending'
  | 'awaiting_answer'
  | 'answer_ready'
  | 'plan_ready'
  | 'plan_invalid'
  | 'executing'
  | 'report_sent'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentTask {
  taskId: string;
  /** 编码工作流的业务状态；老任务没有这个字段，按 task.status 推导。 */
  codingState?: import('./coding-workflow').CodingState;
  title: string;
  userPrompt: string;
  status: TaskStatus;
  permissionPreset: PermissionPreset;
  workspaceRoot?: string;
  conversationId?: string;
  currentRoundId?: string;
  currentPlanId?: string;
  /**
   * V2.1：这份计划要不要先做方案评审辩论。
   *
   * 和会话里的 `debateMode` 是同一个开关，但在这里必须落一份：任务可能来自
   * 没有会话的执行入口，而且审批发生在计划生成之后，那时已经不该再去读会话。
   * 老任务没有这个字段，读到时按 `auto` 处理（小计划不辩）。
   */
  planDebate?: 'auto' | 'on' | 'off';
  createdAt: number;
  updatedAt: number;
  maxRounds: number;
  maxSteps: number;
  timeoutMs: number;
  error?: string;
  summary?: string;
}

export interface AgentRound {
  roundId: string;
  taskId: string;
  roundNumber: number;
  requestId: string;
  /**
   * `plan_repair`：模型上一轮的计划没通过校验，这一轮带着失败原因让它改。
   * 单独一类而不是复用 `user_prompt`，因为「问了几次才对」必须能数出来。
   */
  inputType: 'user_prompt' | 'execution_report' | 'clarification_answer' | 'plan_repair';
  requestText: string;
  answerText?: string;
  status: RoundStatus;
  /** Questions DeepSeek asked in this round, kept so the answer can be matched to them. */
  pendingQuestions?: string[];
  createdAt: number;
  completedAt?: number;
}

export interface StoredPlan {
  planId: string;
  taskId: string;
  roundId: string;
  plan: AgentPlan;
  contentHash: string;
  approvalStatus: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
}

/**
 * 方案评审辩论（V2.1 D-03 / 任务书 Phase F「任务拆分与方案评审（辩论可选）」）。
 *
 * 只影响「这份计划要不要辩、辩了什么」，不改变计划的执行语义：辩完仍要人
 * 点确认。`skippedReason` 是刻意保留的——没辩和辩了没结论是两件不同的事，
 * 界面不能都显示成空白。
 */
export interface PlanDebate {
  /** 真的开了辩论才有；没开时空缺。 */
  debateId?: string;
  status: 'completed' | 'stopped' | 'skipped';
  /** 辩题：从计划的步骤、风险、验收条件里取的争议点。 */
  topics: string[];
  /** 参与者（模型 id）。 */
  participants: string[];
  /** 辩论结论摘要，供审批前阅读。 */
  summary: string;
  /** 为什么没辩：模式是 off / 计划太小 / 没有可用成员。 */
  skippedReason?: string;
  at: number;
}

export interface PlanPreview {
  planId: string;
  taskId: string;
  roundId: string;
  title: string;
  description: string;
  completion: string;
  steps: Array<{ id: string; tool: ToolName; description?: string; args: Record<string, unknown> }>;
  /** V2.1：方案评审辩论结果。没开启辩论时为空。 */
  debate?: PlanDebate;
  /** 计划门禁：缺哪些判据。空/缺失表示没发现问题。 */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Grant / execution
// ---------------------------------------------------------------------------

export const STEP_APPROVAL_MODES = ['every', 'mutating', 'off'] as const;

/**
 * 审批粒度。
 *
 * - `every`：每一步都先问一次（最严，harness 的 pre-execute 语义）；
 * - `mutating`：只问有副作用的步骤（缺省值）——只读步骤也弹窗会把用户训练成
 *   无脑点批准，反而更不安全；
 * - `off`：批准整份计划后一路跑完，与升级前一致。
 */
export type StepApprovalMode = (typeof STEP_APPROVAL_MODES)[number];

export const TaskGrantSchema = z
  .object({
    taskId: Id,
    permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    approvalPolicy: z.literal('ask'),
    rootDir: z.string().min(1).max(2000),
    allowedTools: z.array(z.enum(TOOL_NAMES)).min(1).max(TOOL_NAMES.length),
    expiresAt: z.number().int().positive(),
    maxSteps: z.number().int().min(1).max(30),
    grantVersion: z.number().int().min(1).optional(),
    /** 缺省 `mutating`：老计划、老脚本不带这个字段时按「只问写操作」处理。 */
    stepApproval: z.enum(STEP_APPROVAL_MODES).optional()
  })
  .strict();

export type TaskGrant = z.infer<typeof TaskGrantSchema>;

export interface StepResult {
  stepId: string;
  tool: ToolName;
  status: 'completed' | 'failed' | 'skipped';
  verified: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  /** 这一步实际用的参数；新报告才带，用来核对改了哪些文件。 */
  args?: Record<string, unknown>;
}

export interface ExecutionReport {
  protocol: typeof PROTOCOL;
  type: 'execution_report';
  taskId: string;
  roundId: string;
  planId: string;
  status: 'completed' | 'partial' | 'failed' | 'cancelled';
  results: StepResult[];
  errors: Array<{ stepId?: string; code: string; message: string }>;
  nextAction: 'continue' | 'complete' | 'retry' | 'stop';
  createdAt: number;
  /** 执行证据账本；老报告没有这个字段，读取方要按缺失处理。 */
  evidence?: EvidenceLedger;
  /**
   * 本轮验没验过：改了文件却没有成功的测试/诊断时 verified=false。
   * 老报告没有这个字段，读取方按「未记录」处理，不默认算过。
   */
  verification?: {
    verified: boolean;
    reasons: string[];
    changedFiles: number;
    changedPaths?: string[];
    /**
     * V1.2：compile / tests / diagnostics 各自的状态与退出码。
     * 老报告没有这个字段，界面按「未记录」处理，不补默认值。
     */
    checks?: {
      compile: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string };
      tests: { status: 'passed' | 'failed' | 'skipped'; exitCode?: number; command?: string; detail?: string };
      diagnostics: { status: 'passed' | 'failed' | 'skipped'; errors: number; warnings: number; source?: string; path?: string; detail?: string };
      changedFiles: string[];
    };
  };
}

// ---------------------------------------------------------------------------
// Events (main -> renderer)
// ---------------------------------------------------------------------------

export interface AgentEventBase {
  at: number;
}

export type AgentEvent = AgentEventBase &
  (
    | { type: 'task.updated'; task: AgentTask }
    | { type: 'round.started'; taskId: string; roundId: string; roundNumber: number; inputType: AgentRound['inputType'] }
    | { type: 'round.answer'; taskId: string; roundId: string; text: string }
    | { type: 'plan.ready'; taskId: string; roundId: string; plan: PlanPreview }
    | { type: 'plan.invalid'; taskId: string; roundId: string; error: string }
    | { type: 'clarification.required'; taskId: string; roundId: string; questions: string[] }
    | {
        type: 'step.started';
        taskId: string;
        stepId: string;
        tool: string;
        /** 这一步的真实参数；界面不用等结果就能显示「改哪个文件/跑什么命令」。 */
        args?: Record<string, unknown>;
      }
    /**
     * 逐次审批：某一步马上就要执行，等用户点头。
     *
     * 与 `plan.ready` 的区别是「批准整份计划」与「批准这一次调用」——
     * 前者不知道上下文会变成什么样，后者知道前几步真跑出了什么结果。
     */
    | {
        type: 'step.approval';
        taskId: string;
        stepId: string;
        tool: string;
        /** 第几步 / 共几步，界面用它显示进度。 */
        index: number;
        total: number;
        /** 参数预览（截断后），用户要看着参数点头，而不是看一句描述。 */
        argsPreview: string;
        risk: 'read' | 'write' | 'danger';
        /** 到期时间：到点没答复按拒绝处理。 */
        expiresAt: number;
      }
    /**
     * 执行中提问：模型跑到一半发现必须由用户决定（用哪个目录、要不要覆盖、
     * 两个方案选哪个）。与 `clarification.required` 的区别是它发生在执行中。
     */
    | {
        type: 'step.question';
        taskId: string;
        stepId: string;
        tool: string;
        question: string;
        options?: string[];
        allowFreeText?: boolean;
        expiresAt: number;
      }
    | { type: 'step.question-resolved'; taskId: string; stepId: string; answered: boolean; reason?: string }
    /** 结果回执，让界面上那条待确认的卡片能收起来。 */
    | {
        type: 'step.approval-resolved';
        taskId: string;
        stepId: string;
        approved: boolean;
        reason?: string;
      }
    | {
        type: 'step.completed';
        taskId: string;
        stepId: string;
        tool: string;
        result: unknown;
        /** 本步耗时；老事件没有这个字段。 */
        durationMs?: number;
      }
    | {
        type: 'step.failed';
        taskId: string;
        stepId: string;
        tool: string;
        error: string;
        args?: Record<string, unknown>;
        /** 本步耗时；审批被拒时没有执行，通常为 0。 */
        durationMs?: number;
      }
    | { type: 'report.ready'; taskId: string; roundId: string; report: ExecutionReport }
    /** V2.1：执行之后由独立评审给出的结论。修复仍需用户重新批准计划。 */
    | {
        type: 'review.ready';
        taskId: string;
        roundId: string;
        reviewer: string;
        backend: 'model' | 'rules';
        verdict: string;
        issues: string[];
        needsFix: boolean;
      }
    /** V2.1 D-03：计划生成后、审批前的方案评审辩论。 */
    | { type: 'plan.debated'; taskId: string; roundId: string; planId: string; debate: PlanDebate }
    | { type: 'report.sent'; taskId: string; roundId: string }
    | { type: 'task.completed'; taskId: string; summary?: string }
    | { type: 'task.failed'; taskId: string; error: string }
    | { type: 'task.cancelled'; taskId: string }
    /** Emitted on delete, so a list built from events drops the row too. */
    | { type: 'task.deleted'; taskId: string }
    | { type: 'log'; taskId?: string; level: 'info' | 'warn' | 'error'; message: string }
  );

export type DeepSeekEvent =
  | { type: 'status'; status: DeepSeekStatus }
  | { type: 'send.failed'; requestId: string; reason: string };

export interface DeepSeekStatus {
  url: string;
  pageReady: boolean;
  loggedIn: boolean;
  hasInput: boolean;
  hasSendButton: boolean;
  generating: boolean;
  messageCount: number;
  /** 站点说这条会话的上下文已满（见 `ChannelStatus.contextFull`）。 */
  contextFull?: boolean;
  detail?: string;
  diagnostics?: PageDiagnostics;
}

/**
 * What the probe actually saw, in enough detail to debug a selector failure
 * without a debugger.
 *
 * The selectors are guesses about someone else's markup. When they stop
 * matching, the only useful output is "which candidate matched, how many times,
 * and how much text was found" — a bare "页面异常" cannot be acted on.
 */
export interface PageDiagnostics {
  probeVersion: string;
  /** Hit count per selector, so a dead selector is visibly zero. */
  selectorHits: Record<string, number>;
  /** Which selector (or structural fallback) won for each role. */
  chosen: Record<string, string>;
  composerChars: number;
  conversationChars: number;
}

export interface DeepSeekDiagnostics {
  probeVersion: string;
  /**
   * Which channel was read.
   *
   * The panel can diagnose any channel, not just the one in the pane, so the
   * reply has to say which page these numbers came from — otherwise the header
   * can name Gemini while the numbers are ChatGPT's.
   */
  sourceId?: string;
  url: string;
  title: string;
  status: DeepSeekStatus;
  selectors: Record<string, string[]>;
  /**
   * Where the native page view actually is.
   *
   * The page is a `WebContentsView` laid over the window, not an element, so
   * nothing in the app's DOM can report this — which is exactly how it ended up
   * painted on top of the app's own column without anything noticing. These are
   * the numbers the main process passed to `setBounds`, i.e. the truth.
   */
  view: { x: number; y: number; width: number; height: number } | null;
  /** True while a divider drag has the view parked outside the window. */
  dragging: boolean;
  probe: {
    hasInput: boolean;
    inputKind: string;
    hasSendButton: boolean;
    generating: boolean;
    messageCount: number;
    /**
     * Characters sitting in the composer.
     *
     * Load bearing for the verdict, not decoration: Gemini only renders its
     * send button once there is something to send, so "no send button" on an
     * empty composer is the normal state of a perfectly working page.
     */
    composerChars: number;
    lastTextPreview: string;
    selectorHits: Record<string, number>;
    chosen: Record<string, string>;
  };
}

/** Width of the pane reserved for the embedded page, in CSS pixels. */
export interface LayoutInfo {
  split: number;
  /**
   * True while the page pane is folded away.
   *
   * `split` alone cannot say it: while folded the right edge still has to
   * reserve the rail, so the number is small but not zero, and a
   * renderer that only compared it to zero would draw a page bar over a pane
   * that is not there.
   */
  collapsed: boolean;
}

/**
 * Which embedded pages exist and which one is on screen.
 *
 * The rail on the right edge renders straight from this, so the list of sources
 * is defined once (shared/sources.ts) instead of being duplicated in the UI.
 *
 * `sources` carries disabled ones too. The rail filters them out, and the
 * settings panel needs the whole list — sending two different lists would mean
 * two chances for them to disagree about which sources exist.
 */
export interface SourcesState {
  sources: PageSource[];
  activeId: string;
  /**
   * The source the agent plans through, as it is right now.
   *
   * Not `source.planning`: that flag says which source *ships* as the planner,
   * and the user can switch it off. When they do, planning falls to the next
   * enabled source, and a panel that kept drawing the tag on the shipped one
   * would be pointing at a page the app no longer uses.
   */
  planningId: string | null;
  /** True while the active source's view is still being created or loaded. */
  loading: boolean;
  /**
   * When false, enabled sources stay closed at app start and open on demand.
   * Default true so an untouched install still primes every enabled page.
   */
  openOnLaunch: boolean;
  /**
   * Whether any web-source WebContentsView is alive right now.
   *
   * 「启动时打开」关掉后冷启动为 false；点来源栏或提问建起视图后为 true。
   * 顶栏的「页面就绪 / 未登录 / 诊断」只在有页面时有意义。
   */
  webViewsOpen: boolean;
}

/** An edit to one source, from 设置 · 模型. */
export interface SourcePatch {
  /** The address to load. Normalized and allow-list-checked in the main process. */
  url?: string;
  /** Whether the source is part of the app right now. */
  enabled?: boolean;
}

/** A source the user adds in 设置. */
export interface NewSourceInput {
  label: string;
  url: string;
}

/**
 * The name on the row at the bottom of the sidebar.
 *
 * There is no account system and this does not pretend to be one: it is a name
 * the person chose, defaulting to 本机用户, so the bottom of the sidebar has
 * something to say other than "本地工作区". Everything stays on this machine,
 * which is the honest description of what the app actually is.
 *
 * Note what is *not* here: nothing read from the operating system about its
 * owner. See `shared/identity.ts` for why that matters.
 */
export interface Identity {
  name: string;
  /** One character for the avatar square. */
  initial: string;
  /** Platform description — "这台 Mac", not the machine's name. */
  device: string;
}

/**
 * Whether a page has been pulled out into its own window.
 *
 * The main window cannot see a native view, so "the pane looks empty" and "the
 * page is in another window" are the same pixels. This is the fact that tells
 * the two apart, and it is what flips the button between 放大 and 吸附回来.
 */
export interface PageState {
  detachedId: string | null;
  /**
   * True while the pane is folded shut.
   *
   * Separate from `detachedId` on purpose: a folded page is still *here* — the
   * same view, the same viewport, still askable — it is simply not painted. A
   * detached page is somewhere else. Folding one does not detach it, and
   * unfolding must not reload anything.
   */
  collapsed: boolean;
}

/** Where one native page view currently sits, in window coordinates. */
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Every created view's position, keyed by source id.
 *
 * These views are painted above the DOM, so the app cannot observe them by
 * querying elements — the same blindness that once let a page view sit on top
 * of the app column unnoticed. Anything that needs to prove "the buttons are
 * not covered" or "the parked page really is offscreen" has to ask here.
 */
export type ViewBoundsMap = Record<string, ViewRect>;

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  prompt: string;
  permissionPreset: PermissionPreset;
  workspaceRoot: string;
}

export interface SubmitPromptInput {
  prompt: string;
  permissionPreset: PermissionPreset;
  workspaceRoot?: string;
}

export interface ApprovePlanInput {
  taskId: string;
  roundId: string;
  planId: string;
  approved: true;
}

/** 新建对话设置页能看到的选项。刻意不含 API Key 明文或密文。 */
export interface DebateCandidateView {
  id: string;
  label: string;
  type: 'web' | 'local' | 'cloud';
  available: boolean;
  detail?: string;
}

export interface CloudProviderView {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /**
   * 这家网关报过的**全部**模型（未勾选的也在里面）。
   *
   * 「选择模型」拿它当候选：`models` 是这一问实际会用的子集，`catalog` 是
   * 可选的完整清单。旧版没有这个字段，按 `models` 处理。
   */
  catalog?: string[];
  /** 这个服务有哪些模型不能用、为什么。界面照实显示。 */
  note?: string;
  hasKey: boolean;
  /**
   * 模型清单是不是从网关 `/models` 读回来的。
   *
   * `false` 表示现在列出来的还是预设的几条兜底，不是这家真实有哪些模型——
   * 界面据此决定打开时要不要顺手再问一次，也避免把预设当成事实展示。
   */
  modelsDiscovered?: boolean;
  /** 用户加的服务（目录项或自定义端点）：可以整个删掉；内置三条只能清 Key。 */
  custom?: boolean;
}

/**
 * 勾选清单里的一个云端成员。
 *
 * `id` 是 `provider:model`，不是裸模型名：DeepSeek 和 OpenCode Zen 都有
 * `deepseek-v4-flash`，用模型名当 id 会出现两个一模一样的复选框，而且勾一
 * 个等于把两家一起勾上——用户没法只问其中一家。
 */
export interface CloudMemberView {
  id: string;
  /** 带服务名前缀，界面上才分得清是哪一家。 */
  label: string;
  /** 服务级的 Key 配了没有。没配的成员运行时会被 health() 挡掉。 */
  hasKey: boolean;
}

/**
 * 「添加云模型」里可挑的服务。
 *
 * 与 `CloudProviderView` 的区别：那是「已经装上的」，这是「还能装的」。
 * 目录只收 OpenAI 兼容端点，因为本应用的云端 Provider 只会说
 * Chat Completions。
 */
export interface ProviderCatalogView {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  note?: string;
  /** 自定义项：端点为空白，必须自己填。 */
  custom?: boolean;
}

export interface ExecutionOptions {
  modes: readonly ExecutionMode[];
  webChannels: Array<{ id: string; label: string }>;
  localModels: string[];
  cloudMembers: CloudMemberView[];
  providers: Array<{ id: string; label: string; type: 'web' | 'local' | 'cloud'; hasKey: boolean }>;
  /** 各云端服务的端点与模型（预设 + 用户覆盖）。 */
  cloudProviders: CloudProviderView[];
  /** 「添加云模型」的候选目录；旧版没有这个字段时按空处理。 */
  providerCatalog?: ProviderCatalogView[];
  /** 辩论用的真实可用成员；health() 判出来的，不是注册表里的名字。 */
  debateCandidates: DebateCandidateView[];
}

/** Phase F 的子任务执行记录。放在 shared 是为了让 renderer 不依赖 main。 */
/** 辩论的界面契约。结构与 main/debate/types.ts 一致，避免 renderer 依赖 main。 */
/** 裁决的界面契约。字段与 main/judge/types.ts 对齐。 */
export interface JudgeVerdictView {
  verdictId: string;
  debateId: string;
  createdAt: number;
  judgeAgentId: string | null;
  sharedWith?: string;
  backend: 'model' | 'rules';
  conclusion: string | null;
  undetermined: boolean;
  reason: string;
  disagreement: string;
  evidence: Array<{ messageId: string; agentId: string; score: number; why: string; signals: string[] }>;
  argumentQuality: Array<{ agentId: string; score: number; why: string; responded: boolean }>;
  minorities: Array<{ messageId: string; agentId: string; text: string; why: string }>;
  unresolved: Array<{ question: string; why: string; sourceMessageIds: string[] }>;
  confidence: { level: 'low' | 'medium' | 'high'; why: string };
  sourceMessageIds: string[];
  supportCount: Record<string, number>;
  fallbackReason?: string;
}

export type DebateLeadMode = 'local' | 'web' | 'cloud' | 'hybrid';

/**
 * 协作策略（任务书 4.2）。六个可选值 + 两个只用于读旧记录的名字。
 * 行为在 `main/debate/strategies.ts`，渲染层只需要这个联合类型。
 */
export type DebateStrategyId =
  | 'truth'
  | 'adversarial'
  | 'expert'
  | 'assumption'
  | 'solution'
  | 'discovery'
  | 'standard'
  | 'deep';

export interface DebateConfigInput {
  strategy?: DebateStrategyId;
  maxRounds?: number;
  participants?: string[];
  convergenceStop?: boolean;
  /** 连续两轮没进展就停，默认关闭。 */
  earlyStopOnStall?: boolean;
  /**
   * 预算覆盖（任务书 §10）。主进程的 `normalizeDebateConfig` 一直支持，但渲染层
   * 契约漏了这个字段，UI 之外的调用方传了也会被类型挡掉；三项都可选，不传用
   * 默认值（单次 60s / 并发 3 / 不设整场总时限）。Token 与费用没有数据来源，
   * 契约里也不留这两个字段。
   */
  budget?: {
    stageTimeoutMs?: number;
    totalMs?: number;
    maxConcurrency?: number;
  };
  /** 谁主导这一场：本地 / 网页 / 云端 / 混合（混合会先综合决定采用哪一种）。 */
  leadMode?: DebateLeadMode;
  /** 用户指定的主辩；不传由 planLead 按模式挑。 */
  leadAgentId?: string;
}

export interface DebateLeadView {
  mode: DebateLeadMode;
  agentId: string | null;
  label: string;
  reason: string;
  /** 流程由代码编排，不是模型主持。 */
  drivenBy: 'orchestrator';
}

export interface DebatePlanView {
  reason: string;
  warnings: string[];
  excluded: Array<{ id: string; reason: string }>;
  openingSpeakers: string[];
  debaters: string[];
  webOnly: string[];
  participants: string[];
}

export interface DebateCleanupOutcome {
  cleaned: string[];
  reset: string[];
  failed: Array<{ agentId: string; detail: string }>;
  /** 网页成员回答了但页面没给地址，无法按地址删除，如实列出。 */
  noAddress: string[];
}

export interface DebateMessageView {
  messageId: string;
  roundIndex: number;
  agentId: string;
  role: 'proposer' | 'critic' | 'peer' | 'domain_expert' | 'evidence_reviewer';
  kind: 'position' | 'question' | 'rebuttal' | 'revision';
  text: string;
  targetMessageId?: string;
  /** 只有网页成员有；清理网页侧会话靠它。 */
  threadUrl?: string;
  createdAt: number;
  /** 这一条发言从开始问模型到拿到回答的时间；老辩论记录没有。 */
  startedAt?: number;
  endedAt?: number;
}

/** 一条主张。报告里的「关键主张」读这个。 */
export interface DebateClaimView {
  claimId: string;
  messageId: string;
  agentId: string;
  text: string;
  kind: string;
  kindCue?: string;
  assumptions: string[];
  status: string;
}

export interface DebateRoundView {
  index: number;
  /** 还在等发言的成员；进行中的轮次用它显示「等待 X 发言」。 */
  pending?: string[];
  messages: DebateMessageView[];
  startedAt: number;
  endedAt?: number;
  converged: boolean;
  failures: Array<{ agentId: string; detail: string }>;
  /** 这一轮切出来的主张。老辩论文件没有这个字段。 */
  claims?: DebateClaimView[];
}

/** 证据（Phase 3）。界面用它画证据链：来源、地址、可核验程度。 */
export interface DebateEvidenceView {
  evidenceId: string;
  claimIds: string[];
  kind: string;
  excerpt: string;
  url?: string;
  finalUrl?: string;
  pageTitle?: string;
  sourceId: string;
  roundIndex: number;
  fetchedAt?: number;
  fingerprint: string;
  originKey: string | null;
  verified: 'page-link' | 'reported' | 'unverified';
  independent: boolean;
  duplicateOf?: string;
  assessment: string;
}

export interface DebateDisputeView {
  disputeId: string;
  roundIndex: number;
  claimIds: [string, string];
  agents: [string, string];
  type: string;
  reason: string;
  status: string;
}

export interface DebateRevisionView {
  revisionId: string;
  agentId: string;
  roundIndex: number;
  decision: string | null;
  source: string;
  reason: string;
  before: string;
  after: string;
}

export interface DebateJudgmentView {
  claimId: string;
  claimText: string;
  agentId: string;
  verdict: string;
  rationale: string;
  dimensions: Array<{ dimension: string; outcome: string; rationale: string }>;
  evidenceIds: string[];
}

/** 质量指标（Phase 5）。比率没有分母时是 null，不是 0。 */
export interface DebateMetricsView {
  rounds: number;
  traceability: { judged: number; traceable: number; rate: number | null };
  invalidRounds: { total: number; invalid: number; rate: number | null };
  minority: { count: number; preserved: number; rate: number | null };
  latency: { totalMs: number; averageRoundMs: number | null };
  calls: { messages: number; failures: number };
}

/**
 * 一场辩论的三维结论，界面读这一份（Phase 3）。
 *
 * 三个维度各自带着 outcome 与理由，**没有总分**：逻辑对而证据不足，和
 * 证据强而推理跳步，是两种不同的判断，压成一个数字就再也分不开。
 * `backend: 'rules'` 说明这是本地规则算的，不是模型裁决。
 */
export interface DebateVerdictView {
  verdict:
    | 'supported'
    | 'partially_supported'
    | 'unsupported'
    | 'contradicted'
    | 'insufficient_evidence';
  conclusion: string | null;
  rationale: string;
  /** 被支持的结论来自少数派发言：它赢在证据，不在人数。 */
  minorityWins: boolean;
  minorityReason?: string;
  unresolved: string[];
  dimensions: Array<{
    dimension: 'logic' | 'evidence' | 'counterexample';
    outcome: string;
    rationale: string;
  }>;
  backend: 'rules';
}

export interface DebateView {
  debateId: string;
  conversationId?: string;
  question: string;
  config: {
    strategy: DebateStrategyId;
    maxRounds: number;
    participants: string[];
    convergenceStop: boolean;
    earlyStopOnStall?: boolean;
    leadMode: DebateLeadMode;
    leadAgentId?: string;
  };
  lead: DebateLeadView;
  plan: DebatePlanView;
  status: 'running' | 'completed' | 'stopped' | 'cancelled';
  rounds: DebateRoundView[];
  /** 正在跑、还没收口的那一轮；界面用它显示「等待谁发言」。 */
  runningRound?: DebateRoundView;
  minorities: DebateMessageView[];
  createdAt: number;
  updatedAt: number;
  stopReason?: string;
  /**
   * 跑完才有的五档结论。`debate:get` 返回的就是落盘的辩论状态，所以这个
   * 字段直接来自那份文件，不需要第二个接口。
   */
  verdict?: DebateVerdictView;
  /** 每条主张的三维判断（Phase 4 报告用）。 */
  judgments?: DebateJudgmentView[];
  /** 证据链（Phase 4 报告用）。 */
  evidence?: DebateEvidenceView[];
  /** 逐轮争议。 */
  disputes?: DebateDisputeView[];
  /** 修订记录：观点怎么因为证据变了。 */
  revisions?: DebateRevisionView[];
  /** 质量指标（Phase 5）。 */
  metrics?: DebateMetricsView;
}

/** 与当前问题相似的历史辩论。只作提示，不会自动跳过或复用结论。 */
export interface RelatedDebateView {
  debateId: string;
  question: string;
  similarity: number;
  verdict: DebateVerdictView['verdict'] | null;
  conclusion: string | null;
  strategy: DebateStrategyId;
  status: 'running' | 'completed' | 'stopped' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: Array<{ currency: string; amount: number }>;
  unknownUsageCalls: number;
}

export interface CollaborationTaskRecord {
  taskId: string;
  agentId: string;
  label: string;
  stage: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  attempts: number;
  contextCount: number;
  startedAt?: number;
  endedAt?: number;
  latencyMs?: number;
  text?: string;
  error?: string;
}

export interface ProviderHealthInfo {
  available: boolean;
  detail?: string;
  checkedAt: number;
}

/** 轨迹查询：默认取最近 500 条，`beforeSeq` 向上翻。 */
export interface TraceQuery {
  conversationId: string;
  beforeSeq?: number;
  limit?: number;
}

export interface TraceResult {
  entries: TraceEntry[];
  hasMore: boolean;
  /**
   * `trace` 是新的追加日志；`messages` 是旧会话的回退——
   * 只有消息时间，没有 token / 首 token / 失败原因。
   */
  source: 'trace' | 'messages';
  /** 整份文件的全量合计，不受 entries 分页影响。 */
  totals: TraceTotals;
}

export interface AgentApi {
  // conversations — the primary path
  /**
   * Ask something. The router decides whether this becomes a conversation or a
   * workspace task; the caller does not have to know which.
   */
  submitConversation(input: SubmitConversationInput): Promise<Conversation>;
  /**
   * Ask the router what it would do, without doing it.
   *
   * `submitConversation` is not a dry run: a `workspace` verdict immediately
   * sends the planning prompt to a real web page, which then keeps that thread
   * in its history forever. Anything that only wants to inspect routing — the
   * routing preview in the UI, a check script — has to be able to ask without
   * leaving a conversation behind on somebody's account.
   */
  classifyIntent(text: string): Promise<{ intent: IntentKind; reason: string }>;
  /** V2.1：纯函数式路由预览，无任何副作用。 */
  routeConversation(input: {
    text: string;
    workspaceMode: WorkspaceMode;
    hasProject: boolean;
    override?: EngineeringTaskKind;
    /** 随这一问带了几份文件：带文件时「没说做什么」按只读分析，不再要求确认。 */
    attachmentCount?: number;
  }): Promise<TaskRouting>;
  /** V2.1：新会话默认用哪个空间、绑哪个项目。 */
  getWorkspace(): Promise<WorkspaceState>;
  setWorkspace(patch: Partial<WorkspaceState>): Promise<WorkspaceState>;
  /** 多项目工作区清单：侧栏按它分组，会话记住自己属于哪一组。 */
  getWorkspaces(): Promise<WorkspaceEntry[]>;
  addWorkspace(input: { root: string; name?: string }): Promise<{
    workspace: WorkspaceEntry;
    created: boolean;
    workspaces: WorkspaceEntry[];
  }>;
  renameWorkspace(input: { workspaceId: string; name: string }): Promise<{
    workspace: WorkspaceEntry;
    workspaces: WorkspaceEntry[];
  }>;
  /** 移除分组，不删会话：它们会出现在「未分组」里，历史一条不少。 */
  removeWorkspace(workspaceId: string): Promise<{
    workspaces: WorkspaceEntry[];
    removed: WorkspaceEntry;
    clearedConversations: number;
  }>;
  /** 联网搜索的凭据。key 只回传「是否已填」，不回传原文。 */
  getSearchSettings(): Promise<SearchSettingsView>;
  saveSearchSettings(patch: SearchSettingsPatch): Promise<SearchSettingsView>;
  /** 用当前凭据真发一次请求，验证能不能搜到。 */
  testSearchSettings(patch: SearchSettingsPatch): Promise<SearchTestResult>;
  followupConversation(input: FollowupConversationInput): Promise<Conversation>;
  /**
   * 把当前的研究设置存到这个会话上。
   *
   * 追问本身会带上设置，但那份设置只活在提问那一刻：不存下来，换个会话再
   * 回来（或重开应用）面板就退回默认值，下一条追问照着默认跑。
   */
  updateConversationConfig(input: {
    conversationId: string;
    executionConfig: Partial<ConversationExecutionConfig>;
  }): Promise<Conversation>;
  getConversations(): Promise<Conversation[]>;
  getConversation(conversationId: string): Promise<Conversation | null>;
  getConversationMessages(conversationId: string): Promise<ConversationMessage[]>;
  /**
   * 轨迹与统计的原始记录。旧会话没有 trace 文件时回退到消息级时间线，
   * `source` 会明确写 `messages`，界面不能把它当成完整统计。
   */
  getTrace(input: TraceQuery): Promise<TraceResult>;
  cancelConversation(conversationId: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<ConversationDeleteOutcome>;
  /**
   * 把这条会话导出成本机文件（Markdown / Word）。
   *
   * 内容由主进程从自己的存盘里读，排版由模板定，全程不经过模型——导出的
   * 是会话里已经写好的那段话，不是重新总结一遍。返回 `null` 表示用户在
   * 保存对话框里点了取消（不是失败，界面上不该报错）。
   */
  exportConversation(input: ExportConversationInput): Promise<ExportConversationResult | null>;
  /**
   * 内置插件的全量清单：本地能力与保存能力，含权限与当前开关。
   * 清单由主进程给，界面不另抄一份名字。
   */
  getCapabilities(): Promise<CapabilityView[]>;
  /** 启用 / 停用一个插件，返回更新后的清单。停用的插件执行时会明确报错。 */
  setCapabilityEnabled(id: string, enabled: boolean): Promise<CapabilityView[]>;
  /**
   * 专家与技能的清单：主进程从磁盘读到的两份 .md，含来源、状态与可替换路径。
   * 它们是内容，不是能力插件——只影响工程空间第一意见的 system 轮次。
   */
  getExpertise(): Promise<ExpertiseView[]>;
  /** 启用 / 停用一位专家或一个技能，返回更新后的清单。 */
  setExpertiseEnabled(id: string, enabled: boolean): Promise<ExpertiseView[]>;
  /**
   * 输入框「＋ · 添加文件」：弹系统文件选择框，返回挑中的文件引用。
   *
   * 只回路径与体积，正文不发到渲染层——发送时主进程按当时的磁盘内容读。
   * 用户取消返回空数组（不是失败，界面上不该报错）。
   */
  chooseAttachments(): Promise<ConversationAttachment[]>;
  /** Per-channel availability, so the UI can say *which* page needs a login. */
  getChannelStatuses(): Promise<ChannelStatus[]>;

  // 执行模式（Phase E）
  getExecutionOptions(): Promise<ExecutionOptions>;
  /**
   * 跨会话的研究设置默认值（主导人、参与的云端模型等）。
   * 新对话与重启后用这份；某一条会话自己的 `executionConfig` 仍跟那条线程。
   */
  getExecutionDefaults(): Promise<ConversationExecutionConfig>;
  /** 把当前研究设置记成默认值，下次新对话 / 重启还用。 */
  setExecutionDefaults(config: Partial<ConversationExecutionConfig>): Promise<ConversationExecutionConfig>;
  /**
   * 只写主进程的密文库；返回值里没有 Key。
   *
   * 保存成功后会顺手向网关 `/models` 要一次真实模型清单：`models` 是拿到
   * 的清单（拿不到就是原来那份），`modelNote` 说明为什么没拿到——Key 本身
   * 已经存好了，这条注记不该让用户以为保存失败。
   */
  setApiKey(input: { id: string; key: string }): Promise<{
    id: string;
    configured: boolean;
    models?: string[];
    catalog?: string[];
    modelNote?: string;
  }>;
  removeApiKey(id: string): Promise<{ id: string; configured: boolean }>;
  /** 改云端服务的端点或模型列表；不含 API Key。 */
  setCloudConfig(input: { id: string; baseUrl?: string; models?: string[] }): Promise<CloudProviderView>;
  /**
   * 从「选择模型」的完整候选里勾出这一问要用的一部分。
   *
   * 与 `setCloudConfig.models` 的区别：那条路把清单标成「手写」；这里勾的
   * 就是网关报过的模型，来源仍是 `/models`，不该因为取消勾选几条就退回
   * 「预设兜底」并触发下一次启动重新覆盖用户的勾选。
   */
  setCloudModels(input: { id: string; models: string[] }): Promise<CloudProviderView>;
  /**
   * 从目录加一个云端服务（`catalogId` 对应主进程的目录条目，`custom` 表自定义）。
   * 端点/模型不填就取目录里的默认值；Key 一并存进密文库。
   */
  addCloudProvider(input: {
    catalogId: string;
    label?: string;
    baseUrl?: string;
    models?: string[];
    key?: string;
  }): Promise<CloudProviderView>;
  /** 删掉用户自己加的服务（内置的只允许清 Key）。 */
  removeCloudProvider(id: string): Promise<{ id: string; removed: boolean }>;
  /** 用端点 + Key 去读 `/models`。带 `id` 时主进程会把结果记进配置。 */
  discoverCloudModels(input: { baseUrl: string; key?: string; id?: string }): Promise<{
    /** 网关报的完整清单（「选择模型」的候选）。 */
    models: string[];
    /** 记进配置之后这一问实际会用的子集；用户勾过的不会被新清单覆盖。 */
    selected?: string[];
  }>;
  getProviderHealth(): Promise<Record<string, ProviderHealthInfo>>;
  getCollaborationRecords(): Promise<CollaborationTaskRecord[]>;
  getUsage(): Promise<UsageSummary | null>;
  startDebate(input: {
    question: string;
    config: DebateConfigInput;
    conversationId?: string;
    /** 把这场辩论挂到当前空间/工作区下，侧栏里才找得到。 */
    workspaceMode?: 'knowledge' | 'engineering';
    workspaceId?: string;
    workspaceRoot?: string;
  }): Promise<DebateView>;
  getDebate(debateId: string): Promise<DebateView | null>;
  listDebates(): Promise<DebateView[]>;
  /** 历史上辩过相似问题的记录（Phase 5）。只读，不改任何状态。 */
  relatedDebates(input: { question: string; exclude?: string }): Promise<RelatedDebateView[]>;
  stopDebate(debateId: string): Promise<DebateView | null>;
  resumeDebate(debateId: string): Promise<DebateView | null>;
  cleanupDebateWeb(debateId: string): Promise<DebateCleanupOutcome>;
  removeDebate(debateId: string): Promise<{ id: string; removed: boolean }>;
  adjudicate(debateId: string): Promise<JudgeVerdictView>;
  getVerdict(debateId: string): Promise<JudgeVerdictView | null>;

  // task lifecycle
  submitPrompt(input: SubmitPromptInput): Promise<AgentTask>;
  getTask(taskId: string): Promise<AgentTask | null>;
  getTaskHistory(): Promise<AgentTask[]>;
  getTaskEvents(taskId: string): Promise<AgentEvent[]>;
  approvePlan(input: ApprovePlanInput): Promise<void>;
  rejectPlan(input: { taskId: string; planId: string; reason?: string }): Promise<void>;
  /** 逐次审批：放行某一步。`remember` 表示本次任务的同类步骤不再问。 */
  approveStep(input: { taskId: string; stepId: string; remember?: boolean }): Promise<void>;
  /** 逐次审批：拒绝某一步，该步失败并停止整份计划。 */
  rejectStep(input: { taskId: string; stepId: string; reason?: string }): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  answerClarification(input: { taskId: string; answer: string }): Promise<void>;
  /** 执行中提问的回答；`cancelled` 表示用户放弃回答，模型必须按未回答处理。 */
  answerStepQuestion(input: { taskId: string; stepId: string; answer?: string; cancelled?: boolean }): Promise<void>;
  deleteTask(taskId: string): Promise<void>;

  // environment
  getPermissionPreset(): Promise<PermissionPreset>;
  setPermissionPreset(preset: PermissionPreset): Promise<{ preset: PermissionPreset; approvalPolicy: 'ask' }>;
  chooseDirectory(): Promise<string | null>;
  getPlatform(): Promise<string>;
  getDeepSeekStatus(): Promise<DeepSeekStatus>;
  /**
   * Read one channel's page. Without an id it reads the planning channel —
   * kept so an old caller (and the sources-reload window) still gets an answer.
   */
  getDeepSeekDiagnostics(sourceId?: string): Promise<DeepSeekDiagnostics>;
  getAccessibilitySnapshot(): Promise<AccessibilitySnapshot>;

  // layout
  getLayout(): Promise<LayoutInfo>;
  /**
   * Ask for a page-pane width. The value is clamped in the main process, and
   * the reply is the width that was actually applied — the renderer must use
   * the reply, not its own request, or the two panes drift apart mid-drag.
   * Passing 0 restores the default ratio.
   */
  setSplit(value: number): Promise<LayoutInfo>;
  /**
   * Tell the main process a divider drag started or ended. While dragging, the
   * native page view is parked outside the window so it cannot swallow the
   * pointer moves the drag depends on.
   */
  setPageDragging(active: boolean): Promise<void>;

  // embedded sources
  /** The pages this app embeds, and which one is currently on screen. */
  getSources(): Promise<SourcesState>;
  /**
   * Bring one embedded page to the front. The view is created on first use, so
   * the reply returns before the page has loaded — `loading` says so, and a
   * `sources:changed` event follows when the view is actually up.
   */
  setSource(id: string): Promise<SourcesState>;
  /**
   * Where the native page views are right now.
   *
   * Only the ones that have been created appear. A view missing from the map
   * has never been shown; a view present but with `x` past the window width is
   * parked, which is how a hidden-but-alive page looks.
   */
  getViewBounds(): Promise<ViewBoundsMap>;
  /**
   * Change one source: its address, whether it is on, or both.
   *
   * The URL is normalized and checked against the source's allow-list before
   * anything is written, and the reply is the resulting state — a rejected
   * address must not leave the panel showing something that was never saved.
   */
  saveSource(id: string, patch: SourcePatch): Promise<SourcesState>;
  /** Add a web page as a new source. Its first address is its allow-list. */
  addSource(input: NewSourceInput): Promise<SourcesState>;
  /** Remove a source that was added in 设置. Built-ins are only disabled. */
  removeSource(id: string): Promise<SourcesState>;
  /**
   * Whether enabled web sources open when the app starts.
   *
   * Saving false closes every open source view immediately and leaves them
   * closed on the next launch until something needs them. Saving true opens
   * the enabled ones now (same as a cold start with the switch on).
   */
  setSourcesOpenOnLaunch(open: boolean): Promise<SourcesState>;

  /**
   * 「刷新」: load the page again, in place.
   *
   * Not a navigation back to the home address — the thread that is open stays
   * open, because the point is to recover a page that stopped responding, not to
   * abandon the conversation. The home address is only used as a fallback when
   * the reload itself does not settle, which is the one case where the old
   * document is unreachable anyway.
   */
  reloadPage(id?: string): Promise<SourcesState>;

  /** The display name, for the row at the bottom of the sidebar. */
  getIdentity(): Promise<Identity>;
  /**
   * Rename the row at the bottom of the sidebar.
   *
   * Pass an empty string to go back to the shipped name. The reply is the
   * resulting identity, so the caller never has to guess how the input was
   * normalized (trimmed, upper-cased initial) before showing it.
   */
  setDisplayName(name: string): Promise<Identity>;

  // page pane
  /** Which page, if any, is currently in its own window. */
  getPageState(): Promise<PageState>;
  /**
   * Pull a page out into its own window — the 「放大」 button.
   *
   * This moves the live view, it does not reload the site: a half-written answer
   * keeps writing, and the session is the same one. Closing that window (or
   * pressing 吸附回去) puts it back.
   */
  detachPage(sourceId?: string): Promise<PageState>;
  /** Put the detached page back into the main window. */
  reattachPage(): Promise<PageState>;
  /**
   * Fold the page pane away, or unfold it — the chevron on the page bar.
   *
   * Folding hides the view without shrinking it, so the page keeps the viewport
   * it was given and can still be asked questions while the app column uses the
   * full window. Unfolding restores the width the user had dragged to.
   */
  setPageCollapsed(collapsed: boolean): Promise<PageState>;
  /**
   * Re-read the page and repair selectors that no longer match.
   *
   * Runs in the page, validates the proposal against a real probe, and persists
   * only what measurably fixed something. Safe to press on a healthy page: it
   * reports that nothing needed changing.
   */
  learnSelectors(sourceId?: string): Promise<LearnSelectorsReport>;
  /**
   * 「保存文档」: read the live page's assistant answers (documents and the
   * plan/checklist lines inside them) and write them to a local file.
   *
   * Defaults to Markdown; Word is produced only when explicitly requested.
   * Returns null when the user cancels the save dialog.
   */
  savePageDocument(input: SavePageDocumentInput): Promise<SavePageDocumentResult | null>;
  /** 还原本轮改过的文件（按 taskId）；没有快照就是空结果。 */
  revertTaskSnapshot(taskId: string): Promise<{ taskId: string; restored: string[]; removed: string[]; failed: Array<{ path: string; detail: string }> }>;
  /** Embedding 提供方状态：本地 Ollama 有没有 embedding 模型、云端能不能用。 */
  embeddingStatus(): Promise<EmbeddingStatus>;
  /** 文本 → 向量；只提供这一层，不建代码索引（与 opencode 的 provider API 对齐）。 */
  embedTexts(input: EmbeddingRequest): Promise<EmbeddingResult>;
  /** 本地代码索引状态：READY generation、文件/节点/边/文档数。 */
  getCodeIndexStatus(root: string): Promise<CodeIndexStatus>;
  /** 建立/更新本地代码索引；没有 Python/Neo4j 时走 AST + SQLite 回退。 */
  buildCodeIndex(root: string): Promise<CodeIndexStatus>;
  /** 为当前索引建向量（本地 Ollama / 云端 embedding）。 */
  buildCodeVectors(root: string): Promise<CodeIndexVectorResult>;
  /** 工程检索：CODE / MEMORY / HYBRID；context=true 时附预算内上下文。 */
  searchCodeIndex(input: CodeIndexSearchInput): Promise<CodeIndexSearchResult>;
  /** 写入一条工程记忆；confirmed 只能由用户动作调用。 */
  rememberCodeMemory(input: CodeIndexMemoryInput): Promise<CodeIndexMemory>;
  /** 列出当前工程的记忆，供关联面板选择。 */
  listCodeMemories(root: string): Promise<CodeIndexMemory[]>;
  /** 把当前代码位置关联到一条工程记忆。 */
  linkCodeMemory(input: CodeIndexLinkInput): Promise<CodeIndexLink>;
  /** 工程智能运行模式与外部服务配置。 */
  getCodeIntelligenceConfig(): Promise<CodeIntelligenceConfig>;
  setCodeIntelligenceConfig(patch: CodeIntelligencePatch): Promise<CodeIntelligenceConfig>;
  testCodeIntelligence(): Promise<CodeIntelligenceStatus>;
  managedCodeIntelligence(action: CodeIntelligenceManagedAction): Promise<CodeIntelligenceManagedResult>;
  /** 删除工程索引/记忆/关联/向量；external=true 时尝试清外部 CGC。 */
  deleteCodeIndex(root: string, external?: boolean): Promise<{ local: Record<string, number>; external: number; warnings: string[] }>;
  /** 监听工作区源码变化，后台自动更新索引。 */
  watchCodeIndex(root: string): Promise<{ watching: boolean }>;
  unwatchCodeIndex(root: string): Promise<void>;
  /** 保存前的勾选列表：页面上有哪些对话可保存。只读，不写盘。 */
  extractPage(input?: { sourceId?: string }): Promise<PageExtractPreview>;

  // streams
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
  onDeepSeekEvent(callback: (event: DeepSeekEvent) => void): () => void;
  onLayoutChanged(callback: (info: LayoutInfo) => void): () => void;
  onSourcesChanged(callback: (state: SourcesState) => void): () => void;
  onPageChanged(callback: (state: PageState) => void): () => void;
  onConversationEvent(callback: (event: ConversationEvent) => void): () => void;
}

export interface AccessibilitySnapshot {
  available: boolean;
  application: { name: string; bundleId?: string } | null;
  tree: Array<{ role: string; title?: string; value?: string; children?: unknown[] }>;
}
