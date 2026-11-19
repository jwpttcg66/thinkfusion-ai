/** P6-01/03/04/08：版本清单、迁移备份、备份恢复、发布门禁。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256File, validateManifest } from '../out-test/main/release-ops/manifest.js';
import { migrateWithBackup } from '../out-test/main/release-ops/migrate.js';
import { createBackup, restoreBackup } from '../out-test/main/release-ops/backup.js';
import { evaluateReleaseGate, REQUIRED_RELEASE_CHECKS } from '../out-test/main/release-ops/gate.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tf-release-'));

test('清单：版本/tag/哈希一致通过；不一致拒绝', () => {
  const d = dir();
  const file = path.join(d, 'app.zip');
  fs.writeFileSync(file, 'zip');
  const artifact = { name: 'app.zip', sha256: sha256File(file), size: 3 };
  const manifest = {
    productLine: 'V3', appVersion: '0.3.0', tag: 'v0.3.0', commit: 'abc',
    builtAt: 1, artifacts: [artifact], dataSchema: 1, notes: ''
  };
  assert.equal(validateManifest(manifest, { version: '0.3.0', packageVersion: '0.3.0', tag: 'v0.3.0' }).ok, true);
  assert.equal(validateManifest({ ...manifest, tag: '3.0' }, { version: '0.3.0', packageVersion: '0.3.0', tag: 'v0.3.0' }).ok, false);
  assert.equal(validateManifest({ ...manifest, artifacts: [] }, { version: '0.3.0', packageVersion: '0.3.0', tag: 'v0.3.0' }).ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('迁移：逐步执行、备份存在；失败保留备份', async () => {
  const d = dir();
  const data = path.join(d, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'a.json'), '{}');
  const result = await migrateWithBackup({
    dir: data, current: 1, target: 3,
    steps: [
      { from: 1, to: 2, run: p => fs.writeFileSync(path.join(p, 'b.json'), '{}') },
      { from: 2, to: 3, run: p => fs.writeFileSync(path.join(p, 'c.json'), '{}') }
    ],
    backupRoot: path.join(d, 'backups')
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);
  assert.ok(fs.existsSync(result.backup));
  const failed = await migrateWithBackup({
    dir: data, current: 1, target: 2,
    steps: [{ from: 1, to: 2, run: () => { throw new Error('boom'); } }],
    backupRoot: path.join(d, 'backups')
  });
  assert.equal(failed.ok, false);
  assert.ok(fs.existsSync(failed.backup));
  fs.rmSync(d, { recursive: true, force: true });
});

test('备份/恢复；路径穿越拒绝', () => {
  const d = dir();
  const root = path.join(d, 'root');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'hello');
  const out = path.join(d, 'backup.json');
  assert.equal(createBackup({ root, files: ['a.json', 'sub/b.txt'], out }), 2);
  fs.rmSync(path.join(root, 'a.json'));
  assert.equal(restoreBackup({ bundle: out, root }), 2);
  assert.equal(fs.readFileSync(path.join(root, 'a.json'), 'utf8'), '{"a":1}');
  assert.throws(() => createBackup({ root, files: ['../evil'], out }), /非法路径/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('发布门禁：缺项/失败都拒绝', () => {
  const all = REQUIRED_RELEASE_CHECKS.map(id => ({ id, ok: true }));
  assert.equal(evaluateReleaseGate(all).ok, true);
  assert.equal(evaluateReleaseGate(all.filter(item => item.id !== 'signed-artifact')).ok, false);
  assert.equal(evaluateReleaseGate(all.map(item => item.id === 'release-notes' ? { ...item, ok: false } : item)).ok, false);
});
