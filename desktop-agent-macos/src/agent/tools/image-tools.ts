/**
 * 图片缩放：交给系统自带的 `sips`。
 *
 * 为什么不是装 sharp / jimp：这是本地 harness，多一个原生二进制就多一份
 * 「装不上/架构不对」的故障面，而 `sips` 在每一台 macOS 上都在。代价是只能
 * 做缩放与格式转换，不做裁剪滤镜——够用，且行为可预测。
 *
 * 注意 `sips -z` 的参数顺序是 **高 宽**（不是宽 高），这一处写反不会报错，
 * 只会把图拉变形，所以代码里显式换序并写清楚。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

const MAX_DIMENSION = 8192;

function assertMutable(grant: TaskGrant, action: string): void {
  if (grant.permissionPreset === 'read-only') {
    throw new Error(`当前权限为“仅可查看”，禁止${action}`);
  }
}

function run(file: string, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, argv, { shell: false, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function dimensions(file: string): Promise<{ width: number; height: number }> {
  const result = await run('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  if (result.code !== 0) throw new Error(`读取图片尺寸失败：${result.stderr.trim() || '没有输出'}`);
  const width = Number(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1] ?? 0);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1] ?? 0);
  if (!width || !height) throw new Error('读不到图片尺寸，可能不是支持的图片格式');
  return { width, height };
}

export interface ResizeResult {
  source: string;
  output: string;
  from: { width: number; height: number };
  to: { width: number; height: number };
  bytes: number;
  format: string;
}

async function imageResize(
  grant: TaskGrant,
  args: { path: string; output: string; maxDimension?: number; width?: number; height?: number; format?: 'jpeg' | 'png' }
): Promise<ResizeResult> {
  assertMutable(grant, '缩放图片');
  const source = await resolveGrantedPath(grant, args.path, false);
  const output = await resolveGrantedPath(grant, args.output, true);
  if (source === output) throw new Error('输出不能和原图同一个路径（会覆盖原图）');

  const exists = await fs.lstat(output).then(() => true).catch(() => false);
  if (exists) throw new Error('输出已存在，拒绝覆盖（先删除或换一个名字）');

  const from = await dimensions(source);
  const argv = ['-s', 'format', args.format ?? (path.extname(output).toLowerCase() === '.png' ? 'png' : 'jpeg')];

  if (args.width && args.height) {
    const width = Math.min(Math.trunc(args.width), MAX_DIMENSION);
    const height = Math.min(Math.trunc(args.height), MAX_DIMENSION);
    if (width < 1 || height < 1) throw new Error('width / height 必须是正整数');
    // -z 的顺序是 高 宽。
    argv.push('-z', String(height), String(width));
  } else {
    const max = Math.min(Math.trunc(args.maxDimension ?? 1600), MAX_DIMENSION);
    if (max < 1) throw new Error('maxDimension 必须是正整数');
    // -Z 按长边等比缩放，不改变宽高比。
    argv.push('-Z', String(max));
  }

  argv.push(source, '--out', output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const result = await run('/usr/bin/sips', argv);
  if (result.code !== 0) throw new Error(`缩放失败：${result.stderr.trim() || '没有输出'}`);

  const stat = await fs.lstat(output);
  const to = await dimensions(output);
  return {
    source,
    output,
    from,
    to,
    bytes: stat.size,
    format: args.format ?? (path.extname(output).toLowerCase() === '.png' ? 'png' : 'jpeg')
  };
}

export const imageTools = { imageResize };
