/**
 * 跑一段代码（对齐 DSH 的 `run_code` 用途：写完立刻验证，而不是让用户自己去跑）。
 *
 * 为什么不直接用 `shell.run`：
 * - `workspace-write` 下 shell 只放行只读与构建命令，`node -e '…'` 会被拒——
 *   这正是最常用的「试一下这段代码」；
 * - `shell.run` 的 command 是一整行，模型容易把代码和命令混在一行里，转义一错
 *   就变成另一段程序；这里代码走 stdin 落成文件，命令行只有解释器与文件路径，
 *   引号、`$`、反引号都不参与解析；
 * - 脚本落盘之后是可审计的：出了什么问题，文件还在，能打开看。
 *
 * 边界：三种语言、30 秒默认超时、64 KiB 输出、`shell:false`、
 * `HOME`/`TMPDIR` 都指向工作区内的临时目录（脚本不该往用户家目录写东西）。
 * 完全权限下也不取消这些，因为它们是「让结果可读」而不是「限制能力」。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { TaskGrant } from '../../shared/contracts';
import { CODE_LANGUAGES, type CodeLanguage } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';
import { wrapWithSandbox } from './sandbox';

const MAX_OUTPUT = 64 * 1024;
const MAX_CODE = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
/** 历次运行的脚本保留最近这么多份，避免工作区被临时文件塞满。 */
const KEEP_RUNS = 30;

export { CODE_LANGUAGES };
export type { CodeLanguage };

const SPEC: Record<CodeLanguage, { ext: string; bin: string; argv: (file: string) => string[] }> = {
  node: { ext: 'mjs', bin: 'node', argv: file => [file] },
  python3: { ext: 'py', bin: 'python3', argv: file => ['-u', file] },
  bash: { ext: 'sh', bin: '/bin/bash', argv: file => [file] }
};

export interface CodeRunResult {
  language: CodeLanguage;
  /** 脚本落盘位置（相对工作区），报告里给出，便于人复核。 */
  scriptPath: string;
  scriptSource: string;
  cwd: string;
  sandboxed: boolean;
  sandboxReason: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export async function runCode(
  grant: TaskGrant,
  args: { language: CodeLanguage; code: string; timeoutMs?: number; cwd?: string }
): Promise<CodeRunResult> {
  if (grant.permissionPreset === 'read-only') {
    throw new Error('当前权限为「仅可查看」，不能执行代码');
  }
  const spec = SPEC[args.language];
  if (!spec) throw new Error(`不支持的语言：${String(args.language)}`);
  if (!args.code.trim()) throw new Error('代码为空');
  if (args.code.length > MAX_CODE) throw new Error(`代码超过 ${MAX_CODE} 字符上限`);

  const runDir = await resolveGrantedPath(grant, '.thinkfusion/tmp', true);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const dir = path.join(runDir, `run-${stamp}-${randomBytes(3).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const file = path.join(dir, `main.${spec.ext}`);
  await fs.writeFile(file, args.code, 'utf8');

  // 脚本自己的工作目录：默认就是它所在的那一份运行目录，避免误改项目文件；
  // 需要读写项目时在代码里用相对路径向上走，或显式传 cwd。
  const cwd = args.cwd ? await resolveGrantedPath(grant, args.cwd, true) : dir;
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const started = Date.now();

  // 这段代码是模型写的，比构建命令更该关进笼子：它能干的只有跑一次、看结果。
  const sandbox = wrapWithSandbox(spec.bin, spec.argv(file), { rootDir: grant.rootDir });

  const result = await new Promise<{ code: number | null; out: string; err: string; timedOut: boolean; truncated: boolean }>(
    resolve => {
      const child = spawn(sandbox.command, sandbox.argv, {
        cwd,
        shell: false,
        // 最小环境：不带用户 token、不带 npm 配置；HOME 指向运行目录，
        // 这样脚本里的 ~ 不会写到真实家目录。
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          HOME: dir,
          TMPDIR: path.join(dir, 'tmp'),
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1',
          NO_COLOR: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });

      let out = '';
      let err = '';
      let truncated = false;
      const take = (chunk: Buffer, toErr: boolean) => {
        const text = chunk.toString('utf8');
        if (toErr) {
          if (err.length < MAX_OUTPUT) err += text;
          else truncated = true;
        } else if (out.length < MAX_OUTPUT) out += text;
        else truncated = true;
      };
      child.stdout?.on('data', (chunk: Buffer) => take(chunk, false));
      child.stderr?.on('data', (chunk: Buffer) => take(chunk, true));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // 杀整个进程组：单杀解释器会留下它 spawn 的子进程。
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);

      child.on('error', error => {
        clearTimeout(timer);
        resolve({ code: null, out, err: `${err}${error.message}`, timedOut, truncated });
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ code, out, err, timedOut, truncated });
      });
    }
  );

  await pruneOldRuns(runDir);

  // 报告里的路径要能直接看懂。`/tmp` 在 macOS 上是 `/private/tmp` 的软链，
  // 拿原始 rootDir 去算相对路径会得到一个 `../../../private/tmp/...` 的怪东西；
  // 两边都 realpath 之后再算，算不出来（比如 rootDir 本身就是软链）就给绝对路径。
  let scriptPath = file;
  try {
    const realRoot = await fs.realpath(grant.rootDir);
    const relative = path.relative(realRoot, file);
    if (relative && !relative.startsWith('..')) scriptPath = relative;
  } catch {
    // 保留绝对路径。
  }

  return {
    language: args.language,
    scriptPath,
    scriptSource: args.code,
    cwd,
    sandboxed: sandbox.sandboxed,
    sandboxReason: sandbox.reason,
    exitCode: result.code,
    stdout: result.out,
    stderr: result.err,
    durationMs: Date.now() - started,
    timedOut: result.timedOut,
    truncated: result.truncated
  };
}

/** 只保留最近若干次运行；删不掉也不影响本次结果。 */
async function pruneOldRuns(runDir: string): Promise<void> {
  try {
    const entries = (await fs.readdir(runDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith('run-'))
      .map(entry => entry.name)
      .sort();
    const extra = entries.slice(0, Math.max(0, entries.length - KEEP_RUNS));
    for (const name of extra) {
      await fs.rm(path.join(runDir, name), { recursive: true, force: true });
    }
  } catch {
    // 清理是卫生，不是正确性。
  }
}
