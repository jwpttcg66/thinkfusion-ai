import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import type { TaskGrant } from '../../shared/contracts';
import { resolveGrantedPath } from '../policy';

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
      return { path: target, bytes: stat.size, content: await handle.readFile({ encoding: 'utf8' }) };
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
    const stat = await fs.lstat(finalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('写入后文件类型校验失败');
    return { created: true, path: finalPath, bytes: stat.size };
  }
};
