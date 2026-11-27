/**
 * 本地 shell 能力（对齐 harness 的命令执行）。
 *
 * 为什么不是「再包一层 test.run」：用户要的是真正的 shell——管道、重定向、
 * 自定义命令，而不是五个写死的 npm 脚本。所以这里确实开 `/bin/sh -c`，
 * 代价是模型输出和系统指令之间不再有天然隔离，必须靠权限分层来兜：
 *
 * - `read-only`：直接拒绝，不进入这个文件。
 * - `workspace-write`：只放行只读与构建类命令，且**不允许任何 shell 组合符**
 *   （`;` `&&` `|` `>` 反引号 `$(`）。组合符一多，白名单就形同虚设：
 *   `ls $(rm -rf .)` 的前缀仍然是 `ls`。写文件请走 `fs.writeFile`，
 *   那里有指纹校验和路径约束。
 * - `danger-full-access`：给真 shell，只拦截不可回收的操作（提权、格式化、
 *   清根目录、关机）。这不是"安全"，是"别让一次误判把机器弄没"。
 *
 * 两种模式都：cwd 由授权决定、环境变量最小集（不带 API Key）、超时杀进程组、
 * 输出截断、退出码原样返回。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';
import { startJob, type JobMeta } from './jobs';
import { wrapWithSandbox } from './sandbox';

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/**
 * workspace-write 下可执行的命令前缀。
 *
 * 只读或构建类：能看、能查、能跑项目自己的测试与构建，不能写。
 * 注意 `npm run` 只放行固定脚本名——`npm exec` / `npx` 会下载并执行任意包，
 * 不在其中。
 */
const WORKSPACE_WRITE_ALLOW: RegExp[] = [
  /^(ls|pwd|whoami|id|date|uname|sw_vers|which|wc|head|tail|cat|file|stat|du|df|md5|shasum|sort|uniq|diff|jq|tree|echo)(\s|$)/,
  /^(find|grep|rg)\s/,
  /^git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|blame|describe|tag)(\s|$)/,
  /^(node|python3)\s+(-v|--version)$/,
  /^npm\s+(ls|--version|-v)(\s|$)/,
  /^npm\s+run\s+(test|typecheck|build|lint|test:[a-zA-Z0-9:_-]+)(\s|$)/
];

/** shell 组合符。workspace-write 下出现任何一个都拒绝。 */
const SHELL_COMPOSITION = /[;&|<>`\n]|\$\(/;

/** 即便在白名单里也不允许的查找/删除动作。 */
const WORKSPACE_WRITE_FORBIDDEN = [/\s-exec\b/, /\s-delete\b/, /\bxargs\b/, /\bcd\s/];

/**
 * 任何权限下都拦的操作。
 *
 * 这些不是策略偏好：跑下去就回不来了（提权、抹盘、清根、关机）。
 * 用户真要做得自己动手，不能让一个模型规划把机器带走。
 */
const ALWAYS_FORBIDDEN: Array<[RegExp, string]> = [
  [/\bsudo\b/, '不允许提权执行（sudo）'],
  [/\bdoas\b/, '不允许提权执行（doas）'],
  [/\bmkfs(\.[a-z0-9]+)?\b/, '不允许格式化磁盘'],
  [/\bdd\b[^\n]*\bof=\/dev\//, '不允许直接写块设备'],
  [/>\s*\/dev\/(disk|sd|rdisk)/, '不允许直接写块设备'],
  [/\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rf][a-zA-Z]*\s+(\/|\/\*|~|\$HOME)(\s|$)/, '不允许删除根目录或家目录'],
  [/\brm\s+-rf\s+(\/|\/\*)/, '不允许删除根目录'],
  [/:\(\)\s*\{/, '不允许 fork 炸弹'],
  [/\b(shutdown|reboot|halt)\b/, '不允许关机或重启'],
  [/\bkillall\b/, '不允许批量杀进程'],
  [/\bchmod\s+-R\s+777\s+\/(\s|$)/, '不允许把根目录改成 777']
];

export interface ShellRunResult {
  command: string;
  cwd: string;
  /** 当前用的是哪套策略，方便在报告里分辨「白名单」还是「完全权限」。 */
  policy: 'allowlist' | 'full';
  shell: string;
  /** 这一轮到底有没有真被关进沙箱；false 时 reason 给出原因。 */
  sandboxed: boolean;
  sandboxReason: string;
  exitCode: number | null;
  /** 真正发给进程组的最后一个信号；超时与用户中断都要如实记。 */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** 用户取消导致的中断，与 timedOut 区分开。 */
  interrupted: boolean;
  truncated: boolean;
  /** 后台运行时存在，此时没有退出码。 */
  job?: JobMeta;
}

export function checkShellCommand(command: string, preset: TaskGrant['permissionPreset']): 'allowlist' | 'full' {
  if (typeof command !== 'string' || !command.trim()) throw new Error('命令不能为空');
  if (command.length > 2000) throw new Error('命令超过 2000 字符上限');
  if (command.includes('\0')) throw new Error('命令包含非法字符');

  for (const [pattern, reason] of ALWAYS_FORBIDDEN) {
    if (pattern.test(command)) throw new Error(`命令被拒绝：${reason}`);
  }

  if (preset === 'read-only') {
    throw new Error('当前权限为“仅可查看”，禁止执行 shell 命令');
  }
  if (preset === 'danger-full-access') return 'full';

  if (SHELL_COMPOSITION.test(command)) {
    throw new Error('workspace-write 权限下不允许 shell 组合符（; & | > < 反引号 $( 换行）；需要任意命令请用完全权限');
  }
  for (const pattern of WORKSPACE_WRITE_FORBIDDEN) {
    if (pattern.test(command)) throw new Error('workspace-write 权限下不允许这一步的写法（-exec / -delete / xargs / cd）');
  }
  if (!WORKSPACE_WRITE_ALLOW.some(pattern => pattern.test(command))) {
    throw new Error(
      '这个命令不在 workspace-write 的白名单里。当前只允许 ls/cat/grep/find/git 查询类命令与 npm run test|typecheck|build；' +
      '要执行其它命令，请在审批前把权限切到「完全权限」，或者把写操作改用 fs.writeFile。'
    );
  }
  return 'allowlist';
}

export async function runShell(
  grant: TaskGrant,
  args: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    background?: boolean;
    /** 运行时的任务取消集合；命中时向进程组发中断信号，而不是等它自己跑完。 */
    isCancelled?: () => boolean;
  }
): Promise<ShellRunResult> {
  const policy = checkShellCommand(args.command, grant.permissionPreset);
  const cwd = await resolveGrantedPath(grant, args.cwd ?? '.', false);
  const cwdStat = await fs.stat(cwd);
  if (!cwdStat.isDirectory()) throw new Error('命令的工作目录必须是目录');
  // 白名单模式下不允许把 cwd 挪到工作区外：`cd` 已经被禁，cwd 参数是另一个口子。
  if (policy === 'allowlist') {
    const root = await fs.realpath(grant.rootDir);
    const real = await fs.realpath(cwd);
    const relative = real.startsWith(root.endsWith('/') ? root : `${root}/`);
    if (!relative && real !== root) throw new Error('workspace-write 下命令必须在工作区内执行');
  }

  // 启动前已经取消：不能先 spawn 再补一刀，直接给可核对的中断结果。
  if (args.isCancelled?.()) {
    return {
      command: args.command, cwd, policy, shell: '/bin/sh',
      sandboxed: false, sandboxReason: '命令启动前已取消，没有进程可核对沙箱状态',
      exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0,
      timedOut: false, interrupted: true, truncated: false
    };
  }

  if (args.background) {
    const startedAt = Date.now();
    const job = await startJob(grant, { command: args.command, cwd });
    return {
      command: args.command,
      cwd,
      policy,
      shell: '/bin/sh',
      sandboxed: job.sandboxed ?? false,
      sandboxReason: job.sandboxReason ?? '后台作业没有记录沙箱状态',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startedAt,
      timedOut: false,
      interrupted: false,
      truncated: false,
      job
    };
  }

  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const started = Date.now();
  // spawn 之前包：沙箱不可用时原样返回命令，但 sandboxed 会如实为 false。
  const sandbox = wrapWithSandbox('/bin/sh', ['-c', args.command], { rootDir: grant.rootDir });
  const child = spawn(sandbox.command, sandbox.argv, {
    cwd,
    shell: false,
    detached: true,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      HOME: process.env.HOME ?? '',
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      // Go 默认把构建缓存写到 ~/Library/Caches/go-build；沙箱只允许写授权目录
      // 与系统临时目录，`go run` 会在收尾 trim cache 时退出 1（真机 2026-11-24
      // 的 hello jwp 任务）。把 GOCACHE 指到临时目录，程序本身没失败也才算通过。
      GOCACHE: path.join(os.tmpdir(), 'thinkfusion-go-cache'),
      // 明确不传 API Key / token：命令输出会进入执行报告，进而回传给网页模型。
      CI: '1',
      NO_COLOR: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  const append = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString('utf8');
    if (next.length > MAX_OUTPUT) {
      truncated = true;
      return next.slice(0, MAX_OUTPUT);
    }
    return next;
  };
  child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });

  let timedOut = false;
  let interrupted = false;
  let closed = false;
  let lastSignal: NodeJS.Signals | null = null;
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      lastSignal = signal;
    } catch { /* 进程已经退出 */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup('SIGKILL');
  }, timeoutMs);

  // 沿用 Runtime 的取消集合，不新造第二套取消机制。每 100ms 查一次：
  // 命中就 SIGTERM 整个进程组，2 秒后还活着再 SIGKILL，不能只把下一步 skip。
  let graceTimer: NodeJS.Timeout | undefined;
  const cancelTimer = args.isCancelled
    ? setInterval(() => {
        if (closed || interrupted || timedOut || !args.isCancelled?.()) return;
        interrupted = true;
        clearTimeout(timer);
        killGroup('SIGTERM');
        graceTimer = setTimeout(() => { if (!closed) killGroup('SIGKILL'); }, 2000);
      }, 100)
    : null;

  const exitCode = await new Promise<number | null>(resolve => {
    child.on('error', () => resolve(null));
    child.on('close', (code, childSignal) => {
      closed = true;
      if (childSignal) lastSignal = childSignal;
      resolve(code);
    });
  });
  clearTimeout(timer);
  if (cancelTimer) clearInterval(cancelTimer);
  if (graceTimer) clearTimeout(graceTimer);

  return {
    command: args.command,
    cwd,
    policy,
    shell: '/bin/sh',
    sandboxed: sandbox.sandboxed,
    sandboxReason: sandbox.reason,
    exitCode,
    signal: lastSignal,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
    interrupted,
    truncated
  };
}
