/**
 * P2：工程上下文解析与开场基准 Pack。
 *
 * 钉住的是「Pack 是证据增强，不是辩论的单点依赖」：
 * - 干净仓库只记 commit/branch，不复制整仓；
 * - dirty 仓库冻结改动/未跟踪文件内容，删除或读不到的文件如实标 partial；
 * - 非 Git / 存储失败只写 evidencePack.status，不阻断辩论；
 * - Pack 可以回放，内容 hash 能校验；
 * - 历史辩论只使用会话绑定的工程目录，不拿全局默认目录兜底。
 *
 * Run with: npm run test:repository-pack
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishRepositoryBaseline } from '../out-test/main/evidence-pack/baseline.js';
import { resolveRepositoryContext } from '../out-test/main/evidence-pack/repository.js';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-repo-pack-'));
  git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
  git(root, ['add', 'a.ts']);
  git(root, ['commit', '-qm', 'init']);
  if (dirty) {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n', 'utf8');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 3;\n', 'utf8');
  }
  return root;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('干净仓库：解析出 commit/branch，不产生 dirty 片段', () => {
  const root = makeRepo();
  try {
    const resolution = resolveRepositoryContext(root);
    assert.ok(resolution.context, resolution.error);
    const context = resolution.context;
    assert.equal(context.root, fs.realpathSync(root));
    assert.equal(context.dirty, false);
    assert.deepEqual(context.chunks, []);
    assert.match(context.commit, /^[a-f0-9]{40}$/);
    assert.ok(context.branch.length > 0);
  } finally {
    cleanup(root);
  }
});

test('dirty 仓库：修改与未跟踪文件都被冻结，指纹随内容变化', () => {
  const root = makeRepo({ dirty: true });
  try {
    const first = resolveRepositoryContext(root).context;
    assert.ok(first);
    assert.equal(first.dirty, true);
    const paths = new Set(first.chunks.map(chunk => chunk.path));
    assert.ok(paths.has('a.ts'));
    assert.ok(paths.has('b.ts'));
    assert.ok(first.chunks.every(chunk => chunk.content.includes('export const')));
    assert.match(first.dirtyFingerprint, /^[a-f0-9]{64}$/);

    fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 4;\n', 'utf8');
    const second = resolveRepositoryContext(root).context;
    assert.ok(second);
    assert.notEqual(second.dirtyFingerprint, first.dirtyFingerprint);
  } finally {
    cleanup(root);
  }
});

test('删除文件无法冻结：正文缺失，标记 partial 原因', () => {
  const root = makeRepo({ dirty: true });
  try {
    fs.rmSync(path.join(root, 'a.ts'));
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    assert.equal(context.dirty, true);
    assert.ok(context.errors.some(issue => issue.message.includes('删除的文件')), context.errors.map(issue => issue.message).join('；'));
    assert.ok(context.chunks.every(chunk => chunk.path !== 'a.ts'));
  } finally {
    cleanup(root);
  }
});

test('未跟踪目录里的文件：逐个冻结，不能只记一个目录', () => {
  const root = makeRepo({ dirty: true });
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'new.ts'), 'export const nested = 1;\n', 'utf8');
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    assert.ok(context.chunks.some(chunk => chunk.path === 'nested/new.ts'), context.chunks.map(c => c.path).join(','));
  } finally {
    cleanup(root);
  }
});

test('符号链接：不冻结目标内容，标 partial', () => {
  const root = makeRepo({ dirty: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-outside-'));
  try {
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'do not leak', 'utf8');
    fs.symlinkSync(secret, path.join(root, 'link.txt'));
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    assert.ok(context.errors.some(issue => issue.message.includes('符号链接')), context.errors.map(issue => issue.message).join('；'));
    assert.ok(context.chunks.every(chunk => chunk.path !== 'link.txt'));
    assert.ok(context.chunks.every(chunk => !chunk.content.includes('do not leak')));
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('二进制/非 UTF-8 文件：标记错误，不把替换字符当成内容', () => {
  const root = makeRepo({ dirty: true });
  try {
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    assert.ok(context.errors.some(issue => issue.message.includes('二进制')), context.errors.map(issue => issue.message).join('；'));
    assert.ok(context.chunks.every(chunk => chunk.path !== 'bin.dat'));
  } finally {
    cleanup(root);
  }
});

test('非 Git 目录：返回明确错误，不抛未捕获异常', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-not-git-'));
  try {
    const resolution = resolveRepositoryContext(root);
    assert.equal(resolution.context, undefined);
    assert.match(resolution.error, /Git 仓库/);
  } finally {
    cleanup(root);
  }
});

test('开场基准 Pack：干净仓库只写 commit，可回放为空条目', () => {
  const root = makeRepo();
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pack-store-'));
  try {
    const store = new EvidencePackStore(storeDir);
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    const state = publishRepositoryBaseline({ store, debateId: 'debate-clean', context, createdAt: 1 });
    assert.equal(state.status, 'complete');
    assert.equal(state.itemCount, 0);
    assert.ok(state.baselinePackId);
    const replay = store.replay(state.baselinePackId);
    assert.equal(replay.manifest.items.length, 0);
    assert.equal(replay.manifest.repo.commit, context.commit);
    assert.equal(replay.manifest.repo.dirty, false);
  } finally {
    cleanup(root);
    cleanup(storeDir);
  }
});

test('开场基准 Pack：dirty 内容冻结且可重新读取', () => {
  const root = makeRepo({ dirty: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pack-store-'));
  try {
    const store = new EvidencePackStore(storeDir);
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    const state = publishRepositoryBaseline({ store, debateId: 'debate-dirty', context, createdAt: 1 });
    assert.equal(state.status, 'complete');
    assert.ok(state.itemCount >= 2);
    assert.ok(state.baselinePackId);
    const replay = store.replay(state.baselinePackId);
    assert.equal(replay.manifest.repo.dirty, true);
    assert.ok(replay.manifest.repo.branch);
    const contents = replay.items.map(item => item.content).join('\n');
    assert.match(contents, /export const a = 2/);
    assert.match(contents, /export const b = 3/);
  } finally {
    cleanup(root);
    cleanup(storeDir);
  }
});

function orchestratorHarness(packStore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-debate-pack-'));
  const store = new DebateStore(dir);
  const orchestrator = new DebateOrchestrator(store, {
    ask: async (agentId, task) => ({
      agentId,
      text: `${agentId}：这是一个基于冻结代码的结论。`,
      receivedAt: Date.now(),
      attribution: { requestId: 'q', note: 'test' },
      stage: task.stage
    }),
    ...(packStore ? { evidencePacks: packStore } : {})
  });
  return { dir, store, orchestrator };
}

test('发布使用解析时的内容：文件在发布前被删，Pack 仍可回放原内容', () => {
  const root = makeRepo({ dirty: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pack-store-'));
  try {
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    fs.rmSync(path.join(root, 'a.ts'));
    const store = new EvidencePackStore(storeDir);
    const state = publishRepositoryBaseline({ store, debateId: 'debate-frozen', context, createdAt: 1 });
    assert.equal(state.status, 'complete');
    const replay = store.replay(state.baselinePackId);
    const contents = replay.items.map(item => item.content).join('\n');
    assert.match(contents, /export const a = 2/, '必须冻结解析时的内容，而不是发布时重读');
  } finally {
    cleanup(root);
    cleanup(storeDir);
  }
});

test('Pack 损坏：读取必须失败，不能把损坏内容当有效证据', () => {
  const root = makeRepo({ dirty: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pack-store-'));
  try {
    const store = new EvidencePackStore(storeDir);
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    const state = publishRepositoryBaseline({ store, debateId: 'debate-corrupt', context, createdAt: 1 });
    const replay = store.replay(state.baselinePackId);
    fs.writeFileSync(
      path.join(storeDir, 'packs', state.baselinePackId, 'blobs', replay.items[0].contentHash),
      'tampered',
      'utf8'
    );
    assert.throws(
      () => store.get(state.baselinePackId),
      error => error.code === 'BLOB_CORRUPT'
    );
  } finally {
    cleanup(root);
    cleanup(storeDir);
  }
});

test('删除文件导致的部分冻结：Pack 标 partial，不冒充 complete', () => {
  const root = makeRepo({ dirty: true });
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pack-store-'));
  try {
    fs.rmSync(path.join(root, 'a.ts'));
    const context = resolveRepositoryContext(root).context;
    assert.ok(context);
    const store = new EvidencePackStore(storeDir);
    const state = publishRepositoryBaseline({ store, debateId: 'debate-partial', context, createdAt: 1 });
    assert.equal(state.status, 'partial');
    assert.ok(state.baselinePackId);
    assert.match(state.reason, /删除的文件/);
  } finally {
    cleanup(root);
    cleanup(storeDir);
  }
});

test('辩论开始：干净仓库生成基准 Pack，并随 DebateStore 落盘', async () => {
  const root = makeRepo();
  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pack-store-'));
  const { dir, orchestrator, store } = orchestratorHarness(new EvidencePackStore(packDir));
  try {
    const started = orchestrator.start('这个方案可靠吗？', {
      strategy: 'truth',
      maxRounds: 1,
      participants: ['a', 'b'],
      convergenceStop: false
    }, undefined, undefined, 'manual', { rootDir: root, source: 'conversation' });
    assert.ok(started.repository);
    assert.equal(started.repository.commit.length, 40);
    assert.equal(started.repository.source, 'conversation');
    assert.equal(started.evidencePack.status, 'complete');
    assert.ok(started.evidencePack.baselinePackId);
    const read = store.get(started.debateId);
    assert.ok(read);
    assert.equal(read.evidencePack.baselinePackId, started.evidencePack.baselinePackId);
    await orchestrator.waitFor(started.debateId, 5_000);
  } finally {
    cleanup(root);
    cleanup(packDir);
    cleanup(dir);
  }
});

test('辩论开始：非 Git 目录只标 unavailable，辩论照常启动', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-not-git-'));
  const { dir, orchestrator } = orchestratorHarness(null);
  try {
    const started = orchestrator.start('这个方案可靠吗？', {
      strategy: 'truth',
      maxRounds: 1,
      participants: ['a', 'b'],
      convergenceStop: false
    }, undefined, undefined, 'manual', { rootDir: root, source: 'workspace' });
    assert.equal(started.evidencePack.status, 'unavailable');
    assert.match(started.evidencePack.reason, /Git 仓库/);
    assert.equal(started.status, 'running');
    await orchestrator.waitFor(started.debateId, 5_000);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});

test('Pack 存储失败：标 failed，不阻断辩论', async () => {
  const root = makeRepo({ dirty: true });
  const { dir, orchestrator } = orchestratorHarness({
    publish() {
      throw new Error('磁盘已满');
    }
  });
  try {
    const started = orchestrator.start('这个方案可靠吗？', {
      strategy: 'truth',
      maxRounds: 1,
      participants: ['a', 'b'],
      convergenceStop: false
    }, undefined, undefined, 'manual', { rootDir: root, source: 'workspace' });
    assert.equal(started.evidencePack.status, 'failed');
    assert.match(started.evidencePack.reason, /磁盘已满/);
    assert.equal(started.status, 'running');
    await orchestrator.waitFor(started.debateId, 5_000);
  } finally {
    cleanup(root);
    cleanup(dir);
  }
});
