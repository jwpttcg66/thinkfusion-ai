/**
 * 原始事件归档（LT-P0-06 / LT-P3-03）。
 *
 * Journal 配额仍可裁剪，但被压缩引用的事件必须先落到归档段。
 * 归档段按 owner + checkpoint 分文件，内容 JSONL，带 hash 校验。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ContextOwner } from '../../../shared/context';

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

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}

function hashOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export class ContextArchiveStore {
  constructor(private readonly baseDir: string) {}

  private fileOf(owner: ContextOwner, checkpointId: string): { abs: string; rel: string } {
    const rel = path.join(
      'archive',
      safeSegment(owner.ownerType),
      safeSegment(owner.ownerId),
      `${safeSegment(checkpointId)}.jsonl`
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
}
