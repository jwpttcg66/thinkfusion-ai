#!/usr/bin/env node
/**
 * 用当前统计口径重算一份已冻结的基线，不重跑模型。
 *
 * 原始报告不能被改写（tag 已指向它），所以另写一份 `-stats-corrected.json`。
 * 输入文件永远只读：即使传入的文件名没有时间戳，也不会把输出写成输入本身。
 *
 * 用法：node scripts/regression/recompute-baseline-stats.cjs <baseline.json>
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildBaselineStats, markdownBaseline } = require('./baseline-stats.cjs');

function outputPaths(absolute) {
  const stamped = absolute.replace(/\.json$/, '-stats-corrected.json');
  const baseName = path.basename(absolute);
  const latestName = baseName.replace(/-[0-9T-]+Z\.json$/, '-stats-corrected.json');
  const latest = path.join(
    path.dirname(absolute),
    latestName === baseName ? baseName.replace(/\.json$/, '-stats-corrected.json') : latestName
  );
  for (const [label, file] of [['stamped', stamped], ['latest', latest]]) {
    if (path.resolve(file) === path.resolve(absolute)) {
      throw new Error(`拒绝覆盖输入文件（${label}）：${absolute}`);
    }
  }
  return { stamped, latest };
}

function recomputeBaseline(file) {
  const absolute = path.resolve(process.cwd(), file);
  const data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!Array.isArray(data.runs) || data.runs.length === 0) {
    throw new Error('这不是 P0 基线报告：缺少 runs');
  }

  const questions = data.runs[0].results.map(item => ({
    id: item.id,
    strategy: item.strategy,
    category: item.category
  }));
  const stats = buildBaselineStats(data.runs, questions);
  const runs = data.runs.map(run => ({
    runId: run.runId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    summary: run.summary,
    results: run.results
  }));
  const config = { ...data.config, stoppedEarly: data.stoppedEarly ?? null };

  const payload = {
    ...data,
    correctedAt: new Date().toISOString(),
    correction:
      'stablePass 区分评分稳定与端到端完整；stableFail/fluctuating 只统计完整执行；' +
      'PARTIAL/UNAVAILABLE/缺失归 incomplete。原始 runs 未改动。',
    stats
  };
  const { stamped, latest } = outputPaths(absolute);
  fs.writeFileSync(stamped, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const md = markdownBaseline({ stats, config, runs });
  fs.writeFileSync(stamped.replace(/\.json$/, '.md'), `${md}\n`, 'utf8');
  fs.writeFileSync(latest.replace(/\.json$/, '.md'), `${md}\n`, 'utf8');
  return { stamped, latest, stats };
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('用法：node scripts/regression/recompute-baseline-stats.cjs <baseline.json>');
  const result = recomputeBaseline(file);
  console.log(`CORRECTED ${result.stamped}`);
  console.log(JSON.stringify(result.stats.aggregate));
}

if (require.main === module) main();

module.exports = { recomputeBaseline, outputPaths };
