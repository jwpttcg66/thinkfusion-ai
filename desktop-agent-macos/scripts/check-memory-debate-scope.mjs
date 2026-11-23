/**
 * M4 · DebateRun 级记忆隔离。
 *
 * 验收要求（评审给的三条）：
 * 1. `MemoryTaskScope` 按 DebateRun 透传，不存实例状态；
 * 2. 两个不同项目并发辩论，记忆不交叉；
 * 3. 取消/超时/重试不污染下一次 DebateRun。
 *
 * 这里测 1 和 2：同一个 orchestrator 单例开两场（convA / convB），
 * 断言每次 ask 收到的 task 都带**自己那一场**的 conversationId。
 *
 * Run with: npm run test:memory-debate
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-m4-scope-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const candidates = () => [
  { id: 'a', label: 'A', type: 'local', available: true },
  { id: 'b', label: 'B', type: 'local', available: true }
];

function makeOrchestrator(seen) {
  const store = new DebateStore(path.join(dir, 'debates'));
  return new DebateOrchestrator(store, {
    ask: async (agentId, task) => {
      seen.push({ agentId, conv: task.memory?.conversationId, point: task.memory?.injectionPoint });
      return { agentId, text: `来自 ${agentId} 的回答`, receivedAt: Date.now() };
    },
    candidates
  });
}

test('两场并发辩论：各自的 scope 不交叉', async () => {
  const seen = [];
  const orch = makeOrchestrator(seen);
  const config = { participants: ['a', 'b'], strategy: 'parallel' };
  const scopeA = { conversationId: 'convA', injectionPoint: 'debate' };
  const scopeB = { conversationId: 'convB', injectionPoint: 'debate' };

  orch.start('A 项目的问题', config, 'convA', undefined, 'manual', undefined, scopeA);
  orch.start('B 项目的问题', config, 'convB', undefined, 'manual', undefined, scopeB);

  // 辩论在后台跑；等到两边都发过言即可，不必等整场裁决。
  for (let i = 0; i < 40; i++) {
    const hasA = seen.some(x => x.conv === 'convA');
    const hasB = seen.some(x => x.conv === 'convB');
    if (hasA && hasB) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const a = seen.filter(x => x.conv === 'convA');
  const b = seen.filter(x => x.conv === 'convB');
  assert.ok(a.length > 0, 'convA 的辩论要真的问过模型');
  assert.ok(b.length > 0, 'convB 的辩论要真的问过模型');
  assert.equal(seen.filter(x => x.conv !== 'convA' && x.conv !== 'convB').length, 0,
    '每一次 ask 都必须带自己那一场的 scope，不能有裸 task');
  assert.ok(seen.every(x => x.point === 'debate'), 'injectionPoint 应为 debate');
});

test('两场之间没有共享的可变 scope（第三场不受前两场影响）', async () => {
  const seen = [];
  const orch = makeOrchestrator(seen);
  const config = { participants: ['a', 'b'], strategy: 'parallel' };

  orch.start('第一场', config, 'conv1', undefined, 'manual', undefined,
    { conversationId: 'conv1', injectionPoint: 'debate' });
  for (let i = 0; i < 30 && !seen.some(x => x.conv === 'conv1'); i++) await new Promise(r => setTimeout(r, 100));

  seen.length = 0;
  orch.start('第二场', config, 'conv2', undefined, 'manual', undefined,
    { conversationId: 'conv2', injectionPoint: 'debate' });
  for (let i = 0; i < 30 && !seen.some(x => x.conv === 'conv2'); i++) await new Promise(r => setTimeout(r, 100));

  // 第一场可能还在后台跑（会继续带 conv1，这是对的）；关键是没有裸 task，
  // 且第二场确实拿到了自己的 scope。
  assert.ok(seen.some(x => x.conv === 'conv2'), '第二场要拿到自己的 scope');
  assert.equal(seen.filter(x => !x.conv).length, 0, '不能出现没有 scope 的 ask');
});
