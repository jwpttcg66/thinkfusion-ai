/**
 * Phase 5：标注集评测 + 指标报告。
 *
 * 跑法：
 *   npm run test:debate-eval            # 只跑，报告写 out-test/
 *   npm run report:debate-eval          # 跑完把报告写到 docs/reports/DEBATE_METRICS.md
 *
 * 这一组用**回放**跑完整的辩论链路（与 AC-15 同一套做法），然后用标注集算
 * 三项需要「正确答案」的指标：事实准确率（本仓库只有示例标签）、错误前提
 * 纠正率、以及可追溯率。校准度算不了——结论不带置信度，报告里写明原因。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCases } from '../out-test/main/debate/eval.js';
import { debateMetrics, summarizeMetrics } from '../out-test/main/debate/metrics.js';
import { DebateOrchestrator } from '../out-test/main/debate/orchestrator.js';
import { DebateStore } from '../out-test/main/debate/store.js';
import { LABELED_CASES } from './fixtures/debate-labels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const REPORT_DIR = process.env.TF_REPORT === '1'
  ? path.resolve(ROOT, '..', 'docs', 'reports')
  : path.resolve(ROOT, 'out-test');

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
      agentId,
      text,
      receivedAt: Date.now(),
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

test('标注集跑一遍：结论、指标、报告都能算出来', async () => {
  const states = new Map();
  for (const item of LABELED_CASES) {
    const state = await replay(item);
    assert.ok(state, `${item.id} 没跑起来`);
    states.set(item.id, state);
    assert.ok(state.verdict, `${item.id} 应当有结论`);
    assert.ok(state.metrics, `${item.id} 应当有指标`);
  }

  const report = evaluateCases(LABELED_CASES, states);
  assert.equal(report.total, LABELED_CASES.length);
  assert.equal(report.human.total, 0, '这一版没有人工标签，不能冒充有');
  assert.equal(report.seed.total, LABELED_CASES.length);
  assert.equal(report.calibration, 'not-applicable');
  assert.ok(report.premiseCorrection.total >= 1, '至少有一条带错误前提的用例');

  // 「没有可核验来源」这条底线，无论标签如何都必须成立。
  assert.notEqual(states.get('EVAL-02').verdict.verdict, 'supported', '只有断言不能判成 supported');
  // 少数派有可复现来源时，不能被人数压掉。
  assert.equal(states.get('EVAL-04').verdict.minorityWins, true, 'TF-D-011：少数派应当胜出');

  const summary = summarizeMetrics([...states.values()].map(state => debateMetrics(state)));
  assert.equal(summary.debates, LABELED_CASES.length);
  assert.ok(summary.traceability.judged > 0);

  const reportPath = path.join(REPORT_DIR, 'DEBATE_METRICS.md');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(reportPath, markdown(report, summary, states), 'utf8');
  assert.ok(fs.existsSync(reportPath));
});

function markdown(report, summary, states) {
  const pct = value => (value === null ? '无法计算' : `${Math.round(value * 100)}%`);
  const lines = [
    '# 辩论质量指标（Phase 5）',
    '',
    '> 由 `npm run report:debate-eval` 生成，数据来自 `scripts/fixtures/debate-labels.mjs` 的固定回放。',
    '> **标签是示例标签（`labelSource: seed`），未经人工复核**，所以下面的一致程度',
    '> 只能读成「与示例标签的一致程度」，不能读成事实准确率。',
    '',
    '## 总览',
    '',
    `- 用例：${report.total} 条（pass ${report.passed}）`,
    `- 与示例标签一致：${pct(report.accuracy)}`,
    `- 错误前提纠正：${report.premiseCorrection.corrected}/${report.premiseCorrection.total}（${pct(report.premiseCorrection.rate)}）`,
    `- 证据可追溯率：${summary.traceability.traceable}/${summary.traceability.judged}（${pct(summary.traceability.rate)}）`,
    `- 无效轮次：${summary.invalidRounds.invalid}/${summary.invalidRounds.total}（${pct(summary.invalidRounds.rate)}）`,
    `- 少数派原文完整保留：${summary.minority.preserved}/${summary.minority.count}（${pct(summary.minority.rate)}）`,
    `- 平均轮数：${summary.averageRounds ?? '无法计算'}；平均耗时：${summary.averageTotalMs ?? 0} ms`,
    `- 调用：${summary.calls.messages} 次发言，${summary.calls.failures} 次失败`,
    `- 校准度：不适用——${report.calibrationReason}`,
    '',
    '## 逐条',
    '',
    '| 用例 | 要求 | 实际 | 结果 | 说明 |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const outcome of report.outcomes) {
    const state = states.get(outcome.id);
    const metrics = state?.metrics;
    lines.push(
      `| ${outcome.id} | ${outcome.expected ?? '非 supported'} | ${outcome.actual ?? '无'} | ${outcome.pass ? '通过' : '未通过'} | ${outcome.detail}${metrics ? `；可追溯 ${metrics.traceability.traceable}/${metrics.traceability.judged}` : ''} |`
    );
  }
  lines.push('', '## 指标口径', '');
  lines.push(
    '- **与标签一致**：五档结论和标签相同才算通过；`expectVerdict: null` 的要求是「不是 supported」。',
    '- **错误前提纠正**：带错误前提的用例里，发言出现了正确说法（关键词）的比例；与结论档位无关。',
    '- **证据可追溯率**：被判定的主张中，至少有一条 `page-link` 且非同源转载证据的比例。',
    '- **无效轮次**：除首轮外，既没有新证据、也没有接受/修正/撤回、也没有新争议的轮次比例。',
    '- **少数派保留**：少数派原文在最终记录里仍逐字存在的比例（设计上应恒为 100%，掉了就是回归）。'
  );
  lines.push('', '## 这些数字不能说明什么', '');
  lines.push(
    '- 回放用的是写好的发言，不是真模型：它证明链路与裁判的判定规则在变，不证明模型会这么回答。',
    '- 四条用例的标签是示例标签；上面那个 100% 只说明「标签是按本仓库的规则写的」，不是准确率。要得到可用的事实准确率，需要人工逐条复核或扩充标注集。',
    '- 只有 4 条用例、每条 1 轮，统计上没有代表性；它的用处是让指标随代码变化，不是给系统打分。',
    '- Token 与费用没有数据来源（网页通道与本地模型都不报用量），报告里不出现这两项。'
  );
  return lines.join('\n') + '\n';
}
