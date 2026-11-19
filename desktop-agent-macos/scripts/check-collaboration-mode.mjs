/** P0-04：CollaborationMode 的默认值、持久化、非法值与损坏回退。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CollaborationModeStore,
  collaborationModePath,
  normalizeCollaborationMode
} from '../out-test/main/collaboration/mode.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mode-'));
}

test('默认 legacy；非法值回 legacy', () => {
  assert.equal(normalizeCollaborationMode(undefined), 'legacy');
  assert.equal(normalizeCollaborationMode(''), 'legacy');
  assert.equal(normalizeCollaborationMode('ACTIVE'), 'active');
  assert.equal(normalizeCollaborationMode('bogus'), 'legacy');
  const dir = tmp();
  const store = new CollaborationModeStore(collaborationModePath(dir));
  assert.equal(store.get(), 'legacy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set 持久化；新实例读回', () => {
  const dir = tmp();
  const file = collaborationModePath(dir);
  const store = new CollaborationModeStore(file);
  assert.equal(store.set('shadow', 'test'), 'shadow');
  assert.equal(new CollaborationModeStore(file).get(), 'shadow');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('损坏 / 未知字段 / 非对象回退 legacy，不抛', () => {
  const dir = tmp();
  const file = collaborationModePath(dir);
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.equal(new CollaborationModeStore(file).get(), 'legacy');
  fs.writeFileSync(file, JSON.stringify({ mode: 'bogus', extra: 1 }), 'utf8');
  assert.equal(new CollaborationModeStore(file).get(), 'legacy');
  fs.writeFileSync(file, JSON.stringify(['active']), 'utf8');
  assert.equal(new CollaborationModeStore(file).get(), 'legacy');
  fs.rmSync(dir, { recursive: true, force: true });
});
