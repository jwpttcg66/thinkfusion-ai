/**
 * Gate 2：Evidence Pack 最小实现。
 *
 * 钉住的是契约里「不做会悄悄错」的几条：
 * - 位置与内容冻结：行号越界失败，不截断；
 * - hash 只收稳定字段：同内容换 createdAt 仍是同一份；
 * - 同幂等键同内容复用、不同内容冲突，旧 Pack 不被覆盖；
 * - 读回校验 manifest 与每个 blob，损坏要报错；
 * - 映射出 `snapshot` / `repo-snapshot`，合成 messageId，不冒充真实发言；
 * - 同一文件的多个片段不是多个独立来源；
 * - 旧辩论文件没有新字段时读成 undefined，不补假数据。
 *
 * Run with: npm run test:evidence-pack
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { packIdOf } from '../out-test/main/evidence-pack/hash.js';
import { mapPackToDebateEvidence, packEvidenceIdOf } from '../out-test/main/evidence-pack/mapping.js';
import { EvidencePackStore } from '../out-test/main/evidence-pack/store.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-evidence-pack-'));
  const repo = path.join(root, 'repo');
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src', 'math.ts'),
    [
      '// fixture',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(repo, 'src', 'main.ts'),
    ["import { multiply } from './math';", '', 'export const area = (w: number, h: number) => multiply(w, h);', ''].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(repo, 'docs.md'), '# 设计\n\n冻结快照先冻结内容，再冻结位置。\n', 'utf8');
  return { root, repo, storeDir };
}

function draft(repo, overrides = {}) {
  const commit = 'c0ffee';
  return {
    repoRoot: repo,
    idempotencyKey: 'debate-1:round-0',
    repo: { commit, dirty: false },
    createdAt: 1000,
    items: [
      {
        kind: 'source-file',
        source: { commit },
        locator: { path: 'src/math.ts', startLine: 1, endLine: 4 },
        meta: { tool: 'test', capturedAt: 999 }
      },
      {
        kind: 'symbol',
        source: { commit },
        locator: { path: 'src/math.ts', startLine: 6, endLine: 8, symbolId: 'sym_multiply', symbolName: 'multiply' },
        meta: { tool: 'test', capturedAt: 999 }
      },
      {
        kind: 'call-edge',
        source: { commit },
        locator: { path: 'src/main.ts', startLine: 3, endLine: 3 },
        meta: { tool: 'test', capturedAt: 999 }
      }
    ],
    ...overrides
  };
}

test('发布后读回：条目内容、行号、hash 都对得上', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const result = store.publish(draft(repo));
    assert.equal(result.reused, false);
    assert.equal(result.manifest.items.length, 3);
    assert.match(result.manifest.manifestHash, /^[a-f0-9]{64}$/);
    assert.equal(result.manifest.packId, packIdOf('debate-1:round-0'));

    const read = store.get(result.manifest.packId);
    assert.ok(read);
    const symbol = read.items.find(item => item.kind === 'symbol');
    assert.match(symbol.content, /export function multiply/);
    assert.equal(symbol.locator.startLine, 6);
    const call = read.items.find(item => item.kind === 'call-edge');
    assert.match(call.content, /multiply\(w, h\)/);
    assert.equal(call.locator.endLine, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同幂等键 + 同内容：复用，createdAt 不参与 hash', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const first = store.publish(draft(repo, { createdAt: 1000 }));
    const again = store.publish(draft(repo, { createdAt: 999999 }));
    assert.equal(again.reused, true);
    assert.equal(again.manifest.manifestHash, first.manifest.manifestHash);
    assert.equal(again.manifest.createdAt, 1000, '复用已有 Pack，不重写时间');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同幂等键 + 内容变了：明确冲突，旧 Pack 不动', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const first = store.publish(draft(repo));
    const file = path.join(repo, 'src', 'math.ts');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a * b', 'a * b + 0'), 'utf8');

    assert.throws(
      () => store.publish(draft(repo)),
      error => error.code === 'PACK_CONFLICT'
    );
    const read = store.get(first.manifest.packId);
    assert.ok(read);
    assert.match(read.items.find(item => item.kind === 'symbol').content, /return a \* b;/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('行号越界 / 绝对路径 / 越出仓库：直接失败，不留半成品', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const badRange = draft(repo);
    badRange.items[0].locator.endLine = 999;
    assert.throws(
      () => store.publish(badRange),
      error => error.code === 'INVALID_RANGE'
    );

    const absolute = draft(repo, { idempotencyKey: 'debate-1:absolute' });
    absolute.items[0].locator.path = path.join(repo, 'src', 'math.ts');
    assert.throws(
      () => store.publish(absolute),
      error => error.code === 'INVALID_PATH'
    );

    const escaping = draft(repo, { idempotencyKey: 'debate-1:escaping' });
    escaping.items[0].locator.path = '../math.ts';
    assert.throws(
      () => store.publish(escaping),
      error => error.code === 'INVALID_PATH'
    );

    const names = fs.readdirSync(path.join(storeDir, 'packs'));
    assert.deepEqual(names, [], '失败不发布任何 Pack 目录');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manifest 篡改 / blob 损坏 / 未知版本都能发现', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const { manifest } = store.publish(draft(repo));
    const packId = manifest.packId;

    const copyRoot = path.join(root, 'copies');
    fs.mkdirSync(path.join(copyRoot, 'packs'), { recursive: true });

    const tampered = path.join(copyRoot, 'packs', 'tampered');
    fs.cpSync(path.join(storeDir, 'packs', packId), tampered, { recursive: true });
    const tamperedFile = path.join(tampered, 'manifest.json');
    const tamperedManifest = JSON.parse(fs.readFileSync(tamperedFile, 'utf8'));
    tamperedManifest.items[0].locator.startLine = 2;
    fs.writeFileSync(tamperedFile, JSON.stringify(tamperedManifest), 'utf8');
    fs.renameSync(tampered, path.join(copyRoot, 'packs', packId));
    assert.throws(
      () => new EvidencePackStore(copyRoot).get(packId),
      error => error.code === 'MANIFEST_CORRUPT'
    );
    fs.rmSync(path.join(copyRoot, 'packs', packId), { recursive: true, force: true });

    const corruptRoot = path.join(root, 'corrupt');
    fs.mkdirSync(path.join(corruptRoot, 'packs'), { recursive: true });
    fs.cpSync(path.join(storeDir, 'packs', packId), path.join(corruptRoot, 'packs', packId), { recursive: true });
    const corruptStore = new EvidencePackStore(corruptRoot);
    const blob = path.join(corruptRoot, 'packs', packId, 'blobs', manifest.items[0].contentHash);
    fs.writeFileSync(blob, 'tampered', 'utf8');
    assert.throws(() => corruptStore.get(packId), error => error.code === 'BLOB_CORRUPT');

    const versionRoot = path.join(root, 'version');
    fs.mkdirSync(path.join(versionRoot, 'packs'), { recursive: true });
    fs.cpSync(path.join(storeDir, 'packs', packId), path.join(versionRoot, 'packs', packId), { recursive: true });
    const versionFile = path.join(versionRoot, 'packs', packId, 'manifest.json');
    const versionManifest = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    versionManifest.schemaVersion = 99;
    fs.writeFileSync(versionFile, JSON.stringify(versionManifest), 'utf8');
    assert.throws(
      () => new EvidencePackStore(versionRoot).get(packId),
      error => error.code === 'UNSUPPORTED_VERSION'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('映射：snapshot / repo-snapshot / 合成 messageId，不冒充真实发言', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const { manifest } = store.publish(draft(repo));
    const pack = store.replay(manifest.packId);

    const mapped = mapPackToDebateEvidence(pack, {
      links: [
        { itemId: manifest.items[1].itemId, claimId: 'c1', relation: 'supports' },
        { itemId: manifest.items[2].itemId, claimId: 'c1', relation: 'contradicts' },
        { itemId: manifest.items[2].itemId, claimId: 'c2', relation: 'context' }
      ]
    });
    assert.equal(mapped.length, 3);

    const symbol = mapped.find(item => item.evidenceId === packEvidenceIdOf(manifest.packId, manifest.items[1].itemId));
    assert.ok(symbol);
    assert.equal(symbol.verified, 'snapshot');
    assert.equal(symbol.origin, 'repo-snapshot');
    assert.equal(symbol.roundIndex, -1);
    assert.equal(symbol.messageId, symbol.evidenceId, '合成 id，不能指向真实消息');
    assert.equal(symbol.span.messageId, symbol.evidenceId);
    assert.deepEqual(symbol.claimIds, ['c1']);
    assert.equal(symbol.kind, 'source-code');
    assert.match(symbol.url, /^repo:\/\/c0ffee\/src\/math\.ts#L6-L8$/);
    assert.ok(symbol.fingerprint.length > 0);

    const call = mapped.find(item => item.evidenceId === packEvidenceIdOf(manifest.packId, manifest.items[2].itemId));
    assert.ok(call);
    assert.deepEqual(call.claimIds, ['c1'], 'context 不进 claimIds');

    const sameFile = mapped.filter(item => item.originKey === 'repo:c0ffee:src/math.ts');
    assert.equal(sameFile.length, 2);
    assert.equal(sameFile.filter(item => item.independent).length, 1, '同一文件只算一个独立来源');
    const duplicate = sameFile.find(item => !item.independent);
    assert.ok(duplicate.duplicateOf, '同源条目要指回第一条');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doc-excerpt：显式 sourceType 才映射；没有就拒绝猜', () => {
  const { root, repo, storeDir } = fixture();
  try {
    const store = new EvidencePackStore(storeDir);
    const commit = 'c0ffee';
    const good = store.publish({
      repoRoot: repo,
      idempotencyKey: 'doc:good',
      repo: { commit },
      items: [
        {
          kind: 'doc-excerpt',
          source: { commit },
          locator: { path: 'docs.md', startLine: 3, endLine: 3 },
          meta: { tool: 'test', capturedAt: 1, sourceType: 'official-doc' }
        }
      ]
    });
    const goodMapped = mapPackToDebateEvidence(store.replay(good.manifest.packId));
    assert.equal(goodMapped[0].kind, 'official-doc');

    const bad = store.publish({
      repoRoot: repo,
      idempotencyKey: 'doc:bad',
      repo: { commit },
      items: [
        {
          kind: 'doc-excerpt',
          source: { commit },
          locator: { path: 'docs.md', startLine: 3, endLine: 3 },
          meta: { tool: 'test', capturedAt: 1 }
        }
      ]
    });
    assert.throws(
      () => mapPackToDebateEvidence(store.replay(bad.manifest.packId)),
      error => error.code === 'UNMAPPED_ITEM'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧辩论文件没有 claimEvidenceLinks：读成 undefined，不补空数组', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-legacy-'));
  try {
    fs.writeFileSync(
      path.join(root, 'legacy-1.json'),
      JSON.stringify({
        debateId: 'legacy-1',
        question: '旧问题',
        config: { strategy: 'standard', maxRounds: 1, participants: [] },
        status: 'completed',
        rounds: [],
        minorities: [],
        createdAt: 1,
        updatedAt: 2
      }),
      'utf8'
    );
    const state = new DebateStore(root).get('legacy-1');
    assert.ok(state);
    assert.equal(state.claimEvidenceLinks, undefined);
    assert.equal(state.evidence, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
