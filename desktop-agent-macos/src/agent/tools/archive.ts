/**
 * 压缩包：看目录、解压、打包。
 *
 * 为什么不让模型 `shell.run unzip`：workspace-write 下 shell 白名单只放行只读
 * 子命令，而解压/打包都要写盘；更重要的是 **zip-slip**——一个条目名叫
 * `../../.ssh/authorized_keys` 就能把文件写到授权目录之外。这里在解压前先把
 * 条目名读出来，发现绝对路径或 `..` 就整包拒绝，再交给 `unzip` / `tar`。
 *
 * 支持 zip 与 tar.gz/tgz；其它格式明确说不支持，而不是猜。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

const MAX_ENTRIES = 5000;
const ARCHIVE_EXT = ['.zip', '.tar.gz', '.tgz'];

function assertMutable(grant: TaskGrant, action: string): void {
  if (grant.permissionPreset === 'read-only') {
    throw new Error(`当前权限为“仅可查看”，禁止${action}`);
  }
}

function run(file: string, argv: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, { cwd, shell: false, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', chunk => { if (stdout.length < 256 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function kindOf(file: string): 'zip' | 'tar' {
  const lower = file.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar';
  throw new Error(`不支持的压缩格式（只支持 ${ARCHIVE_EXT.join(' / ')}）`);
}

async function listEntries(file: string): Promise<string[]> {
  const kind = kindOf(file);
  const dir = path.dirname(file);
  const run1 = kind === 'zip'
    ? await run('unzip', ['-Z1', file], dir)
    : await run('tar', ['-tzf', file], dir);
  if (run1.code !== 0) throw new Error(`读取压缩包失败：${run1.stderr.trim() || '没有输出'}`);
  return run1.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

/** 条目名只要出现绝对路径或 `..` 就整包拒绝：这是 zip-slip 的唯一入口。 */
function assertSafeEntries(entries: string[]): void {
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`压缩包里有绝对路径条目（${entry}），拒绝解压`);
    }
    if (normalized.split('/').some(part => part === '..')) {
      throw new Error(`压缩包里有越界条目（${entry}），拒绝解压`);
    }
  }
}

export interface ArchiveListResult {
  path: string;
  kind: 'zip' | 'tar';
  entries: number;
  truncated: boolean;
  names: string[];
}

async function archiveList(grant: TaskGrant, args: { path: string; maxEntries?: number }): Promise<ArchiveListResult> {
  const target = await resolveGrantedPath(grant, args.path, false);
  const all = await listEntries(target);
  const limit = Math.min(Math.max(args.maxEntries ?? 200, 1), MAX_ENTRIES);
  return {
    path: target,
    kind: kindOf(target),
    entries: all.length,
    truncated: all.length > limit,
    names: all.slice(0, limit)
  };
}

export interface ArchiveExtractResult {
  path: string;
  destination: string;
  entries: number;
  exitCode: number;
}

async function archiveExtract(
  grant: TaskGrant,
  args: { path: string; destination?: string }
): Promise<ArchiveExtractResult> {
  assertMutable(grant, '解压文件');
  const target = await resolveGrantedPath(grant, args.path, false);
  const destination = await resolveGrantedPath(grant, args.destination ?? 'extracted', true);
  await fs.mkdir(destination, { recursive: true });

  const entries = await listEntries(target);
  assertSafeEntries(entries);

  const kind = kindOf(target);
  const result = kind === 'zip'
    ? await run('unzip', ['-o', '-qq', target, '-d', destination], path.dirname(target))
    : await run('tar', ['-xzf', target, '-C', destination], path.dirname(target));
  if (result.code !== 0) throw new Error(`解压失败：${result.stderr.trim() || '没有输出'}`);

  return { path: target, destination, entries: entries.length, exitCode: result.code ?? 0 };
}

export interface ArchiveCreateResult {
  output: string;
  sources: string[];
  entries: number;
  bytes: number;
}

async function archiveCreate(
  grant: TaskGrant,
  args: { output: string; sources: string[] }
): Promise<ArchiveCreateResult> {
  assertMutable(grant, '打包文件');
  const output = await resolveGrantedPath(grant, args.output, true);
  if (!args.sources || args.sources.length === 0) throw new Error('sources 不能为空');
  kindOf(output); // 只接受 .zip / .tar.gz / .tgz，其余在这里就报错

  // 已存在的包不覆盖：覆盖会把上一次的结果悄悄换掉，调用方还以为只是追加。
  try {
    await fs.lstat(output);
    throw new Error('输出文件已存在，先删掉或换个名字');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const resolved: string[] = [];
  for (const source of args.sources) {
    resolved.push(await resolveGrantedPath(grant, source, false));
  }
  const cwd = await resolveGrantedPath(grant, '.', false);
  const relatives = resolved.map(item => {
    const relative = path.relative(cwd, item);
    if (relative.startsWith('..')) throw new Error('sources 必须在授权目录内');
    return relative || '.';
  });

  const kind = kindOf(output);
  const result = kind === 'zip'
    ? await run('zip', ['-r', '-q', '-X', output, ...relatives], cwd)
    : await run('tar', ['-czf', output, ...relatives], cwd);
  if (result.code !== 0) throw new Error(`打包失败：${result.stderr.trim() || '没有输出'}`);

  const entries = await listEntries(output);
  const stat = await fs.stat(output);
  return { output, sources: relatives, entries: entries.length, bytes: stat.size };
}

export const archiveTools = {
  archiveList,
  archiveExtract,
  archiveCreate
};

/** 供测试：越界条目判定逻辑单独可用，不必真造一个恶意压缩包。 */
export { assertSafeEntries as assertSafeArchiveEntries };
