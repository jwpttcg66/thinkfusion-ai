/**
 * 快照元数据的指纹与一致性规则。
 *
 * `dirtyFingerprint` 只回答「dirty overlay 的路径、行号、片段 hash、错误
 * 有没有变化」，它不是 Git commit，也不是 Pack blob hash。三者不能互相替代。
 */
import { sha256Hex } from './hash';
import type {
  EvidencePackSnapshot,
  EvidencePackSnapshotFile,
  EvidencePackSnapshotIssue
} from './types';

export function snapshotFingerprintOf(
  files: readonly EvidencePackSnapshotFile[],
  errors: readonly EvidencePackSnapshotIssue[]
): string {
  const lines: string[] = [];
  for (const file of files) {
    for (const range of file.ranges) {
      lines.push(`range:${file.path}:${String(range.startLine)}-${String(range.endLine)}:${range.contentHash}`);
    }
    for (const issue of file.issues) {
      lines.push(`issue:${issue.code}:${issue.path ?? ''}:${issue.message}`);
    }
  }
  // 文件级 issue 已经由 file.issues 覆盖；顶层 errors 只放没有 path 的全局错误。
  for (const issue of errors) {
    lines.push(`issue:${issue.code}:${issue.path ?? ''}:${issue.message}`);
  }
  return sha256Hex(lines.sort().join('\n'));
}

export function snapshotFingerprint(snapshot: EvidencePackSnapshot): string {
  return snapshotFingerprintOf(snapshot.files, snapshot.errors);
}
