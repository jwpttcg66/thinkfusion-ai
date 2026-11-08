/**
 * 文本能力：比对两份文件、base64 编解码。
 *
 * `text.diff` 交给系统的 `diff -u`，不自己写 LCS：行差异算法在边界情况
 * （空白、行尾、二进制）上极容易和「人看到的不一样」，而 `diff` 的输出正好
 * 可以被 `fs.applyPatch` 直接吃下去——两步能接上才是这条链的价值。
 *
 * `text.base64` 用于「把一段二进制安全搬进上下文」和「把模型给的 base64 落盘」。
 * 编码读文件、解码可写文件（写盘属于改动，只读档位拒绝）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;

function assertMutable(grant: TaskGrant, action: string): void {
  if (grant.permissionPreset === 'read-only') {
    throw new Error(`当前权限为“仅可查看”，禁止${action}`);
  }
}

function run(file: string, argv: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, { cwd, shell: false, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_DIFF_BYTES) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function readableFile(target: string): Promise<Buffer> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('目标必须是普通文件');
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`文件超过 ${MAX_TEXT_BYTES} bytes 上限`);
  return fs.readFile(target);
}

export interface TextDiffResult {
  pathA: string;
  pathB: string;
  same: boolean;
  added: number;
  removed: number;
  truncated: boolean;
  text: string;
}

async function textDiff(grant: TaskGrant, args: { pathA: string; pathB: string }): Promise<TextDiffResult> {
  const a = await resolveGrantedPath(grant, args.pathA, false);
  const b = await resolveGrantedPath(grant, args.pathB, false);
  const run1 = await run('diff', ['-u', '--label', args.pathA, '--label', args.pathB, a, b], path.dirname(a));
  // diff 的退出码：0 相同、1 有差异、2 才是出错。把「有差异」当失败是最常见的错。
  if (run1.code === 2 || run1.code === null) {
    throw new Error(`diff 执行失败：${run1.stderr.trim() || '没有输出'}`);
  }
  const text = run1.stdout;
  const added = text.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = text.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return {
    pathA: a,
    pathB: b,
    same: run1.code === 0,
    added,
    removed,
    truncated: Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES,
    text
  };
}

export interface Base64Result {
  action: 'encode' | 'decode';
  source: string;
  bytes: number;
  encoded?: string;
  text?: string;
  written?: string;
}

async function textBase64(
  grant: TaskGrant,
  args: { action: 'encode' | 'decode'; path: string; output?: string }
): Promise<Base64Result> {
  const target = await resolveGrantedPath(grant, args.path, false);

  if (args.action === 'encode') {
    const buffer = await readableFile(target);
    return { action: 'encode', source: target, bytes: buffer.byteLength, encoded: buffer.toString('base64') };
  }

  const raw = (await readableFile(target)).toString('utf8').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('内容不是合法的 base64');
  const buffer = Buffer.from(raw, 'base64');

  if (!args.output) {
    return { action: 'decode', source: target, bytes: buffer.byteLength, text: buffer.toString('utf8') };
  }
  assertMutable(grant, '解码后写文件');
  const destination = await resolveGrantedPath(grant, args.output, true);
  const exists = await fs.lstat(destination).then(() => true).catch(() => false);
  if (exists) throw new Error('输出已存在，拒绝覆盖（先删除或换一个名字）');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, buffer);
  // 回读确认字节数：写了 0 字节也算失败，不能让调用方以为成功了。
  const after = await fs.lstat(destination);
  if (after.size !== buffer.byteLength) {
    throw new Error(`写入后大小不一致（期望 ${buffer.byteLength}，实际 ${after.size}）`);
  }
  return { action: 'decode', source: target, bytes: buffer.byteLength, written: destination };
}

export const textTools = { textDiff, textBase64 };
