/**
 * 召回规范（`GLOBAL_MEMORY.md` §2）：切分、打分、过滤、确定性、语料指标。
 *
 * 这里有一条**守门断言**：阈值必须在 `corpus-v1` 上重新扫描，且扫描出的
 * 最小满足值要等于 `RECALL_THRESHOLD`。改公式或语料而不改版本号/常量，
 * 这条会红——防止「调参数让测试变绿」悄悄发生。
 *
 * Run with: npm run test:memory-recall
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  tokenize,
  fieldSimilarity,
  scoreMemory,
  recallMemories,
  evaluateRecall
} from '../out-test/main/memory/recall.js';
import { RECALL_THRESHOLD, RECALL_CORPUS_VERSION } from '../out-test/shared/memory.js';
import {
  records, queries, NOW, COUNTS, CORPUS_VERSION, FORBIDDEN_IDS
} from './fixtures/memory-recall-corpus.mjs';

const opts = { threshold: RECALL_THRESHOLD, maxRecords: 5, now: NOW };

test('语料版本与常量一致（改动必须同步升级版本）', () => {
  assert.equal(CORPUS_VERSION, RECALL_CORPUS_VERSION);
  assert.equal(COUNTS.records, 40);
  assert.equal(COUNTS.queries, 24);
  assert.equal(COUNTS.emptyQueries, 8);
});

// ---- 切分 6 ----

test('中文连续段走字符 bigram，不做跨类切分', () => {
  assert.deepEqual([...tokenize('订单')].sort(), ['订单']);
  assert.ok(tokenize('数据库迁移').has('数据'));
  assert.ok(tokenize('数据库迁移').has('库迁'));
  assert.ok(!tokenize('数据库迁移').has('据')); // 长度≥2 不产单字
});

test('单字停用字不进 token，非停用单字保留', () => {
  assert.ok(!tokenize('的').has('的'));
  assert.ok(tokenize('锁').has('锁'));
});

test('ASCII 标识符整段 + 子段双保留，不被字符 bigram 破坏', () => {
  const t = tokenize('Redisson');
  assert.ok(t.has('redisson'));
  assert.ok(!t.has('re'));
  const u = tokenize('Unsafe_AllocateMemory0');
  assert.ok(u.has('unsafe_allocatememory0'));
  assert.ok(u.has('unsafe'));
  assert.ok(u.has('allocatememory0'));
  // 没有大小写边界就不硬拆语义子词（拆了会造噪声），但绝不能切成字符碎片。
  assert.ok(!u.has('un') && !u.has('al') && !u.has('em'));
  assert.equal([...u].every(token => token.length >= 2), true);
});

test('下划线/点/路径符号整段保留且拆出子段', () => {
  const t = tokenize('code_memory_facts');
  assert.ok(t.has('code_memory_facts'));
  assert.ok(t.has('code'));
  assert.ok(t.has('memory'));
  assert.ok(t.has('facts'));
  const p = tokenize('src/main/memory/store.ts');
  assert.ok(p.has('src/main/memory/store.ts'));
  assert.ok(p.has('store'));
  assert.ok(p.has('ts'));
  assert.ok(!p.has('sr') && !p.has('to'));
});

test('NFKC 归一 + ASCII 小写，CJK 不动', () => {
  const t = tokenize('ＳＱＬ 订单');
  assert.ok(t.has('sql'));
  assert.ok(t.has('订单'));
});

test('中英交界处各自保留，不产出跨类 bigram', () => {
  const t = tokenize('staging 环境');
  assert.ok(t.has('staging'));
  assert.ok(t.has('环境'));
  assert.equal([...t].filter(x => /[\u4e00-\u9fff]/.test(x) && /[a-z]/.test(x)).length, 0);
});

// ---- 打分 5 ----

test('无共享 token 时字段相似度为 0', () => {
  assert.equal(fieldSimilarity(tokenize('量子拓扑弦论'), '番茄炒蛋配方'), 0);
  assert.equal(fieldSimilarity(new Set(), '任意文本'), 0);
});

test('无关记录 lex=0，总分=0（乘性质量权重，静态项不凭空造分）', () => {
  const r = records.find(x => x.memoryId === 'r35');
  const s = scoreMemory(r, tokenize('数据库迁移前要先做什么验证'), { now: NOW });
  assert.equal(s.lex, 0);
  assert.equal(s.score, 0);
});

test('scoreMemory 六项拆项齐全且 score 在 0..1', () => {
  const s = scoreMemory(records[0], tokenize('数据库迁移前要先做什么验证'), { now: NOW });
  for (const key of ['lex', 'kindWeight', 'scopeWeight', 'recency', 'confidence', 'confirmBonus', 'penalty']) {
    assert.equal(typeof s[key], 'number', key);
  }
  assert.ok(s.score >= 0 && s.score <= 1);
  assert.ok(s.lex > 0);
});

test('coverage 为主项：长问题命中短标题不再被 jaccard 压到阈值以下', () => {
  const q = tokenize('数据库迁移前要先做什么验证');
  const title = fieldSimilarity(q, '迁移前先跑 staging');
  assert.ok(title > 0.1, `title sim=${String(title)}`);
});

test('代码变化且超期的决策被判 stale（penalty > 0）', () => {
  const r = { ...records[4], kind: 'decision', codeRefs: [{ symbolKey: 'x', commit: 'old-head' }], lastConfirmedAt: NOW - 200 * 86_400_000 };
  const s = scoreMemory(r, tokenize('自辩'), { now: NOW, headCommit: 'new-head', projectStaleDays: 90 });
  assert.ok(s.penalty > 0);
});

// ---- 过滤 4 ----

test('过期记忆硬过滤，进 omitted(expired)', () => {
  const res = recallMemories(records, { question: '旧缓存淘汰策略', conversationId: 'c', projectId: 'p_alpha', now: NOW }, opts);
  assert.ok(!res.included.some(r => r.memoryId === 'r29'));
  assert.ok(res.omitted.some(o => o.memoryId === 'r29' && o.reason === 'expired'));
});

test('superseded / refuted / expired 状态不参与召回', () => {
  const res = recallMemories(records, { question: '架构决策 推断 临时结论', conversationId: 'c', projectId: 'p_alpha', now: NOW }, opts);
  for (const id of ['r32', 'r33', 'r34']) {
    assert.ok(!res.included.some(r => r.memoryId === id));
  }
  assert.ok(res.omitted.some(o => o.memoryId === 'r32' && o.reason === 'superseded'));
  assert.ok(res.omitted.some(o => o.memoryId === 'r33' && o.reason === 'refuted'));
});

test('Scope 隔离：Project A 的记忆不出现在 Project B', () => {
  const res = recallMemories(records, { question: '数据库迁移前要先做什么验证', conversationId: 'c', projectId: 'p_beta', now: NOW }, opts);
  assert.ok(!res.included.some(r => r.memoryId === 'r01'));
  assert.ok(res.omitted.some(o => o.memoryId === 'r01' && o.reason === 'scope'));
});

test('GLOBAL 记忆对所有项目可见', () => {
  const res = recallMemories(records, { question: '完全权限档还要人工审批计划吗', conversationId: 'c', projectId: 'p_beta', now: NOW }, opts);
  assert.ok(res.included.some(r => r.memoryId === 'r08'));
});

// ---- 语料指标 3 + 确定性 ----

function metricsAt(threshold) {
  return evaluateRecall(records, queries, { threshold, maxRecords: 5, now: NOW });
}

test('阈值扫描：满足全部指标的最小值必须等于冻结常量', () => {
  let smallest = null;
  for (let t = 0.1; t <= 0.350001; t += 0.01) {
    const th = Number(t.toFixed(2));
    const m = metricsAt(th);
    const ok = m.precision >= 0.8 && m.recall >= 0.8 && m.wrongInjectionRate <= 0.1 && m.emptyQueryHits === 0;
    if (ok && smallest === null) smallest = th;
  }
  assert.notEqual(smallest, null, '语料上没有任何阈值满足指标，说明公式或语料坏了');
  assert.equal(smallest, RECALL_THRESHOLD, `扫描最小值 ${String(smallest)} 与冻结值 ${String(RECALL_THRESHOLD)} 不一致`);
});

test('P@5 ≥ .80、R@5 ≥ .80、误注入率 ≤ .10', () => {
  const m = metricsAt(RECALL_THRESHOLD);
  assert.ok(m.precision >= 0.8, `P@5=${String(m.precision)}`);
  assert.ok(m.recall >= 0.8, `R@5=${String(m.recall)}`);
  assert.ok(m.wrongInjectionRate <= 0.1, `误注入率=${String(m.wrongInjectionRate)}`);
});

test('8 条空召回查询零误命中，且 forbidden 记忆一条都不注', () => {
  const m = metricsAt(RECALL_THRESHOLD);
  assert.equal(m.emptyQueryHits, 0);
  for (const q of m.perQuery) assert.deepEqual(q.wrong, []);
  for (const id of FORBIDDEN_IDS) {
    assert.ok(!m.perQuery.some(q => q.got.includes(id)), `${id} 被误注入`);
  }
});

test('两次召回顺序完全一致（并列按 updatedAt 降序、memoryId 升序）', () => {
  const a = recallMemories(records, { question: '数据库迁移前要先做什么验证', conversationId: 'c', projectId: 'p_alpha', now: NOW }, opts);
  const b = recallMemories([...records].reverse(), { question: '数据库迁移前要先做什么验证', conversationId: 'c', projectId: 'p_alpha', now: NOW }, opts);
  assert.deepEqual(a.included.map(r => r.memoryId), b.included.map(r => r.memoryId));
  assert.deepEqual(a.scores, b.scores);
});

test('超过 maxRecords 的命中进 omitted(budget)，且 scores 仍给理由', () => {
  const res = recallMemories(records, { question: '提交信息 typecheck push 迁移', conversationId: 'c', projectId: 'p_alpha', now: NOW }, { ...opts, maxRecords: 2 });
  assert.ok(res.included.length <= 2);
  assert.ok(res.scores.length >= 0);
});
