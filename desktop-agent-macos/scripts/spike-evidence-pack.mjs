#!/usr/bin/env node
/**
 * Gate 1A：Evidence Pack 最小 Spike。
 *
 * 这不是正式实现，也不被产品代码引用。它只用来回答一个问题：
 * 「按 Gate 1 契约里的 hash / 冻结 / 映射 / 回放规则，能不能在一个真实
 * TypeScript 小仓库上跑通，并且旧快照确实不会被动到？」
 *
 * 刻意自带一套最小的 canonicalJson / sha256 / publish / readPack，
 * 而不是先写生产模块：如果 Spike 的规则要改，改这里没有兼容负担；
 * 通过之后再把这套规则搬进 `src/main/evidence-pack/`。
 *
 * 用法：
 *   node scripts/spike-evidence-pack.mjs [--keep]
 *
 * 退出码 0 表示全部验收项通过。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = process.argv.includes('--keep');
const SCHEMA_VERSION = 1;
let tempSeq = 0;

/* ---------- 规则：canonical JSON 与 hash ---------- */

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function contentHashOf(content) {
  return sha256(`blob\0${content}`);
}

function itemHashOf(item) {
  return sha256(
    canonical({
      kind: item.kind,
      commit: item.source.commit,
      path: item.locator.path,
      startLine: item.locator.startLine,
      endLine: item.locator.endLine,
      symbolId: item.locator.symbolId ?? null,
      contentHash: item.contentHash
    })
  );
}

function packIdOf(idempotencyKey) {
  // 同一个逻辑快照只能有一个 packId；内容变了是冲突，不是「再来一个包」。
  return `pack_${sha256(idempotencyKey).slice(0, 16)}`;
}

function manifestHashOf({ commit, itemHashes }) {
  return sha256(
    canonical({
      schemaVersion: SCHEMA_VERSION,
      commit,
      items: [...itemHashes].sort()
    })
  );
}

/* ---------- 规则：校验与派生 ---------- */

function validatePath(relative) {
  assert.ok(typeof relative === 'string' && relative.length > 0, '路径不能为空');
  assert.ok(!path.isAbsolute(relative), `路径必须是仓库相对路径：${relative}`);
  assert.ok(!relative.includes('\\'), `路径不能含反斜杠：${relative}`);
  const normalized = path.posix.normalize(relative);
  assert.ok(!normalized.startsWith('..'), `路径不能越出仓库：${relative}`);
  return normalized;
}

function assertLineRange(locator, lineCount) {
  const { startLine, endLine } = locator;
  assert.ok(Number.isInteger(startLine) && startLine >= 1, `startLine 必须从 1 开始：${startLine}`);
  assert.ok(Number.isInteger(endLine) && endLine >= startLine, `endLine 必须 >= startLine：${endLine}`);
  assert.ok(endLine <= lineCount, `endLine ${endLine} 超过文件行数 ${lineCount}，不能截断成空证据`);
}

function deriveItem(draftItem, repoRoot) {
  const relPath = validatePath(draftItem.locator.path);
  const absolute = path.join(repoRoot, relPath);
  const source = fs.readFileSync(absolute, 'utf8');
  const lines = source.split(/\r?\n/);
  assertLineRange(draftItem.locator, lines.length);
  const content = lines.slice(draftItem.locator.startLine - 1, draftItem.locator.endLine).join('\n');
  assert.ok(content.length > 0, '证据片段不能为空');
  assert.ok(content.length <= 2000, '单条证据超过 2000 字符，应由创建方拆分而不是截断');

  const itemId = `item_${sha256(
    [
      draftItem.kind,
      relPath,
      draftItem.locator.startLine,
      draftItem.locator.endLine,
      draftItem.locator.symbolId ?? ''
    ].join('\0')
  ).slice(0, 16)}`;

  return {
    itemId,
    kind: draftItem.kind,
    source: {
      commit: draftItem.source.commit,
      path: relPath,
      language: 'typescript'
    },
    locator: {
      path: relPath,
      startLine: draftItem.locator.startLine,
      endLine: draftItem.locator.endLine,
      symbolId: draftItem.locator.symbolId,
      symbolName: draftItem.locator.symbolName
    },
    content,
    contentHash: contentHashOf(content),
    meta: {
      tool: draftItem.meta.tool,
      capturedAt: draftItem.meta.capturedAt,
      generation: draftItem.meta.generation
    }
  };
}

/* ---------- 规则：发布与回读 ---------- */

function packDir(root, packId) {
  return path.join(root, 'packs', packId);
}

function manifestPath(root, packId) {
  return path.join(packDir(root, packId), 'manifest.json');
}

function readManifest(root, packId) {
  const file = manifestPath(root, packId);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    const error = new Error(`不支持的 Pack 版本：${String(manifest.schemaVersion)}`);
    error.code = 'UNSUPPORTED_VERSION';
    throw error;
  }
  return manifest;
}

async function publish(root, draft) {
  assert.ok(draft.idempotencyKey, 'idempotencyKey 不能为空');
  const packId = packIdOf(draft.idempotencyKey);
  const repoRoot = draft.repo.root;
  const items = draft.items.map(item => deriveItem(item, repoRoot));

  const seen = new Map();
  for (const item of items) {
    const previous = seen.get(item.itemId);
    if (previous && previous.contentHash !== item.contentHash) {
      const error = new Error(`同包内 itemId 冲突：${item.itemId}`);
      error.code = 'ITEM_CONFLICT';
      throw error;
    }
    seen.set(item.itemId, item);
  }

  const itemHashes = items.map(itemHashOf);
  const manifestHash = manifestHashOf({ commit: draft.repo.commit, itemHashes });
  const target = packDir(root, packId);

  if (fs.existsSync(target)) {
    const existing = readManifest(root, packId);
    if (existing.idempotencyKey === draft.idempotencyKey && existing.manifestHash === manifestHash) {
      return { reused: true, manifest: existing };
    }
    const error = new Error('幂等键已被另一份不同内容的 Pack 占用');
    error.code = 'PACK_CONFLICT';
    throw error;
  }

  const temp = `${target}.tmp-${process.pid}-${tempSeq++}`;
  try {
    fs.mkdirSync(path.join(temp, 'blobs'), { recursive: true });
    for (const item of items) {
      fs.writeFileSync(path.join(temp, 'blobs', item.contentHash), item.content, 'utf8');
    }
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      packId,
      status: 'ready',
      idempotencyKey: draft.idempotencyKey,
      repo: { commit: draft.repo.commit, dirty: Boolean(draft.repo.dirty) },
      items: items.map(({ content, ...rest }) => ({ ...rest }) ),
      manifestHash,
      createdAt: draft.createdAt
    };
    fs.writeFileSync(path.join(temp, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(path.join(temp, 'manifest.json.tmp'), path.join(temp, 'manifest.json'));
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') {
        // 另一个调用已经先发布：只接受同一份内容，否则明确冲突。
        const winner = readManifest(root, packId);
        if (winner.idempotencyKey === draft.idempotencyKey && winner.manifestHash === manifestHash) {
          return { reused: true, manifest: winner };
        }
        const conflict = new Error('并发发布：同一幂等键已有不同内容');
        conflict.code = 'PACK_CONFLICT';
        throw conflict;
      }
      throw error;
    }
    return { reused: false, manifest };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function readPack(root, packId) {
  const manifest = readManifest(root, packId);
  const expected = manifestHashOf({
    commit: manifest.repo.commit,
    itemHashes: manifest.items.map(itemHashOf)
  });
  if (expected !== manifest.manifestHash) {
    const error = new Error('manifest hash 对不上');
    error.code = 'MANIFEST_CORRUPT';
    throw error;
  }

  const items = manifest.items.map(item => {
    const blob = path.join(packDir(root, packId), 'blobs', item.contentHash);
    const content = fs.readFileSync(blob, 'utf8');
    if (contentHashOf(content) !== item.contentHash) {
      const error = new Error(`证据内容与 hash 不符：${item.itemId}`);
      error.code = 'BLOB_CORRUPT';
      throw error;
    }
    return { ...item, content };
  });

  return { manifest, items };
}

/* ---------- fixture：一个真实的 TypeScript 小仓库 ---------- */

function makeFixture(root) {
  const repo = path.join(root, 'fixture-repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src', 'math.ts'),
    [
      '// Spike fixture: 只用来验证证据快照，不参与产品构建。',
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
    [
      "import { multiply } from './math';",
      '',
      'export function area(width: number, height: number): number {',
      '  return multiply(width, height);',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );

  let commit = 'spike-commit-1';
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=Spike', '-c', 'user.email=spike@example.invalid', 'commit', '-qm', 'fixture'],
      { cwd: repo }
    );
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    // 没有 git 也能验证快照机制；commit 用占位值，报告里说明。
  }
  return { repo, commit, git: commit !== 'spike-commit-1' };
}

function lineOf(file, pattern) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const index = lines.findIndex(line => pattern.test(line));
  assert.ok(index >= 0, `fixture 里找不到 ${String(pattern)}`);
  return { line: index + 1, lines };
}

function draftFor({ repo, commit }, idempotencyKey, capturedAt) {
  const math = path.join(repo, 'src', 'math.ts');
  const main = path.join(repo, 'src', 'main.ts');
  const symbol = lineOf(math, /export function multiply/);
  const call = lineOf(main, /multiply\(width, height\)/);
  return {
    idempotencyKey,
    createdAt: capturedAt,
    repo: { root: repo, commit, dirty: false },
    items: [
      {
        kind: 'source-file',
        source: { commit },
        locator: { path: 'src/math.ts', startLine: 1, endLine: 4 },
        meta: { tool: 'spike', capturedAt, generation: 1 }
      },
      {
        kind: 'symbol',
        source: { commit },
        locator: {
          path: 'src/math.ts',
          startLine: symbol.line,
          endLine: symbol.line + 2,
          symbolId: 'sym_multiply',
          symbolName: 'multiply'
        },
        meta: { tool: 'spike', capturedAt, generation: 1 }
      },
      {
        kind: 'call-edge',
        source: { commit },
        locator: {
          path: 'src/main.ts',
          startLine: call.line,
          endLine: call.line,
          symbolName: 'area -> multiply'
        },
        meta: { tool: 'spike', capturedAt, generation: 1 }
      }
    ]
  };
}

/* ---------- 验收 ---------- */

const results = [];
async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` · ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
    console.log(`FAIL ${name} · ${error?.stack ?? String(error)}`);
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-evidence-pack-spike-'));
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(store, 'packs'), { recursive: true });
  const fixture = makeFixture(root);
  const t0 = Date.UTC(2026, 10, 16, 4, 0, 0);

  console.log(`fixture: ${fixture.repo}`);
  console.log(`commit: ${fixture.commit}${fixture.git ? ' (git)' : ' (占位：本机无 git)'}`);

  const firstId = packIdOf('spike:first');
  const first = await publish(store, draftFor(fixture, 'spike:first', t0));

  await check('生成 1 个 Pack、3 个 Item', () => {
    assert.equal(first.manifest.items.length, 3);
    assert.equal(first.manifest.status, 'ready');
    assert.match(first.manifest.manifestHash, /^[a-f0-9]{64}$/);
    return `manifest ${first.manifest.manifestHash.slice(0, 12)}…`;
  });

  await check('行号与 fixture 一致', () => {
    const { items } = readPack(store, firstId);
    const symbol = items.find(item => item.kind === 'symbol');
    assert.match(symbol.content, /export function multiply/);
    assert.equal(symbol.locator.startLine, 6);
    const call = items.find(item => item.kind === 'call-edge');
    assert.match(call.content, /multiply\(width, height\)/);
    return 'symbol@6, call@4';
  });

  await check('Manifest 校验通过', () => {
    const { manifest } = readPack(store, firstId);
    assert.equal(manifest.manifestHash, first.manifest.manifestHash);
    return 'hash 重算一致';
  });

  await check('旧快照在源码改动后不变', () => {
    const before = readPack(store, firstId);
    const file = path.join(fixture.repo, 'src', 'math.ts');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a * b', 'a * b + 0'), 'utf8');
    const after = readPack(store, firstId);
    assert.deepEqual(after.items, before.items);
    assert.equal(after.manifest.manifestHash, before.manifest.manifestHash);
    return '旧 Pack 逐条相同';
  });

  const second = await publish(store, draftFor(fixture, 'spike:second', t0 + 1000));

  await check('改动源码后新 Pack hash 改变', () => {
    assert.notEqual(second.manifest.manifestHash, first.manifest.manifestHash);
    const firstSymbol = first.manifest.items.find(item => item.kind === 'symbol');
    const secondSymbol = second.manifest.items.find(item => item.kind === 'symbol');
    assert.notEqual(firstSymbol.contentHash, secondSymbol.contentHash);
    return `新 hash ${second.manifest.manifestHash.slice(0, 12)}…`;
  });

  await check('旧 Pack 仍可回放，且内容没被新 Pack 覆盖', () => {
    const replay = readPack(store, firstId);
    const symbol = replay.items.find(item => item.kind === 'symbol');
    assert.match(symbol.content, /return a \* b;/);
    assert.doesNotMatch(symbol.content, /\+ 0/);
    return '回放拿到旧内容';
  });

  await check('同一幂等键 + 同一内容 → 复用，不重复发布', async () => {
    const again = await publish(store, draftFor(fixture, 'spike:second', t0 + 9999));
    assert.equal(again.reused, true);
    assert.equal(again.manifest.manifestHash, second.manifest.manifestHash);
    return 'reused=true';
  });

  await check('同一幂等键 + 不同内容 → 明确冲突', async () => {
    const key = 'spike:second';
    const before = readManifest(store, packIdOf(key));
    const draft = draftFor(fixture, key, t0 + 2000);
    draft.repo.commit = 'different-commit';
    await assert.rejects(() => publish(store, draft), error => error.code === 'PACK_CONFLICT');
    const after = readManifest(store, packIdOf(key));
    assert.equal(after.manifestHash, before.manifestHash, '冲突时不能覆盖已有 Pack');
    return 'PACK_CONFLICT，旧 Pack 未被覆盖';
  });

  await check('并发发布同一幂等键 → 只产生一份，无临时目录残留', async () => {
    const draftA = draftFor(fixture, 'spike:concurrent', t0 + 3000);
    const draftB = draftFor(fixture, 'spike:concurrent', t0 + 3001);
    const outcomes = await Promise.allSettled([publish(store, draftA), publish(store, draftB)]);
    const fulfilled = outcomes.filter(item => item.status === 'fulfilled');
    assert.equal(fulfilled.length, 2, '同一内容应全部落到复用或发布成功');
    const hashes = new Set(fulfilled.map(item => item.value.manifest.manifestHash));
    assert.equal(hashes.size, 1);
    const leftovers = fs
      .readdirSync(path.join(store, 'packs'))
      .filter(name => name.startsWith(`${packIdOf('spike:concurrent')}.tmp-`));
    assert.deepEqual(leftovers, []);
    return '两份请求同一 hash';
  });

  await check('manifest 被篡改能被发现', () => {
    const copy = path.join(root, 'tampered-manifest');
    fs.cpSync(packDir(store, firstId), copy, { recursive: true });
    const file = path.join(copy, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.items[0].locator.startLine = 2;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');

    const targetRoot = path.join(root, 'tampered-root');
    fs.mkdirSync(path.join(targetRoot, 'packs'), { recursive: true });
    fs.renameSync(copy, path.join(targetRoot, 'packs', firstId));
    assert.throws(() => readPack(targetRoot, firstId), error => error.code === 'MANIFEST_CORRUPT');
    return 'MANIFEST_CORRUPT';
  });

  await check('损坏一条 Item 能被发现', () => {
    const copyRoot = path.join(root, 'corrupt-root');
    fs.mkdirSync(path.join(copyRoot, 'packs'), { recursive: true });
    fs.cpSync(packDir(store, firstId), path.join(copyRoot, 'packs', firstId), { recursive: true });
    const { manifest } = readPack(copyRoot, firstId);
    const target = path.join(copyRoot, 'packs', firstId, 'blobs', manifest.items[0].contentHash);
    fs.writeFileSync(target, 'tampered', 'utf8');
    assert.throws(() => readPack(copyRoot, firstId), error => error.code === 'BLOB_CORRUPT');
    return 'BLOB_CORRUPT';
  });

  await check('越界行号直接失败，不截断成空证据', async () => {
    const draft = draftFor(fixture, 'spike:bad-range', t0 + 4000);
    draft.items[0].locator.endLine = 999;
    await assert.rejects(() => publish(store, draft), /超过文件行数/);
    assert.equal(fs.existsSync(packDir(store, packIdOf('spike:bad-range'))), false);
    const leftovers = fs
      .readdirSync(path.join(store, 'packs'))
      .filter(name => name.startsWith(`${packIdOf('spike:bad-range')}.tmp-`));
    assert.deepEqual(leftovers, []);
    return '失败且无半成品';
  });

  await check('未知 schemaVersion 明确失败', () => {
    const copyRoot = path.join(root, 'version-root');
    fs.mkdirSync(path.join(copyRoot, 'packs'), { recursive: true });
    fs.cpSync(packDir(store, firstId), path.join(copyRoot, 'packs', firstId), { recursive: true });
    const file = path.join(copyRoot, 'packs', firstId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.schemaVersion = 99;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
    assert.throws(() => readPack(copyRoot, firstId), error => error.code === 'UNSUPPORTED_VERSION');
    return 'UNSUPPORTED_VERSION';
  });

  const failed = results.filter(item => !item.ok);
  console.log('');
  console.log(`Spike ${failed.length === 0 ? '通过' : '失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`);
  }
  console.log(`工作目录：${root}${KEEP ? '（保留）' : ''}`);
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
