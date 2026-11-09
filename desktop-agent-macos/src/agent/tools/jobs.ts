/**
 * 后台作业（对齐 DSH 的 `run_in_background` + `job_*`）。
 *
 * 没有后台作业，模型只能等命令跑完：一个 `npm run dev` 或长轮询会把整轮
 * 卡到超时。这里把长命令放到独立进程组，输出直接写日志文件，模型随后用
 * `job.output` 读、`job.kill` 停。
 *
 * 元数据落盘（`~/Library/Application Support/ThinkFusion/jobs/<id>.json`），
 * 因为 Runtime 是按任务启动的 UtilityProcess：内存里的作业表活不过一次
 * 任务切换，磁盘上的不会。`job.list` 每次都重新探活，不靠写死的 status。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskGrant } from '../../shared/contracts';
import { wrapWithSandbox } from './sandbox';

export const JOBS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ThinkFusion', 'jobs');
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface JobMeta {
  id: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: number;
  logPath: string;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  finishedAt: number | null;
  /** 这一轮有没有真被关进沙箱；后台作业同样不许含糊。 */
  sandboxed?: boolean;
  sandboxReason?: string;
}

function metaPath(id: string) {
  return path.join(JOBS_DIR, `${id}.json`);
}

/** 只接受本模块生成的 id，避免用 `../` 读到别处。 */
function assertJobId(id: string) {
  if (!/^job-[a-z0-9-]{6,80}$/.test(id)) throw new Error('任务 id 格式不正确');
}

export async function startJob(
  grant: TaskGrant,
  args: { command: string; cwd?: string }
): Promise<JobMeta> {
  await fs.mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
  const id = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const logPath = path.join(JOBS_DIR, `${id}.log`);
  // 后台作业的进程活得更久，更需要笼子：它不受 30 秒超时约束，能一直写下去。
  // 日志目录作为额外可写位置放进去，作业自己要写盘时不会被自己的日志路径挡住。
  const sandbox = wrapWithSandbox('/bin/sh', ['-c', args.command], {
    rootDir: grant.rootDir,
    extraWritable: [JOBS_DIR]
  });
  const meta: JobMeta = {
    id,
    command: args.command,
    cwd: args.cwd ?? grant.rootDir,
    pid: null,
    startedAt: Date.now(),
    logPath,
    status: 'running',
    exitCode: null,
    finishedAt: null,
    sandboxed: sandbox.sandboxed,
    sandboxReason: sandbox.reason
  };

  const handle = await fs.open(logPath, 'a', 0o600);
  const child = spawn(sandbox.command, sandbox.argv, {
    cwd: meta.cwd,
    shell: false,
    detached: true,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
      HOME: process.env.HOME ?? '',
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      CI: '1',
      NO_COLOR: '1'
    },
    stdio: ['ignore', handle.fd, handle.fd]
  });
  child.unref();
  await handle.close().catch(() => undefined);

  meta.pid = child.pid ?? null;
  child.on('exit', code => {
    // 记录退出码，但进程可能比 Runtime 活得久，所以以磁盘为准。
    void updateMeta(id, { status: 'exited', exitCode: code, finishedAt: Date.now() });
  }).on('error', () => {
    void updateMeta(id, { status: 'exited', exitCode: null, finishedAt: Date.now() });
  });

  await fs.writeFile(metaPath(id), JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

async function updateMeta(id: string, patch: Partial<JobMeta>): Promise<void> {
  try {
    const current = JSON.parse(await fs.readFile(metaPath(id), 'utf8')) as JobMeta;
    const next = { ...current, ...patch };
    await fs.writeFile(metaPath(id), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    // 作业目录被清掉、或进程退出时文件已不存在：不影响主流程。
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function listJobs(): Promise<JobMeta[]> {
  const names = await fs.readdir(JOBS_DIR).catch(() => [] as string[]);
  const jobs: JobMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(JOBS_DIR, name), 'utf8')) as JobMeta;
      const running = meta.status === 'running' && alive(meta.pid);
      if (meta.status === 'running' && !running) {
        meta.status = 'exited';
        meta.finishedAt = meta.finishedAt ?? Date.now();
        await updateMeta(meta.id, { status: 'exited', finishedAt: meta.finishedAt });
      }
      jobs.push({ ...meta, status: running ? 'running' : meta.status });
    } catch {
      continue;
    }
  }
  return jobs.sort((a, b) => b.startedAt - a.startedAt);
}

export async function jobOutput(args: { id: string; tailBytes?: number }) {
  assertJobId(args.id);
  const meta = JSON.parse(await fs.readFile(metaPath(args.id), 'utf8')) as JobMeta;
  await trimJobLog(meta.logPath).catch(() => undefined);
  const stat = await fs.stat(meta.logPath).catch(() => null);
  if (!stat) throw new Error('这个作业没有输出文件');
  const tail = Math.min(args.tailBytes ?? 32 * 1024, 262_144);
  const start = Math.max(0, stat.size - tail);
  const handle = await fs.open(meta.logPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(tail, stat.size));
    await handle.read(buffer, 0, buffer.length, start);
    return {
      id: meta.id,
      command: meta.command,
      status: meta.status,
      running: meta.status === 'running' && alive(meta.pid),
      pid: meta.pid,
      bytes: stat.size,
      truncated: start > 0,
      output: buffer.toString('utf8')
    };
  } finally {
    await handle.close();
  }
}

export async function killJob(args: { id: string; signal?: 'TERM' | 'KILL' }) {
  assertJobId(args.id);
  const meta = JSON.parse(await fs.readFile(metaPath(args.id), 'utf8')) as JobMeta;
  if (!meta.pid) throw new Error('这个作业没有记录到 pid');
  const signal = args.signal ?? 'TERM';
  let delivered = false;
  try {
    process.kill(-meta.pid, signal);
    delivered = true;
  } catch {
    try {
      process.kill(meta.pid, signal);
      delivered = true;
    } catch {
      delivered = false;
    }
  }
  if (!delivered && !alive(meta.pid)) {
    throw new Error('进程已经退出');
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  const running = alive(meta.pid);
  await updateMeta(meta.id, { status: running ? 'running' : 'killed', finishedAt: Date.now() });
  return { id: meta.id, signal, delivered, pid: meta.pid, stillRunning: running };
}

/** 日志超过上限时截断，避免长期运行的作业把磁盘写满。 */
export async function trimJobLog(logPath: string) {
  const stat = await fs.stat(logPath).catch(() => null);
  if (!stat || stat.size <= MAX_LOG_BYTES) return;
  const handle = await fs.open(logPath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_LOG_BYTES / 2);
    await handle.read(buffer, 0, buffer.length, stat.size - buffer.length);
    await fs.writeFile(logPath, buffer);
  } finally {
    await handle.close();
  }
}
