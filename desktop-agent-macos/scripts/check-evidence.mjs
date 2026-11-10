/**
 * 执行证据账本：从步骤结果抽事实，不许把「看一眼」记成证据。
 *
 * Run with: npm run test:evidence
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEvidenceLedger,
  evidenceFromStep
} from '../out-test/shared/engineering-evidence.js';

test('读文件：带路径、哈希与行数', () => {
  const ref = evidenceFromStep({
    tool: 'fs.readFile',
    args: { path: 'src/index.ts' },
    result: { path: '/tmp/proj/src/index.ts', bytes: 120, sha256: 'abc', lines: 664, content: '…' }
  });
  assert.deepEqual(ref, {
    kind: 'file',
    path: '/tmp/proj/src/index.ts',
    lines: 664,
    sha256: 'abc'
  });
});

test('写文件：结果是文件事实，不是「成功」', () => {
  const ref = evidenceFromStep({
    tool: 'fs.writeFile',
    args: { path: 'a.md', content: 'x' },
    result: { created: true, path: '/tmp/a.md', bytes: 1 }
  });
  assert.equal(ref.kind, 'file');
  assert.equal(ref.path, '/tmp/a.md');
});

test('前台命令：退出码原样记录', () => {
  const ref = evidenceFromStep({
    tool: 'shell.run',
    args: { command: 'npm test' },
    result: { command: 'npm test', exitCode: 1, timedOut: false }
  });
  assert.equal(ref.kind, 'command');
  assert.equal(ref.command, 'npm test');
  assert.equal(ref.exitCode, 1);
  assert.equal(ref.background, undefined);
});

test('后台作业：exitCode null 且标 background，不能被判成失败', () => {
  const ref = evidenceFromStep({
    tool: 'shell.run',
    args: { command: 'npm run dev', background: true },
    result: { jobId: 'job-1', exitCode: null }
  });
  assert.equal(ref.kind, 'command');
  assert.equal(ref.exitCode, null);
  assert.equal(ref.background, true);
});

test('抓网页：记 URL 与抓取时间', () => {
  const ref = evidenceFromStep(
    { tool: 'web.fetch', args: { url: 'https://example.com' }, result: { status: 200, url: 'https://example.com' } },
    123
  );
  assert.deepEqual(ref, { kind: 'url', url: 'https://example.com', fetchedAt: 123 });
});

test('只是看了一眼的步骤不产生证据', () => {
  assert.equal(evidenceFromStep({ tool: 'fs.list', args: {}, result: { entries: ['a'] } }), null);
  assert.equal(evidenceFromStep({ tool: 'job.list', args: {}, result: { jobs: [] } }), null);
  assert.equal(evidenceFromStep({ tool: 'shell.run', args: {}, result: undefined }), null);
});

test('同一文件读两次只记一条，后一次覆盖前一次', () => {
  const ledger = buildEvidenceLedger([
    { tool: 'fs.readFile', result: { path: '/a.ts', sha256: 'old' } },
    { tool: 'fs.readFile', result: { path: '/a.ts', sha256: 'new' } },
    { tool: 'fs.readFile', result: { path: '/b.ts' } }
  ]);
  assert.equal(ledger.refs.length, 2);
  assert.equal(ledger.refs.find(ref => ref.path === '/a.ts').sha256, 'new');
});

test('主族随账本一起记，界面能显示这次在做什么', () => {
  const ledger = buildEvidenceLedger([{ tool: 'fs.stat', result: { path: '/a' } }], 'code.read');
  assert.equal(ledger.primaryFamily, 'code.read');
  assert.equal(ledger.refs.length, 1);
});
