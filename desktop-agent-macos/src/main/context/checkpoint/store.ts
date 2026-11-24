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
import { CONTEXT_CONTRACT_VERSION } from '../../../shared/context';

export interface ContextCheckpointStoreOptions {
  baseDir: string;
  now?: () => number;
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
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
      safeSegment(owner.ownerType),
      `${safeSegment(owner.ownerId)}.json`
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
}
