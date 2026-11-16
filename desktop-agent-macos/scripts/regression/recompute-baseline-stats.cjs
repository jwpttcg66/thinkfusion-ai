#!/usr/bin/env node
/**
 * 用当前统计口径重算一份已冻结的基线，不重跑模型。
 *
 * 用途：P0 冻结之后才发现 stableFail 没有区分「完整执行」与「Provider 不可用」。
 * 原始报告不能被改写（tag 已指向它），所以另写一份 `-stats-corrected.json`，
 * 并把修正口径写进 correctedAt 与 correction 字段。
 *
 * 用法：node scripts/regression/recompute-baseline-stats.cjs <baseline.json>
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildBaselineStats, markdownBaseline } = require('./baseline-stats.cjs');

const file = process.argv[2];
if (!file) throw new Error('用法：node scripts/regression/recompute-baseline-stats.cjs <baseline.json>');
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
const stamped = absolute.replace(/\.json$/, '-stats-corrected.json');
const latest = path.join(path.dirname(absolute), path.basename(absolute).replace(/-[0-9T-]+Z\.json$/, '-stats-corrected.json'));
fs.writeFileSync(stamped, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.writeFileSync(latest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
const md = markdownBaseline({ stats, config, runs });
fs.writeFileSync(stamped.replace(/\.json$/, '.md'), `${md}\n`, 'utf8');
fs.writeFileSync(latest.replace(/\.json$/, '.md'), `${md}\n`, 'utf8');
console.log(`CORRECTED ${stamped}`);
console.log(JSON.stringify(stats.aggregate));
