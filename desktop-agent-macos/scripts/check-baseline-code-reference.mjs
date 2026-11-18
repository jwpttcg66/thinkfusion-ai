/**
 * P2 基准一致性：源码引用必须从开场 Pack/commit 恢复，不能读当前工作区。
 *
 * Run with: npm run test:baseline-code-reference
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishRepositorySnapshot } from '../out-test/main/evidence-pack/repository-snapshot.js';
import { resolveBaselineCodeReference, reconstructDirtyFile } from '../out-test/main/evidence-pack/baseline-code-reference-resolver.js';
import { resolveRepositoryContext } from '../out-test/main/evidence-pack/repository.js';
import { snapshotFingerprint } from '../out-test/main/evidence-pack/snapshot.js';
import { itemHashOf, manifestHashOf } from '../out-test/main/evidence-pack/hash.js';
import { EvidencePackStore } from '../out-test/main/evidence-pack/store.js';

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid'
    }
  }).trim();
}

function makeRepo({ dirty = false, cleanFile = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-baseline-ref-'));
  git(root, ['init', '-q']);
  if (cleanFile) fs.writeFileSync(path.join(root, 'clean.ts'), 'export const clean = 1;\nexport const clean2 = 2;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  if (dirty) {
    fs.writeFileSync(path.join(root, 'src.ts'), 'export const a = 10;\nexport const b = 20;\nexport const c = 30;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'untracked.ts'), 'export const u = 40;\n', 'utf8');
  }
  return root;
}

function harness(root, debateId = 'debate-baseline') {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-baseline-store-'));
  const store = new EvidencePackStore(storeDir);
  const context = resolveRepositoryContext(root).context;
  assert.ok(context);
  const pack = publishRepositorySnapshot({ store, ownerId: debateId, context, createdAt: 1 });
  const state = {
    debateId,
    repository: {
      root: context.root,
      commit: context.commit,
      branch: context.branch,
      dirty: context.dirty,
      ...(context.dirtyFingerprint ? { dirtyFingerprint: context.dirtyFingerprint } : {})
    },
    evidencePack: { status: pack.status, baselinePackId: pack.snapshotPackId }
  };
  return { store, storeDir, context, pack, state };
}

function candidate(path, startLine, endLine = startLine) {
  return { path, startLine, endLine, confidence: 'explicit-line', raw: `${path}:${startLine}` };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('干净仓库：引用从开场 commit 恢复，辩论后改工作区不影响', () => {
  const root = makeRepo();
  const h = harness(root);
  try {
    const before = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 2)
    });
    assert.equal(before.status, 'baseline-verified', JSON.stringify(before.error));
    assert.equal(before.resolved.source, 'git-commit');
    assert.equal(before.resolved.content, 'export const b = 2;');
    const firstHash = before.resolved.excerptHash;

    fs.writeFileSync(path.join(root, 'src.ts'), 'changed\n', 'utf8');
    const after = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 2)
    });
    assert.equal(after.status, 'baseline-verified');
    assert.equal(after.resolved.content, 'export const b = 2;');
    assert.equal(after.resolved.excerptHash, firstHash);
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('dirty 文件：修改与未跟踪文件只从 Pack 恢复，辩论后再改也不受影响', () => {
  const root = makeRepo({ dirty: true });
  const h = harness(root);
  try {
    const modified = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1, 2)
    });
    assert.equal(modified.status, 'baseline-verified', JSON.stringify(modified.error));
    assert.equal(modified.resolved.source, 'dirty-overlay');
    assert.equal(modified.resolved.content, 'export const a = 10;\nexport const b = 20;');

    const untracked = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('untracked.ts', 1)
    });
    assert.equal(untracked.status, 'baseline-verified');
    assert.equal(untracked.resolved.content, 'export const u = 40;');

    fs.writeFileSync(path.join(root, 'src.ts'), 'after debate\n', 'utf8');
    fs.rmSync(path.join(root, 'untracked.ts'));
    const again = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1, 2)
    });
    assert.equal(again.resolved.content, 'export const a = 10;\nexport const b = 20;');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('跨 chunk 重组：引用范围跨边界仍得到完整片段', () => {
  const root = makeRepo({ dirty: true });
  const lines = Array.from({ length: 80 }, (_, index) => `line ${String(index + 1)} ${'x'.repeat(30)}`);
  fs.writeFileSync(path.join(root, 'src.ts'), `${lines.join('\n')}\n`, 'utf8');
  const h = harness(root);
  try {
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 44, 48)
    });
    assert.equal(result.status, 'baseline-verified', JSON.stringify(result.error));
    assert.equal(result.resolved.content, lines.slice(43, 48).join('\n'));
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('仓库 dirty 时，开场干净的文件仍从 commit 读', () => {
  const root = makeRepo({ dirty: true });
  const h = harness(root);
  try {
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('clean.ts', 2)
    });
    assert.equal(result.status, 'baseline-verified', JSON.stringify(result.error));
    assert.equal(result.resolved.source, 'git-commit');
    assert.equal(result.resolved.content, 'export const clean2 = 2;');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('基准漂移：HEAD 已变化，仍从开场 commit 恢复', () => {
  const root = makeRepo();
  const h = harness(root);
  try {
    fs.writeFileSync(path.join(root, 'src.ts'), 'second\n', 'utf8');
    git(root, ['add', 'src.ts']);
    git(root, ['commit', '-qm', 'second']);
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 2)
    });
    assert.equal(result.status, 'baseline-verified');
    assert.equal(result.resolved.content, 'export const b = 2;');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('Pack 损坏：返回 rejected，不产生 baseline-verified', () => {
  const root = makeRepo({ dirty: true });
  const h = harness(root);
  try {
    const replay = h.store.replay(h.pack.snapshotPackId);
    fs.writeFileSync(
      path.join(h.storeDir, 'packs', h.pack.snapshotPackId, 'blobs', replay.items[0].contentHash),
      'tampered',
      'utf8'
    );
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1)
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'PACK_CORRUPT');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('partial 基准：未冻结文件拒绝；其它文件只能标 partial', () => {
  const root = makeRepo({ dirty: true });
  fs.rmSync(path.join(root, 'src.ts'));
  const h = harness(root);
  try {
    const unfrozen = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1)
    });
    assert.equal(unfrozen.status, 'rejected');
    assert.equal(unfrozen.error.code, 'FILE_UNFROZEN');

    const clean = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('clean.ts', 1)
    });
    assert.equal(clean.status, 'partial');
    assert.equal(clean.resolved.snapshotVerification, 'partial');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('旧 dirty Pack 没有快照元数据：拒绝恢复，不猜', () => {
  const root = makeRepo({ dirty: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-baseline-store-'));
  try {
    const store = new EvidencePackStore(storeDir);
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    const published = store.publish({
      repoRoot: root,
      idempotencyKey: 'old-pack',
      repo: { commit: context.commit, dirty: true },
      items: [{
        kind: 'source-file',
        source: { commit: context.commit, path: 'src.ts' },
        locator: { path: 'src.ts', startLine: 1, endLine: 1 },
        meta: { tool: 'old', capturedAt: 1 }
      }]
    });
    const state = {
      debateId: 'old',
      repository: { root: context.root, commit: context.commit, branch: context.branch, dirty: true },
      evidencePack: { status: 'complete', baselinePackId: published.manifest.packId }
    };
    const result = resolveBaselineCodeReference({
      state,
      baselinePackId: published.manifest.packId,
      store,
      candidate: candidate('src.ts', 1)
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'SNAPSHOT_MISSING');
  } finally {
    cleanup(root, storeDir);
  }
});

test('chunk 重叠/缺口：直接拒绝，不重组半份文件', () => {
  const item = (start, end, content) => ({
    itemId: `i-${start}`,
    kind: 'source-file',
    source: { commit: 'c', path: 'a.ts' },
    locator: { path: 'a.ts', startLine: start, endLine: end },
    content,
    contentHash: 'unused',
    meta: { tool: 't', capturedAt: 1 }
  });
  const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
  const ranges = [
    { startLine: 1, endLine: 1, contentHash: hash('a') },
    { startLine: 3, endLine: 3, contentHash: hash('c') }
  ];
  const gap = reconstructDirtyFile({ path: 'a.ts', ranges, issues: [] }, [item(1, 1, 'a'), item(3, 3, 'c')]);
  assert.equal(gap.code, 'CHUNK_GAP');

  const overlap = reconstructDirtyFile(
    { path: 'a.ts', ranges: [{ startLine: 1, endLine: 2, contentHash: hash('a\nb') }, { startLine: 2, endLine: 3, contentHash: hash('b\nc') }], issues: [] },
    [item(1, 2, 'a\nb'), item(2, 3, 'b\nc')]
  );
  assert.equal(overlap.code, 'CHUNK_OVERLAP');
});

test('Hash 语义：excerptHash 是片段 sha256，不是 Pack blob hash', () => {
  const root = makeRepo();
  const h = harness(root);
  try {
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1)
    });
    const expected = createHash('sha256').update('export const a = 1;', 'utf8').digest('hex');
    const blob = createHash('sha256').update(`blob\0export const a = 1;`, 'utf8').digest('hex');
    assert.equal(result.resolved.excerptHash, expected);
    assert.notEqual(result.resolved.excerptHash, blob);
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('fingerprint 对行号/内容变化敏感', () => {
  const base = { path: 'a.ts', ranges: [{ startLine: 1, endLine: 1, contentHash: 'h' }], issues: [] };
  const snapshot = { version: 1, dirty: true, dirtyFingerprint: 'x', files: [base], errors: [] };
  const first = snapshotFingerprint(snapshot);
  const moved = snapshotFingerprint({ ...snapshot, files: [{ ...base, ranges: [{ startLine: 2, endLine: 2, contentHash: 'h' }] }] });
  const content = snapshotFingerprint({ ...snapshot, files: [{ ...base, ranges: [{ startLine: 1, endLine: 1, contentHash: 'other' }] }] });
  const issue = snapshotFingerprint({ ...snapshot, files: [{ ...base, issues: [{ code: 'binary', path: 'a.ts', message: 'x' }] }] });
  assert.notEqual(first, moved);
  assert.notEqual(first, content);
  assert.notEqual(first, issue);
});

test('commit / fingerprint 与辩论状态不一致：拒绝', () => {
  const root = makeRepo({ dirty: true });
  const h = harness(root);
  try {
    const wrongCommit = {
      ...h.state,
      repository: { ...h.state.repository, commit: 'f'.repeat(40) }
    };
    const commitMismatch = resolveBaselineCodeReference({
      state: wrongCommit,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1)
    });
    assert.equal(commitMismatch.status, 'rejected');
    assert.equal(commitMismatch.error.code, 'PACK_MISMATCH');

    const wrongFingerprint = {
      ...h.state,
      repository: { ...h.state.repository, dirtyFingerprint: '0'.repeat(64) }
    };
    const fingerprintMismatch = resolveBaselineCodeReference({
      state: wrongFingerprint,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1)
    });
    assert.equal(fingerprintMismatch.status, 'rejected');
    assert.equal(fingerprintMismatch.error.code, 'FINGERPRINT_MISMATCH');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('开场 commit 中的符号链接 / 开场不存在的文件：拒绝', () => {
  const root = makeRepo();
  fs.symlinkSync('clean.ts', path.join(root, 'link.ts'));
  git(root, ['add', 'link.ts']);
  git(root, ['commit', '-qm', 'link']);
  const h = harness(root);
  try {
    const link = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('link.ts', 1)
    });
    assert.equal(link.status, 'rejected');
    assert.equal(link.error.code, 'SYMLINK');

    fs.writeFileSync(path.join(root, 'created-later.ts'), 'later\n', 'utf8');
    const created = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('created-later.ts', 1)
    });
    assert.equal(created.status, 'rejected');
    assert.equal(created.error.code, 'FILE_NOT_IN_BASELINE');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('引用片段超限：拒绝，不截断后伪装成完整证据', () => {
  const root = makeRepo({ dirty: true });
  const lines = Array.from({ length: 120 }, (_, index) => `line ${String(index + 1)} ${'y'.repeat(30)}`);
  fs.writeFileSync(path.join(root, 'src.ts'), `${lines.join('\n')}\n`, 'utf8');
  const h = harness(root);
  try {
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1, 120)
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'RANGE_TOO_LARGE');
  } finally {
    cleanup(root, h.storeDir);
  }
});

test('快照元数据被篡改：manifest 校验失败，不能当有效基准', () => {
  const root = makeRepo({ dirty: true });
  const h = harness(root);
  try {
    const manifestPath = path.join(h.storeDir, 'packs', h.pack.snapshotPackId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.snapshot.dirtyFingerprint = '0'.repeat(64);
    manifest.manifestHash = manifestHashOf({
      commit: manifest.repo.commit,
      itemHashes: manifest.items.map(itemHashOf),
      snapshot: manifest.snapshot
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const result = resolveBaselineCodeReference({
      state: h.state,
      baselinePackId: h.pack.snapshotPackId,
      store: h.store,
      candidate: candidate('src.ts', 1)
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'PACK_CORRUPT');
  } finally {
    cleanup(root, h.storeDir);
  }
});
