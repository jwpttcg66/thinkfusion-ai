import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function ensureSafeDirectory(grant: TaskGrant, relativePath: string) {
  const target = await resolveGrantedPath(grant, relativePath, true);
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  // Re-resolve after creation to catch symlinks introduced during the operation.
  const checked = await resolveGrantedPath(grant, relativePath, false);
  const stat = await fs.stat(checked);
  if (!stat.isDirectory()) throw new Error('目标不是目录');
  return checked;
}

export const filesystemTools = {
  async list(grant: TaskGrant, args: { path: string }) {
    const target = await resolveGrantedPath(grant, args.path, false);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error('读取目标必须是目录');
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.slice(0, 1000).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
  },
  async readFile(grant: TaskGrant, args: { path: string; maxBytes?: number }) {
    const target = await resolveGrantedPath(grant, args.path, false);
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('读取目标必须是普通文件');
      const limit = Math.min(args.maxBytes ?? 262144, 262144);
      if (stat.size > limit) throw new Error(`文件超过读取上限 ${limit} bytes`);
      const content = await handle.readFile({ encoding: 'utf8' });
      // 改这个文件时要回填这个值。没有它，覆盖写只能靠路径判断，
      // 中间被人改过也照写不误。
      return { path: target, bytes: stat.size, sha256: sha256(content), content };
    } finally { await handle.close(); }
  },
  async mkdir(grant: TaskGrant, args: { path: string }) {
    const target = await ensureSafeDirectory(grant, args.path);
    return { created: true, path: target };
  },
  async writeFile(grant: TaskGrant, args: { path: string; content: string }) {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 1_000_000) throw new Error('文件内容超过 1 MB 限制');
    const target = await resolveGrantedPath(grant, args.path, true);
    let parent: string;
    if (grant.permissionPreset === 'danger-full-access') {
      parent = path.dirname(target);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    } else {
      const root = await fs.realpath(grant.rootDir);
      const parentRel = path.relative(root, path.dirname(target)) || '.';
      parent = await ensureSafeDirectory(grant, parentRel);
    }
    const finalPath = path.join(parent, path.basename(target));
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(finalPath, flags, 0o600);
    try {
      await handle.writeFile(args.content, { encoding: 'utf8' });
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.unlink(finalPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    const stat2 = await fs.lstat(finalPath);
    if (!stat2.isFile() || stat2.isSymbolicLink()) throw new Error('写入后文件类型校验失败');
    return { created: true, path: finalPath, bytes: stat2.size };
  },

  /**
   * 覆盖已有文件（V2.1 Phase F）。
   *
   * 「修改一个功能」以前做不到：`writeFile` 用 O_EXCL，遇到已有文件直接
   * EEXIST，而模型又不能凭空写出没读过的全文。现在要求调用方先读文件、
   * 把 `sha256` 回填，这里核对一致才允许替换——读完之后被人改过就拒绝，
   * 不会出现「拿旧版本盖掉别人刚改的内容」。
   *
   * 落地方式是「同目录临时文件 + rename」：不截断原文件，万一写一半失败，
   * 原文件仍是完好的；rename 在同一目录内是原子的。
   */
  async overwriteFile(
    grant: TaskGrant,
    args: { path: string; content: string; expectedHash?: string }
  ) {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 1_000_000) {
      throw new Error('文件内容超过 1 MB 限制');
    }
    if (!args.expectedHash || !/^[a-f0-9]{64}$/.test(args.expectedHash)) {
      throw new Error('覆盖已有文件必须提供先前读取到的 sha256');
    }
    const target = await resolveGrantedPath(grant, args.path, false);
    const before = await fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('覆盖目标必须是普通文件');

    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let current: string;
    try {
      current = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
    const actual = sha256(current);
    if (actual !== args.expectedHash) {
      throw new Error('文件在读取之后已经变化，拒绝覆盖（请重新读取再生成计划）');
    }

    const dir = path.dirname(target);
    const temp = path.join(dir, `.thinkfusion-${randomUUID()}.tmp`);
    try {
      const tempHandle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await tempHandle.writeFile(args.content, { encoding: 'utf8' });
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }
      await fs.rename(temp, target);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
    const after = await fs.lstat(target);
    return {
      replaced: true,
      path: target,
      bytes: after.size,
      previousSha256: actual,
      sha256: sha256(args.content)
    };
  }
};
