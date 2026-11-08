/**
 * 打开应用 / 文件（真实启动，不是「建议用户去打开」）。
 *
 * 分工：
 * - `app`：启动一个 macOS 应用（`open -a`）。
 * - `path`：用默认应用打开文件或目录（`open <path>`）。
 *
 * 权限：
 * - `read-only` 拒绝——启动进程是副作用。
 * - `workspace-write`：只允许常见图形应用与工作区内文件。终端类应用不在
 *   白名单里：能开一个终端就等于绕过 `shell.run` 的白名单。
 * - `danger-full-access`：任意应用与路径。
 *
 * 验证：`open` 退出码为 0 只代表 LaunchServices 收下了请求。为了不把
 * 「命令没报错」当成「软件真的开了」，这里再回读一次进程表（pgrep），
 * 把 running / pid 一起写进结果。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

/** workspace-write 允许启动的应用（小写比较）。终端类刻意不在其中。 */
const SAFE_APPS = new Set([
  'textedit', 'preview', 'finder', 'safari', 'notes', 'calculator',
  'calendar', 'music', 'photos', 'maps', 'reminders', 'contacts',
  'system settings', 'activity monitor', 'font book', 'stickies'
]);

export interface AppOpenResult {
  opened: true;
  target: 'app' | 'path';
  app?: string;
  path?: string;
  exitCode: number | null;
  /** 进程是否真的在跑。`path` 打开时不做进程判断，返回 null。 */
  running: boolean | null;
  pid: number | null;
  verified: boolean;
  durationMs: number;
}

function openCommand(argv: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/open', argv, {
      shell: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', error => resolve({ code: null, stderr: error.message }));
    child.on('close', code => resolve({ code, stderr }));
  });
}

/** `pgrep -x <name>`：返回 pid 或 null。只用于"应用是否真的起来了"。 */
function findProcess(name: string): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn('pgrep', ['-x', name], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const pid = Number.parseInt(out.trim().split('\n')[0] ?? '', 10);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

function appBinaryName(app: string): string {
  const base = app.endsWith('.app') ? app.slice(0, -4) : app;
  return path.basename(base);
}

export async function openApp(
  grant: TaskGrant,
  args: { app?: string; path?: string }
): Promise<AppOpenResult> {
  if (grant.permissionPreset === 'read-only') {
    throw new Error('当前权限为“仅可查看”，禁止启动应用');
  }
  const hasApp = typeof args.app === 'string' && args.app.trim().length > 0;
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
  if (hasApp === hasPath) throw new Error('app 与 path 必须给出且只给出一个');

  if (grant.permissionPreset === 'workspace-write' && hasApp) {
    const name = (args.app ?? '').trim().toLowerCase();
    if (!SAFE_APPS.has(name)) {
      throw new Error(`workspace-write 只允许打开常见图形应用（${[...SAFE_APPS].slice(0, 6).join('、')} 等）；要打开「${args.app}」请使用完全权限`);
    }
  }

  const started = Date.now();
  if (hasApp) {
    const app = (args.app ?? '').trim();
    const run = await openCommand(['-a', app]);
    if (run.code !== 0) {
      throw new Error(`打开应用失败（退出码 ${String(run.code)}）：${run.stderr.trim() || app}`);
    }
    // LaunchServices 是异步的：给最多 2 秒让进程出现，再判定。
    const binary = appBinaryName(app);
    let pid: number | null = null;
    for (let i = 0; i < 10 && pid === null; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      pid = await findProcess(binary);
    }
    return {
      opened: true,
      target: 'app',
      app,
      exitCode: run.code,
      running: pid !== null,
      pid,
      verified: pid !== null,
      durationMs: Date.now() - started
    };
  }

  const target = await resolveGrantedPath(grant, args.path ?? '.', false);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error('要打开的文件或目录不存在');
  const run = await openCommand([target]);
  if (run.code !== 0) {
    throw new Error(`打开文件失败（退出码 ${String(run.code)}）：${run.stderr.trim() || target}`);
  }
  return {
    opened: true,
    target: 'path',
    path: target,
    exitCode: run.code,
    running: null,
    pid: null,
    verified: true,
    durationMs: Date.now() - started
  };
}
