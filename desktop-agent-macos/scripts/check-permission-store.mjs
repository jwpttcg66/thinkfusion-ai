/** 权限预设持久化。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPermissionPreset, savePermissionPreset } from '../out-test/main/permission-store.js';

test('保存完全权限后重载仍是完全权限', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-perm-'));
  const f = path.join(d, 'permission.json');
  assert.equal(loadPermissionPreset(f), 'workspace-write');
  savePermissionPreset(f, 'danger-full-access');
  assert.equal(loadPermissionPreset(f), 'danger-full-access');
  fs.rmSync(d, { recursive: true, force: true });
});
