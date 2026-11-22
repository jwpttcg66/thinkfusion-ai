/**
 * M3 · CodeIndex 记忆写入路由切换的专项验收（R1–R8）。
 *
 * 核心命题：`CodeIndexPanel` 的新写入进 `memory.sqlite`，旧表
 * `code_memory_facts` **零新增**；旧表只作为迁移来源与只读历史。
 *
 * 这里用真实临时 SQLite，不用 mock。`CodeIndexService` 不传 `memory`
 * 时会按同目录 `memory.sqlite` 惰性建一个——正好就是被测路径。
 *
 * Run with: npm run test:memory-codeindex
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CodeIndexService } from '../out-test/main/code-index/service.js';
import { CodeIndexStore } from '../out-test/main/code-index/store.js';
import { MemoryService } from '../out-test/main/memory/service.js';
import { projectIdFor } from '../out-test/shared/project-id.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-m3-route-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** 造一个最小工程目录（remember 要对 realpath，必须是真实目录）。 */
function project(name) {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  return root;
}

const legacyCount = dbFile => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM code_memory_facts').get().n);
  } finally {
    db.close();
  }
};

test('R1 一轮 remember 之后旧表零新增', async () => {
  const root = project('r1');
  const dbFile = path.join(root, 'index.sqlite');
  const service = new CodeIndexService(dbFile);
  try {
    const before = legacyCount(dbFile);
    const fact = await service.remember(root, {
      kind: 'constraint', title: '订单幂等', content: '重试不能重复扣款',
      source: 'user', status: 'confirmed'
    });
    assert.ok(fact.factId.startsWith('mem_'), '新库的 memoryId 以 mem_ 开头');
    assert.equal(legacyCount(dbFile), before, '旧表行数不变');
    assert.equal(legacyCount(dbFile), 0);
  } finally {
    service.close();
  }
});

test('R2 新写入可跨会话召回（关闭 service 后用 MemoryService 重开同一库）', async () => {
  const root = project('r2');
  const dbFile = path.join(root, 'index.sqlite');
  const service = new CodeIndexService(dbFile);
  const fact = await service.remember(root, {
    kind: 'decision', title: '迁移前先跑 staging', content: '所有数据库迁移前必须先在 staging 环境验证',
    source: 'user', status: 'confirmed'
  });
  service.close();

  const memory = new MemoryService({ file: `${dbFile}.memory.sqlite` });
  try {
    assert.ok(memory.getRecord(fact.factId), '重启后同一 memoryId 仍在');
    const result = memory.recall({
      question: '数据库迁移前要做什么验证', conversationId: 'c-new', projectId: fact.projectId
    });
    assert.ok(result.included.some(r => r.memoryId === fact.factId), '新会话能召回');
  } finally {
    memory.close();
  }
});

test('R3 kind 双向映射：issue / solution / debate / fact / decision / constraint', async () => {
  const root = project('r3');
  const dbFile = path.join(root, 'index.sqlite');
  const service = new CodeIndexService(dbFile);
  try {
    const cases = [
      ['issue', 'open_question'], ['solution', 'problem_solution'], ['debate', 'decision'],
      ['fact', 'fact'], ['decision', 'decision'], ['constraint', 'constraint']
    ];
    for (const [kind] of cases) {
      const fact = await service.remember(root, {
        kind, title: `映射 ${kind}`, content: `映射测试 ${kind}`, source: 'user', status: 'confirmed'
      });
      assert.equal(fact.kind, kind, `${kind} 往返映射应回到原值`);
    }
    // debate 额外打了 tag，新库那边也要能看见
    const memory = new MemoryService({ file: `${dbFile}.memory.sqlite` });
    try {
      const debates = memory.listRecords({ scope: 'PROJECT', contains: '映射 debate', limit: 10 });
      assert.equal(debates[0].kind, 'decision');
      assert.ok(debates[0].tags.includes('debate'));
    } finally {
      memory.close();
    }
  } finally {
    service.close();
  }
});

test('R4 sourceRefs 顺序：source 在前、sourceRef 在后，空串被过滤', async () => {
  const root = project('r4');
  const service = new CodeIndexService(path.join(root, 'index.sqlite'));
  try {
    const withRef = await service.remember(root, {
      kind: 'fact', title: '带引用', content: '带引用内容', source: 'conversation:c1',
      sourceRef: 'message:m1', status: 'confirmed'
    });
    assert.equal(withRef.source, 'conversation:c1');
    assert.equal(withRef.sourceRef, 'message:m1');
    const withoutRef = await service.remember(root, {
      kind: 'fact', title: '无引用', content: '无引用内容', source: 'user', status: 'confirmed'
    });
    assert.equal(withoutRef.source, 'user');
    assert.equal(withoutRef.sourceRef, undefined, '没有 sourceRef 时不能给空串');
  } finally {
    service.close();
  }
});

test('R5 迁移的 code_memory_link 仍能按 memoryId 解析（不搬表、无外键）', async () => {
  const root = project('r5');
  const dbFile = path.join(root, 'index.sqlite');
  // 造旧库：必须先用真实 store 建完整 schema。手工 CREATE TABLE 会漏列
  // （上一版就漏了 code_memory_link.project_id，报 no such column）。
  // project_id 必须与 service 用 realpath 算出的值一致，否则迁进来的记录
  // 落在另一个 scopeId 下，`memories(root)` 查不到（上一版就是这样）。
  const legacyProjectId = projectIdFor(fs.realpathSync(root));
  const bootstrap = new CodeIndexStore(dbFile);
  bootstrap.upsertMemory({
    projectId: legacyProjectId, factId: 'f_legacy', kind: 'decision',
    title: '旧决策', content: '旧决策内容', source: 'conversation:old',
    status: 'confirmed', confidence: 0.8, createdAt: 1, updatedAt: 2
  });
  bootstrap.close();
  const legacy = new DatabaseSync(dbFile);
  legacy.prepare(`INSERT INTO code_memory_link
    (id, project_id, symbol_key, symbol_locator, symbol_fingerprint, memory_entity_id,
     link_type, confidence, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'l1', legacyProjectId, 'sym-1', '{"filePath":"a.ts"}', 'fp', 'f_legacy',
    'HISTORY_EXPLAINS_CODE', 0.9, 'active', 1, 2
  );
  legacy.close();

  const service = new CodeIndexService(dbFile); // 构造即迁移
  try {
    const facts = await service.memories(root);
    const migrated = facts.find(f => f.factId === 'f_legacy');
    assert.ok(migrated, '旧 fact_id 原样迁入新库');
    assert.equal(migrated.status, 'confirmed');
  } finally {
    service.close();
  }

  const memory = new MemoryService({ file: `${dbFile}.memory.sqlite`, legacyFile: dbFile });
  try {
    const links = memory.linksForMemory('f_legacy');
    assert.equal(links.length, 1);
    assert.equal(links[0].symbolKey, 'sym-1');
    assert.equal(links[0].filePath, 'a.ts');
  } finally {
    memory.close();
  }
});

test('R6 删工程：旧表记忆清零，但新库的 PROJECT 记忆仍在', async () => {
  const root = project('r6');
  const dbFile = path.join(root, 'index.sqlite');
  const service = new CodeIndexService(dbFile);
  try {
    const fact = await service.remember(root, {
      kind: 'constraint', title: '删除测试', content: '删除测试内容', source: 'user', status: 'confirmed'
    });
    await service.deleteProject(root);
    assert.equal(legacyCount(dbFile), 0, '旧表清零');
    assert.equal((await service.memories(root)).length, 1, '新库记忆仍在');
    assert.ok((await service.memories(root))[0].factId === fact.factId);
  } finally {
    service.close();
  }
});

test('R7 关闭记忆：remember 明确报错，旧表也不新增', async () => {
  const root = project('r7');
  const dbFile = path.join(root, 'index.sqlite');
  const memory = new MemoryService({
    file: path.join(root, 'memory.sqlite'),
    settingsFile: path.join(root, 'settings.json')
  });
  memory.updateSettings({ enabled: false });
  const service = new CodeIndexService(dbFile, { memory });
  try {
    await assert.rejects(
      () => service.remember(root, { kind: 'fact', title: '关了', content: '关了', source: 'user' }),
      /记忆已关闭|不可用/
    );
    assert.equal(legacyCount(dbFile), 0, '不静默回落旧表');
  } finally {
    service.close();
    memory.close();
  }
});

test('R8 MEMORY 检索与 summary 计数都来自新库', async () => {
  const root = project('r8');
  const service = new CodeIndexService(path.join(root, 'index.sqlite'));
  try {
    await service.remember(root, {
      kind: 'fact', title: '唯一标题 ZXQ', content: '唯一内容 ZXQ', source: 'user', status: 'confirmed'
    });
    const summary = await service.summary(root);
    assert.equal(summary.memory, 1, 'summary.memory 不再读旧表');

    const result = await service.retrieve(root, 'ZXQ', { mode: 'MEMORY' });
    assert.ok(result.items.some(item => item.kind === 'memory' && item.title === '唯一标题 ZXQ'));
    assert.equal(result.sources.memory, true);
  } finally {
    service.close();
  }
});
