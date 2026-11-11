/**
 * 本轮改动的快照：第一次改某个文件之前留一份原文，供「还原本轮」。
 *
 * 不依赖 git（工程可能不是仓库），也不把整份工作区复制一份：
 * 只备份本次真正动过的文件，按 taskId 分目录，任务结束由调用方清理。
 * 路径一律钉在授权根内；taskId 只接受安全字符，挡路径穿越。
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../atomic-write';

export interface SnapshotEntry {
  /** 相对工作区根的路径。 */
  path: string;
  /** 改动前是否存在；不存在表示这次是新建，还原时删掉。 */
  existed: boolean;
  /** 备份文件名；existed=false 时为空。 */
  backup?: string;
  bytes?: number;
  at: number;
}

export interface SnapshotManifest {
  taskId: string;
  root: string;
  entries: SnapshotEntry[];
}

export interface SnapshotOutcome {
  taskId: string;
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; detail: string }>;
}

function safeId(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9-]/g, '');
  if (!clean) throw new Error('taskId 无效');
  return clean;
}

function resolveInside(root: string, relative: string): string {
  const abs = path.resolve(root, relative);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${relative} 不在工作区内`);
  return abs;
}

export class SnapshotStore {
  constructor(private readonly baseDir: string) {}

  private dirOf(taskId: string): string {
    return path.join(this.baseDir, safeId(taskId));
  }

  private manifestFile(taskId: string): string {
    return path.join(this.dirOf(taskId), 'manifest.json');
  }

  private read(taskId: string): SnapshotManifest {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestFile(taskId), 'utf8')) as SnapshotManifest;
      if (!parsed || !Array.isArray(parsed.entries)) throw new Error('bad manifest');
      return parsed;
    } catch {
      return { taskId: safeId(taskId), root: '', entries: [] };
    }
  }

  /** 第一次动这个文件时留底；已经留过就不覆盖（还原要回到本轮开始）。 */
  capture(root: string, taskId: string, relative: string): void {
    const dir = this.dirOf(taskId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest = this.read(taskId);
    manifest.root = root;
    if (manifest.entries.some(entry => entry.path === relative)) return;
    const abs = resolveInside(root, relative);
    const entry: SnapshotEntry = { path: relative, existed: false, at: Date.now() };
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        const backup = `${String(manifest.entries.length)}-${path.basename(abs)}.bak`;
        fs.copyFileSync(abs, path.join(dir, backup));
        entry.existed = true;
        entry.backup = backup;
        entry.bytes = stat.size;
      }
    } catch {
      // 不存在：记成「新建」，还原时删掉。
    }
    manifest.entries.push(entry);
    writeFileAtomic(this.manifestFile(taskId), JSON.stringify(manifest, null, 2), 0o600);
  }

  revert(taskId: string): SnapshotOutcome {
    const manifest = this.read(taskId);
    const outcome: SnapshotOutcome = { taskId: manifest.taskId, restored: [], removed: [], failed: [] };
    if (!manifest.root || manifest.entries.length === 0) return outcome;
    for (const entry of manifest.entries) {
      const abs = resolveInside(manifest.root, entry.path);
      try {
        if (!entry.existed) {
          fs.rmSync(abs, { force: true });
          outcome.removed.push(entry.path);
          continue;
        }
        const backup = path.join(this.dirOf(taskId), entry.backup ?? '');
        if (!entry.backup || !fs.existsSync(backup)) throw new Error('备份文件不存在');
        const temp = `${abs}.tf-restore-${String(process.pid)}`;
        fs.copyFileSync(backup, temp);
        fs.renameSync(temp, abs);
        outcome.restored.push(entry.path);
      } catch (error) {
        outcome.failed.push({ path: entry.path, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcome;
  }

  /** 任务结束后清理；失败不抛（清理不该盖住业务结果）。 */
  clear(taskId: string): void {
    try { fs.rmSync(this.dirOf(taskId), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
