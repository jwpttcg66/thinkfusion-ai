/**
 * 文件系统的其余本地能力：元数据、字面量编辑、移动、复制、删除、读图。
 *
 * 为什么不能只有 readFile / writeFile：
 * - 改一行要重写整个文件，模型的输出量与出错面都被放大；`fs.edit` 对齐
 *   DSH 的 `edit`：给唯一字面量就替换，出现多次直接拒绝，不会"猜你要改哪一处"。
 * - 没有移动/复制/删除，等于把一个文件管理器降级成只能新建文件。
 * - 读图不是"看看文件名"：返回尺寸、指纹和 base64，才能确认拿到的是哪张图。
 *
 * 删除的默认语义是**移入废纸篓**，不是 unlink。真正不可恢复的删除只有
 * `danger-full-access` 下的 `permanent: true` 才能触发。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';
import { withFileLock } from './file-lock';

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const TRASH_DIR = path.join(os.homedir(), '.Trash');

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 全角/弯引号、长短破折号、不换行空格 → ASCII。
 *
 * 这个替换是逐字符 1:1 的，所以归一化后的下标可以安全地映射回原文；
 * 不会为了匹配一处而把整份文件的标点改掉。
 */
function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ');
}

/** 从后往前按命中位置替换，保证下标不漂移；返回 null 表示一处都没命中。 */
function replaceMatches(
  content: string,
  needle: string,
  replacement: string,
  all: boolean
): { next: string; count: number } | null {
  const haystack = normalizeTypography(content);
  const target = normalizeTypography(needle);
  if (target.length === 0) return null;
  const hits: number[] = [];
  let at = 0;
  while (true) {
    const index = haystack.indexOf(target, at);
    if (index === -1) break;
    hits.push(index);
    at = index + target.length;
    if (!all) break;
  }
  if (hits.length === 0) return null;
  let next = content;
  for (const index of [...hits].reverse()) {
    next = next.slice(0, index) + replacement + next.slice(index + target.length);
  }
  return { next, count: hits.length };
}

/** 修改已有文件前必须证明「读到的那一版」；缺失时明确报 OBSERVATION_REQUIRED。 */
function requireExpectedHash(expected: string | undefined): string {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(
      'OBSERVATION_REQUIRED：修改已有文件前先 fs.readFile / fs.stat 拿到 sha256，并在 expectedHash 里回填'
    );
  }
  return expected;
}

function assertMutable(grant: TaskGrant, action: string) {
  if (grant.permissionPreset === 'read-only') {
    throw new Error(`当前权限为“仅可查看”，禁止${action}`);
  }
}

export interface StatResult {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  bytes: number;
  mode: string;
  mtimeMs: number;
  sha256?: string;
  /** 文本文件的总行数；二进制或大文件不填（问「多少行」时直接引这里）。 */
  lines?: number;
}

export interface EditResult {
  path: string;
  replaced: number;
  previousSha256: string;
  sha256: string;
  bytes: number;
  /** 改之前/之后的字面量（截断），给界面画 diff 卡。 */
  before: string;
  after: string;
}

export interface RemoveResult {
  path: string;
  trashed: boolean;
  trashPath?: string;
  deleted: boolean;
}

/** PNG / JPEG / GIF 的尺寸；WebP 与其它格式返回 null，但仍然给出字节与指纹。 */
function imageSize(buffer: Buffer, ext: string): { width: number; height: number } | null {
  if (ext === '.png' && buffer.length > 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (ext === '.gif' && buffer.length > 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export const fsExtraTools = {
  async stat(grant: TaskGrant, args: { path: string }): Promise<StatResult> {
    const target = await resolveGrantedPath(grant, args.path, false);
    const stat = await fs.lstat(target);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    const result: StatResult = {
      path: target,
      type,
      bytes: stat.size,
      mode: `0o${(stat.mode & 0o777).toString(8)}`,
      mtimeMs: stat.mtimeMs
    };
    // 小文本文件顺带给出指纹与总行数，省一轮 readFile；行数按整份文件算，
    // 末尾换行不算一行（和 fs.readFile 的 totalLines 同口径）。
    if (type === 'file' && stat.size <= 262_144) {
      const buffer = await fs.readFile(target);
      const binary = buffer.includes(0);
      result.sha256 = binary ? sha256(buffer) : sha256(buffer.toString('utf8'));
      if (!binary) {
        const text = buffer.toString('utf8');
        const parts = text.split('\n');
        if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
        result.lines = parts.length;
      }
    }
    return result;
  },

  /**
   * 唯一字面量替换。`replaceAll` 为 false（默认）时，`oldString` 必须恰好出现
   * 一次——出现两次说明计划里没写清要改哪一处，这时替换任何一处都是猜。
   */
  async edit(
    grant: TaskGrant,
    args: { path: string; oldString: string; newString: string; replaceAll?: boolean; expectedHash?: string }
  ): Promise<EditResult> {
    assertMutable(grant, '编辑文件');
    const expectedHash = requireExpectedHash(args.expectedHash);
    const target = await resolveGrantedPath(grant, args.path, false);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('编辑目标必须是普通文件');
    if (stat.size > MAX_EDIT_BYTES) throw new Error(`文件超过编辑上限 ${MAX_EDIT_BYTES} bytes`);

    return withFileLock(target, async () => {
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let content: string;
      try {
        content = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close();
      }

      const previous = sha256(content);
      if (expectedHash !== previous) {
        throw new Error('文件在读取之后已经变化，拒绝编辑（请重新读取再生成计划）');
      }

      // 先按原样匹配；Unix / Windows 混用换行时，统一成 LF 再匹配，
      // 写回时恢复原文件的换行风格。这样同一份计划在两种工程里都能用。
      const crlf = content.includes('\r\n');
      const haystack = crlf ? content.replace(/\r\n/g, '\n') : content;
      const needle = crlf ? args.oldString.replace(/\r\n/g, '\n') : args.oldString;
      const replacement = crlf ? args.newString.replace(/\r\n/g, '\n') : args.newString;

      let next: string;
      let replaced: number;
      const exactCount = haystack.split(needle).length - 1;
      if (exactCount > 0) {
        if (exactCount > 1 && !args.replaceAll) {
          throw new Error(`要替换的文本出现了 ${exactCount} 次；请给更长的上下文，或显式声明 replaceAll`);
        }
        replaced = args.replaceAll ? exactCount : 1;
        next = args.replaceAll ? haystack.split(needle).join(replacement) : haystack.replace(needle, replacement);
      } else {
        // 只有精确匹配失败才退回标点归一化；替换仍然只落在命中的那一段。
        const probe = replaceMatches(haystack, needle, replacement, true);
        if (!probe) throw new Error('要替换的文本在文件里不存在');
        if (probe.count > 1 && !args.replaceAll) {
          throw new Error(`要替换的文本出现了 ${probe.count} 次；请给更长的上下文，或显式声明 replaceAll`);
        }
        next = probe.next;
        replaced = probe.count;
      }

      if (crlf) next = next.replace(/\n/g, '\r\n');

      const temp = path.join(path.dirname(target), `.thinkfusion-${randomUUID()}.tmp`);
      try {
        const tempHandle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await tempHandle.writeFile(next, { encoding: 'utf8' });
          await tempHandle.sync();
        } finally {
          await tempHandle.close();
        }
        await fs.rename(temp, target);
      } catch (error) {
        await fs.unlink(temp).catch(() => undefined);
        throw error;
      }

      // 写回之后重新读一遍，而不是拿内存里的 next 当证据。
      const written = await fs.readFile(target, 'utf8');
      const actual = sha256(written);
      if (actual !== sha256(next)) throw new Error('写入后回读与预期内容不一致，拒绝把这一步算作成功');

      const after = await fs.lstat(target);
      return {
        path: target,
        replaced,
        previousSha256: previous,
        sha256: actual,
        bytes: after.size,
        before: args.oldString.slice(0, 4000),
        after: args.newString.slice(0, 4000)
      };
    });
  },

  async remove(grant: TaskGrant, args: { path: string; recursive?: boolean; permanent?: boolean }): Promise<RemoveResult> {
    assertMutable(grant, '删除');
    const target = await resolveGrantedPath(grant, args.path, false);
    const stat = await fs.lstat(target);
    if (stat.isDirectory() && !args.recursive) {
      throw new Error('删除目录必须显式声明 recursive: true');
    }
    if (args.permanent && grant.permissionPreset !== 'danger-full-access') {
      throw new Error('永久删除只在完全权限下可用；当前会移入废纸篓');
    }

    if (args.permanent) {
      await fs.rm(target, { recursive: !!args.recursive, force: false });
      return { path: target, trashed: false, deleted: true };
    }

    await fs.mkdir(TRASH_DIR, { recursive: true });
    const base = path.basename(target);
    let destination = path.join(TRASH_DIR, base);
    if (await fs.stat(destination).then(() => true).catch(() => false)) {
      destination = path.join(TRASH_DIR, `${base}-${Date.now()}`);
    }
    try {
      await fs.rename(target, destination);
    } catch (error) {
      // 跨卷（工作区在外部磁盘）时 rename 会 EXDEV，退回复制 + 删除。
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.cp(target, destination, { recursive: true, errorOnExist: true, force: false });
      await fs.rm(target, { recursive: !!args.recursive, force: false });
    }
    return { path: target, trashed: true, trashPath: destination, deleted: false };
  },

  async move(grant: TaskGrant, args: { from: string; to: string }) {
    assertMutable(grant, '移动文件');
    const source = await resolveGrantedPath(grant, args.from, false);
    const destination = await resolveGrantedPath(grant, args.to, true);
    await assertAbsent(destination);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      await fs.rm(source, { recursive: true, force: false });
    }
    const stat = await fs.lstat(destination);
    return { from: source, to: destination, bytes: stat.size };
  },

  async copy(grant: TaskGrant, args: { from: string; to: string }) {
    assertMutable(grant, '复制文件');
    const source = await resolveGrantedPath(grant, args.from, false);
    const destination = await resolveGrantedPath(grant, args.to, true);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error('不复制符号链接');
    await assertAbsent(destination);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.cp(source, destination, { recursive: stat.isDirectory(), errorOnExist: true, force: false });
    const after = await fs.lstat(destination);
    return {
      from: source,
      to: destination,
      type: after.isDirectory() ? 'directory' : 'file',
      bytes: after.size
    };
  },

  async readImage(grant: TaskGrant, args: { path: string }) {
    const target = await resolveGrantedPath(grant, args.path, false);
    const ext = path.extname(target).toLowerCase();
    const mime: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp'
    };
    if (!mime[ext]) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}`);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new Error('读取目标必须是普通文件');
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES} bytes 上限`);
    const buffer = await fs.readFile(target);
    const size = imageSize(buffer, ext);
    return {
      path: target,
      mime: mime[ext],
      bytes: stat.size,
      width: size?.width ?? null,
      height: size?.height ?? null,
      sha256: sha256(buffer),
      base64: buffer.toString('base64')
    };
  },

  /**
   * 目录体积：回答「为什么这个仓库这么大」时，`fs.tree` 只给名字，给不了体积。
   * 只统计直接子项各自的总量（含其中所有层级），不逐层返回——否则一个
   * node_modules 就能把结果撑爆。符号链接一律不跟随，避免顺着链接跑进别的盘。
   */
  async diskUsage(grant: TaskGrant, args: { path?: string; maxEntries?: number; maxNodes?: number }) {
    const root = await resolveGrantedPath(grant, args.path ?? '.', false);
    const maxEntries = Math.min(Math.max(args.maxEntries ?? 40, 1), 500);
    const maxNodes = Math.min(Math.max(args.maxNodes ?? 20_000, 100), 200_000);

    let scanned = 0;
    let truncated = false;

    const measure = async (target: string): Promise<{ bytes: number; files: number }> => {
      const stack = [target];
      let bytes = 0;
      let files = 0;
      while (stack.length > 0) {
        if (scanned >= maxNodes) { truncated = true; break; }
        const current = stack.pop()!;
        let stat;
        try {
          stat = await fs.lstat(current);
        } catch {
          continue;
        }
        scanned += 1;
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          let children: string[];
          try {
            children = await fs.readdir(current);
          } catch {
            continue;
          }
          for (const child of children) stack.push(path.join(current, child));
          continue;
        }
        if (stat.isFile()) {
          bytes += stat.size;
          files += 1;
        }
      }
      return { bytes, files };
    };

    const children = await fs.readdir(root, { withFileTypes: true });
    const rows: Array<{ path: string; kind: 'directory' | 'file'; bytes: number; files: number }> = [];
    for (const child of children) {
      const target = path.join(root, child.name);
      const result = await measure(target);
      rows.push({
        path: child.name,
        kind: child.isDirectory() ? 'directory' : 'file',
        bytes: result.bytes,
        files: result.files
      });
    }

    rows.sort((a, b) => b.bytes - a.bytes);
    const total = rows.reduce((sum, row) => sum + row.bytes, 0);
    return {
      path: root,
      totalBytes: total,
      scannedNodes: scanned,
      truncated,
      entries: rows.slice(0, maxEntries)
    };
  }
};

async function assertAbsent(target: string) {
  const exists = await fs.lstat(target).then(() => true).catch(() => false);
  if (exists) throw new Error('目标已存在，拒绝覆盖（先删除或换一个名字）');
}
