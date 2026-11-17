#!/usr/bin/env node
/**
 * 汇总一次 Pack Judge 真实回归，分开原 12 题与 F 组，并单独统计无判断。
 *
 * 用法：node scripts/regression/summarize-pack-judge.cjs <report.json> [--out=x.md]
 */
const fs = require('node:fs');
const path = require('node:path');

function rate(n, d) {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

function subsetMetrics(cases) {
  const runs = cases.flatMap(item => item.runs);
  const byRelation = {};
  let noJudgment = 0;
  let rejected = 0;
  for (const item of cases) {
    for (const run of item.runs) {
      const expected = item.expected.relation;
      byRelation[expected] = byRelation[expected] ?? { total: 0, correct: 0 };
      byRelation[expected].total += 1;
      if (run.relationCorrect) byRelation[expected].correct += 1;
      if (!run.primaryRelation) noJudgment += 1;
      rejected += (run.rejected ?? []).length;
    }
  }
  return {
    runs: runs.length,
    relationAccuracy: Object.fromEntries(
      Object.entries(byRelation).map(([key, value]) => [key, rate(value.correct, value.total)])
    ),
    noJudgment,
    rejected
  };
}

function summarize(report) {
  const base = report.cases.filter(item => !item.caseId.startsWith('F'));
  const f = report.cases.filter(item => item.caseId.startsWith('F'));
  const consistency = list => {
    const consistent = list.filter(item => new Set(item.runs.map(run => run.primaryRelation ?? 'none')).size === 1).length;
    return rate(consistent, list.length);
  };
  return {
    dataset: report.dataset,
    models: report.environment.models,
    runsPerCase: report.environment.runsPerCase,
    overall: subsetMetrics(report.cases),
    base: subsetMetrics(base),
    f: subsetMetrics(f),
    consistency: { overall: consistency(report.cases), base: consistency(base), f: consistency(f) },
    hard: {
      invalidIdAccepted: report.metrics.invalidIdAccepted,
      forbiddenAccepted: report.metrics.forbiddenAccepted,
      sourceMismatch: report.metrics.sourceMismatch,
      fallbackRate: report.metrics.fallbackRate
    }
  };
}

function markdown(summary) {
  const lines = [
    '# Pack Judge 回归摘要',
    '',
    `- 数据集：${summary.dataset.version} · \`${summary.dataset.sha256.slice(0, 12)}…\``,
    `- 模型：${summary.models.join('、')}`,
    `- 每次运行：${summary.runsPerCase} 次`,
    '',
    '## 分组',
    '',
    '| 组 | 运行数 | context | supports | contradicts | 无判断 | rejected | 一致率 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...['overall', 'base', 'f'].map(key => {
      const group = summary[key];
      const acc = group.relationAccuracy;
      return `| ${key} | ${group.runs} | ${String(acc.context ?? '-')} | ${String(acc.supports ?? '-')} | ${String(acc.contradicts ?? '-')} | ${group.noJudgment} | ${group.rejected} | ${String(summary.consistency[key])} |`;
    }),
    '',
    '## 硬门槛',
    '',
    `- 非法 ID 接受：${summary.hard.invalidIdAccepted}`,
    `- 禁止方向接受：${summary.hard.forbiddenAccepted}`,
    `- 来源错配：${summary.hard.sourceMismatch}`,
    `- 回退规则版：${summary.hard.fallbackRate}%`,
    '',
    '> 无判断单独计数，不当作正确；数据集的 F 组用于检验证据覆盖范围。'
  ];
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2).filter(item => !item.startsWith('--'));
  const outArg = process.argv.find(item => item.startsWith('--out='));
  if (!args[0]) throw new Error('用法：node scripts/regression/summarize-pack-judge.cjs <report.json> [--out=x.md]');
  const report = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args[0]), 'utf8'));
  const summary = summarize(report);
  const text = markdown(summary);
  if (outArg) {
    const out = path.resolve(process.cwd(), outArg.slice('--out='.length));
    fs.writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`已写入 ${out}`);
  } else {
    console.log(text);
  }
}

if (require.main === module) main();
module.exports = { summarize, markdown };
