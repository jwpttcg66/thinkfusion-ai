/**
 * 外部 CLI Agent 的真实执行：spawn、限时、取消、回收证据。
 *
 * 这里刻意不做的事：
 *
 * - **不把终端输出当结构化事件。** 只有 CLI 自己输出的 JSON 结果才被标记
 *   `native`；解析失败时把 stdout 尾部当文本交出去，并标 `unverified`。
 * - **不猜参数。** 命令行来自注册表，`headless` 没被 Spike 标成 `verified`
 *   的配置根本不会走到这里（见 cliAgentConfigError）。
 * - **不信 CLI 自报的成功。** 改了哪些文件用运行前后的工作区快照算，不是从
 *   它的 JSON 里抄；任务算不算成功仍由 verifyExecution 决定。
 * - **不经过 shell。** argv 数组直接交给 spawn，任务原文作为单个参数，不做引号拼接。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CliAgentConfig, CliModelIdentity, CliRunResult } from '../../shared/cli-agents';

/** 每个流最多留 2 MB；再多就不是「输出」，是把日志塞进内存。 */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
/** 交回计划的尾部长度；完整输出不塞进上下文。 */
const TAIL_CHARS = 8000;
/** 取消后等这么久再强杀进程组。 */
const KILL_GRACE_MS = 5000;

/** 基础环境：登录与路径相关，缺一个 CLI 就可能找不到 home 里的凭据。 */
const BASE_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ', 'TERM', 'LC_ALL'];

interface Running {
  child: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
}

const running = new Map<string, Running>();

export interface CliRunRequest {
  taskId: string;
  /** 绝对路径，调用方已用 resolveGrantedPath 校验过。 */
  cwd: string;
  /** 交给 CLI 的任务原文。 */
  task: string;
  timeoutMs: number;
}

export function cliAgentConfigError(config: CliAgentConfig | undefined): string | null {
  if (!config) return '没有这个 CLI Agent 配置';
  if (!config.enabled) return `CLI Agent「${config.label || config.id}」已在设置里关闭`;
  if (config.headless === 'unsupported') return `CLI Agent「${config.label}」不支持非交互执行`;
  if (config.headless !== 'verified') {
    return `CLI Agent「${config.label}」的非交互能力尚未实测（headless=unverified），不能启动；先跑它自己的帮助与最小任务，把结果记进注册表`;
  }
  if (!config.command.trim()) return 'CLI Agent 缺少可执行文件配置';
  if (!config.args.some(arg => arg.includes('{task}'))) return 'CLI Agent 参数模板里没有 {task} 占位符';
  return null;
}

function buildArgs(config: CliAgentConfig, task: string): string[] {
  const args = config.args.map(arg => arg.split('{task}').join(task));
  args.push(...(config.permissionArgs ?? []));
  return args;
}

function buildEnv(config: CliAgentConfig): NodeJS.ProcessEnv {
  const allowed = new Set([...BASE_ENV, ...(config.envAllowlist ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function trimTail(buffer: string, limit: number): string {
  return buffer.length > limit ? buffer.slice(buffer.length - limit) : buffer;
}

interface Capture {
  text: string;
  bytes: number;
  truncated: boolean;
}

function collector(limit: number): { push: (chunk: Buffer | string) => void; done: () => Capture } {
  let text = '';
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      bytes += Buffer.byteLength(value);
      text += value;
      if (text.length > limit) {
        text = text.slice(text.length - limit);
        truncated = true;
      }
    },
    done() {
      return { text, bytes, truncated };
    }
  };
}

interface WorkspaceSnapshot {
  git: boolean;
  head: string | null;
  /** path → `status|size|mtimeMs`。状态相同但内容变了的文件也能看出来。 */
  entries: Map<string, string>;
}

function runGit(cwd: string, args: string[]): string | null {
  const run = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  return run.status === 0 ? String(run.stdout) : null;
}

function snapshotWorkspace(cwd: string): WorkspaceSnapshot {
  const raw = runGit(cwd, ['status', '--porcelain=v1', '-z']);
  if (raw === null) return { git: false, head: null, entries: new Map() };
  const parts = raw.split('\0').filter(Boolean);
  const entries = new Map<string, string>();
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    let size = -1;
    let mtime = -1;
    try {
      const stat = fs.statSync(path.join(cwd, file));
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch {
      // 删除的文件 stat 不到，状态码本身已经说明它变了。
    }
    entries.set(file, `${status}|${size}|${mtime}`);
    // 重命名/复制会多带一条来源路径，它也是这次改动的一部分。
    if (status[0] === 'R' || status[0] === 'C') {
      const from = parts[index + 1];
      if (from) entries.set(from, `${status}|-1|-1`);
      index += 1;
    }
  }
  return { git: true, head: runGit(cwd, ['rev-parse', 'HEAD'])?.trim() ?? null, entries };
}

function changedPathsBetween(before: WorkspaceSnapshot, after: WorkspaceSnapshot, cwd: string): string[] {
  if (!before.git || !after.git) return [];
  const changed = new Set<string>();
  for (const [file, signature] of after.entries) {
    if (before.entries.get(file) !== signature) changed.add(file);
  }
  for (const file of before.entries.keys()) {
    if (!after.entries.has(file)) changed.add(file);
  }
  if (before.head && after.head && before.head !== after.head) {
    // CLI 自己提交了：把提交涉及的路径也算进来，否则报告会说「什么都没改」。
    const diff = runGit(cwd, ['diff', '--name-only', before.head, after.head]);
    for (const line of (diff ?? '').split('\n')) {
      if (line.trim()) changed.add(line.trim());
    }
  }
  return [...changed].sort();
}

/** 从 stdout 里找出 CLI 的结构化结果；找不到返回 null。 */
function parseResultJson(stdout: string): Record<string, unknown> | null {
  const whole = stdout.trim();
  if (whole) {
    try {
      const parsed = JSON.parse(whole) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 不是整段 JSON，继续按行找。
    }
  }
  const lines = whole.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function modelFrom(parsed: Record<string, unknown> | null): Omit<CliModelIdentity, 'cliId' | 'cliVersion'> {
  if (!parsed) {
    return { declaredModel: null, provider: null, provenance: 'unverified' };
  }
  const usage = parsed.modelUsage;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    // Qoder 的键是 auto / efficient，属于档位不是模型名；不能当模型身份。
    const names = Object.keys(usage as Record<string, unknown>).filter(
      key => key !== 'auto' && key !== 'efficient' && key !== 'default'
    );
    const declared = names[0] ?? null;
    const inner = declared ? (usage as Record<string, unknown>)[declared] : null;
    const provider =
      inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).provider === 'string'
        ? String((inner as Record<string, unknown>).provider)
        : null;
    return { declaredModel: declared, provider, provenance: declared ? 'native' : 'unverified' };
  }
  const model = typeof parsed.model === 'string' ? parsed.model : null;
  return { declaredModel: model, provider: null, provenance: model ? 'native' : 'unverified' };
}

function denialsFrom(parsed: Record<string, unknown> | null): string[] {
  const raw = parsed?.permission_denials;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
    .filter(item => item.length > 0)
    .slice(0, 20);
}

function terminate(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    // detached: true 让子进程自己成为进程组组长；负号才是「整棵树」。
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已经退出。
    }
  }
}

/** 用户取消任务：Runtime 收到 task.cancel 时调用。 */
export function cancelCliRuns(taskId: string): boolean {
  const entry = running.get(taskId);
  if (!entry) return false;
  entry.cancelled = true;
  terminate(entry.child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      terminate(entry.child, 'SIGKILL');
    }
  }, KILL_GRACE_MS);
  timer.unref?.();
  return true;
}

export function cancelAllCliRuns() {
  for (const [taskId] of running) cancelCliRuns(taskId);
}

export function runningCliTasks(): string[] {
  return [...running.keys()];
}

/**
 * 真正跑一次。Promise 一定在进程退出（或超时后被杀）后 resolve 一个结果；
 * 只有 spawn 本身失败才 reject。
 */
export function runCliAgent(config: CliAgentConfig, request: CliRunRequest): Promise<CliRunResult> {
  const configError = cliAgentConfigError(config);
  if (configError) return Promise.reject(new Error(configError));
  if (running.has(request.taskId)) {
    return Promise.reject(new Error(`任务 ${request.taskId} 已有一个外部 CLI 在执行`));
  }

  const before = snapshotWorkspace(request.cwd);
  const started = Date.now();
  const args = buildArgs(config, request.task);
  const env = buildEnv(config);
  const stdout = collector(MAX_CAPTURE_BYTES);
  const stderr = collector(MAX_CAPTURE_BYTES);

  return new Promise<CliRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(config.command, args, {
        cwd: request.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组：取消时打的是整棵树，不是只有 CLI 自己。
        detached: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    const entry: Running = { child, cancelled: false, timedOut: false };
    running.set(request.taskId, entry);

    let settled = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(request.taskId);
      const out = stdout.done();
      const err = stderr.done();
      const parsed = parseResultJson(out.text);
      const after = snapshotWorkspace(request.cwd);
      const model = modelFrom(parsed);
      const text =
        parsed && typeof parsed.result === 'string' ? parsed.result : trimTail(out.text, TAIL_CHARS);
      resolve({
        cli: config.id,
        exitCode,
        signal,
        timedOut: entry.timedOut,
        cancelled: entry.cancelled,
        durationMs: Date.now() - started,
        stdoutBytes: out.bytes,
        stderrBytes: err.bytes,
        stdoutTail: trimTail(out.text, TAIL_CHARS),
        stderrTail: trimTail(err.text, TAIL_CHARS),
        truncated: out.truncated || err.truncated,
        changedPaths: changedPathsBetween(before, after, request.cwd),
        text,
        model: {
          ...model,
          cliId: config.id,
          cliVersion: config.version ?? null,
          provenance: parsed ? model.provenance : 'unverified'
        },
        costUsd: parsed && typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
        sessionId: parsed && typeof parsed.session_id === 'string' ? parsed.session_id : null,
        permissionDenials: denialsFrom(parsed),
        terminalSessionId: null
      });
    };

    const timer = setTimeout(() => {
      entry.timedOut = true;
      terminate(child, 'SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) terminate(child, 'SIGKILL');
      }, KILL_GRACE_MS);
      force.unref?.();
      // 强杀后 child 的 exit 事件会来；这里不自己 resolve，避免与真实退出抢时序。
    }, Math.max(1000, Math.min(request.timeoutMs, 1_800_000)));

    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(request.taskId);
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

/** 让 `agent.exec` 即使在 cwd 被删除后也能给出可读错误。 */
export function assertUsableCwd(cwd: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error(`工作目录不存在：${cwd}`);
  }
  if (!stat.isDirectory()) throw new Error(`工作目录不是目录：${cwd}`);
  return path.resolve(cwd);
}
