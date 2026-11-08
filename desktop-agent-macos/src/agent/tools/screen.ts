/**
 * 真实截屏。
 *
 * 为什么不让模型「描述一张截图」：那只是又一段文字。用户要的是能落到磁盘、
 * 能打开、能证明「这一刻屏幕上确实是这样」的证据。所以这里直接调系统的
 * `screencapture`，把结果写成 PNG，再回读尺寸与指纹。
 *
 * 边界：
 * - `read-only` 拒绝——截屏会读取整块屏幕，不能算「只看工作区」。
 * - 输出路径受授权约束；不给路径时落在应用缓存目录，不污染工程。
 * - 文件必须真的存在且非空，否则如实报错（最常见的原因是没给应用
 *   「屏幕录制」权限，macOS 会让 screencapture 失败或产出空图）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

const CAPTURE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ThinkFusion', 'captures');
const CAPTURE_TIMEOUT_MS = 20_000;

export interface ScreenCaptureResult {
  path: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  target: 'screen' | 'region';
  capturedAt: number;
  durationMs: number;
}

/** 从 PNG 的 IHDR 读宽高，避免为了两个数字引入图像库。 */
function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function runScreencapture(argv: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('/usr/sbin/screencapture', argv, {
      shell: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
    }, CAPTURE_TIMEOUT_MS);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ code: null, stderr: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

export async function captureScreen(
  grant: TaskGrant,
  args: {
    target?: 'screen' | 'region';
    region?: { x: number; y: number; width: number; height: number };
    path?: string;
  }
): Promise<ScreenCaptureResult> {
  if (grant.permissionPreset === 'read-only') {
    throw new Error('当前权限为“仅可查看”，禁止截屏');
  }
  const target = args.target ?? 'screen';
  if (target === 'region' && !args.region) throw new Error('target=region 时必须给出 region');
  if (args.region && (args.region.width <= 0 || args.region.height <= 0)) throw new Error('region 的宽高必须大于 0');

  const outPath = args.path
    ? await resolveGrantedPath(grant, args.path, true)
    : path.join(CAPTURE_DIR, `capture-${Date.now()}.png`);
  await fs.mkdir(path.dirname(outPath), { recursive: true, mode: 0o700 });

  const argv = ['-x', '-t', 'png'];
  if (target === 'region' && args.region) {
    const { x, y, width, height } = args.region;
    argv.push('-R', `${x},${y},${width},${height}`);
  }
  argv.push(outPath);

  const started = Date.now();
  const run = await runScreencapture(argv);
  const durationMs = Date.now() - started;

  if (run.code !== 0) {
    const hint = /permission|not authorized|cannot|could not/i.test(run.stderr)
      ? '（可能缺少「屏幕录制」权限：系统设置 → 隐私与安全性 → 屏幕录制，勾选 ThinkFusion 后重启应用）'
      : '';
    throw new Error(`截屏失败，退出码 ${String(run.code)}${run.stderr ? `：${run.stderr.trim()}` : ''}${hint}`);
  }

  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('截屏命令返回成功，但没有生成文件');
  if (stat.size === 0) {
    throw new Error('截图文件是空的——通常是没有授予「屏幕录制」权限，请在系统设置里允许后重试');
  }

  const buffer = await fs.readFile(outPath);
  const size = pngSize(buffer);
  if (!size) throw new Error('生成的文件不是有效的 PNG（可能被系统拦截）');

  return {
    path: outPath,
    bytes: stat.size,
    width: size.width,
    height: size.height,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    target,
    capturedAt: Date.now(),
    durationMs
  };
}
