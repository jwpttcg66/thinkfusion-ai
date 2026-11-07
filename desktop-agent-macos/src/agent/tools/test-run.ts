/**
 * V2.1 Phase F：真实执行测试，把结果写回执行报告。
 *
 * 模型不能自称「测试通过」——它得给出真实命令、工作目录、退出码、输出和
 * 耗时。所以这里不解析任意命令行，只认一份固定映射：命令字符串 → argv。
 * 没有 shell、没有管道、没有参数插值，模型输出永远变不成系统指令。
 *
 * 边界：
 * - 命令在授权根目录里跑（cwd = realpath(rootDir)）；
 * - 固定白名单，参数写死；
 * - 环境变量只带运行所需的最小集合，不带 API Key；
 * - 输出与时长都有上限，超时杀掉整个进程组；
 * - 不把非零退出码吞掉，如实返回 `exitCode`。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { TEST_COMMANDS, type TaskGrant, type TestCommand } from '../../shared/contracts';

const ARGV: Record<TestCommand, string[]> = {
  'npm test': ['npm', 'test'],
  'npm run typecheck': ['npm', 'run', 'typecheck'],
  'npm run build': ['npm', 'run', 'build'],
  'npm run build:agent': ['npm', 'run', 'build:agent'],
  'npm run test:protocol': ['npm', 'run', 'test:protocol']
};

const MAX_OUTPUT = 64 * 1024;
const MAX_DURATION_MS = 120_000;

export interface TestRunResult {
  command: TestCommand;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export async function runTest(grant: TaskGrant, args: { command: string }): Promise<TestRunResult> {
  if (!TEST_COMMANDS.includes(args.command as TestCommand)) {
    throw new Error(`不在允许的命令清单里：${args.command}`);
  }
  const command = args.command as TestCommand;
  const cwd = await fs.realpath(grant.rootDir);
  // 没有 package.json 的目录里跑 npm 只会得到一串无意义的报错，先说清楚。
  await fs.stat(`${cwd}/package.json`).catch(() => {
    throw new Error('授权目录里没有 package.json，无法运行测试命令');
  });

  const started = Date.now();
  const child = spawn(ARGV[command][0], ARGV[command].slice(1), {
    cwd,
    shell: false,
    detached: true,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      HOME: process.env.HOME ?? '',
      LANG: 'en_US.UTF-8',
      CI: '1',
      FORCE_COLOR: '0',
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
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
  }, MAX_DURATION_MS);

  const exitCode = await new Promise<number | null>(resolve => {
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code));
  });
  clearTimeout(timer);

  return {
    command,
    cwd,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
    truncated
  };
}
