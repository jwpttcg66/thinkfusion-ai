#!/usr/bin/env node
/**
 * 比较两次 Pack Judge 真实回归。只做机械对比，不解释好坏。
 *
 * 用法：
 *   node scripts/regression/compare-pack-judge.cjs <baseline.json> <current.json> [--out=x.md]
 */
const fs = require('node:fs');
const path = require('node:path');

const read = file => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));

function relationOf(run) {
  return run.primaryRelation ?? 'none';
}

function compare(baseline, current) {
  const problems = [];
  if (baseline?.dataset?.sha256 !== current?.dataset?.sha256) problems.push('数据集不同，不能比较');
  if (baseline?.environment?.runsPerCase !== current?.environment?.runsPerCase) problems.push('每次运行次数不同');
  const modelsA = (baseline.environment.models ?? []).join(',');
  const modelsB = (current.environment.models ?? []).join(',');
  if (modelsA !== modelsB) problems.push(`模型池不同：${modelsA} / ${modelsB}`);

  const before = new Map((baseline.cases ?? []).map(item => [item.caseId, item]));
  const after = new Map((current.cases ?? []).map(item => [item.caseId, item]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const rows = ids.map(id => {
    const a = before.get(id);
    const b = after.get(id);
    const relationsA = (a?.runs ?? []).map(relationOf);
    const relationsB = (b?.runs ?? []).map(relationOf);
    return {
      id,
      expected: b?.expected?.relation ?? a?.expected?.relation ?? null,
      before: relationsA,
      after: relationsB,
      changed: relationsA.join(',') !== relationsB.join(',')
    };
  });
  return {
    comparable: problems.length === 0,
    problems,
    rows,
    metrics: { before: baseline.metrics ?? {}, after: current.metrics ?? {} }
  };
}

function markdown(outcome, labels) {
  const lines = ['# Pack Judge 回归对比', '', `- 基线：\`${labels.baseline}\``, `- 本次：\`${labels.current}\``, ''];
  if (!outcome.comparable) {
    lines.push('## 口径不同，不作逐题差异', '', ...outcome.problems.map(item => `- ${item}`), '');
    return lines.join('\n');
  }
  lines.push('## 指标', '', '| 指标 | 基线 | 本次 |', '| --- | ---: | ---: |');
  const keys = ['modelSuccessRate', 'jsonFirstAttempt', 'fallbackRate', 'invalidIdAccepted', 'forbiddenAccepted', 'sourceMismatch', 'consistencyRate'];
  for (const key of keys) {
    lines.push(`| ${key} | ${String(outcome.metrics.before[key] ?? '-')} | ${String(outcome.metrics.after[key] ?? '-')} |`);
  }
  lines.push('', '## 逐题方向', '', '| 题 | 期望 | 基线 | 本次 | 变化 |', '| --- | --- | --- | --- | --- |');
  for (const row of outcome.rows) {
    lines.push(`| ${row.id} | ${row.expected ?? '-'} | ${row.before.join(' / ')} | ${row.after.join(' / ')} | ${row.changed ? '是' : '否'} |`);
  }
  lines.push('', '> 方向取自每次运行的第一个 accepted Pack 判断；`none` 表示模型没有给出可接受判断。');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2).filter(item => !item.startsWith('--'));
  const outArg = process.argv.find(item => item.startsWith('--out='));
  if (args.length < 2) throw new Error('用法：node scripts/regression/compare-pack-judge.cjs <baseline.json> <current.json> [--out=x.md]');
  const outcome = compare(read(args[0]), read(args[1]));
  const text = markdown(outcome, { baseline: args[0], current: args[1] });
  if (outArg) {
    const out = path.resolve(process.cwd(), outArg.slice('--out='.length));
    fs.writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`已写入 ${out}`);
  } else {
    console.log(text);
  }
  if (!outcome.comparable) process.exitCode = 2;
}

if (require.main === module) main();
module.exports = { compare, markdown };
