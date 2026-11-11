/**
 * 「还原本轮」的落盘与还原：第一次改之前留底，之后一键回到当时。
 *
 * 钉住四件事：
 * 1. 已有文件改两次，还原只回到第一次之前（不能回到第二次之前）；
 * 2. 本轮新建的文件，还原时删除；
 * 3. 路径不能穿出工作区；
 * 4. 还原失败如实列出，不假装成功。
 *
 * Run with: npm run test:snapshot
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotStore } from '../out-test/main/snapshots/store.js';

const work = mkdtempSync(join(tmpdir(), 'tf-snapshot-'));
const root = join(work, 'project');
const storeDir = join(work, 'store');
after(() => rmSync(work, { recursive: true, force: true }));

import { mkdirSync } from 'node:fs';
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'existing.txt'), 'v1\n');

const store = new SnapshotStore(storeDir);

test('改两次只回到第一次之前', () => {
  store.capture(root, 'task-1', 'existing.txt');
  writeFileSync(join(root, 'existing.txt'), 'v2\n');
  store.capture(root, 'task-1', 'existing.txt');
  writeFileSync(join(root, 'existing.txt'), 'v3\n');
  const outcome = store.revert('task-1');
  assert.deepEqual(outcome.restored, ['existing.txt']);
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'v1\n');
});

test('本轮新建的文件，还原时删除', () => {
  store.capture(root, 'task-2', 'new.txt');
  writeFileSync(join(root, 'new.txt'), 'created\n');
  const outcome = store.revert('task-2');
  assert.deepEqual(outcome.removed, ['new.txt']);
  assert.equal(existsSync(join(root, 'new.txt')), false);
});

test('路径不能穿出工作区', () => {
  assert.throws(() => store.capture(root, 'task-3', '../outside.txt'), /不在工作区内/);
});

test('没有留底时还原是空结果，不报错', () => {
  const empty = store.revert('task-none');
  assert.deepEqual(empty.restored, []);
  assert.deepEqual(empty.failed, []);
});

test('清理后目录不存在', () => {
  store.clear('task-1');
  assert.equal(existsSync(join(storeDir, 'task-1')), false);
});
