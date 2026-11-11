/**
 * `fs.readFile` 的寻址读：行号、offset/limit、总行数、超限。
 *
 * 钉住的是四件事：
 * 1. 默认能读到整份小文件；大文件按 2000 行分页；
 * 2. `content` 保持无行号原文，`numbered` 才带行号；
 * 3. `sha256` 永远按整份文件算（分页读两次必须一致，才能回填给 fs.edit）；
 * 4. 行数口径与工程分析那条只读通道一致（1-based，末尾换行不算一行）。
 *
 * Run with: npm run test:code-read
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filesystemTools } from '../out-test/agent/tools/filesystem.js';
import { fsExtraTools } from '../out-test/agent/tools/fs-extra.js';

const root = mkdtempSync(join(tmpdir(), 'tf-code-read-'));
after(() => rmSync(root, { recursive: true, force: true }));

const grant = {
  taskId: 'task-read',
  permissionPreset: 'read-only',
  approvalPolicy: 'ask',
  rootDir: root,
  allowedTools: ['fs.readFile', 'fs.stat'],
  expiresAt: Date.now() + 60_000,
  maxSteps: 30,
  grantVersion: 1
};

const big = Array.from({ length: 3000 }, (_, index) => `line-${String(index + 1)}`).join('\n') + '\n';
writeFileSync(join(root, 'big.txt'), big);
writeFileSync(join(root, 'small.txt'), 'alpha\nbeta\ngamma\n');
writeFileSync(join(root, 'empty.txt'), '');
mkdirSync(join(root, 'dir'));
writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));

test('小文件默认读全文：totalLines、content、numbered 都对', async () => {
  const result = await filesystemTools.readFile(grant, { path: 'small.txt' });
  assert.equal(result.totalLines, 3);
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.content, 'alpha\nbeta\ngamma\n');
  assert.equal(result.numbered, '1\talpha\n2\tbeta\n3\tgamma');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('大文件按 offset/limit 分页：行号从 1 开始，content 不带前缀', async () => {
  const result = await filesystemTools.readFile(grant, { path: 'big.txt', offset: 1500, limit: 2 });
  assert.equal(result.totalLines, 3000);
  assert.equal(result.startLine, 1500);
  assert.equal(result.endLine, 1501);
  assert.equal(result.truncated, true);
  assert.equal(result.content, 'line-1500\nline-1501\n');
  assert.equal(result.numbered, '1500\tline-1500\n1501\tline-1501');
});

test('不传 limit 时默认 2000 行，不会把整份 3000 行塞回来', async () => {
  const result = await filesystemTools.readFile(grant, { path: 'big.txt' });
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 2000);
  assert.equal(result.truncated, true);
  assert.equal(result.content.replace(/\n$/, '').split('\n').length, 2000);
});

test('分页读两次的 sha256 一致：expectedHash 不会被窗口改变', async () => {
  const first = await filesystemTools.readFile(grant, { path: 'big.txt', offset: 1, limit: 10 });
  const second = await filesystemTools.readFile(grant, { path: 'big.txt', offset: 2500, limit: 10 });
  assert.equal(first.sha256, second.sha256);
});

test('offset 超过末尾时停在最后一行，不返回空窗口', async () => {
  const result = await filesystemTools.readFile(grant, { path: 'big.txt', offset: 99999, limit: 10 });
  assert.equal(result.startLine, 3000);
  assert.equal(result.endLine, 3000);
  assert.equal(result.content, 'line-3000\n');
  assert.equal(result.truncated, false);
});

test('空文件是 0 行，不抛错', async () => {
  const result = await filesystemTools.readFile(grant, { path: 'empty.txt' });
  assert.equal(result.totalLines, 0);
  assert.equal(result.content, '');
  assert.equal(result.numbered, '');
});

test('目录不按文件读，让调用方改用 fs.list', async () => {
  await assert.rejects(() => filesystemTools.readFile(grant, { path: 'dir' }), /普通文件/);
});

test('fs.stat 给小文本文件总行数，二进制不统计', async () => {
  const small = await fsExtraTools.stat(grant, { path: 'small.txt' });
  assert.equal(small.lines, 3);
  const binary = await fsExtraTools.stat(grant, { path: 'blob.bin' });
  assert.equal(binary.lines, undefined);
});

test('超过 8MB 的读取明确报上限并提示改用搜索', async () => {
  const huge = join(root, 'huge.txt');
  writeFileSync(huge, 'x'.repeat(8 * 1024 * 1024 + 16));
  await assert.rejects(
    () => filesystemTools.readFile(grant, { path: 'huge.txt' }),
    /超过读取上限.*fs\.search/
  );
});
