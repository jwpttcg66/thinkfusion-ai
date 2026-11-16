#!/usr/bin/env node
/**
 * N 次基线对比：两份 `debate-p0-baseline` 的逐题分类对比。
 *
 * 为什么不复用 `compare-results.cjs`：那份工具面向「单次 24 题」，
 * 按 `results[].standard.passed` 数一次通过。P0 之后的门槛是逐题稳定性，
 * 两次运行的 15/24 和 21/24 可能代表同一能力；拿单次总数比会直接比错。
 *
 * 这里只做一件事：把每题的 `category`（stable-pass / stable-fail /
 * fluctuating / incomplete）对齐，输出稳定通过丢失、新增稳定失败、
 * 波动/不完整变化。口径不一致时拒绝给差异。
 *
 * 用法：
 *   node scripts/regression/compare-baselines.cjs <baseline.json> <current.json>
 *   node scripts/regression/compare-baselines.cjs <baseline.json> <current.json> --out=xxx.md
 */
const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isBaseline(doc) {
  return doc?.kind === 'debate-p0-baseline' || (Array.isArray(doc?.runs) && doc?.stats?.perQuestion);
}

function metaOf(doc) {
  const config = doc?.config ?? {};
  return {
    sampleCount: doc?.sampleCount ?? doc?.stats?.sampleCount ?? null,
    dataset: config.dataset?.sha256 ?? null,
    standard: config.standard?.sha256 ?? null,
    standardVersion: config.standard?.version ?? null,
    runner: config.runner?.version ?? null,
    retry: config.retryPolicy?.version ?? null,
    models: [...(config.models ?? [])].map(item => item.model).sort().join(','),
    completeness: Boolean(config.runtime?.completeness),
    temperature: config.sampling?.temperature?.value ?? null,
    seed: config.sampling?.seed?.value ?? null,
    seedSupport: config.sampling?.seed?.support ?? null
  };
}

/** 两次基线能不能比。返回原因列表；空数组才给差异。 */
function comparability(baseline, current) {
  const problems = [];
  if (!isBaseline(baseline)) problems.push('基线不是 N 次基线（kind / runs / stats 不符）');
  if (!isBaseline(current)) problems.push('本次不是 N 次基线（kind / runs / stats 不符）');
  if (problems.length > 0) return problems;

  for (const [label, doc] of [['基线', baseline], ['本次', current]]) {
    const rows = doc?.stats?.perQuestion ?? [];
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every(row => row.category)) {
      problems.push(`${label} 缺少逐题 category，先用 recompute-baseline-stats.cjs 重算`);
    }
  }
  if (problems.length > 0) return problems;

  const base = metaOf(baseline);
  const now = metaOf(current);
  if (!base.dataset || !now.dataset) problems.push('缺少数据集 sha256，无法确认题目是否同一套');
  else if (base.dataset !== now.dataset) problems.push(`数据集不同：基线 ${base.dataset.slice(0, 12)}… / 本次 ${now.dataset.slice(0, 12)}…`);

  if (!base.standard || !now.standard) problems.push('缺少标准答案 sha256，无法确认评分口径一致');
  else if (base.standard !== now.standard) problems.push(`标准答案不同：基线 ${base.standard.slice(0, 12)}… / 本次 ${now.standard.slice(0, 12)}…`);
  else if (base.standardVersion !== now.standardVersion) problems.push(`标准答案版本不同：${String(base.standardVersion)} / ${String(now.standardVersion)}`);

  if (!base.runner || !now.runner) problems.push('缺少 runner 版本');
  else if (base.runner !== now.runner) problems.push(`runner 不同：${base.runner} / ${now.runner}`);

  if (!base.retry || !now.retry) problems.push('缺少重试策略版本');
  else if (base.retry !== now.retry) problems.push(`重试策略不同：${base.retry} / ${now.retry}`);

  if (base.sampleCount !== now.sampleCount) problems.push(`样本数不同：${String(base.sampleCount)} / ${String(now.sampleCount)}`);
  if (base.models !== now.models) problems.push(`模型池不同：${base.models} / ${now.models}`);
  if (base.completeness !== now.completeness) problems.push(`completeness 不同：${String(base.completeness)} / ${String(now.completeness)}`);
  if (base.temperature !== now.temperature) problems.push(`temperature 不同：${String(base.temperature)} / ${String(now.temperature)}`);
  if (base.seed !== now.seed || base.seedSupport !== now.seedSupport) {
    problems.push(`seed 不同：${String(base.seed)}/${String(base.seedSupport)} vs ${String(now.seed)}/${String(now.seedSupport)}`);
  }

  return problems;
}

function categoryOf(doc) {
  return new Map((doc?.stats?.perQuestion ?? []).map(row => [row.id, row]));
}

function compare(baseline, current) {
  const problems = comparability(baseline, current);
  const before = categoryOf(baseline);
  const after = categoryOf(current);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  const rows = ids.map(id => {
    const a = before.get(id) ?? null;
    const b = after.get(id) ?? null;
    let delta = 'same';
    if (!a || !b) delta = 'missing';
    else if (a.category !== b.category) {
      if (a.category === 'stable-pass') delta = 'lost-stable-pass';
      else if (b.category === 'stable-pass') delta = 'gained-stable-pass';
      else if (b.category === 'stable-fail') delta = 'new-stable-fail';
      else if (a.category === 'stable-fail') delta = 'resolved-stable-fail';
      else delta = 'changed';
    }
    return {
      id,
      strategy: b?.strategy ?? a?.strategy ?? null,
      before: a?.category ?? null,
      after: b?.category ?? null,
      beforeV1Pass: a?.v1Pass ?? null,
      afterV1Pass: b?.v1Pass ?? null,
      beforeComplete: a?.completed ?? null,
      afterComplete: b?.completed ?? null,
      delta
    };
  });

  const count = category => rows.filter(row => row.after === category).length;
  const countBefore = category => rows.filter(row => row.before === category).length;
  return {
    comparable: problems.length === 0,
    problems,
    rows,
    totals: {
      sampleCount: metaOf(current).sampleCount,
      before: {
        stablePass: countBefore('stable-pass'),
        stableFail: countBefore('stable-fail'),
        fluctuating: countBefore('fluctuating'),
        incomplete: countBefore('incomplete')
      },
      after: {
        stablePass: count('stable-pass'),
        stableFail: count('stable-fail'),
        fluctuating: count('fluctuating'),
        incomplete: count('incomplete')
      },
      // 一个转移可以同时是「稳定通过丢失」和「新增稳定失败」。
      // 计数按 before/after 独立算，不靠单一 delta 标签，避免漏掉一半。
      lostStablePass: rows.filter(row => row.before === 'stable-pass' && row.after !== 'stable-pass').length,
      gainedStablePass: rows.filter(row => row.after === 'stable-pass' && row.before !== 'stable-pass').length,
      newStableFail: rows.filter(row => row.after === 'stable-fail' && row.before !== 'stable-fail').length,
      resolvedStableFail: rows.filter(row => row.before === 'stable-fail' && row.after !== 'stable-fail').length,
      changed: rows.filter(row =>
        row.before && row.after && row.before !== row.after &&
        row.before !== 'stable-pass' && row.after !== 'stable-pass' &&
        row.before !== 'stable-fail' && row.after !== 'stable-fail'
      ).length,
      missing: rows.filter(row => row.delta === 'missing').length
    }
  };
}

function markdown(outcome, paths) {
  const t = outcome.totals;
  const lines = [];
  lines.push('# N 次基线对比');
  lines.push('');
  lines.push(`- 基线：\`${paths.baseline}\``);
  lines.push(`- 本次：\`${paths.current}\``);
  lines.push(`- 样本数：${String(t.sampleCount)}`);
  lines.push('');
  if (!outcome.comparable) {
    lines.push('## 口径不同，不作逐题差异');
    lines.push('');
    for (const problem of outcome.problems) lines.push(`- ${problem}`);
    lines.push('');
    lines.push('需要同数据集、同标准答案、同 runner、同重试策略、同样本数才能比。');
    return lines.join('\n');
  }

  lines.push('## 分类变化');
  lines.push('');
  lines.push('| 分类 | 基线 | 本次 |');
  lines.push('| --- | ---: | ---: |');
  lines.push(`| 稳定通过（完整执行） | ${t.before.stablePass} | ${t.after.stablePass} |`);
  lines.push(`| 稳定未通过（完整执行） | ${t.before.stableFail} | ${t.after.stableFail} |`);
  lines.push(`| 波动（完整执行） | ${t.before.fluctuating} | ${t.after.fluctuating} |`);
  lines.push(`| 不完整 | ${t.before.incomplete} | ${t.after.incomplete} |`);
  lines.push('');
  lines.push(`- 稳定通过丢失：${t.lostStablePass}`);
  lines.push(`- 新增稳定通过：${t.gainedStablePass}`);
  lines.push(`- 新增稳定失败：${t.newStableFail}`);
  lines.push(`- 解除稳定失败：${t.resolvedStableFail}`);
  lines.push(`- 波动/不完整变化：${t.changed}`);
  lines.push(`- 缺题：${t.missing}`);
  lines.push('');

  const changed = outcome.rows.filter(row => row.delta !== 'same');
  lines.push('## 变化题');
  lines.push('');
  if (changed.length === 0) lines.push('无。');
  else {
    lines.push('| 题目 | 基线 | 本次 | 判定 | V1 通过（基线→本次） |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of changed) {
      lines.push(`| ${row.id} | ${row.before ?? '-'} | ${row.after ?? '-'} | ${row.delta} | ${String(row.beforeV1Pass ?? '-')} → ${String(row.afterV1Pass ?? '-')} |`);
    }
  }
  lines.push('');
  lines.push('> 分类按逐题稳定性，不按单次 24 题总数；`stable-pass` 要求每次 COMPLETED 且 V1 通过。');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2).filter(item => !item.startsWith('--'));
  const outArg = process.argv.find(item => item.startsWith('--out='));
  if (args.length < 2) {
    console.error('用法：node scripts/regression/compare-baselines.cjs <baseline.json> <current.json> [--out=xxx.md]');
    process.exit(1);
  }
  const baselinePath = path.resolve(process.cwd(), args[0]);
  const currentPath = path.resolve(process.cwd(), args[1]);
  const outcome = compare(readJson(baselinePath), readJson(currentPath));
  const text = markdown(outcome, {
    baseline: path.relative(path.resolve(__dirname, '../../..'), baselinePath),
    current: path.relative(path.resolve(__dirname, '../../..'), currentPath)
  });
  if (outArg) {
    const out = path.resolve(process.cwd(), outArg.slice('--out='.length));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${text}\n`, 'utf8');
    console.log(`已写入 ${out}`);
  } else {
    console.log(text);
  }
  if (!outcome.comparable) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { compare, comparability, markdown, metaOf };
