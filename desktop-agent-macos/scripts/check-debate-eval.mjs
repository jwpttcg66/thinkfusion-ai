/**
 * 辩论质量门槛 + 基准集评测（任务书 §14 / Phase 5）。
 *
 * 跑法：
 *   npm run quality:debate              # 达标检查 + 报告写 docs/reports/
 *   npm run test:debate-eval            # 同上，但报告只写 out-test/
 *
 * 两个层次，别混：
 * 1. **硬门槛**（`quality.ts`）：从落盘数据能算出来的十一项布尔检查，任何一项
 *    不过就 exit 1。它们与模型措辞无关，是「结论可信」的底线。
 * 2. **基准集一致程度**（`eval.ts`）：13 条固定回放，标签分 `rule`（任务书
 *    条款推出）/ `seed`（示例）/ `human`（当前 0 条）。这个数字只能读成
 *    「与规则基准一致」，**不是事实准确率**。
 *
 * 回放而不是真跑模型：同样的问题模型每次说的话都不一样，断言「模型说了 X」
 * 的用例第二天就会红，而且红得没有意义。这里守的是链路与判据不回退。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCases } from '../out-test/main/debate/eval.js';
import { debateMetrics, summarizeMetrics } from '../out-test/main/debate/metrics.js';
import { assessAll, NOT_MEASURABLE, VERDICT_LABEL } from '../out-test/main/debate/quality.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';
import { LABELED_CASES } from './fixtures/debate-labels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const REPORT = process.env.TF_REPORT === '1'
  ? path.resolve(ROOT, '..', 'docs', 'reports', 'DEBATE_QUALITY.md')
  : path.resolve(ROOT, 'out-test', 'DEBATE_QUALITY.md');

/** 回放一场：第 i 轮用 `rounds[i]` 里录好的话，引用链接按用例给。 */
async function replay(item) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-eval-'));
  const store = new DebateStore(dir);
  const turns = new Map();
  const ask = async (agentId, task) => {
    const index = turns.get(agentId) ?? 0;
    turns.set(agentId, index + 1);
    const round = item.rounds[Math.min(index, item.rounds.length - 1)];
    const text = round[agentId];
    if (typeof text !== 'string') throw new Error(`${item.id}：${agentId} 第 ${index + 1} 轮没有录好的发言`);
    const citations = item.citations?.[agentId];
    return {
      agentId, text, receivedAt: Date.now(),
      ...(citations ? { citations } : {}),
      attribution: { requestId: 'replay', note: 'fixture' },
      stage: task.stage
    };
  };
  const orchestrator = new DebateOrchestrator(store, { ask });
  const started = orchestrator.start(item.question, {
    strategy: item.strategy,
    maxRounds: item.rounds.length,
    participants: item.participants,
    convergenceStop: false
  });
  const state = await orchestrator.waitFor(started.debateId, 10_000);
  fs.rmSync(dir, { recursive: true, force: true });
  return state;
}

test('质量达标：十一项硬门槛全过，基准集 13 条全过', async () => {
  const states = new Map();
  for (const item of LABELED_CASES) {
    const state = await replay(item);
    assert.ok(state, `${item.id} 没跑起来`);
    assert.ok(state.verdict, `${item.id} 应当有结论`);
    assert.ok(state.metrics, `${item.id} 应当有指标`);
    states.set(item.id, state);
  }

  const report = evaluateCases(LABELED_CASES, states);
  const quality = assessAll([...states.values()]);
  const summary = summarizeMetrics([...states.values()].map(state => debateMetrics(state)));

  // 标签来源如实分开：一条 human 都没有，就不许报告里出现「人工准确率」。
  assert.equal(report.human.total, 0);
  assert.equal(report.rule.total + report.seed.total, LABELED_CASES.length);
  assert.equal(report.calibration, 'not-applicable');
  assert.ok(report.premiseCorrection.total >= 1);

  // 底线，无论标签怎么写都必须成立。
  assert.notEqual(states.get('EVAL-02').verdict.verdict, 'supported', '只有断言不能判 supported');
  assert.equal(states.get('EVAL-04').verdict.minorityWins, true, 'TF-D-011 少数派应当胜出');
  assert.equal(states.get('EVAL-08').verdict.verdict, 'insufficient_evidence', 'TF-D-007 多数一致不算正确');
  assert.equal(states.get('EVAL-10').verdict.conclusion, null, 'TF-D-010 不许伪造结论');

  assert.equal(summary.debates, LABELED_CASES.length);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, markdown(report, quality, summary, states), 'utf8');

  // 最后才断言达标：报告无论如何都写出来，失败时能直接看是哪一项红的。
  assert.equal(report.passed, report.total, '基准集有未通过的场景，见报告逐条');
  assert.equal(quality.ok, true, `质量门槛未全过（${quality.passed}/${quality.total}），见报告`);
});

function pct(value) {
  return value === null ? '无法计算' : `${Math.round(value * 100)}%`;
}

function markdown(report, quality, summary, states) {
  const lines = [
    '# 辩论质量达标报告',
    '',
    `> 由 \`npm run quality:debate\` 生成。数据来自 \`scripts/fixtures/debate-labels.mjs\` 的 ${report.total} 条固定回放。`,
    `> **结论：${quality.ok && report.passed === report.total ? '达标' : '未达标'}**（硬门槛 ${quality.passed}/${quality.total}，基准集 ${report.passed}/${report.total}）。`,
    '',
    '两个数字的含义不同，别混：硬门槛是「结论可信的底线」，基准集一致程度是',
    '「与任务书规则推出来的期望一致」。**都不是事实准确率**——那需要人工标注集。',
    '',
    '## 1. 硬门槛（全部通过才算达标）',
    '',
    '| 门槛 | 依据 | 通过 |',
    '| --- | --- | --- |'
  ];
  for (const row of quality.byGate) {
    lines.push(`| ${row.label} \`${row.id}\` | ${row.basis} | ${row.passed}/${row.total}${row.passed === row.total ? ' ✓' : ' ✗'} |`);
  }
  const failures = quality.assessments.flatMap(item =>
    item.gates.filter(g => !g.passed).map(g => `${item.question.slice(0, 24)} → ${g.label}：${g.detail}`)
  );
  if (failures.length > 0) {
    lines.push('', '**未通过的明细**：', ...failures.map(item => `- ${item}`));
  }

  lines.push('', '## 2. 基准集一致程度', '');
  lines.push(`- 与规则基准（\`rule\`）一致：${report.rule.passed}/${report.rule.total}（${pct(report.rule.accuracy)}）`);
  lines.push(`- 与示例标签（\`seed\`）一致：${report.seed.passed}/${report.seed.total}（${pct(report.seed.accuracy)}）`);
  lines.push(`- 人工标注（\`human\`）：${report.human.total} 条 —— **当前没有人工基准，不算事实准确率**`);
  lines.push(`- 错误前提纠正：${report.premiseCorrection.corrected}/${report.premiseCorrection.total}（${pct(report.premiseCorrection.rate)}）`);
  lines.push(`- 校准度：不适用 —— ${report.calibrationReason}`);
  lines.push('', '| 用例 | 场景 | 要求 | 实际 | 结果 | 标签依据 |', '| --- | --- | --- | --- | --- | --- |');
  const byId = new Map(LABELED_CASES.map(item => [item.id, item]));
  for (const outcome of report.outcomes) {
    const item = byId.get(outcome.id);
    lines.push(
      `| ${outcome.id} | ${item?.title ?? item?.question.slice(0, 18) ?? ''} | ` +
      `${outcome.expected === null ? '非 supported' : VERDICT_LABEL[outcome.expected] ?? outcome.expected} | ` +
      `${outcome.actual === null ? '无' : VERDICT_LABEL[outcome.actual] ?? outcome.actual} | ` +
      `${outcome.pass ? '通过' : '**未通过**'} | ${item?.basis ?? ''} |`
    );
  }

  lines.push('', '## 3. 过程指标（报告值，不设假阈值）', '');
  lines.push(
    `- 证据可追溯率：${summary.traceability.traceable}/${summary.traceability.judged}（${pct(summary.traceability.rate)}）`,
    `- 无效轮次：${summary.invalidRounds.invalid}/${summary.invalidRounds.total}（${pct(summary.invalidRounds.rate)}）`,
    `- 少数派原文完整保留：${summary.minority.preserved}/${summary.minority.count}（${pct(summary.minority.rate)}）`,
    `- 平均轮数：${summary.averageRounds ?? '无法计算'}；平均耗时：${summary.averageTotalMs ?? 0} ms`,
    `- 调用：${summary.calls.messages} 次发言，${summary.calls.failures} 次失败`,
    `- 结论分布：${Object.entries(summary.byVerdict).map(([k, v]) => `${k} ${v}`).join('、')}`
  );
  lines.push('', '这些指标**不设达标线**：可追溯率取决于页面有没有给链接（本地模型永远不给），',
    '无效轮次取决于场景复杂度。给它们编一个「≥ 80%」的门槛，只会逼着系统去凑数字。');

  lines.push('', '## 4. 本仓库无法达标的项目（要达标需要什么）', '');
  lines.push('| 项 | 为什么算不了 | 需要什么 |', '| --- | --- | --- |');
  for (const item of NOT_MEASURABLE) lines.push(`| ${item.item} | ${item.reason} | ${item.needs} |`);

  lines.push('', '## 5. 这些数字不能说明什么', '');
  lines.push(
    '- 回放用的是写好的发言，不是真模型：它证明链路与判据没有回退，不证明模型会这么回答。',
    '- `rule` 标签由任务书条款推出，改规则时标签和实现可能一起改——它的用处是',
    '  锁住「已知该判对的场景」，不是给系统打分。',
    `- ${report.total} 条用例、每条 1 轮，统计上没有代表性。`,
    '- 「档位 ↔ 证据强度自洽」是确定性一致性检查，不是概率校准度。',
    '- Token 与费用没有数据来源（网页通道与本地模型都不报用量），报告里不出现这两项。'
  );
  return lines.join('\n') + '\n';
}
