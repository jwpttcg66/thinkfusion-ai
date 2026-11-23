/**
 * CLI Agent 注册表：装没装、什么版本、能不能用、用户开没开。
 *
 * **一个 CLI 有两个身份，别把它们混成一层**（2026-11-15 用户裁决）：
 *
 * 1. **回答问题的源**——跟网页源同一层级。用户开着的 CLI 会像 DeepSeek /
 *    Kimi 那样被问同一句原话，答案从进程输出里回来，进第一轮、进汇总、
 *    进转录的通道条。实现见 `execution/cli-answer-agent.ts`。
 * 2. **被派活的执行者**——`agent.exec` 在执行阶段点名它去改代码，走授权与
 *    工作树（见 `agent/tools/cli-agent.ts`）。
 *
 * 两个身份共用这份配置，但用的不是同一组参数：回答源不传 `permissionArgs`
 * 也不碰工程目录，它只是答一句问题。配置落在 userData/cli-agents.json。
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isAbsoluteCliCommand, normalizeCliSoftwareSource, validateCliCommand, type CliSoftwareSource } from '../shared/cli-software-source';
import type { CliAgentConfig, CliAgentView } from '../shared/cli-agents';
import { isStructuredCliSuccess, parseCliResultJson } from '../shared/cli-result';
import {
  capabilityFingerprint,
  configureCliCapabilities,
  listCapabilityRecords,
  recordCapability,
  resolveHeadless
} from './cli-capabilities';

const execFileAsync = promisify(execFile);

/** 只有实测过的参数才能标 verified；改参数就要重新跑一次最小任务。 */
const DEFAULTS: readonly CliAgentConfig[] = [
  {
    id: 'qoder',
    label: 'Qoder CLI',
    command: 'qoder',
    args: ['-p', '{task}', '--output-format', 'json'],
    interactiveArgs: [],
    glyph: 'Q',
    permissionArgs: ['--permission-mode', 'accept_edits'],
    // 2026-11-15 实测（Qoder CLI 1.1.89，macOS）：-p + JSON 输出可用，
    // accept_edits 下能创建文件，退出码 0；permission_denials 为空。
    headless: 'verified',
    enabled: true,
    envAllowlist: []
  },
  {
    id: 'claude',
    label: 'Claude CLI',
    command: 'claude',
    args: ['-p', '{task}', '--output-format', 'json'],
    interactiveArgs: [],
    glyph: 'C',
    permissionArgs: ['--permission-mode', 'acceptEdits'],
    // 2026-11-15 实测（Claude Code 2.1.325）：同上；JSON 里的
    // modelUsage.canonicalModel 可能是第三方模型，不能按品牌猜。
    headless: 'verified',
    enabled: true,
    envAllowlist: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR']
  }
];

interface StoredFile {
  agents?: Record<string, Partial<CliAgentConfig>>;
}

let configPath: string | null = null;
let cached: CliAgentConfig[] = [...DEFAULTS];
const versionCache = new Map<string, { version: string | null; at: number }>();
const VERSION_TTL_MS = 60 * 60 * 1000;

export function configureCliAgents(input: { userDataDir: string }) {
  configPath = path.join(input.userDataDir, 'cli-agents.json');
  // 能力记录与注册表同目录：版本/参数变化后自动降级，不再靠写死的 verified。
  configureCliCapabilities({ userDataDir: input.userDataDir, defaults: DEFAULTS });
  cached = load();
  refreshCliAgentVersions();
}

/** 落盘的软件源坏了就当没填，不让它拖垮整个注册表。 */
function storedSoftwareSource(raw: unknown): { softwareSource: CliSoftwareSource } | null {
  if (!raw) return null;
  try {
    return { softwareSource: normalizeCliSoftwareSource(raw) };
  } catch {
    return null;
  }
}

function load(): CliAgentConfig[] {
  if (!configPath) return [...DEFAULTS];
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as StoredFile;
    const stored = raw.agents ?? {};
    return DEFAULTS.map(base => {
      const patch = stored[base.id] ?? {};
      return {
        ...base,
        ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
        ...(typeof patch.command === 'string' && patch.command.trim() ? { command: patch.command } : {}),
        ...(Array.isArray(patch.args) && patch.args.every(item => typeof item === 'string')
          ? { args: patch.args }
          : {}),
        ...(Array.isArray(patch.permissionArgs) && patch.permissionArgs.every(item => typeof item === 'string')
          ? { permissionArgs: patch.permissionArgs }
          : {}),
        ...(Array.isArray(patch.interactiveArgs) && patch.interactiveArgs.every(item => typeof item === 'string')
          ? { interactiveArgs: patch.interactiveArgs }
          : {}),
        ...(Array.isArray(patch.envAllowlist) && patch.envAllowlist.every(item => typeof item === 'string')
          ? { envAllowlist: patch.envAllowlist }
          : {}),
        ...(storedSoftwareSource(patch.softwareSource) ?? {})
      };
    });
  } catch {
    // 坏文件不该让整个应用起不来：回默认值，下次保存会覆盖它。
    return [...DEFAULTS];
  }
}

function save(): void {
  if (!configPath) return;
  const agents: Record<string, Partial<CliAgentConfig>> = {};
  for (const item of cached) {
    agents[item.id] = {
      enabled: item.enabled,
      command: item.command,
      args: item.args,
      permissionArgs: item.permissionArgs ?? [],
      interactiveArgs: item.interactiveArgs ?? [],
      envAllowlist: item.envAllowlist ?? [],
      ...(item.softwareSource ? { softwareSource: item.softwareSource } : {})
    };
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ agents }, null, 2)}\n`, 'utf8');
}

/** GUI 应用从 Finder 启动时 PATH 往往只有 /usr/bin:/bin:/usr/sbin:/sbin。 */
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
];

function searchDirs(): string[] {
  const home = process.env.HOME ?? '';
  return [
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...EXTRA_BIN_DIRS,
    ...(home
      ? [`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.npm-global/bin`, `${home}/bin`]
      : [])
  ].filter(Boolean);
}

/** `command` 可能是绝对路径，也可能是 PATH 里的名字。 */
export function resolveExecutable(command: string): string | null {
  if (command.includes('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of searchDirs()) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  // Qoder 的安装器默认不放 PATH：~/.qoder/entry/qoder 是它自己的入口。
  if (command === 'qoder') {
    const fallback = path.join(process.env.HOME ?? '', '.qoder', 'entry', 'qoder');
    try {
      fs.accessSync(fallback, fs.constants.X_OK);
      return fallback;
    } catch {
      return null;
    }
  }
  return null;
}

function versionOf(executable: string): { version: string | null; error?: string } {
  const cachedVersion = versionCache.get(executable);
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) {
    return { version: cachedVersion.version };
  }
  try {
    const out = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    // 有的 CLI 打印多行（版本 + 构建信息），只留第一行非空内容。
    const version = out.split('\n').map(line => line.trim()).find(Boolean) ?? null;
    versionCache.set(executable, { version, at: Date.now() });
    return { version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { version: null, error: message };
  }
}

function viewOf(config: CliAgentConfig): CliAgentView {
  const executable = resolveExecutable(config.command);
  const detected = executable ? versionOf(executable) : { version: null };
  const headless = resolveHeadless(config, detected.version);
  const reason = !executable
    ? `找不到可执行文件「${config.command}」`
    : !config.enabled
      ? '已在设置里关闭'
      : headless === 'unsupported'
        ? '不支持非交互执行'
        : headless === 'unverified'
          // 不写「点『重新验证』」：这行字显示在模型弹层的 label 里，
          // 点它只会 toggle 勾选，用户会以为验证跑过了（真机踩到）。
          ? '当前版本或启动参数没有实测记录，非交互能力未验证（去「设置 → 模型 → CLI 来源」验证）'
          : detected.version === null
            ? '能执行，但读不到版本；先自己跑一次 --version 确认'
            : undefined;
  return {
    ...config,
    headless,
    detected: Boolean(executable),
    executable,
    version: detected.version,
    available: Boolean(executable) && config.enabled && headless === 'verified' && detected.version !== null,
    ...(reason ? { reason } : {})
  };
}

export function listCliAgents(): CliAgentView[] {
  return cached.map(viewOf);
}

/**
 * 回答源此刻的状态：可用性、不可用原因、版本都取注册表当前值。
 *
 * 不给实例缓存：设置里关掉一个 CLI、换了可执行文件、版本升级导致能力降级，
 * 都必须在下一轮提问里立刻生效，而不是等应用重启。
 */
export function cliAnswerView(id: string): CliAgentView | undefined {
  const config = cached.find(item => item.id === id);
  return config ? viewOf(config) : undefined;
}

/** 回答源真正 spawn 时用的配置：可执行文件已解析、headless 已按版本判定。 */
export function cliAnswerConfig(id: string): CliAgentConfig | undefined {
  return cliAgentSnapshot().find(item => item.id === id);
}

/** 注册表里有哪些 CLI（顺序即右侧栏顺序）。 */
export function cliAgentIds(): string[] {
  return cached.map(item => item.id);
}

/**
 * 用户开着的 CLI。**不探版本、不碰文件系统**：这条路每条消息都会走一遍，
 * 只回答「开关状态」，可用性由提问那一刻的 health() 自己报。
 */
export function enabledCliAgentIds(): string[] {
  return cached.filter(item => item.enabled).map(item => item.id);
}

/** 给 Runtime 的只读快照：包含配置与真实路径，不包含任何用户密钥。 */
export function cliAgentSnapshot(): CliAgentConfig[] {
  return cached.map(item => {
    const executable = resolveExecutable(item.command);
    const version = executable ? versionOf(executable).version : null;
    return {
      ...item,
      command: executable ?? item.command,
      version,
      // agent.exec 只认这个字段；必须由当前版本的能力记录决定，不能透传写死值。
      headless: resolveHeadless(item, version)
    };
  });
}

export function cliCapabilityRecords() {
  return listCapabilityRecords();
}

export function setCliAgentEnabled(input: { id: string; enabled: boolean }): CliAgentView[] {
  const target = cached.find(item => item.id === input.id);
  if (!target) throw new Error(`没有这个 CLI Agent：${input.id}`);
  target.enabled = input.enabled;
  save();
  return listCliAgents();
}

/**
 * 设置页的「软件源」：改可执行命令，并登记这个 CLI 从哪来。
 *
 * 两道闸都在主进程：
 * 1. 命令只能是 PATH 名字或干净的绝对路径；绝对路径必须是用户本次亲手
 *    在文件对话框里挑过的（或本来就在配置里），渲染层不能凭空塞一条
 *    `~/.ssh/...` 之类的路径进来。
 * 2. 命令必须真的能执行。填错路径会当场报错，而不是把一个可用的 CLI
 *    悄悄变成「找不到可执行文件」。
 *
 * 安装来源与端点只落盘展示，不执行任何安装/更新命令。换掉命令名会让
 * 参数指纹变化，headless 能力自动降为 unverified（见 cli-capabilities.ts）。
 */
export function setCliSoftwareSource(input: {
  id: string;
  command?: string;
  softwareSource?: CliSoftwareSource;
  isPicked?: (command: string) => boolean;
}): CliAgentView[] {
  const target = cached.find(item => item.id === input.id);
  if (!target) throw new Error(`没有这个 CLI Agent：${input.id}`);
  if (input.softwareSource === undefined) throw new Error('缺少软件源配置');
  const softwareSource = normalizeCliSoftwareSource(input.softwareSource);

  if (input.command !== undefined) {
    const command = validateCliCommand(input.command);
    if (isAbsoluteCliCommand(command) && command !== target.command && !input.isPicked?.(command)) {
      throw new Error('绝对路径必须先用「选择…」在文件对话框里挑过');
    }
    if (!resolveExecutable(command)) {
      throw new Error(`找不到可执行文件「${command}」，先安装或选对路径`);
    }
    target.command = command;
  }
  target.softwareSource = softwareSource;
  save();
  refreshCliAgentVersions();
  return listCliAgents();
}

/** 版本升级后能力结论要重验：清掉缓存，下一次 list 会重新执行 --version。 */
export function refreshCliAgentVersions(): void {
  versionCache.clear();
}

const VERIFY_TASK = 'Reply with exactly: OK';
const VERIFY_TIMEOUT_MS = 90_000;

/** 主进程跑 CLI 时只透传这些变量，不把整个环境（含无关密钥）交给它。 */
function verifyEnv(config: CliAgentConfig): NodeJS.ProcessEnv {
  const keys = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ', 'TERM', ...(config.envAllowlist ?? [])];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * 「重新验证」：真的跑一次最小 headless 任务，通过才写记录。
 *
 * 这是 opt-in 动作（会调用云端模型、消耗额度），不自动执行；命令、参数、
 * 任务文本全部来自注册表与常量，渲染层只能给一个 cliId，不能塞可执行文件。
 */
export async function verifyCliHeadless(id: string): Promise<{
  ok: boolean;
  version: string | null;
  error?: string;
  view?: CliAgentView;
}> {
  const config = cached.find(item => item.id === id);
  if (!config) return { ok: false, version: null, error: `没有这个 CLI Agent：${id}` };
  const executable = resolveExecutable(config.command);
  if (!executable) return { ok: false, version: null, error: `找不到可执行文件「${config.command}」` };
  const version = versionOf(executable).version;
  if (!version) return { ok: false, version: null, error: '读不到版本，无法把能力结论绑定到版本' };

  const argv = config.args.map(item => (item === '{task}' ? VERIFY_TASK : item));
  argv.push(...(config.permissionArgs ?? []));
  let stdout: string;
  try {
    const result = await execFileAsync(executable, argv, {
      cwd: os.tmpdir(),
      env: verifyEnv(config),
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    });
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, version, error: `最小任务失败：${message}` };
  }

  // 只认结构化成功结果：能解析、没标 is_error、有 result 文本。
  // 「进程退出 0 但输出不是 JSON」不足以证明 headless 参数仍然有效。
  // 解析按行容错：Qoder 会先打一行自定义命令警告，整段 JSON.parse 会把
  // exit 0、result 正常的任务误判成失败（2026-11-15 真机 E2E 抓到）。
  const parsed = parseCliResultJson(stdout);
  if (!isStructuredCliSuccess(parsed)) {
    return { ok: false, version, error: '最小任务没有返回可识别的结构化成功结果' };
  }

  recordCapability({
    cliId: config.id,
    capability: 'headless',
    version,
    fingerprint: capabilityFingerprint(config),
    note: `真实 CLI 最小任务通过（${new Date().toISOString()}），版本 ${version}`
  });
  refreshCliAgentVersions();
  return { ok: true, version, view: viewOf(config) };
}
