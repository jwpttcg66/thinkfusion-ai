/**
 * P2 每轮代码引用 Pack：只把基准一致的引用冻结成条目。
 *
 * Run with: npm run test:round-evidence-pack
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EvidencePackStore } from '../out-test/main/evidence-pack/store.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

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

function makeRepo({ dirty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-round-pack-'));
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'src.ts'), 'line one\nline two\nline three\n', 'utf8');
  git(root, ['add', 'src.ts']);
  git(root, ['commit', '-qm', 'init']);
  if (dirty) fs.writeFileSync(path.join(root, 'src.ts'), 'dirty one\ndirty two\ndirty three\n', 'utf8');
  return root;
}

function harness({ packStore = true, answer }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-round-debate-'));
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-round-store-'));
  const store = new DebateStore(dir);
  const packs = packStore ? new EvidencePackStore(packDir) : null;
  const orchestrator = new DebateOrchestrator(store, {
    ask: async (agentId, task) => ({
      agentId,
      text: answer(agentId),
      receivedAt: Date.now(),
      attribution: { requestId: 'q', note: 'test' },
      stage: task.stage
    }),
    ...(packs ? { evidencePacks: packs } : {})
  });
  return { dir, packDir, store, packs, orchestrator };
}

async function run(orchestrator, root) {
  const started = orchestrator.start('这个方案可靠吗？', {
    strategy: 'truth',
    maxRounds: 1,
    participants: ['a', 'b'],
    convergenceStop: false
  }, undefined, undefined, 'manual', { rootDir: root, source: 'workspace' });
  const state = await orchestrator.waitFor(started.debateId, 10_000);
  assert.ok(state);
  return state;
}

function cleanup(...dirs) {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

test('每轮引用：生成 round Pack，内容来自开场 commit', async () => {
  const root = makeRepo();
  const h = harness({ answer: () => '根据 src.ts:2，这一行说明方案可行。' });
  try {
    const state = await run(h.orchestrator, root);
    assert.equal(state.roundEvidencePacks.length, 1);
    const record = state.roundEvidencePacks[0];
    assert.equal(record.status, 'complete');
    assert.ok(record.packId);
    assert.equal(record.itemCount, 1);
    assert.ok(record.claimIds.length > 0, '至少要关联到一条主张');

    const replay = h.packs.replay(record.packId);
    assert.equal(replay.manifest.context.kind, 'round');
    assert.equal(replay.manifest.context.baselinePackId, state.evidencePack.baselinePackId);
    assert.equal(replay.items[0].content, 'line two');
  } finally {
    cleanup(root, h.dir, h.packDir);
  }
});

test('dirty 基准：round Pack 冻结开场内容，辩论后改工作区不影响', async () => {
  const root = makeRepo({ dirty: true });
  const h = harness({ answer: () => '看 src.ts:1 的实现。' });
  try {
    const state = await run(h.orchestrator, root);
    const record = state.roundEvidencePacks[0];
    assert.equal(record.status, 'complete');
    const replay = h.packs.replay(record.packId);
    assert.equal(replay.items[0].content, 'dirty one');

    fs.writeFileSync(path.join(root, 'src.ts'), 'after debate\n', 'utf8');
    const again = h.packs.replay(record.packId);
    assert.equal(again.items[0].content, 'dirty one');
  } finally {
    cleanup(root, h.dir, h.packDir);
  }
});

test('只有无效引用：记录 partial，但没有 Pack', async () => {
  const root = makeRepo();
  const h = harness({ answer: () => '参考 missing.ts:1。' });
  try {
    const state = await run(h.orchestrator, root);
    assert.equal(state.roundEvidencePacks.length, 1);
    const record = state.roundEvidencePacks[0];
    assert.equal(record.status, 'partial');
    assert.equal(record.packId, undefined);
    assert.equal(record.itemCount, 0);
    assert.ok(record.errors.some(error => error.includes('FILE_NOT_IN_BASELINE')));
  } finally {
    cleanup(root, h.dir, h.packDir);
  }
});

test('没有代码引用：不写空 round 记录', async () => {
  const root = makeRepo();
  const h = harness({ answer: () => '这是一个纯文本结论，没有代码引用。' });
  try {
    const state = await run(h.orchestrator, root);
    assert.equal(state.roundEvidencePacks, undefined);
  } finally {
    cleanup(root, h.dir, h.packDir);
  }
});

test('基准 partial：round Pack 只能标 partial', async () => {
  const root = makeRepo();
  fs.rmSync(path.join(root, 'deleted.ts'), { force: true });
  fs.writeFileSync(path.join(root, 'deleted.ts'), 'will delete\n', 'utf8');
  git(root, ['add', 'deleted.ts']);
  git(root, ['commit', '-qm', 'add deleted']);
  fs.rmSync(path.join(root, 'deleted.ts'));
  const h = harness({ answer: () => '看 src.ts:1。' });
  try {
    const state = await run(h.orchestrator, root);
    assert.equal(state.evidencePack.status, 'partial');
    assert.equal(state.roundEvidencePacks.length, 1);
    assert.equal(state.roundEvidencePacks[0].status, 'partial');
  } finally {
    cleanup(root, h.dir, h.packDir);
  }
});
