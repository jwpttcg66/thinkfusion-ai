/**
 * N 次 24 题回归的逐题统计与波动分析。
 *
 * 分工：runner 负责跑、落每轮结果；这里只做聚合，不重新解释结果。
 * 「V1 通过次数」是 N 次里 `standard.passed === true` 的次数，
 * PARTIAL 题同样计入，但单独展示，不能读成「完整运行通过」。
 */

function outcomeOf(result) {
  return result?.debate?.outcome ?? 'UNKNOWN';
}

function v1Of(result) {
  if (result?.standard?.passed === true) return 'pass';
  if (result?.standard?.backend === 'unavailable') return 'unavailable';
  if (result?.standard) return 'fail';
  return 'missing';
}

function providerUnavailableOf(result) {
  const failures = result?.debate?.failures ?? [];
  const details = failures.map(item => String(item?.detail ?? '')).join('\n');
  if (/endpoint is unavailable|（403）|\(403\)/i.test(details)) return true;
  if (/endpoint-unavailable|retry:endpoint-unavailable/i.test(String(result?.error ?? ''))) return true;
  return false;
}

function roundRate(value) {
  return Math.round(value * 1000) / 10;
}

function buildBaselineStats(runs, datasetQuestions) {
  const sampleCount = runs.length;
  const byId = new Map();
  for (const question of datasetQuestions) {
    byId.set(question.id, {
      id: question.id,
      strategy: question.strategy,
      category: question.category,
      runs: sampleCount,
      completed: 0,
      partial: 0,
      failed: 0,
      cancelled: 0,
      v1Pass: 0,
      v1Fail: 0,
      v1Unavailable: 0,
      judgeModel: 0,
      qualityPassed: 0,
      providerUnavailable: 0,
      outcomes: []
    });
  }

  for (const run of runs) {
    for (const result of run.results ?? []) {
      const row = byId.get(result.id);
      if (!row) continue;
      const outcome = outcomeOf(result);
      row.outcomes.push(outcome);
      if (outcome === 'COMPLETED') row.completed += 1;
      else if (outcome === 'PARTIAL') row.partial += 1;
      else if (outcome === 'CANCELLED') row.cancelled += 1;
      else row.failed += 1;

      const v1 = v1Of(result);
      if (v1 === 'pass') row.v1Pass += 1;
      else if (v1 === 'unavailable') row.v1Unavailable += 1;
      else if (v1 === 'fail') row.v1Fail += 1;

      if (result?.judge?.backend === 'model') row.judgeModel += 1;
      if (result?.quality?.status === 'passed') row.qualityPassed += 1;
      if (providerUnavailableOf(result)) row.providerUnavailable += 1;
    }
  }

  const perQuestion = [...byId.values()].map(row => {
    const assessed = row.v1Pass + row.v1Fail;
    const incomplete = row.completed < sampleCount || row.v1Unavailable > 0 || assessed < sampleCount;
    const category = incomplete
      ? 'incomplete'
      : row.v1Pass === sampleCount
        ? 'stable-pass'
        : row.v1Fail === sampleCount
          ? 'stable-fail'
          : 'fluctuating';
    return {
      ...row,
      v1PassRate: roundRate(row.v1Pass / Math.max(1, sampleCount)),
      completeRate: roundRate(row.completed / Math.max(1, sampleCount)),
      category
    };
  });

  const totalAttempts = perQuestion.length * sampleCount;
  const sum = key => perQuestion.reduce((acc, row) => acc + row[key], 0);
  // 「评分稳定通过」只看 V1 次数；「端到端稳定通过」还要求每次都 COMPLETED。
  // 两者分开，避免把一次 PARTIAL/评分不可用混成「稳定」。
  const stablePass = perQuestion.filter(row => row.v1Pass === sampleCount).length;
  const stableCompletePass = perQuestion.filter(row => row.category === 'stable-pass').length;
  const stableFail = perQuestion.filter(row => row.category === 'stable-fail').length;
  const fluctuating = perQuestion.filter(row => row.category === 'fluctuating').length;
  const incomplete = perQuestion.filter(row => row.category === 'incomplete').length;

  return {
    sampleCount,
    questionCount: perQuestion.length,
    totalAttempts,
    perRun: runs.map(run => ({
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      summary: run.summary
    })),
    aggregate: {
      completed: sum('completed'),
      partial: sum('partial'),
      failed: sum('failed'),
      cancelled: sum('cancelled'),
      executionCompleteRate: roundRate(sum('completed') / Math.max(1, totalAttempts)),
      v1Pass: sum('v1Pass'),
      v1Fail: sum('v1Fail'),
      v1Unavailable: sum('v1Unavailable'),
      v1PassRate: roundRate(sum('v1Pass') / Math.max(1, totalAttempts)),
      judgeModel: sum('judgeModel'),
      qualityPassed: sum('qualityPassed'),
      qualityCompleteRate: roundRate(sum('qualityPassed') / Math.max(1, totalAttempts)),
      providerUnavailable: sum('providerUnavailable'),
      stablePass,
      stableCompletePass,
      stableFail,
      fluctuating,
      incomplete
    },
    perQuestion
  };
}

function markdownBaseline({ stats, config, runs }) {
  const lines = [];
  lines.push('# Debate V4.1 P0 基线报告');
  lines.push('');
  lines.push(`- 生成时间：${config.createdAt}`);
  lines.push(`- 代码基线：${config.runner.commit ?? '未知'}（tag：${config.baselineTag ?? '未打'}）`);
  lines.push(`- Runner：${config.runner.version} · 重试策略 ${config.retryPolicy.version}`);
  lines.push(`- 模型：${config.models.map(item => item.model).join('、')}`);
  lines.push(`- Backend：${config.runner.backend} · Provider：${config.runner.provider}`);
  lines.push(`- 数据集：${config.dataset.version} · \`${config.dataset.sha256.slice(0, 12)}…\``);
  lines.push(`- Prompt：${config.runner.promptVersion}`);
  lines.push(`- 运行：${stats.sampleCount}/${config.runtime.runs} 次 × ${stats.questionCount} 题（workers=${config.runtime.workers}，providerConcurrency=${config.runtime.providerConcurrency}）`);
  if (config.stoppedEarly) {
    lines.push(`- 提前停止：${config.stoppedEarly.reason}（${config.stoppedEarly.afterRun} 后，${config.stoppedEarly.quotaFailures} 题 429/额度失败）`);
  }
  lines.push(`- 采样：temperature=${config.sampling.temperature.support === 'unsupported' ? 'unsupported' : config.sampling.temperature.value}，seed=${config.sampling.seed.support === 'unsupported' ? 'unsupported' : config.sampling.seed.value}（${config.sampling.seed.support}）`);
  lines.push('');
  lines.push('## 总体');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 完整运行 | ${stats.aggregate.completed}/${stats.totalAttempts}（${stats.aggregate.executionCompleteRate}%） |`);
  lines.push(`| PARTIAL | ${stats.aggregate.partial} |`);
  lines.push(`| FAILED / CANCELLED | ${stats.aggregate.failed} / ${stats.aggregate.cancelled} |`);
  lines.push(`| V1 通过 | ${stats.aggregate.v1Pass}/${stats.totalAttempts}（${stats.aggregate.v1PassRate}%） |`);
  lines.push(`| 质量报告通过 | ${stats.aggregate.qualityPassed}/${stats.totalAttempts}（${stats.aggregate.qualityCompleteRate}%） |`);
  lines.push(`| 稳定通过（评分） | ${stats.aggregate.stablePass} |`);
  lines.push(`| 稳定通过（完整执行） | ${stats.aggregate.stableCompletePass} |`);
  lines.push(`| 稳定未通过（完整执行） | ${stats.aggregate.stableFail} |`);
  lines.push(`| 波动（完整执行） | ${stats.aggregate.fluctuating} |`);
  lines.push(`| 不完整（PARTIAL/UNAVAILABLE/缺失） | ${stats.aggregate.incomplete} |`);
  lines.push(`| Provider 不可用 | ${stats.aggregate.providerUnavailable} 次 |`);
  lines.push('');
  lines.push('## 每次运行');
  lines.push('');
  lines.push('| 运行 | 开始 | 结束 | COMPLETED | PARTIAL | V1 通过 | V1 失败 | structuralOk |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const run of runs) {
    const s = run.summary;
    lines.push(`| ${run.runId} | ${run.startedAt} | ${run.endedAt} | ${s.execution?.COMPLETED ?? 0} | ${s.execution?.PARTIAL ?? 0} | ${s.standard?.passed ?? 0}/${s.standard?.total ?? 0} | ${s.standard?.failed ?? 0} | ${s.structuralOk ? '是' : '否'} |`);
  }
  lines.push('');
  lines.push('## 逐题统计');
  lines.push('');
  lines.push('| 题目 | 策略 | 分类 | 完整运行 | V1 通过 | 通过率 | PARTIAL | Provider 不可用 |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const row of stats.perQuestion) {
    lines.push(`| ${row.id} | ${row.strategy} | ${row.category} | ${row.completed}/${stats.sampleCount} | ${row.v1Pass}/${stats.sampleCount} | ${row.v1PassRate}% | ${row.partial} | ${row.providerUnavailable} |`);
  }
  lines.push('');
  const fluctuating = stats.perQuestion.filter(row => row.category === 'fluctuating');
  lines.push('## 波动题');
  lines.push('');
  if (fluctuating.length === 0) lines.push('无。');
  else {
    for (const row of fluctuating) {
      lines.push(`- ${row.id}：${row.v1Pass}/${stats.sampleCount} 次通过，执行状态 ${row.outcomes.join(' / ')}`);
    }
  }
  lines.push('');
  lines.push('> `V1 通过` 是标准答案评分，不等于事实正确；PARTIAL 题的评分单独计入，不表示完整运行通过。');
  return lines.join('\n');
}

module.exports = { buildBaselineStats, markdownBaseline, providerUnavailableOf, v1Of };
