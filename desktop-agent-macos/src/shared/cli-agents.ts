/**
 * 外部 CLI Agent 的共享形状。
 *
 * 这一层只描述「怎么启动、跑出了什么」，不描述「该不该跑」——授权在
 * `TaskGrant` / `assertGrant`，进程边界在 Runtime。主进程持有配置（userData），
 * 每次执行随 `task.run` 下发一份只读快照，因此 Runtime 不需要读 userData，
 * 也就不需要为了配置把执行搬回主进程。
 *
 * 三个诚实的约束：
 *
 * 1. `headless: 'verified'` 只能由 Spike 实测后设置。默认 `unverified` 的 CLI
 *    会被 `agent.exec` 明确拒绝，不允许靠猜参数「先跑起来再说」。
 * 2. 参数模板是数组，不是 shell 字符串。`{task}` 是唯一占位符，替换后原样
 *    作为 argv 传入，不经过 shell，也就不存在引号与注入问题。
 * 3. 模型身份只记录 CLI 自己声明的值。Qoder 的 JSON 里 modelUsage 键是
 *    `auto` / `efficient`，那不是模型名；Claude 的 `canonicalModel` 可能是
 *    经由第三方 provider 的模型。都没声明时写 null，不按品牌推测。
 */

export type CliHeadlessSupport = 'verified' | 'unverified' | 'unsupported';

export interface CliAgentConfig {
  /** 稳定 id，计划步骤里的 `cli` 字段用它。 */
  id: string;
  label: string;
  /** 可执行文件名或绝对路径。绝对路径只在注册表内部使用，不接受模型传入。 */
  command: string;
  /** 参数模板：必须且只能含一个 `{task}` 占位符。 */
  args: string[];
  /** 权限参数单独列，便于界面说明与按版本调整；同样逐项作为 argv。 */
  permissionArgs?: string[];
  /**
   * 除基础变量外，额外透传的环境变量名。
   * 基础变量固定为 HOME / PATH / USER / LOGNAME / SHELL / TMPDIR / LANG / TZ / TERM。
   */
  envAllowlist?: string[];
  /** 非交互能力：只有实测通过的配置才允许被 agent.exec 启动。 */
  headless: CliHeadlessSupport;
  enabled: boolean;
  /** 检测到的版本；能力结论与它绑定，升级后要重验。 */
  version?: string | null;
}

export interface CliAgentView extends CliAgentConfig {
  detected: boolean;
  executable: string | null;
  version: string | null;
  /** 现在能不能用：能执行文件 + 已启用 + headless 已实测。 */
  available: boolean;
  /** 不可用的原因；可用时为 undefined。 */
  reason?: string;
}

export interface CliModelIdentity {
  cliId: string;
  cliVersion: string | null;
  /** CLI 输出里声明的模型名；没有就 null。 */
  declaredModel: string | null;
  /** 声明里的 provider 字段；没有就 null。 */
  provider: string | null;
  /** native = CLI 结构化输出里读到；unverified = 没有可核对来源。 */
  provenance: 'native' | 'unverified';
}

export interface CliRunResult {
  cli: string;
  /** 实际执行目录：独立工作树，或授权根目录。 */
  cwd: string;
  /** 进程退出码；被信号终止或超时为 null。 */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** 用户取消（任务被取消）与超时分开记，报告里不能混为一谈。 */
  cancelled: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** 截断后的尾部；完整输出不塞进上下文。 */
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
  /** 运行前后 git status 的差集，已做去重与排序；不是 CLI 自报。 */
  changedPaths: string[];
  /** CLI 结构化输出里的最终文本；解析失败时是 stdout 尾部。 */
  text: string;
  model: CliModelIdentity;
  costUsd: number | null;
  sessionId: string | null;
  permissionDenials: string[];
  /** 供后续交互式接管的会话 id；headless 执行没有 PTY，因此为 null。 */
  terminalSessionId: string | null;
}

/** 终端面板 attach 时拿到的现状：一次把 backlog 和 cursor 给全。 */
export interface TerminalAttach {
  sessionId: string;
  cols: number;
  rows: number;
  /** 自上次读取以来（对本面板而言）的新输出。 */
  backlog: string;
  cursor: number;
  dropped: number;
  exited: boolean;
  exitCode?: number;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
  /** 环缓冲已经丢弃的字节数；非 0 时界面要如实说。 */
  dropped: number;
  exited: boolean;
  exitCode?: number;
}
