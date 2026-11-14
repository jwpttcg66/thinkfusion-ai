/**
 * 回归结果汇总工具。供单进程 runner 和并行 wrapper 共用同一套口径。
 * 不依赖 Electron，只处理已经落盘的 results。
 */
function countBy(items, pick) {
  const out = {};
  for (const item of items) {
    const key = pick(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function buildSummary(results) {
  const completed = results.filter(item => item.debate.outcome === 'COMPLETED').length;
  const judgeModel = results.filter(item => item.judge.backend === 'model').length;
  const independent = results.filter(item => item.judge.backend === 'model' && !item.judge.sharedWith).length;
  const factual = countBy(results, item => item.quality?.factualAccuracy?.status ?? 'missing');
  const quality = countBy(results, item => item.quality?.status ?? 'missing');
  const anchors = results.filter(item => item.anchor?.checked);
  const standardRows = results.filter(item => item.standard);
  const standardScores = standardRows
    .map(item => item.standard?.score)
    .filter(score => typeof score === 'number');
  return {
    total: results.length,
    execution: countBy(results, item => item.debate.outcome ?? 'UNKNOWN'),
    completed,
    judgeModel,
    independent,
    sharedWith: results.filter(item => item.judge.sharedWith).length,
    quality,
    factual,
    anchors: {
      checked: anchors.length,
      hit: anchors.filter(item => item.anchor.hit).length
    },
    standard: {
      total: standardRows.length,
      passed: standardRows.filter(item => item.standard?.passed).length,
      failed: standardRows.filter(item => item.standard && !item.standard.passed && item.standard.backend !== 'unavailable').length,
      unavailable: standardRows.filter(item => item.standard?.backend === 'unavailable').length,
      averageScore: standardScores.length > 0
        ? Math.round(standardScores.reduce((sum, score) => sum + score, 0) / standardScores.length)
        : null,
      classificationMatches: standardRows.filter(item => item.standard?.classificationMatch).length
    },
    byStrategy: Object.fromEntries(
      [...new Set(results.map(item => item.strategy))].map(strategy => {
        const rows = results.filter(item => item.strategy === strategy);
        return [strategy, {
          total: rows.length,
          completed: rows.filter(item => item.debate.outcome === 'COMPLETED').length,
          judgeModel: rows.filter(item => item.judge.backend === 'model').length,
          independent: rows.filter(item => item.judge.backend === 'model' && !item.judge.sharedWith).length,
          avgDurationMs: Math.round(rows.reduce((sum, item) => sum + item.debate.durationMs, 0) / rows.length)
        }];
      })
    ),
    structuralOk: results.every(item =>
      item.debate.outcome === 'COMPLETED' &&
      item.judge.backend === 'model' &&
      !item.judge.sharedWith &&
      item.quality &&
      item.decision &&
      item.quality.factualAccuracy.status !== 'supported' &&
      item.standard?.passed === true
    )
  };
}

function markdown(summary, dataset, results) {
  const rows = results.map(item => [
    item.id,
    item.strategy,
    item.judge.agentId,
    item.debate.outcome,
    `${item.debate.rounds}/${item.debate.messages}`,
    item.judge.backend,
    item.quality?.status ?? 'missing',
    item.quality?.factualAccuracy?.status ?? 'missing',
    item.decision?.verdict ?? 'missing',
    item.decision?.action ?? 'missing',
    item.standard
      ? item.standard.backend === 'unavailable'
        ? 'unavail'
        : item.standard.passed ? 'pass' : 'fail'
      : '-',
    item.standard?.score ?? '-',
    item.anchor?.checked ? (item.anchor.hit ? 'hit' : 'miss') : '-',
    `${Math.round(item.debate.durationMs / 1000)}s`
  ]);
  return [
    '# Debate V3 24 题自动回归结果',
    '',
    `- 数据集版本：\`${dataset.version}\``,
    `- 数据集 SHA-256：\`${dataset.sha256}\``,
    `- 生成时间：${new Date().toISOString()}`,
    `- 结构化通过：${summary.structuralOk ? '是' : '否'}`,
    `- 执行结果：${JSON.stringify(summary.execution)}`,
    `- 裁判：模型 ${summary.judgeModel}/${summary.total}，独立 ${summary.independent}/${summary.total}，sharedWith ${summary.sharedWith}`,
    `- 质量状态：${JSON.stringify(summary.quality)}`,
    `- 事实维度：${JSON.stringify(summary.factual)}`,
    `- anchor 烟测：${summary.anchors.hit}/${summary.anchors.checked}（不是事实准确率）`,
    `- V1 门槛：passed ${summary.standard.passed}/${summary.standard.total}，failed ${summary.standard.failed}，unavailable ${summary.standard.unavailable}，平均分 ${summary.standard.averageScore ?? '-'}`,
    `- V1 分类匹配：${summary.standard.classificationMatches}/${summary.standard.total}`,
    '',
    '| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.join(' | ')} |`),
    '',
    '> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。',
    ''
  ].join('\n');
}

module.exports = { countBy, buildSummary, markdown };
