/** P0-06：模式文件升级 / 降级 / 损坏 / 未知字段的钻取。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CollaborationModeStore, collaborationModePath } from '../out-test/main/collaboration/mode.js';

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tf-rollback-')); }

test('升级：active 写入后可读；未知字段不影响', () => {
  const d = dir();
  const file = collaborationModePath(d);
  fs.writeFileSync(file, JSON.stringify({ mode: 'active', future: { x: 1 } }), 'utf8');
  assert.equal(new CollaborationModeStore(file).get(), 'active');
  fs.rmSync(d, { recursive: true, force: true });
});

test('降级：删除模式文件 → legacy；旧入口不依赖新字段', () => {
  const d = dir();
  const file = collaborationModePath(d);
  new CollaborationModeStore(file).set('active');
  fs.rmSync(file);
  assert.equal(new CollaborationModeStore(file).get(), 'legacy');
  fs.rmSync(d, { recursive: true, force: true });
});

test('损坏：回 legacy，不抛；再写可恢复', () => {
  const d = dir();
  const file = collaborationModePath(d);
  fs.writeFileSync(file, 'broken', 'utf8');
  assert.equal(new CollaborationModeStore(file).get(), 'legacy');
  new CollaborationModeStore(file).set('shadow');
  assert.equal(new CollaborationModeStore(file).get(), 'shadow');
  fs.rmSync(d, { recursive: true, force: true });
});

test('非法值：写入被规范为 legacy，不污染文件', () => {
  const d = dir();
  const file = collaborationModePath(d);
  new CollaborationModeStore(file).set('nope');
  assert.equal(new CollaborationModeStore(file).get(), 'legacy');
  fs.rmSync(d, { recursive: true, force: true });
});
