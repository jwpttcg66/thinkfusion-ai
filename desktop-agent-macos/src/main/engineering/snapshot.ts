/**
 * P3-07：工程快照 S1/S2。commit + dirty + diff 的指纹，供证据/回退引用。
 * 不叫流程基线；不创建共享上下文。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface EngineeringSnapshot {
  kind: 'S1' | 'S2';
  commit: string;
  dirty: boolean;
  dirtyFiles: string[];
  diffHash: string;
  /** 截断后的 diff 正文；只用于 UI 展示，不参与哈希。 */
  diff?: string;
  snapshot: string;
  at: number;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

export function captureSnapshot(repoRoot: string, kind: 'S1' | 'S2'): EngineeringSnapshot {
  const commit = git(repoRoot, ['rev-parse', 'HEAD']);
  const status = git(repoRoot, ['status', '--porcelain']);
  const dirtyFiles = status
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.slice(2).trim());
  const diff = git(repoRoot, ['diff', 'HEAD', '--binary']);
  const diffHash = createHash('sha256').update(diff).digest('hex');
  const snapshot = createHash('sha256')
    .update(`${commit}\n${dirtyFiles.join('\n')}\n${diffHash}`)
    .digest('hex');
  return {
    kind,
    commit,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    diffHash,
    ...(diff ? { diff: diff.slice(0, 20_000) } : {}),
    snapshot,
    at: Date.now()
  };
}

export function sameSnapshot(left: EngineeringSnapshot, right: EngineeringSnapshot): boolean {
  return left.snapshot === right.snapshot;
}
