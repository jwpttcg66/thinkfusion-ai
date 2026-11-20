/** P3-07：git 快照 S1/S2 的 commit/dirty/diff 指纹。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureSnapshot, sameSnapshot } from '../out-test/main/engineering/snapshot.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-snap-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

test('S1 干净；修改后 dirty 且指纹变化；提交后恢复干净', () => {
  const dir = repo();
  const s1 = captureSnapshot(dir, 'S1');
  assert.equal(s1.dirty, false);
  assert.equal(s1.commit.length, 40);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
  const s2 = captureSnapshot(dir, 'S2');
  assert.equal(s2.dirty, true);
  assert.match(s2.diff ?? '', /two/);
  assert.deepEqual(s2.dirtyFiles, ['a.txt']);
  assert.equal(sameSnapshot(s1, s2), false);
  execFileSync('git', ['commit', '-qam', 'change'], { cwd: dir });
  const s3 = captureSnapshot(dir, 'S2');
  assert.equal(s3.dirty, false);
  assert.equal(s3.commit === s1.commit, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
