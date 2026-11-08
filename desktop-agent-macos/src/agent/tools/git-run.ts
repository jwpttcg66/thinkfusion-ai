/**
 * 跑 git 的唯一入口：argv 逐个构造，**不拼 shell**。
 *
 * 从 `extended.ts` 里搬出来的：worktree、status、diff、log、show、stash、branch
 * 都要用同一套「30 秒超时、输出截断、非零退出码当事实」的规矩，各写一份就会
 * 一份限制宽一份限制严。
 *
 * 环境只给 `PATH` 与 `HOME`：`GIT_DIR` / `GIT_WORK_TREE` 这类变量能把命令指到
 * 授权目录之外，不能从父进程继承。
 */

import { spawn } from 'node:child_process';

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const GIT_MAX_OUTPUT = 64 * 1024;

export function runGit(cwd: string, argv: string[], timeoutMs = 30_000): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, GIT_MAX_OUTPUT); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 16 * 1024); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr }); });
  });
}

/** 允许出现在命令里的引用名：不能以 `-` 开头，否则会被当成选项。 */
const SAFE_REF = /^[A-Za-z0-9_@][A-Za-z0-9._/@~^-]{0,159}$/;

export function assertSafeRef(value: string, what: string): string {
  const text = value.trim();
  if (!text || text.startsWith('-') || !SAFE_REF.test(text)) {
    throw new Error(`${what}不合法：只接受普通提交/分支名，且不能以 - 开头`);
  }
  return text;
}

/** 失败就把 git 自己的话带出去——「没仓库」和「参数错」必须分得开。 */
export function gitFailure(action: string, run: GitRunResult): Error {
  const detail = run.stderr.trim() || run.stdout.trim() || '没有输出';
  return new Error(`git ${action} 失败（退出码 ${run.exitCode}）：${detail}`);
}
