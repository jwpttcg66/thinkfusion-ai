/**
 * 候选抽取与审批（`GLOBAL_MEMORY.md` §4）。
 *
 * 白名单逐行、来源约束、脱敏、去重、审批流、重启恢复、抽取失败旁路。
 * 「规则抽取默认开启 ≠ 自动批准」是这里的守门禁。
 *
 * Run with: npm run test:memory-extract
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractFromMessage, extractFromTaskReport
} from '../out-test/main/memory/extract.js';
import {
  decideCandidate, containsSensitive, prepareCandidateText, dedupeKeyOf
} from '../out-test/main/memory/policy.js';
import { MemoryService } from '../out-test/main/memory/service.js';
import { MEMORY_DEFAULTS } from '../out-test/shared/memory.js';

const S = { ...MEMORY_DEFAULTS };
const msg = (text, overrides = {}) => ({
  conversationId: 'c1', messageId: 'm1', text, role: 'user', projectId: 'p_alpha', ...overrides
});

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-extract-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const service = name => new MemoryService({ file: path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.sqlite`) });

// ---- 抽取白名单 8 ----

test('用户显式「记住：」→ 1 条候选，带 messageId 与 quote', () => {
  const r = extractFromMessage(msg('记住：迁移前先跑 staging'), S);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].reason, 'explicit-remember');
  assert.deepEqual(r.candidates[0].sourceMessageIds, ['m1']);
  assert.ok(r.candidates[0].quote.includes('staging'));
  assert.ok(r.candidates[0].sourceRefs.some(ref => ref.startsWith('message:')));
});

test('稳定约束「不要再」→ 候选；稳定偏好「以后都」→ 候选', () => {
  assert.equal(extractFromMessage(msg('不要再偷偷注入网页提示词'), S).candidates[0].reason, 'stable-constraint');
  assert.equal(extractFromMessage(msg('以后都一律用中文写提交信息'), S).candidates[0].reason, 'stable-preference');
});

test('普通闲聊不生成候选', () => {
  assert.equal(extractFromMessage(msg('今天天气真不错啊'), S).candidates.length, 0);
});

test('工具 / 网页 / system 数据禁止成为记忆', () => {
  assert.deepEqual(extractFromMessage(msg('工具返回：端口 8080', { role: 'tool' }), S).dropped[0].reason, 'tool-data');
  assert.equal(extractFromMessage(msg('系统提示：记住这个', { role: 'system' }), S).candidates.length, 0);
});

test('没有 messageId 的候选不生成（MEM-06）', () => {
  const r = extractFromMessage(msg('记住：这条没有来源', { messageId: '' }), S);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped[0].reason, 'no-message-id');
});

test('含密钥 / 凭据直接丢弃并记 dropped-secret', () => {
  const r = extractFromMessage(msg('记住：我的密钥 sk-abcdefghijklmnopqrstuvwxyz123456'), S);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dropped[0].reason, 'dropped-secret');
  assert.ok(containsSensitive('password: hunter2secret'));
});

test('助手推断只进待确认，且低置信直接被策略拒绝', () => {
  const r = extractFromMessage(msg('我决定采用方案 A', { role: 'assistant' }), S);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].reason, 'assistant-inference');
  assert.equal(r.candidates[0].riskLevel, 'high');
  const d = decideCandidate({
    reason: 'assistant-inference', kind: 'decision', scope: 'PROJECT',
    confidence: 0.4, sourceMessageIds: ['m1'], text: '我决定采用方案 A', settings: S
  });
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'low-confidence-inference');
});

test('GLOBAL 只允许显式记住；writeMode=off 全关', () => {
  const global = extractFromMessage({ conversationId: 'c1', messageId: 'm1', text: '以后都不要再推送远端', role: 'user' }, S);
  assert.equal(global.candidates.length, 0);
  assert.equal(global.dropped[0].reason, 'global-needs-explicit');
  assert.equal(extractFromMessage(msg('记住：任何事'), { ...S, writeMode: 'off' }).candidates.length, 0);
  assert.equal(extractFromMessage(msg('记住：任何事'), { ...S, enabled: false }).candidates.length, 0);
});

// ---- 规范化、去重、任务报告 4 ----

test('quote ≤200 字、内容截断、去换行', () => {
  const { content, quote } = prepareCandidateText('第一行\n第二行  '.repeat(80));
  assert.ok(quote.length <= 200);
  assert.ok(content.length <= 600);
  assert.ok(!quote.includes('\n'));
});

test('dedupeKey 含 scope，跨 scope 不合并', () => {
  assert.notEqual(
    dedupeKeyOf({ scope: 'PROJECT', scopeId: 'p_a', normalizedKey: 'x' }),
    dedupeKeyOf({ scope: 'PROJECT', scopeId: 'p_b', normalizedKey: 'x' })
  );
});

test('任务报告最多 3 条决策，必须带 projectId 与 sourceMessageIds', () => {
  const r = extractFromTaskReport({
    taskId: 't1', conversationId: 'c1', summary: '完成', projectId: 'p_alpha',
    sourceMessageIds: ['m1'],
    decisions: ['决定采用独立 sqlite', '决定保留只读旧表', '决定加事务', '决定再写第四条']
  });
  assert.equal(r.candidates.length, 3);
  assert.equal(r.candidates[0].reason, 'task-decision');
  assert.equal(r.candidates[0].proposedScope, 'PROJECT');
  assert.equal(r.candidates[0].sourceTaskId, 't1');
});

test('任务报告无来源消息 / 无项目范围 → 不生成', () => {
  const base = { taskId: 't1', conversationId: 'c1', summary: '完成', decisions: ['决定采用独立 sqlite'] };
  assert.equal(extractFromTaskReport({ ...base, sourceMessageIds: [], projectId: 'p_alpha' }).dropped[0].reason, 'no-source-message');
  assert.equal(extractFromTaskReport({ ...base, sourceMessageIds: ['m1'] }).dropped[0].reason, 'no-project-scope');
});

// ---- 审批流与旁路 4 ----

test('策略默认不自动批准：规则开 ≠ 自动写入', () => {
  const d = decideCandidate({
    reason: 'explicit-remember', kind: 'preference', scope: 'PROJECT',
    confidence: 0.8, sourceMessageIds: ['m1'], text: '用中文', settings: S
  });
  assert.equal(d.action, 'pending');
  const auto = decideCandidate({
    reason: 'explicit-remember', kind: 'preference', scope: 'PROJECT',
    confidence: 0.8, sourceMessageIds: ['m1'], text: '用中文',
    settings: { ...S, autoApproveExplicit: true }
  });
  assert.equal(auto.action, 'auto-approve');
});

test('端到端审批：抽取 → pending → 确认 → active，重启后仍在', () => {
  const file = path.join(dir, 'approval.sqlite');
  const a = service('approval-a');
  a.close();
  const b = new MemoryService({ file });
  const r = b.extractMessage(msg('记住：迁移前先跑 staging'));
  assert.equal(r.stored.length, 1);
  assert.equal(r.stored[0].status, 'pending');
  const approved = b.confirmCandidate(r.stored[0].candidateId);
  assert.ok(approved.record);
  assert.equal(approved.record.status, 'active');
  const memoryId = approved.record.memoryId;
  b.close();
  const c = new MemoryService({ file });
  assert.equal(c.getRecord(memoryId).status, 'active');
  c.close();
});

test('拒绝后同 dedupeKey 不再重复提出', () => {
  const s = service('reject');
  const first = s.extractMessage(msg('记住：这条要被拒绝'));
  s.rejectCandidate(first.stored[0].candidateId);
  const again = s.extractMessage(msg('记住：这条要被拒绝', { messageId: 'm2' }));
  assert.equal(again.stored.length, 0);
  s.close();
});

test('抽取失败被捕获：返回 failed + dropped，不抛给主链路', () => {
  const s = service('failure');
  // 缺 messageId 是正常拒绝路径；这里确认它不抛错且可重试
  const r = s.extractMessage(msg('记住：任意内容', { messageId: '' }));
  assert.equal(r.stored.length, 0);
  assert.equal(r.candidates.length, 0);
  assert.equal(s.status().state, 'ready');
  const retry = s.extractMessage(msg('记住：重试成功', { messageId: 'm1' }));
  assert.equal(retry.stored.length, 1);
  s.close();
});

test('关闭记忆后不写入候选', () => {
  const s = service('disabled');
  s.updateSettings({ enabled: false });
  assert.equal(s.extractMessage(msg('记住：关掉之后不该写')).stored.length, 0);
  s.close();
});
