/**
 * P6-04：备份/恢复。JSON 包，路径白名单，拒绝绝对路径与 ..
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface BackupEntry {
  path: string;
  content: string;
  sha256: string;
}

interface BackupBundle {
  version: 1;
  createdAt: number;
  files: BackupEntry[];
}

function safeRelative(file: string): string {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error(`非法路径：${file}`);
  }
  return file;
}

export function createBackup(input: { root: string; files: readonly string[]; out: string }): number {
  const entries: BackupEntry[] = input.files.map(file => {
    const rel = safeRelative(file);
    const content = fs.readFileSync(path.join(input.root, rel), 'utf8');
    return { path: rel, content, sha256: createHash('sha256').update(content).digest('hex') };
  });
  const bundle: BackupBundle = { version: 1, createdAt: Date.now(), files: entries };
  fs.mkdirSync(path.dirname(input.out), { recursive: true });
  fs.writeFileSync(input.out, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return entries.length;
}

export function restoreBackup(input: { bundle: string; root: string }): number {
  const parsed = JSON.parse(fs.readFileSync(input.bundle, 'utf8')) as BackupBundle;
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error('备份格式不支持');
  let restored = 0;
  for (const entry of parsed.files) {
    const rel = safeRelative(entry.path);
    if (createHash('sha256').update(entry.content).digest('hex') !== entry.sha256) {
      throw new Error(`备份内容损坏：${rel}`);
    }
    const target = path.join(input.root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.content, 'utf8');
    restored += 1;
  }
  return restored;
}
