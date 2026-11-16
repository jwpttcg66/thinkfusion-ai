/**
 * P2 工程证据生产者第一层：代码引用识别与源码定位。
 *
 * 钉住三件事：
 * - 只认 `path:line` / `path#Lx-Ly`，路径+行号必须能在真实仓库里验证；
 * - 路径穿越、绝对路径、符号链接、二进制、越界行号一律拒绝；
 * - 只有路径没有行号时只产生候选，不产生证据。
 *
 * Run with: npm run test:code-references
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractAndResolveCodeReferences,
  extractCodeReferences,
  resolveCodeReference
} from '../out-test/main/evidence-pack/code-references.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-code-refs-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    ['export const a = 1;', 'export const b = 2;', 'export const c = 3;', ''].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(root, 'src', 'bin.dat'), Buffer.from([0, 1, 2]));
  return root;
}

test('提取 path:line / path#Lx-Ly，并去重', () => {
  const candidates = extractCodeReferences(
    '看 src/a.ts:2-3，再看 src/a.ts#L2-L3，还有 `src/a.ts`。'
  );
  const explicit = candidates.filter(item => item.confidence === 'explicit-line');
  assert.equal(explicit.length, 1, '同一 path/行范围只保留一个');
  assert.equal(explicit[0].path, 'src/a.ts');
  assert.equal(explicit[0].startLine, 2);
  assert.equal(explicit[0].endLine, 3);
  const pathOnly = candidates.find(item => item.confidence === 'path-only');
  assert.ok(pathOnly);
});

test('URL 里的文件名不被当成仓库引用', () => {
  const candidates = extractCodeReferences('来源 https://example.com/src/a.ts:2 不是本地文件');
  assert.equal(candidates.length, 0, candidates.map(item => item.raw).join(' | '));
});

test('定位：行号、内容、hash 与文件一致', () => {
  const root = fixture();
  try {
    const [candidate] = extractCodeReferences('src/a.ts:2-3');
    const outcome = resolveCodeReference(root, candidate);
    assert.ok(outcome.resolved, outcome.error);
    assert.equal(outcome.resolved.path, 'src/a.ts');
    assert.equal(outcome.resolved.startLine, 2);
    assert.equal(outcome.resolved.endLine, 3);
    assert.equal(outcome.resolved.content, 'export const b = 2;\nexport const c = 3;');
    assert.match(outcome.resolved.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(outcome.resolved.lineCount, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('路径安全：绝对路径、穿越、缺失、符号链接都拒绝', () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-outside-'));
  try {
    const secret = path.join(outside, 'secret.ts');
    fs.writeFileSync(secret, 'secret\n', 'utf8');
    fs.symlinkSync(secret, path.join(root, 'src', 'link.ts'));

    for (const [candidate, pattern] of [
      [{ path: '/etc/passwd', startLine: 1, endLine: 1, confidence: 'explicit-line', raw: '' }, /非法路径/],
      [{ path: '../secret.ts', startLine: 1, endLine: 1, confidence: 'explicit-line', raw: '' }, /非法路径/],
      [{ path: 'src/missing.ts', startLine: 1, endLine: 1, confidence: 'explicit-line', raw: '' }, /文件不存在/],
      [{ path: 'src/link.ts', startLine: 1, endLine: 1, confidence: 'explicit-line', raw: '' }, /符号链接/]
    ]) {
      const outcome = resolveCodeReference(root, candidate);
      assert.equal(outcome.resolved, undefined);
      assert.match(outcome.error, pattern, `${candidate.path}: ${outcome.error}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('行号越界、二进制文件、只有路径没有行号都不产生证据', () => {
  const root = fixture();
  try {
    const cases = [
      [{ path: 'src/a.ts', startLine: 9, endLine: 9, confidence: 'explicit-line', raw: '' }, /行号越界/],
      [{ path: 'src/bin.dat', startLine: 1, endLine: 1, confidence: 'explicit-line', raw: '' }, /二进制/],
      [{ path: 'src/a.ts', confidence: 'path-only', raw: '' }, /没有行号/]
    ];
    for (const [candidate, pattern] of cases) {
      const outcome = resolveCodeReference(root, candidate);
      assert.equal(outcome.resolved, undefined);
      assert.match(outcome.error, pattern);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('批量提取：有效引用进 resolved，错误逐条进 errors', () => {
  const root = fixture();
  try {
    const batch = extractAndResolveCodeReferences(
      'src/a.ts:1 有效；src/missing.ts:1 不存在；`src/a.ts` 只有路径。',
      root
    );
    assert.equal(batch.resolved.length, 1);
    assert.equal(batch.resolved[0].path, 'src/a.ts');
    assert.ok(batch.errors.some(error => error.includes('文件不存在')));
    assert.ok(batch.errors.some(error => error.includes('没有行号')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
