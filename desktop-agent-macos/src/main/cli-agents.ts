/**
 * CLI Agent 注册表：装没装、什么版本、能不能用、用户开没开。
 *
 * 它**不是**网页来源（`PageSource`）的一部分：网页是「被问的通道」，CLI 是
 * 「被派活的执行者」。混在一起会让「所有已开启的通道都要被问」这条规则
 * 错误地作用到 CLI 上——用户问一个事实问题时不该启动一个会改代码的进程。
 *
 * 配置落在 userData/cli-agents.json；每次 task.run 把只读快照随执行下发，
 * Runtime 因此不需要读 userData，执行也没有被搬到主进程。
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
          : {})
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
      envAllowlist: item.envAllowlist ?? []
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
          ? '当前版本或启动参数没有实测记录，非交互能力未验证（点「重新验证」跑一次最小任务）'
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
