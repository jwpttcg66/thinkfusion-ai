/**
 * 送达证据 L1/L2/L3（`GLOBAL_MEMORY.md` §1）。
 *
 * 最关键的一条：L3 必须由 Provider 从**自己拼好的 messages** 反抽，
 * 不能把 L1 回显。这里同时测 shared helper、状态判定表、两个真实 Provider
 * 的 `systemHashFor`，以及 usage 落库反查。
 *
 * Run with: npm run test:memory-usage
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { submittedSystemHash, finalizeUsage, recordUsage } from '../out-test/main/memory/usage.js';
import { MemoryStore } from '../out-test/main/memory/store.js';
import { MemoryService } from '../out-test/main/memory/service.js';
import { OllamaProvider } from '../out-test/main/providers/ollama.js';
import { OpenAICompatibleProvider } from '../out-test/main/providers/openai-compatible.js';
import {
  judgeInjection, describeInjection, contextHashOf, systemHashFromMessages,
  memoryBlockFromSystem, renderMemoryBlock, MEMORY_BLOCK_PREFIX
} from '../out-test/shared/memory.js';
import { sha256Hex } from '../out-test/shared/sha256.js';

const record = {
  memoryId: 'm1', kind: 'constraint', scope: 'PROJECT', scopeId: 'p_alpha',
  title: '迁移前先跑 staging', content: '所有数据库迁移前必须先在 staging 环境验证',
  normalizedKey: 'x', sourceRefs: [], evidenceRefs: [], codeRefs: [], tags: [],
  confidence: 0.9, status: 'active', riskLevel: 'low', sensitivity: 'normal',
  createdAt: 0, updatedAt: 0, supersedes: [], schemaVersion: 1
};
const rendered = renderMemoryBlock([record]).text;
const system = ['原有系统指令', rendered];
const L1 = contextHashOf(rendered);
const L2 = submittedSystemHash(system);
const messages = [
  { role: 'system', content: '原有系统指令' },
  { role: 'system', content: rendered },
  { role: 'user', content: '数据库迁移前要做什么' }
];
const L3 = systemHashFromMessages(messages);

const pending = (overrides = {}) => ({
  requestId: 'req_1_a_1', conversationId: 'c1', memoryIds: ['m1'],
  contextHash: L1, injectionPoint: 'master-agent', status: 'injected',
  charCount: rendered.length, timestamp: 1_700_000_000_000, system, ...overrides
});

let dir, store, svc;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-usage-'));
  store = new MemoryStore(path.join(dir, 'store.sqlite'));
  svc = new MemoryService({ file: path.join(dir, 'memory.sqlite') });
});
after(() => { store.close(); svc.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---- 三级哈希 4 ----

test('L1 是构造指纹，L2 从 task.system 抽出同一个记忆块，L3 从 messages 反抽', () => {
  assert.equal(L1, sha256Hex(rendered));
  assert.equal(memoryBlockFromSystem(system), rendered);
  assert.equal(L2, sha256Hex(rendered));
  assert.equal(L3, sha256Hex(rendered));
  assert.equal(L1, L2);
  assert.equal(L2, L3);
});

test('L3 不是入参回显：丢掉 system 的 messages 抽不出记忆块 → undefined', () => {
  const dropped = [{ role: 'user', content: '数据库迁移前要做什么' }];
  assert.equal(systemHashFromMessages(dropped), undefined);
  assert.equal(memoryBlockFromSystem(['原有系统指令']), undefined);
});

test('submittedSystemHash：没有记忆块的 system 返回 undefined', () => {
  assert.equal(submittedSystemHash(undefined), undefined);
  assert.equal(submittedSystemHash(['普通 system 指令']), undefined);
  assert.ok(rendered.startsWith(MEMORY_BLOCK_PREFIX));
});

test('Provider 把 system 合并成一段时，覆盖句必须在记忆块之前', () => {
  // 合并成一个大字符串后，抽取是「从前缀切到段末」；覆盖句在后面会连进块里，
  // 哈希立刻对不上。这就是 attachSystemText 把 overrideLine 放前面的原因。
  const mergedWrong = [...system, memoryOverrideText()].join('\n\n');
  assert.notEqual(memoryBlockFromSystem([mergedWrong]), rendered);
  const mergedRight = ['原有系统指令', memoryOverrideText(), rendered].join('\n\n');
  assert.equal(memoryBlockFromSystem([mergedRight]), rendered);
  // 独立段场景：覆盖句在后也不影响抽取
  assert.equal(memoryBlockFromSystem([...system, memoryOverrideText()]), rendered);
});
function memoryOverrideText() { return '【记忆的边界】记忆不是本轮证据'; }

// ---- 状态判定表 6 ----

test('判定表：无 L2 → skipped', () => {
  assert.equal(judgeInjection({ contextHash: L1 }).status, 'skipped');
});

test('判定表：Provider 不支持哈希 → injected（未获确认）', () => {
  const r = judgeInjection({ submittedSystemHash: L2, contextHash: L1, supportsSystemHash: false });
  assert.equal(r.status, 'injected');
  assert.equal(r.providerConfirmed, false);
});

test('判定表：声明支持却没返回 L3 → failed/provider-capability', () => {
  const r = judgeInjection({ submittedSystemHash: L2, contextHash: L1, supportsSystemHash: true });
  assert.equal(r.status, 'failed/provider-capability');
});

test('判定表：三哈希相等 → provider-confirmed', () => {
  const r = judgeInjection({ submittedSystemHash: L2, providerSystemHash: L3, contextHash: L1, supportsSystemHash: true });
  assert.equal(r.status, 'provider-confirmed');
  assert.equal(r.providerConfirmed, true);
});

test('判定表：任一哈希不等 → failed/hash-mismatch（缺陷）', () => {
  const r = judgeInjection({ submittedSystemHash: L2, providerSystemHash: 'wrong', contextHash: L1, supportsSystemHash: true });
  assert.equal(r.status, 'failed/hash-mismatch');
});

test('判定表：Provider 抛错 → failed/provider-error；文案不写「模型已使用记忆」', () => {
  assert.equal(judgeInjection({ submittedSystemHash: L2, contextHash: L1, error: 'ECONNREFUSED' }).status, 'failed/provider-error');
  const text = describeInjection({ status: 'provider-confirmed', providerConfirmed: true });
  assert.ok(!text.includes('模型已使用记忆'));
  assert.ok(text.includes('Provider'));
  assert.equal(describeInjection({ status: 'skipped', skipReason: 'web-verbatim' }).includes('原话直发'), true);
});

// ---- 真实 Provider 3 ----

test('OllamaProvider.systemHashFor 从自己拼的 messages 反抽，声明 supportsSystemHash', () => {
  const p = new OllamaProvider();
  assert.equal(p.supportsSystemHash, true);
  const req = { question: '数据库迁移前要做什么', system, context: [] };
  assert.equal(p.systemHashFor(req), L3);
  assert.equal(p.systemHashFor({ question: 'x', system: ['普通指令'] }), undefined);
});

test('OpenAICompatibleProvider.systemHashFor 同样成立', () => {
  const p = new OpenAICompatibleProvider({ keyStore: { get: () => 'k', has: () => true } });
  assert.equal(p.supportsSystemHash, true);
  assert.equal(p.systemHashFor({ question: '数据库迁移前要做什么', system, context: [] }), L3);
  assert.equal(p.systemHashFor({ question: 'x', system: [] }), undefined);
});

test('Provider 声明 true 但组装时丢了 system → 抽不出 L3（守门前置条件）', () => {
  const broken = [
    { role: 'system', content: '原有系统指令' },
    { role: 'user', content: '数据库迁移前要做什么' }
  ];
  assert.equal(systemHashFromMessages(broken), undefined);
  const event = finalizeUsage({
    pending: pending(),
    supportsSystemHash: true,
    providerId: 'fake'
  });
  assert.equal(event.status, 'failed/provider-capability');
});

// ---- 落库与反查 3 ----

test('finalizeUsage 组装完整事件：三个哈希、memoryIds、charCount 都在', () => {
  const event = finalizeUsage({
    pending: pending(),
    providerSystemHash: L3,
    supportsSystemHash: true,
    providerId: 'ollama', modelId: 'qwen'
  });
  assert.equal(event.status, 'provider-confirmed');
  assert.equal(event.submittedSystemHash, L2);
  assert.equal(event.providerSystemHash, L3);
  assert.equal(event.contextHash, L1);
  assert.deepEqual(event.memoryIds, ['m1']);
  assert.equal(event.charCount, rendered.length);
  assert.equal(event.providerId, 'ollama');
});

test('recordUsage 落库后可按 requestId 反查，listUsage 按会话过滤', () => {
  const event = finalizeUsage({ pending: pending(), providerSystemHash: L3, supportsSystemHash: true });
  recordUsage(store, event, 'ctx-1');
  const got = store.getUsage('req_1_a_1');
  assert.equal(got.status, 'provider-confirmed');
  assert.equal(got.contextHash, L1);
  assert.ok(store.listUsage('c1').some(e => e.requestId === 'req_1_a_1'));
  assert.equal(store.listUsage('other').length, 0);
});

test('skipped 事件 memoryIds 为空、charCount 为 0，且仍可反查', () => {
  const event = finalizeUsage({ pending: pending({ status: 'skipped', skipReason: 'web-verbatim' }) });
  assert.equal(event.status, 'skipped');
  assert.deepEqual(event.memoryIds, []);
  assert.equal(event.charCount, 0);
  recordUsage(store, event);
  assert.equal(store.getUsage('req_1_a_1').skipReason, 'web-verbatim');
});

test('MemoryService.finalize 传 error 判 provider-error，不影响 status', () => {
  const event = svc.finalize(pending(), undefined, { error: 'boom' });
  assert.equal(event.status, 'failed/provider-error');
  assert.equal(svc.status().state, 'ready');
});
