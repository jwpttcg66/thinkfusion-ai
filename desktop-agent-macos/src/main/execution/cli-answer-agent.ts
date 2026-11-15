import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { classifyCliError, type CliErrorClassification } from '../../shared/cli-errors';
import { parseCliResultJson } from '../../shared/cli-result';
import { redactSecrets } from '../../shared/redact';
import type { ChannelStatus } from '../../shared/conversation';
import type { CliAgentConfig, CliAgentView } from '../../shared/cli-agents';
import type { SubAgent, SubAgentAnswer, SubAgentIdentity, SubAgentTask } from '../agents/types';

/**
 * 把「CLI 软件源」包成 `SubAgent`：跟网页源、模型源并列的第三类回答源。
 *
 * 2026-11-15 用户裁决：回答源只有三类——**网页 / 模型 / CLI**，同一层级。
 * 所以 CLI 在选人、状态条、转录、汇总里都跟网页通道并列：同一句用户原话发
 * 过去，答案原样回来，进第一轮与后面的汇总/交锋材料。
 *
 * 四条刻意的边界：
 *
 * 1. **只被问，不动工程。** 不传 `permissionArgs`、工作目录固定在系统临时
 *    目录。一个答案不该顺手获得改文件的权限；改文件是 `agent.exec` 那条执行
 *    链的职责，有自己的授权与工作树。
 * 2. **不做流式。** headless 的 stdout 要到进程退出才完整，`askStream` 不实现，
 *    调用方会退回 `ask`——宁愿晚一点看到整段，也不假装在流。
 * 3. **失败要说清楚是哪一类。** 限流 / 额度 / 认证 / 网络 / 超时来自
 *    `classifyCliError`，不是把 stderr 整段糊到错误里。
 * 4. **不经过 shell。** argv 数组直接 spawn，问题原文作为单个参数。
 */

/** 一次问答的上限。超过就没在答题了，多半是卡在登录或网络。 */
export const CLI_ANSWER_TIMEOUT_MS = 240_000;
/** 只留尾部：回答是文本，不是日志。 */
const MAX_CAPTURE_CHARS = 400_000;
const KILL_GRACE_MS = 5000;
/** 与执行链相同的环境白名单：少一个 HOME 就可能找不到 CLI 自己的凭据。 */
const BASE_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ', 'TERM', 'LC_ALL'];

const running = new Map<string, { child: ChildProcess; markCancelled: () => void }>();

export interface CliAnswerOutcome {
  /** 已脱敏、已从结构化结果里取出的正文。 */
  text: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stderrTail: string;
  cliVersion: string | null;
  errorClassification: CliErrorClassification | null;
}

export interface CliAnswerDeps {
  /** 注册表此刻的状态；关掉、找不到可执行文件、能力降级都在这里体现。 */
  view(cliId: string): CliAgentView | undefined;
  /** 真的跑一次 CLI。`requestId` 同时是取消键。 */
  run(input: { cliId: string; task: string; requestId: string }): Promise<CliAnswerOutcome>;
  /** 终止一次正在跑的问答。 */
  cancel(requestId: string): boolean;
}

function trimTail(text: string): string {
  return text.length > MAX_CAPTURE_CHARS ? text.slice(text.length - MAX_CAPTURE_CHARS) : text;
}

function answerEnv(config: CliAgentConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...(config.envAllowlist ?? [])]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // detached: true 让子进程自己是进程组组长；负号才是「整棵树」。
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已经退出。
    }
  }
}

/**
 * 真的跑一次问答。
 *
 * 只有 spawn 本身失败才 reject；其余情况一律 resolve 一个带原因的结果，
 * 让「这一家为什么没答」能作为通道失败显示在转录里，而不是整轮挂掉。
 */
export function runCliAnswer(
  config: CliAgentConfig,
  input: { task: string; requestId: string; timeoutMs?: number }
): Promise<CliAnswerOutcome> {
  const timeoutMs = Math.max(1000, Math.min(input.timeoutMs ?? CLI_ANSWER_TIMEOUT_MS, 1_800_000));
  const started = Date.now();
  const args = config.args.map(arg => arg.split('{task}').join(input.task));
  // permissionArgs 故意不加：回答不该顺手拿到写盘权限。

  let child: ChildProcess;
  try {
    child = spawn(config.command, args, {
      cwd: os.tmpdir(),
      env: answerEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<CliAnswerOutcome>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    /** 用户点了「停止等待」：这是取消，不是失败，两者不能混成一类错误。 */
    const markCancelled = () => {
      cancelled = true;
      terminate(child, 'SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) terminate(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      force.unref?.();
    };
    running.set(input.requestId, { child, markCancelled });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(input.requestId);
      const parsed = parseCliResultJson(stdout);
      const text = redactSecrets(
        parsed && typeof parsed.result === 'string' ? parsed.result : trimTail(stdout)
      );
      const stderrTail = redactSecrets(trimTail(stderr).slice(-8000));
      resolve({
        text,
        exitCode,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        stderrTail,
        cliVersion: config.version ?? null,
        errorClassification: classifyCliError({
          exitCode,
          signal,
          timedOut,
          cancelled,
          parsed,
          stderrTail
        })
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, 'SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) terminate(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      force.unref?.();
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = trimTail(stdout + chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = trimTail(stderr + chunk.toString('utf8'));
    });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(input.requestId);
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        code === 'ENOENT'
          ? new Error(`找不到可执行文件「${config.command}」：GUI 应用的 PATH 可能不含它，请在设置里填绝对路径`)
          : error
      );
    });
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

/** 「停止等待」：终止一个还在跑的 CLI 回答进程。返回是否真有进程被掐。 */
export function cancelCliAnswer(requestId: string): boolean {
  const entry = running.get(requestId);
  if (!entry) return false;
  entry.markCancelled();
  return true;
}

function identityOf(cliId: string, label: string): SubAgentIdentity {
  return {
    id: `cli:${cliId}`,
    label,
    kind: 'provider',
    role: 'CLI 软件源（被问的通道，不是页面）'
  };
}

function failureOf(outcome: CliAnswerOutcome): string | null {
  if (outcome.cancelled) return '这次提问被取消了';
  if (outcome.timedOut) return `超过 ${Math.round(CLI_ANSWER_TIMEOUT_MS / 1000)} 秒没有答完，已终止`;
  const classified = outcome.errorClassification;
  if (classified) {
    const evidence = classified.evidence ? `（${classified.evidence}）` : '';
    return `${classified.kind}${evidence}`;
  }
  if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    const tail = outcome.stderrTail.trim().split('\n').filter(Boolean).slice(-2).join(' ');
    return `退出码 ${outcome.exitCode}${tail ? `：${tail}` : ''}`;
  }
  if (!outcome.text.trim()) return '没有输出任何回答';
  return null;
}

export class CliAnswerAgent implements SubAgent {
  readonly identity: SubAgentIdentity;
  readonly id: string;
  readonly label: string;

  private seq = 0;
  /** 正在等待的请求：停止时要把它们全部掐掉。 */
  private readonly pending = new Set<string>();

  constructor(readonly cliId: string, private readonly deps: CliAnswerDeps) {
    const view = deps.view(cliId);
    this.id = `cli:${cliId}`;
    this.label = view?.label ?? `CLI ${cliId}`;
    this.identity = identityOf(cliId, this.label);
  }

  /** 选人策略与报错文案靠它区分「软件源」，不用 instanceof 猜。 */
  get sourceType(): 'cli' {
    return 'cli';
  }

  async health(): Promise<ChannelStatus> {
    const view = this.deps.view(this.cliId);
    if (!view) {
      return {
        id: this.id,
        label: this.label,
        sourceType: 'cli',
        available: false,
        loggedIn: false,
        pageReady: false,
        generating: false,
        detail: '注册表里没有这个 CLI'
      };
    }
    return {
      id: this.id,
      label: view.label,
      sourceType: 'cli',
      available: view.available,
      // CLI 没有「登录页面」这两个概念。这里写的是「不缺这两样」，
      // 真正的原因在 detail 里（关掉了 / 没装 / 能力未验证）。
      loggedIn: view.available,
      pageReady: view.available,
      generating: false,
      ...(view.reason ? { detail: view.reason } : {})
    };
  }

  async ask(task: SubAgentTask): Promise<SubAgentAnswer> {
    const requestId = `${this.id}-${++this.seq}-${Date.now()}`;
    const started = Date.now();
    this.pending.add(requestId);
    /**
     * CLI 只有一个 stdin 提示，没有 system 轮次。辩论 / 汇总的材料（别人的
     * 回答、辩题、角色要求）必须随提示一起发过去，否则它只看到一句辩题、
     * 拿不到要交锋的内容。
     *
     * 第一轮没有 system / context：这一句就是用户原话，逐字不改——「问什么
     * 发什么」那条硬规则在 CLI 上同样成立。网页通道不受影响：它永远只收到
     * question（见 `SubAgentTask` 的字段注释）。
     */
    const material = [...(task.system ?? []), ...(task.context ?? [])].filter(part => part.trim());
    const prompt = material.length === 0 ? task.question : [...material, task.question].join('\n\n');
    let outcome: CliAnswerOutcome;
    try {
      outcome = await this.deps.run({ cliId: this.cliId, task: prompt, requestId });
    } finally {
      this.pending.delete(requestId);
    }
    const failure = failureOf(outcome);
    // 只报原因，不带自己的名字：上层显示时已经写了「Claude CLI：…」，
    // 这里再加一次会变成「Claude CLI：Claude CLI：RATE_LIMITED」。
    if (failure) throw new Error(failure);
    return {
      agentId: this.id,
      text: outcome.text,
      receivedAt: Date.now(),
      attribution: {
        requestId,
        note: `cli:${this.cliId}${outcome.cliVersion ? `@${outcome.cliVersion}` : ''}`
      },
      stage: task.stage,
      // 进程输出里没有 token 用量；null 不是 0。
      usage: null,
      latencyMs: outcome.durationMs > 0 ? outcome.durationMs : Date.now() - started
    };
  }

  cancel(requestId: string): void {
    this.deps.cancel(requestId);
    this.pending.delete(requestId);
  }

  /** 「停止等待」：这个来源上还在跑的问答全部终止。 */
  cancelAll(): void {
    for (const requestId of this.pending) this.deps.cancel(requestId);
    this.pending.clear();
  }
}
