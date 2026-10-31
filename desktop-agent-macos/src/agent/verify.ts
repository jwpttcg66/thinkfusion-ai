import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { TaskGrant } from '../shared/contracts';
import { resolveGrantedPath } from './policy';

export interface WriteVerification {
  ok: boolean;
  bytes: number;
  sha256: string;
  reason?: string;
}

/**
 * A write call returning without throwing is not evidence that the file is on
 * disk with the expected content. Re-open it, hash it, compare.
 */
export async function verifyWrittenFile(
  grant: TaskGrant,
  relativePath: string,
  expected: { content: string }
): Promise<WriteVerification> {
  const target = await resolveGrantedPath(grant, relativePath, false);

  let handle;
  try {
    handle = await fs.open(target, 'r');
  } catch {
    return { ok: false, bytes: 0, sha256: '', reason: '文件不存在或不可读' };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, bytes: 0, sha256: '', reason: '目标不是普通文件' };

    const actual = await handle.readFile();
    const sha256 = createHash('sha256').update(actual).digest('hex');
    const expectedHash = createHash('sha256').update(expected.content, 'utf8').digest('hex');

    if (sha256 !== expectedHash) {
      return { ok: false, bytes: stat.size, sha256, reason: '写入内容与预期不一致' };
    }
    return { ok: true, bytes: stat.size, sha256 };
  } finally {
    await handle.close();
  }
}
