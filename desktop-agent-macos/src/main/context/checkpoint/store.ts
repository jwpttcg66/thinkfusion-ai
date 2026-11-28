/**
 * 检查点独立文件存储（LT-P3-03）。
 *
 * 文件按 owner 聚合；Journal 指针才是提交权威，activeCache 只是可重建缓存。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  ContextCheckpoint,
  ContextOwner,
  ContextOwnerFile
} from '../../../shared/context';
import { CONTEXT_CONTRACT_VERSION, contextOwnerSegment } from '../../../shared/context';

export interface ContextCheckpointStoreOptions {
  baseDir: string;
  now?: () => number;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  try {
    const directory = await fs.open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    // 某些平台不允许 fsync 目录；尽力而为。
  }
}

export class ContextCheckpointStore {
  private readonly baseDir: string;
  private readonly now: () => number;

  constructor(options: ContextCheckpointStoreOptions) {
    this.baseDir = options.baseDir;
    this.now = options.now ?? Date.now;
  }

  ownerFile(owner: ContextOwner): string {
    return path.join(
      this.baseDir,
      'owners',
      contextOwnerSegment(owner.ownerType),
      `${contextOwnerSegment(owner.ownerId)}.json`
    );
  }

  async read(owner: ContextOwner): Promise<ContextOwnerFile | null> {
    try {
      const raw = await fs.readFile(this.ownerFile(owner), 'utf8');
      const parsed = JSON.parse(raw) as ContextOwnerFile;
      if (!parsed || parsed.owner?.ownerType !== owner.ownerType || parsed.owner.ownerId !== owner.ownerId) {
        throw new Error('检查点文件 owner 不匹配');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(owner: ContextOwner): Promise<ContextCheckpoint[]> {
    const file = await this.read(owner);
    return file?.checkpoints ?? [];
  }

  async find(owner: ContextOwner, checkpointId: string): Promise<ContextCheckpoint | null> {
    const file = await this.read(owner);
    return file?.checkpoints.find(item => item.checkpointId === checkpointId) ?? null;
  }

  /**
   * 写入 prepared 检查点。若同 checkpointId 已存在则替换；不修改 Journal 指针。
   */
  async write(owner: ContextOwner, checkpoint: ContextCheckpoint): Promise<void> {
    const existing = await this.read(owner);
    const now = this.now();
    const next: ContextOwnerFile = existing ?? {
      contractVersion: CONTEXT_CONTRACT_VERSION,
      owner,
      checkpoints: [],
      updatedAt: now
    };
    const index = next.checkpoints.findIndex(item => item.checkpointId === checkpoint.checkpointId);
    if (index >= 0) next.checkpoints[index] = checkpoint;
    else next.checkpoints.push(checkpoint);
    next.updatedAt = now;
    await atomicWrite(this.ownerFile(owner), JSON.stringify(next, null, 2));
  }

  /** 仅缓存；Journal 指针缺失时可由 checkpointId/runId 重建。 */
  async setActiveCache(owner: ContextOwner, active: { runId: string; checkpointId: string } | null): Promise<void> {
    const file = await this.read(owner);
    if (!file) return;
    file.activeCache = active;
    file.updatedAt = this.now();
    await atomicWrite(this.ownerFile(owner), JSON.stringify(file, null, 2));
  }

  /**
   * 回收整个 owner 的检查点文件（V4 P1 M2-2 垃圾回收）。
   *
   * owner 就是 `agent-task:<taskId>`，任务删了这份文件再没人读：Journal 指针随任务
   * 一起消失，留着只会变成磁盘上的孤儿。返回「是否真的删掉了一份」而不是笼统的
   * 成功——调用方要把这个数字讲给用户听，没删过就不能报「已回收」。
   * 读不到/删不动一律按未回收处理，不让磁盘异常把「删除任务」这个用户动作变成报错。
   */
  async deleteOwner(owner: ContextOwner): Promise<boolean> {
    return this.removeOwnerSegment(owner.ownerType, contextOwnerSegment(owner.ownerId));
  }

  private ownersDir(ownerType: ContextOwner['ownerType']): string {
    return path.join(this.baseDir, 'owners', contextOwnerSegment(ownerType));
  }

  /**
   * 孤儿扫描入口（V4 P1 M2-2 垃圾回收）：列出某类 owner 的归属文件段名。
   *
   * 只给段名、不给 owner：`safeSegment` 不是单射，解码再拼回 ownerId 会把两个不同
   * id 认成同一个，删除也就可能删错。目录不存在给空表——「没跑过检查点」不是错误。
   */
  async listOwnerSegments(ownerType: ContextOwner['ownerType']): Promise<string[]> {
    try {
      const names = await fs.readdir(this.ownersDir(ownerType));
      return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  }

  /** 按段名删一份归属文件；同样只报「真的删掉了没有」，`force` 的沉默成功不算数。 */
  async removeOwnerSegment(ownerType: ContextOwner['ownerType'], segment: string): Promise<boolean> {
    const file = path.join(this.ownersDir(ownerType), `${segment}.json`);
    try {
      await fs.access(file);
    } catch {
      return false;
    }
    try {
      await fs.rm(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
