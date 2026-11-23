/**
 * 记忆治理（`GLOBAL_MEMORY.md` §5、§6 P6）。
 *
 * 替代链可追溯、纠错不覆盖旧记录、过期不再注入、删除留审计、导出可重建、
 * 冲突可人工裁决、设置持久化和降级。
 *
 * Run with: npm run test:memory-governance
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryService } from '../out-test/main/memory/service.js';

let dir;
// 每个实例独立的 settings 文件：否则「关闭记忆」那条用例会把同目录的
// settings.json 写脏，后续实例全都读到 enabled=false（测试隔离，也贴近真实
// 部署里一个 userData 只对应一个记忆库与一份设置）。
const fresh = name => {
  const file = path.join(dir, `${name}-${Math.random().toString(36).slice(2)}.sqlite`);
  return new MemoryService({ file, settingsFile: `${file}.settings.json` });
};
const decision = (title, extra = {}) => ({
  kind: 'decision', scope: 'PROJECT', scopeId: 'p_alpha', title,
  content: `${title} 的具体内容`, status: 'active',
  normalizedKey: title, ...extra
});

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mem-gov-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('supersede 建替代链：新记录 active + supersedes，旧记录标 superseded', () => {
  const s = fresh('supersede');
  const old = s.remember(decision('用 JSON 存记忆'));
  const result = s.supersede(old.memoryId, decision('改用独立 sqlite'));
  assert.ok(result);
  assert.equal(result.record.status, 'active');
  assert.ok(result.record.supersedes.includes(old.memoryId));
  const previous = s.getRecord(old.memoryId);
  assert.equal(previous.status, 'superseded');
  assert.equal(previous.supersededBy, result.record.memoryId);
  assert.ok(s.listAudit().some(e => e.action === 'governance.supersede'));
  s.close();
});

test('纠错不覆盖旧记录：旧内容仍可查，新内容独立存在', () => {
  const s = fresh('no-overwrite');
  const old = s.remember(decision('旧架构'));
  const result = s.supersede(old.memoryId, decision('新架构'));
  assert.equal(s.getRecord(old.memoryId).content, '旧架构 的具体内容');
  assert.equal(s.getRecord(result.record.memoryId).content, '新架构 的具体内容');
  s.close();
});

test('refute / expire / archive 三种状态都留审计', () => {
  const s = fresh('status');
  const r = s.remember(decision('某决策'));
  assert.equal(s.refute(r.memoryId).status, 'refuted');
  const e = s.remember(decision('另一个决策'));
  assert.equal(s.expire(e.memoryId).status, 'expired');
  const a = s.remember(decision('第三个决策'));
  assert.equal(s.archive(a.memoryId).status, 'archived');
  const actions = s.listAudit().map(x => x.action);
  assert.ok(actions.includes('governance.refute'));
  assert.ok(actions.includes('governance.expire'));
  assert.ok(actions.includes('governance.archive'));
  s.close();
});

test('被替代 / 被否定 / 过期记忆都不再被召回注入', () => {
  const s = fresh('filter');
  const old = s.remember(decision('旧架构决策'));
  s.supersede(old.memoryId, decision('新架构决策'));
  const refuted = s.remember(decision('被否定的推断'));
  s.refute(refuted.memoryId);
  const result = s.recall({ question: '旧架构决策 被否定的推断', conversationId: 'c1', projectId: 'p_alpha' });
  assert.ok(!result.included.some(r => r.memoryId === old.memoryId));
  assert.ok(!result.included.some(r => r.memoryId === refuted.memoryId));
  assert.ok(result.omitted.some(o => o.memoryId === old.memoryId && o.reason === 'superseded'));
  assert.ok(result.omitted.some(o => o.memoryId === refuted.memoryId && o.reason === 'refuted'));
  s.close();
});

test('expiresAt 已过的记忆即使状态 active 也被硬过滤', () => {
  const s = fresh('expiry');
  const r = s.remember(decision('短期结论', { expiresAt: 1 }));
  const result = s.recall({ question: '短期结论', conversationId: 'c1', projectId: 'p_alpha', now: 999 });
  assert.ok(!result.included.some(x => x.memoryId === r.memoryId));
  assert.ok(result.omitted.some(o => o.memoryId === r.memoryId && o.reason === 'expired'));
  s.close();
});

test('detectConflicts 报出同 scope 同 key 的多条 active，不自动合并', () => {
  const s = fresh('conflict');
  s.remember(decision('同一决策'));
  s.remember(decision('同一决策', { content: '另一份内容' }));
  const groups = s.detectConflicts();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].normalizedKey, '同一决策');
  assert.equal(groups[0].memoryIds.length, 2);
  assert.equal(s.listRecords({ status: 'active' }).length, 2);
  s.close();
});

test('冲突可人工裁决：refute 一条后冲突组消失', () => {
  const s = fresh('resolve');
  const a = s.remember(decision('同一决策'));
  s.remember(decision('同一决策', { content: '另一份内容' }));
  assert.equal(s.detectConflicts().length, 1);
  s.refute(a.memoryId);
  assert.equal(s.detectConflicts().length, 0);
  s.close();
});

test('跨 scope 的同名记录不合并（normalizedKey 含 scope）', () => {
  const s = fresh('scope-key');
  s.remember(decision('同名决策'));
  s.remember({ ...decision('同名决策'), scope: 'PROJECT', scopeId: 'p_beta' });
  assert.equal(s.detectConflicts().length, 0);
  s.close();
});

test('删除留审计，删除后召回不到', () => {
  const s = fresh('delete');
  const r = s.remember(decision('要删的决策'));
  assert.equal(s.deleteRecord(r.memoryId), true);
  assert.equal(s.getRecord(r.memoryId), null);
  assert.ok(!s.recall({ question: '要删的决策', conversationId: 'c1', projectId: 'p_alpha' }).included.some(x => x.memoryId === r.memoryId));
  s.close();
});

test('导出可重建：导出的记录能灌进新库', () => {
  const a = fresh('export-a');
  a.remember(decision('导出的决策'));
  a.refute(a.remember(decision('被否定的决策')).memoryId);
  const dump = a.exportAll();
  assert.equal(dump.records.length, 2);
  const b = fresh('export-b');
  const result = b.importAll(dump);
  assert.equal(result.imported, 2);
  assert.equal(b.listRecords({ limit: 100 }).length, 2);
  a.close(); b.close();
});

test('设置更新后持久化，重开仍是新值；enabled=false 不写入', () => {
  const file = path.join(dir, 'settings.sqlite');
  const a = new MemoryService({ file });
  a.updateSettings({ enabled: false, budgetChars: 300 });
  assert.equal(a.getSettings().enabled, false);
  a.close();
  const b = new MemoryService({ file });
  assert.equal(b.getSettings().enabled, false);
  assert.equal(b.getSettings().budgetChars, 300);
  assert.equal(b.remember(decision('关掉后不该写')), null);
  assert.equal(b.status().enabled, false);
  b.close();
});

test('status() 计数现读：写入后 records / candidates 立即反映（不是启动快照）', () => {
  const s = fresh('live-status');
  assert.equal(s.status().records, 0);
  assert.equal(s.status().candidates, 0);
  s.remember(decision('状态计数'));
  s.extractMessage({
    conversationId: 'c1', messageId: 'm1', role: 'user', projectId: 'p_alpha',
    text: '记住：状态计数的候选'
  });
  const after = s.status();
  // 真机验收发现：status 曾用构造时的 baseStatus 快照，写入后仍显示 0。
  assert.equal(after.records, 1);
  assert.equal(after.candidates, 1);
  assert.equal(s.status().records, s.listRecords({ limit: 10 }).length);
  // 「待审候选」只能算 pending：已拒绝的不该继续占着这个数字。
  const pendingOne = s.listCandidates('pending')[0];
  s.rejectCandidate(pendingOne.candidateId);
  assert.equal(s.status().candidates, 0, '已拒绝的候选不算待审');
  assert.equal(s.listCandidates('all').length, 1, '但历史候选仍可查');
  s.close();
});

test('linksForMemory：没有旧库时返回空，不抛错', () => {
  const s = fresh('links');
  const r = s.remember(decision('带链接'));
  assert.deepEqual(s.linksForMemory(r.memoryId), []);
  assert.equal(s.orphanLinks(), 0);
  s.close();
});

test('单源场景：治理与召回照常，不因只有一个记录跳过', () => {
  const s = fresh('single');
  const r = s.remember(decision('唯一的记忆'));
  const result = s.recall({ question: '唯一的记忆', conversationId: 'c1', projectId: 'p_alpha' });
  assert.equal(result.included.length, 1);
  assert.equal(result.included[0].memoryId, r.memoryId);
  s.close();
});
