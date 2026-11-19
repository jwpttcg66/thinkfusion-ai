/** P6-06：应用/数据回滚钻取。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBackup, restoreBackup } from '../out-test/main/release-ops/backup.js';
import { CollaborationModeStore, collaborationModePath } from '../out-test/main/collaboration/mode.js';

test('数据回滚：备份→删除→恢复', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-rollback-'));
  const root = path.join(d, 'data');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'pack.json'), '{"v":1}');
  const bundle = path.join(d, 'b.json');
  createBackup({ root, files: ['pack.json'], out: bundle });
  fs.rmSync(path.join(root, 'pack.json'));
  assert.equal(restoreBackup({ bundle, root }), 1);
  assert.equal(fs.readFileSync(path.join(root, 'pack.json'), 'utf8'), '{"v":1}');
  fs.rmSync(d, { recursive: true, force: true });
});

test('应用回滚：active→legacy；损坏→legacy', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mode-rb-'));
  const file = collaborationModePath(d);
  const store = new CollaborationModeStore(file);
  store.set('active');
  assert.equal(store.get(), 'active');
  store.set('legacy');
  assert.equal(store.get(), 'legacy');
  fs.writeFileSync(file, 'broken');
  assert.equal(store.get(), 'legacy');
  fs.rmSync(d, { recursive: true, force: true });
});
