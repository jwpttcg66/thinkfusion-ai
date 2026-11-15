#!/usr/bin/env node
/**
 * 24 题回归逐题对比：当前结果 vs 历史基线。
 *
 * 这条脚本存在的理由：Gate 0C 要求「与 18/24 逐题差异（新增通过 / 退化 /
 * 不变）」，手工抄一遍既慢又容易挑好看的写。这里只做机械对比，不做解释。
 *
 * 口径不一致时**拒绝给出差异结论**——不同数据集、不同 completeness 开关、
 * 不同模型池的两次结果不能逐题比，硬比出来的「退化」是假的。
 *
 * 用法：
 *   node scripts/regression/compare-results.cjs <baseline.json> <current.json>
 *   node scripts/regression/compare-results.cjs <baseline.json> <current.json> --out=xxx.md
 */
const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function passOf(result) {
  return result?.standard?.passed === true;
}

function judgeOf(result) {
  const judge = result?.judge ?? {};
  const backend = judge.backend ?? 'missing';
  const reselection = judge.reselection;
  const switched = Boolean(reselection && Array.isArray(reselection.attempts) && reselection.attempts.length > 0);
  return {
    backend,
    agentId: judge.agentId ?? null,
    switched,
    exhausted: Boolean(reselection && reselection.exhausted)
  };
}

/** 两次结果能不能逐题比。不能比时返回原因，不返回一份「差了几个」的假差异。 */
function comparability(baseline, current) {
  const problems = [];
  const baseSha = baseline?.dataset?.sha256 ?? null;
  const currentSha = current?.dataset?.sha256 ?? null;
  if (!baseSha || !currentSha) problems.push('缺少数据集 sha256，无法确认题目是否同一套');
  else if (baseSha !== currentSha) problems.push(`数据集不同：基线 ${baseSha.slice(0, 12)}… / 本次 ${currentSha.slice(0, 12)}…`);

  if (Boolean(baseline?.completeness) !== Boolean(current?.completeness)) {
    problems.push(`completeness 开关不同：基线 ${String(baseline?.completeness)} / 本次 ${String(current?.completeness)}`);
  }

  const baseModels = [...(baseline?.models ?? [])].sort().join(',');
  const currentModels = [...(current?.models ?? [])].sort().join(',');
  if (baseModels !== currentModels) problems.push(`模型池不同：基线 ${baseModels} / 本次 ${currentModels}`);

  return problems;
}

function compare(baseline, current) {
  const problems = comparability(baseline, current);
  const baseById = new Map((baseline?.results ?? []).map(item => [item.id, item]));
  const currentById = new Map((current?.results ?? []).map(item => [item.id, item]));
  const ids = [...new Set([...baseById.keys(), ...currentById.keys()])].sort();

  const rows = ids.map(id => {
    const before = baseById.get(id) ?? null;
    const after = currentById.get(id) ?? null;
    const beforePass = before ? passOf(before) : null;
    const afterPass = after ? passOf(after) : null;
    const delta = beforePass === null || afterPass === null
      ? 'missing'
      : beforePass === afterPass
        ? 'same'
        : afterPass
          ? 'gained'
          : 'regressed';
    return {
      id,
      strategy: after?.strategy ?? before?.strategy ?? null,
      beforePass,
      afterPass,
      delta,
      beforeQuality: before?.quality?.status ?? null,
      afterQuality: after?.quality?.status ?? null,
      beforeJudge: before ? judgeOf(before) : null,
      afterJudge: after ? judgeOf(after) : null,
      beforeError: before?.error ?? null,
      afterError: after?.error ?? null
    };
  });

  const count = delta => rows.filter(row => row.delta === delta).length;
  return {
    comparable: problems.length === 0,
    problems,
    rows,
    totals: {
      baselinePassed: rows.filter(row => row.beforePass === true).length,
      currentPassed: rows.filter(row => row.afterPass === true).length,
      gained: count('gained'),
      regressed: count('regressed'),
      same: count('same'),
      missing: count('missing')
    }
  };
}

function markdown(baseline, current, outcome, files) {
  const lines = [];
  lines.push('# 24 题回归逐题对比', '');
  lines.push(`- 基线：\`${files.baseline}\``);
  lines.push(`- 本次：\`${files.current}\``);
  lines.push(`- 基线生成时间：${baseline?.createdAt ?? '未知'} · workers=${baseline?.workers ?? '?'} · completeness=${String(baseline?.completeness)}`);
  lines.push(`- 本次生成时间：${current?.createdAt ?? '未知'} · workers=${current?.workers ?? '?'} · completeness=${String(current?.completeness)} · incremental=${current?.incremental ? 'YES' : 'null'}`);
  if (current?.runner) {
    lines.push(`- 本次代码：commit ${current.runner.commit ?? '?'} · runner ${current.runner.version} · prompt ${current.runner.promptVersion} · 裁决入口 ${current.runner.adjudication ?? '?'}`);
  }
  lines.push('');

  if (!outcome.comparable) {
    lines.push('## 口径不同，不作逐题差异', '');
    for (const problem of outcome.problems) lines.push(`- ${problem}`);
    lines.push('', '需要重跑一次同口径的基线，或明确标注「不可比」，不要强行对比。');
    return lines.join('\n');
  }

  const { totals, rows } = outcome;
  lines.push('## 汇总', '');
  lines.push(`- 基线通过：${String(totals.baselinePassed)}/${String(rows.length)}`);
  lines.push(`- 本次通过：${String(totals.currentPassed)}/${String(rows.length)}`);
  lines.push(`- 新增通过：${String(totals.gained)} · 退化：${String(totals.regressed)} · 不变：${String(totals.same)} · 缺题：${String(totals.missing)}`);
  lines.push('');
  lines.push('> `passed` 是 V1 标准答案评分过关，不等于事实正确；`quality` 是规则/评审状态，两者分开看。');
  lines.push('');
  lines.push('## 逐题', '');
  lines.push('| 题 | 策略 | 基线 | 本次 | 差异 | 质量（基线→本次） | 裁判（本次） |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const mark = value => (value === null ? '缺' : value ? 'pass' : 'fail');
  const deltaText = { gained: '**新增通过**', regressed: '**退化**', same: '不变', missing: '缺题' };
  for (const row of rows) {
    const judge = row.afterJudge
      ? `${row.afterJudge.backend}${row.afterJudge.switched ? '（换过裁判）' : ''}${row.afterJudge.exhausted ? '（候选耗尽）' : ''}`
      : '-';
    lines.push(
      `| ${row.id} | ${row.strategy ?? '-'} | ${mark(row.beforePass)} | ${mark(row.afterPass)} | ${deltaText[row.delta]} | ${row.beforeQuality ?? '-'} → ${row.afterQuality ?? '-'} | ${judge} |`
    );
  }
  lines.push('');
  const regressed = rows.filter(row => row.delta === 'regressed');
  if (regressed.length > 0) {
    lines.push('## 退化题的原因（照原文记，不改写）', '');
    for (const row of regressed) {
      lines.push(`- ${row.id}：${row.afterError ?? '无报错，评分未过'}（质量 ${row.beforeQuality ?? '-'} → ${row.afterQuality ?? '-'}）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2).filter(item => !item.startsWith('--'));
  const outArg = process.argv.find(item => item.startsWith('--out='));
  if (args.length < 2) {
    console.error('用法：node scripts/regression/compare-results.cjs <baseline.json> <current.json> [--out=xxx.md]');
    process.exit(1);
  }
  const baselinePath = path.resolve(process.cwd(), args[0]);
  const currentPath = path.resolve(process.cwd(), args[1]);
  const baseline = readJson(baselinePath);
  const current = readJson(currentPath);
  const outcome = compare(baseline, current);
  const text = markdown(baseline, current, outcome, {
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

module.exports = { compare, markdown };
