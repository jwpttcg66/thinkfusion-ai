/**
 * P2-Final：Evidence Pack 引用可达性 GC。
 *
 * Run with: npm run test:pack-gc
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DebateStore } from '../out-test/main/debate/store.js';
import { collectPackGarbage, collectPackReferences } from '../out-test/main/evidence-pack/gc.js';
import { EvidencePackStore } from '../out-test/main/evidence-pack/store.js';

const commit = 'a'.repeat(40);

function tempDir(prefix = 'tf-pack-gc-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pack(store, key, createdAt = 1, text = 'export const a = 1;') {
  return store.publish({
    repoRoot: path.dirname(store.dir ?? process.cwd()),
    idempotencyKey: key,
    repo: { commit, dirty: false },
    createdAt,
    items: [{
      kind: 'source-file',
      content: text,
      source: { commit, path: 'src.ts' },
      locator: { path: 'src.ts', startLine: 1, endLine: 1 },
      meta: { tool: 'test', capturedAt: createdAt }
    }]
  }).manifest;
}

function stateOf(debateId, packId, overrides = {}) {
  return {
    debateId,
    question: 'q',
    config: { strategy: 'standard', maxRounds: 1, participants: ['a'], convergenceStop: false },
    status: 'completed',
    rounds: [],
    minorities: [],
    evidencePack: { status: 'complete', baselinePackId: packId },
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('被 baseline/round 引用的 Pack 永不按时间删除', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const baseline = pack(store, 'debate:one:baseline', 1);
    const round = pack(store, 'debate:one:round:0', 1);
    const now = 10 * 24 * 60 * 60 * 1000;
    const debates = [
      stateOf('one', baseline.packId, {
        roundEvidencePacks: [{
          roundIndex: 0,
          status: 'complete',
          packId: round.packId,
          itemCount: 1,
          claimIds: [],
          items: [],
          errors: [],
          createdAt: 1
        }]
      })
    ];
    const refs = collectPackReferences(debates);
    assert.ok(refs.referenced.has(baseline.packId));
    assert.ok(refs.referenced.has(round.packId));
    assert.deepEqual(refs.errors, []);

    const plan = collectPackGarbage({ store, debates, now, graceMs: 1, dryRun: false });
    assert.equal(plan.deletedPacks, 0);
    assert.equal(plan.referencedPacks, 2);
    assert.ok(store.get(baseline.packId));
    assert.ok(store.get(round.packId));
  } finally {
    cleanup(storeDir);
  }
});

test('孤儿宽限期：未到不删，超过才删；dry-run 不产生删除', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const old = pack(store, 'orphan:old', 1000);
    const fresh = pack(store, 'orphan:fresh', 9000);
    const now = 10_000;
    const dry = collectPackGarbage({ store, debates: [], now, graceMs: 500, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.candidatePacks, 2);
    assert.equal(dry.deletedPacks, 0);
    assert.ok(store.get(old.packId));
    assert.ok(store.get(fresh.packId));

    const apply = collectPackGarbage({ store, debates: [], now, graceMs: 500, dryRun: false });
    assert.equal(apply.deletedPacks, 2);
    assert.ok(apply.deletedBytes > 0);
    assert.equal(store.get(old.packId), null);
    assert.equal(store.get(fresh.packId), null);
  } finally {
    cleanup(storeDir);
  }
});

test('宽限期内未引用 Pack 被保护；删除后 replay 返回 PACK_NOT_FOUND', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const fresh = pack(store, 'orphan:fresh', 9000);
    const plan = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 5000, dryRun: false });
    assert.equal(plan.deletedPacks, 0);
    assert.ok(plan.skipped.some(item => item.reason.startsWith('grace:')));
    assert.ok(store.get(fresh.packId));

    const deleted = collectPackGarbage({ store, debates: [], now: 20_000, graceMs: 5000, dryRun: false });
    assert.equal(deleted.deletedPacks, 1);
    assert.throws(() => store.replay(fresh.packId), error => error.code === 'PACK_NOT_FOUND');
  } finally {
    cleanup(storeDir);
  }
});

test('损坏 Pack 默认保护，不因无法解析而误删', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const good = pack(store, 'bad:manifest', 1);
    fs.writeFileSync(path.join(storeDir, 'packs', good.packId, 'manifest.json'), '{broken', 'utf8');
    const plan = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 1, dryRun: false });
    assert.equal(plan.corruptPacks, 1);
    assert.equal(plan.deletedPacks, 0);
    assert.ok(plan.skipped.some(item => item.reason === 'corrupt'));
    assert.ok(fs.existsSync(path.join(storeDir, 'packs', good.packId)));
  } finally {
    cleanup(storeDir);
  }
});

test('辩论记录读不了：整个 GC 中止，不删除任何 Pack', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    pack(store, 'orphan:old', 1);
    const plan = collectPackGarbage({
      store,
      debates: [],
      scanErrors: ['broken.json: Unexpected token'],
      now: 10_000,
      graceMs: 1,
      dryRun: false
    });
    assert.ok(plan.aborted);
    assert.equal(plan.deletedPacks, 0);
    assert.equal(plan.temp.deleted, 0);
    assert.match(plan.aborted.reason, /拒绝删除/);
  } finally {
    cleanup(storeDir);
  }
});

test('同一 Pack 被多场辩论引用：删一场不释放', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const shared = pack(store, 'shared', 1);
    const debates = [stateOf('a', shared.packId), stateOf('b', shared.packId)];
    const refs = collectPackReferences(debates);
    assert.ok(refs.referenced.has(shared.packId));
    const plan = collectPackGarbage({ store, debates: [debates[1]], now: 10_000, graceMs: 1, dryRun: false });
    assert.equal(plan.referencedPacks, 1);
    assert.equal(plan.deletedPacks, 0);
    assert.ok(store.get(shared.packId));
  } finally {
    cleanup(storeDir);
  }
});

test('删除最后一场辩论后，Pack 才进入候选并可清理', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const baseline = pack(store, 'debate:last:baseline', 1);
    const before = collectPackGarbage({
      store,
      debates: [stateOf('last', baseline.packId)],
      now: 10_000,
      graceMs: 1,
      dryRun: false
    });
    assert.equal(before.deletedPacks, 0);
    const after = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 1, dryRun: false });
    assert.equal(after.deletedPacks, 1);
    assert.equal(store.get(baseline.packId), null);
  } finally {
    cleanup(storeDir);
  }
});

test('packEvidence/packEvidenceLinks 的 pack:<id>:<item> 也算引用', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const round = pack(store, 'debate:evidence:round:0', 1);
    const item = store.get(round.packId).items[0];
    const evidenceId = `pack:${round.packId}:${item.itemId}`;
    const state = stateOf('evidence', pack(store, 'debate:evidence:baseline', 1).packId, {
      packEvidence: [{ evidenceId }],
      packEvidenceLinks: [{
        debateId: 'evidence',
        claimId: 'c1',
        evidenceId,
        relation: 'context',
        source: 'pack',
        reason: 'x'
      }]
    });
    const refs = collectPackReferences([state]);
    assert.ok(refs.referenced.has(round.packId));
    assert.deepEqual(refs.errors, []);
  } finally {
    cleanup(storeDir);
  }
});

test('无法解析的 pack: 引用会报错，GC 不冒险删除', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    pack(store, 'orphan', 1);
    const state = stateOf('bad-ref', 'not-a-pack');
    state.evidencePack.baselinePackId = 'pack:not-valid';
    const refs = collectPackReferences([state]);
    assert.ok(refs.errors.length > 0);
    const plan = collectPackGarbage({
      store,
      debates: [state],
      scanErrors: refs.errors,
      now: 10_000,
      graceMs: 1,
      dryRun: false
    });
    assert.ok(plan.aborted);
    assert.equal(plan.deletedPacks, 0);
  } finally {
    cleanup(storeDir);
  }
});

test('临时目录与 quarantine：宽限期后清理，审计记录完整', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    const temp = path.join(storeDir, 'packs', 'pack_aaaaaaaaaaaaaaaa.tmp-1-0');
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'blob'), 'x', 'utf8');
    const old = new Date(1_000);
    fs.utimesSync(temp, old, old);

    const quarantine = path.join(storeDir, 'packs', '.quarantine', 'pack_bbbbbbbbbbbbbbbb-1-0');
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(path.join(quarantine, 'blob'), 'y', 'utf8');
    fs.utimesSync(quarantine, old, old);

    const dry = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 1000, dryRun: true });
    assert.equal(dry.temp.scanned, 1);
    assert.equal(dry.quarantine.scanned, 1);
    assert.equal(dry.temp.deleted, 0);
    assert.ok(fs.existsSync(temp));

    const apply = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 1000, dryRun: false });
    assert.equal(apply.temp.deleted, 1);
    assert.equal(apply.quarantine.deleted, 1);
    assert.equal(fs.existsSync(temp), false);
    assert.equal(fs.existsSync(quarantine), false);
    assert.ok(apply.audit.some(item => item.action === 'delete-temp'));
    assert.ok(apply.audit.some(item => item.action === 'delete-quarantine'));
  } finally {
    cleanup(storeDir);
  }
});

test('重复 GC 幂等；dry-run 不产生任何删除', () => {
  const storeDir = tempDir();
  const store = new EvidencePackStore(storeDir);
  try {
    pack(store, 'idempotent', 1);
    const first = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 1, dryRun: false });
    const second = collectPackGarbage({ store, debates: [], now: 10_000, graceMs: 1, dryRun: false });
    assert.equal(first.deletedPacks, 1);
    assert.equal(second.deletedPacks, 0);
    assert.equal(second.scannedPacks, 0);
  } finally {
    cleanup(storeDir);
  }
});

test('DebateStore.scanAll 把坏文件报成 error，而不是静默跳过', () => {
  const dir = tempDir();
  try {
    const store = new DebateStore(dir);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{broken', 'utf8');
    store.save(stateOf('good', 'pack_aaaaaaaaaaaaaaaa'));
    const scan = store.scanAll();
    assert.equal(scan.states.length, 1);
    assert.equal(scan.errors.length, 1);
    assert.match(scan.errors[0], /bad\.json/);
  } finally {
    cleanup(dir);
  }
});
