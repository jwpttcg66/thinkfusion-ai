/**
 * 原始事件归档（LT-P0-06 / LT-P3-03）。
 *
 * Journal 配额仍可裁剪，但被压缩引用的事件必须先落到归档段。
 * 归档段按 owner + checkpoint 分文件，内容 JSONL，带 hash 校验。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { contextOwnerSegment, type ContextOwner } from '../../../shared/context';

export interface ContextArchiveResult {
  /** 相对 context 根目录的路径；写入 checkpoint.archiveRef。 */
  archiveRef: string;
  archiveHash: string;
  eventCount: number;
}

export interface ContextArchiveFile {
  meta: {
    ownerType: ContextOwner['ownerType'];
    ownerId: string;
    checkpointId: string;
    sourceStream: 'events' | 'runEvents';
    eventCount: number;
    archiveHash: string;
  };
  events: unknown[];
}

function hashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export class ContextArchiveStore {
  constructor(private readonly baseDir: string) {}

  private fileOf(owner: ContextOwner, checkpointId: string): { abs: string; rel: string } {
    const rel = path.join(
      'archive',
      contextOwnerSegment(owner.ownerType),
      contextOwnerSegment(owner.ownerId),
      `${contextOwnerSegment(checkpointId)}.jsonl`
    );
    return { abs: path.join(this.baseDir, rel), rel };
  }

  async write(input: {
    owner: ContextOwner;
    checkpointId: string;
    sourceStream: 'events' | 'runEvents';
    events: readonly unknown[];
  }): Promise<ContextArchiveResult> {
    const { abs, rel } = this.fileOf(input.owner, input.checkpointId);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const body = input.events.map(event => JSON.stringify(event)).join('\n');
    const hash = hashOf(body);
    const meta = {
      ownerType: input.owner.ownerType,
      ownerId: input.owner.ownerId,
      checkpointId: input.checkpointId,
      sourceStream: input.sourceStream,
      eventCount: input.events.length,
      archiveHash: hash
    };
    const content = `${JSON.stringify({ __meta: meta })}\n${body}${body ? '\n' : ''}`;
    const tmp = `${abs}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, abs);
    try {
      const dir = await fs.open(path.dirname(abs), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {
      // 目录 fsync 尽力而为。
    }
    return { archiveRef: rel, archiveHash: hash, eventCount: input.events.length };
  }

  async verify(archiveRef: string): Promise<boolean> {
    try {
      const abs = path.join(this.baseDir, archiveRef);
      const raw = await fs.readFile(abs, 'utf8');
      const [metaLine, ...lines] = raw.split('\n');
      const meta = (JSON.parse(metaLine) as { __meta?: ContextArchiveFile['meta'] }).__meta;
      if (!meta) return false;
      const body = lines.filter(line => line.length > 0).join('\n');
      return hashOf(body) === meta.archiveHash;
    } catch {
      return false;
    }
  }

  async read(archiveRef: string): Promise<ContextArchiveFile | null> {
    try {
      const raw = await fs.readFile(path.join(this.baseDir, archiveRef), 'utf8');
      const [metaLine, ...lines] = raw.split('\n');
      const meta = (JSON.parse(metaLine) as { __meta?: ContextArchiveFile['meta'] }).__meta;
      if (!meta) return null;
      const events = lines.filter(line => line.length > 0).map(line => JSON.parse(line) as unknown);
      return { meta, events };
    } catch {
      return null;
    }
  }

  /**
   * 回收该 owner 的全部归档段（V4 P1 M2-2 垃圾回收）。
   *
   * 段文件名带 checkpointId，而检查点文件已随任务删除——没有指针就再也寻不到这些
   * 段，留着就是纯占用磁盘的孤儿。返回删掉的段数；目录不存在返回 0。
   * 只按 owner 目录删，不按时间或文件大小猜：误删别人正在用的归档比留几个孤儿更糟。
   */
  async deleteOwner(owner: ContextOwner): Promise<number> {
    return this.removeOwnerSegment(owner.ownerType, contextOwnerSegment(owner.ownerId));
  }

  /**
   * 孤儿扫描入口：列出某类 owner 下有归档段的段名（V4 P1 M2-2 垃圾回收）。
   * 与检查点存储一样只给段名不给 owner——段名不可逆地解码会认错人。
   */
  async listOwnerSegments(ownerType: ContextOwner['ownerType']): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.baseDir, 'archive', contextOwnerSegment(ownerType)));
      return entries.filter(name => !name.startsWith('.'));
    } catch {
      return [];
    }
  }

  /** 删掉该段名下全部归档段与目录，返回删掉的段数。 */
  async removeOwnerSegment(
    ownerType: ContextOwner['ownerType'],
    segment: string
  ): Promise<number> {
    const dir = path.join(this.baseDir, 'archive', contextOwnerSegment(ownerType), segment);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        await fs.rm(path.join(dir, name), { force: true });
        removed += 1;
      } catch {
        // 单个段删不动不影响其余回收；调用方按「没删掉的就不算回收」如实报数。
      }
    }
    try {
      await fs.rmdir(dir);
    } catch {
      // 还有别的文件（或并发写入）时保留目录。
    }
    return removed;
  }
}
