/**
 * spawn 前置沙箱（对齐 harness 的 `packages/sandbox`：在 spawn 之前包 argv，
 * 而不是事后检查路径）。
 *
 * 为什么要在 spawn 之前包：路径校验只能约束**我们自己的**文件工具。命令一旦
 * 交给 `/bin/sh -c`，子进程能写哪里就与 grant 无关了——`find . -delete`、
 * `curl … | sh`、往 `~/.ssh` 写 key 都不经过 `resolveGrantedPath`。所以这里
 * 在进程启动前把它关进一个只能写授权目录的笼子里。
 *
 * 采用「默认放行、禁止一切写入、再逐个放开允许写的位置」：读全放开是刻意的。
 * 构建要读 `~/.npm/_cacache`、`/usr/local/lib/node_modules`、`/private/var/folders`
 * 这些工作区外的东西，逐个枚举读权限既写不全也维护不动，而「写到哪」才是
 * 真正会造成损失的维度。
 *
 * **探测是必须的，不是保险**。macOS 15 之后系统开始拒绝施加限制的 seatbelt
 * profile（`sandbox_apply: Operation not permitted`），只有纯 `(allow default)`
 * 能应用——那等于没沙箱。所以我们先真跑一次 canary，通过了才声称 sandboxed，
 * 否则如实返回 `sandboxed: false` 与原因。把「没能沙箱」说成「沙箱了」比
 * 不做沙箱更糟：用户会据此放松警惕。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SandboxKind = 'seatbelt' | 'none';

export interface SandboxPlan {
  /** 实际要执行的二进制（沙箱可用时是 sandbox-exec）。 */
  command: string;
  argv: string[];
  sandboxed: boolean;
  kind: SandboxKind;
  /** 没启用时说明原因，会进执行结果，用户能看到到底有没有关进笼子。 */
  reason: string;
  profile: string;
}

export interface SandboxOptions {
  /** 授权根目录：唯一允许写的地方。 */
  rootDir: string;
  /** 额外允许写的位置（如 `code.run` 的运行目录、作业日志目录）。 */
  extraWritable?: string[];
  /** 是否允许联网。默认允许——构建与测试需要。 */
  network?: boolean;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROBE_TIMEOUT_MS = 5000;

let probeCache: { ok: boolean; reason: string } | null = null;

/** SBPL 字符串转义：反斜杠与双引号。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 生成 seatbelt profile。
 *
 * `file-write*` 之后必须重新 allow 允许写的路径：SBPL 的规则是后写的覆盖先写的，
 * 顺序反过来就变成「全禁」。
 */
export function buildSeatbeltProfile(options: SandboxOptions): string {
  const writable = new Set<string>();
  writable.add(path.resolve(options.rootDir));
  for (const extra of options.extraWritable ?? []) {
    if (extra) writable.add(path.resolve(extra));
  }
  // 系统临时目录：很多构建工具会往这里写中间产物，禁掉会得到一堆莫名 EPERM。
  writable.add(os.tmpdir());
  writable.add('/private/tmp');
  writable.add('/private/var/folders');

  const allowWrite = [...writable]
    .map(dir => `  (subpath ${quote(dir)})`)
    // 写 /dev/null 不算写文件，但 node 的 stdout 重定向会走它。
    .concat(['  (literal "/dev/null")', '  (literal "/dev/stdout")', '  (literal "/dev/stderr")'])
    .join('\n');

  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write*\n${allowWrite}\n)`
  ];
  if (options.network === false) lines.push('(deny network*)');
  return lines.join('\n');
}

/**
 * 真跑一次 canary 判断这台机器能不能施加限制。
 *
 * 用「禁止写 `/tmp` 之外的任意位置」这种一定会被拒绝的 profile 去跑一次
 * `touch`：沙箱生效时它必然失败且退出码非 0；如果 sandbox_apply 本身被系统
 * 拒绝，stderr 里会出现 `Operation not permitted`。两种情况都会让探测失败，
 * 但原因不同，要分开报。
 */
export function probeSandbox(): { ok: boolean; reason: string } {
  if (probeCache) return probeCache;

  if (process.platform !== 'darwin') {
    probeCache = { ok: false, reason: `当前平台（${process.platform}）没有接沙箱后端，命令在授权目录外仍然可写` };
    return probeCache;
  }
  if (!fs.existsSync(SANDBOX_EXEC)) {
    probeCache = { ok: false, reason: '系统没有 sandbox-exec，无法在 spawn 前施加限制' };
    return probeCache;
  }

  const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-sbprobe-'));
  const profile = buildSeatbeltProfile({ rootDir: canaryDir });
  const probe = spawnSync(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', 'true'], {
    timeout: PROBE_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    fs.rmSync(canaryDir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响判断。
  }

  if (probe.error) {
    probeCache = { ok: false, reason: `沙箱探测失败：${probe.error.message}` };
    return probeCache;
  }
  if (probe.status !== 0) {
    const detail = `${probe.stderr ?? ''}`.trim().split('\n').pop() || `退出码 ${probe.status}`;
    probeCache = {
      ok: false,
      // 这里最常见的就是新版 macOS 拒绝施加限制，原样报出来，别让用户以为是别的问题。
      reason: `系统拒绝施加沙箱限制（${detail}），命令只能靠权限预设与路径校验约束`
    };
    return probeCache;
  }

  probeCache = { ok: true, reason: '沙箱可用' };
  return probeCache;
}

/** 供测试重置探测缓存。 */
export function resetSandboxProbe(): void {
  probeCache = null;
}

/** 沙箱可用时的 argv 拼装。单独一个函数，为了能在测试里核对顺序。 */
export function sandboxArgv(profile: string, command: string, argv: readonly string[]): string[] {
  // `-p` 直接给 profile 文本：不落临时文件，也就没有「profile 被人改写」这条口子。
  return ['-p', profile, command, ...argv];
}

/**
 * 把一条命令包进沙箱。
 *
 * 沙箱不可用时**原样返回**命令，并带上原因——不抛错。理由：沙箱是纵深防御，
 * 不是功能前提；因为系统不让沙箱就整个拒绝执行，等于把能干的活也一起关掉。
 * 但结果里一定写明没关进笼子，报告要能看出这一轮到底有没有隔离。
 */
export function wrapWithSandbox(
  command: string,
  argv: readonly string[],
  options: SandboxOptions
): SandboxPlan {
  const profile = buildSeatbeltProfile(options);
  const probe = probeSandbox();
  if (!probe.ok) {
    return {
      command,
      argv: [...argv],
      sandboxed: false,
      kind: 'none',
      reason: probe.reason,
      profile
    };
  }
  return {
    command: SANDBOX_EXEC,
    argv: sandboxArgv(profile, command, argv),
    sandboxed: true,
    kind: 'seatbelt',
    reason: 'sandbox-exec 生效，只能写授权目录与系统临时目录',
    profile
  };
}
