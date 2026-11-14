/**
 * Render the 24-question technical fact baseline to Markdown.
 * Run: npm run docs:debate-standard
 */
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const source = path.join(here, 'debate-standard-answers-v1.json');
const target = path.resolve(here, '../../../docs/implementation/DEBATE_TECH_FACT_BASELINE_V1.md');
const data = JSON.parse(fs.readFileSync(source, 'utf8'));

const verdictLabel = { retain: '保留', supplement: '保留并补充', redo: '重新形成结论' };
const classificationLabel = {
  FACT: 'FACT（客观事实）',
  CONTEXTUAL: 'CONTEXTUAL（依赖场景）',
  INSUFFICIENT: 'INSUFFICIENT（信息不足）'
};

const counts = {};
for (const item of data.questions) counts[item.review.verdict] = (counts[item.review.verdict] ?? 0) + 1;
const classCounts = {};
for (const item of data.questions) classCounts[item.classification] = (classCounts[item.classification] ?? 0) + 1;

const lines = [];
lines.push('# ThinkFusion 技术事实回归标准答案 V1');
lines.push('');
lines.push(`- Schema：\`${data.schema}\``);
lines.push(`- 版本：\`${data.version}\``);
lines.push(`- 复核人：${data.reviewedBy}`);
lines.push(`- 复核日期：${data.reviewedAt}`);
lines.push(`- SHA-256：\`${data.sha256}\``);
lines.push('');
lines.push('> 这是人工复核后的技术知识基线，不是对所有世界事实的自动核验。');
lines.push('> 分类与必答主张来自用户逐条审查；模型做得好不好，按这里的标准判，不看模型自评。');
lines.push('');
lines.push('## 1. 分类规则');
lines.push('');
lines.push('| 分类 | 含义 | 裁判要求 |');
lines.push('| --- | --- | --- |');
for (const [key, value] of Object.entries(data.classificationRule)) {
  lines.push(`| ${classificationLabel[key] ?? key} | ${value} | ${key === 'FACT' ? '必须给明确结论' : key === 'CONTEXTUAL' ? '必须给条件、边界和推荐方案' : '必须指出缺失信息及其影响'} |`);
}
lines.push('');
lines.push('本批 24 题：');
lines.push('');
lines.push(`- FACT：${classCounts.FACT ?? 0}`);
lines.push(`- CONTEXTUAL：${classCounts.CONTEXTUAL ?? 0}`);
lines.push(`- INSUFFICIENT：${classCounts.INSUFFICIENT ?? 0}`);
lines.push('');
lines.push('`CONTEXTUAL` 不等于 `INSUFFICIENT`：没有普适最优答案，不代表不能给条件性方案。');
lines.push('');
lines.push('## 2. 评分标准');
lines.push('');
lines.push(`总分 0–100；权重：必答主张 ${data.scoring.weights.requiredClaims}，边界条件 ${data.scoring.weights.boundaries}，无错误主张 ${data.scoring.weights.noWrongClaims}。`);
lines.push('');
for (const rule of data.scoring.rules) lines.push(`- ${rule}`);
lines.push('');
if (Array.isArray(data.mustReview) && data.mustReview.length > 0) {
  lines.push('### 2.1 must 复核');
  lines.push('');
  lines.push('| 题目 | claim | 变更 | 理由 |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of data.mustReview) {
    lines.push(`| \`${item.id}\` | \`${item.claimId}\` | ${item.from} → ${item.to} | ${item.reason} |`);
  }
  lines.push('');
}
lines.push('## 3. 怎么用这份基线');
lines.push('');
lines.push('对每个模型回答，按下面顺序判：');
lines.push('');
lines.push('1. 先看 `classification`：FACT 必须给明确结论；CONTEXTUAL 必须给条件、边界和推荐方案；INSUFFICIENT 才允许只说信息不足。');
lines.push('2. 逐条检查 `requiredClaims` 的 must 项是否被语义覆盖；不按字面匹配，允许 `allowedExpressions`。');
lines.push('3. 检查 `wrongClaims`：出现 major 错误直接压到 39 分以下；minor 只扣分。');
lines.push('4. 检查边界：CONTEXTUAL 只给结论、不给条件，最高 65。');
lines.push('5. 最后才看表达质量、结构和篇幅，不用模型自评的 `passed` 替代这套规则。');
lines.push('');
lines.push('建议的裁判输出结构：');
lines.push('');
lines.push('```json');
lines.push('{');
lines.push('  "questionType": "FACT|CONTEXTUAL|INSUFFICIENT",');
lines.push('  "matchedClaims": ["c1"],');
lines.push('  "missingClaims": ["c2"],');
lines.push('  "wrongClaims": [],');
lines.push('  "boundaryCovered": true,');
lines.push('  "score": 0,');
lines.push('  "reason": "为什么扣分"');
lines.push('}');
lines.push('```');
lines.push('');
lines.push('`score` 只是这套基线下的回归分，不是事实准确率，也不是 `PRODUCTION_READY`。');
lines.push('');
lines.push('## 4. 复核汇总');
lines.push('');
lines.push(`- 保留：${counts.retain ?? 0} 题`);
lines.push(`- 保留并补充：${counts.supplement ?? 0} 题`);
lines.push(`- 重新形成结论：${counts.redo ?? 0} 题`);
lines.push('');
lines.push('| # | ID | 复核结论 | 分类 |');
lines.push('| --- | --- | --- | --- |');
data.questions.forEach((item, index) => {
  lines.push(`| ${index + 1} | \`${item.id}\` | ${verdictLabel[item.review.verdict]} | ${classificationLabel[item.classification]} |`);
});
lines.push('');
lines.push('## 5. 逐题标准');
lines.push('');
data.questions.forEach((item, index) => {
  lines.push(`### ${index + 1}. ${item.id}`);
  lines.push('');
  lines.push(`**题目：** ${item.question}`);
  lines.push('');
  lines.push(`**复核：** ${verdictLabel[item.review.verdict]} · ${item.review.summary}`);
  lines.push('');
  lines.push(`**分类：** ${classificationLabel[item.classification]}`);
  lines.push('');
  lines.push('**标准事实：**');
  lines.push('');
  for (const fact of item.standardFacts) lines.push(`- ${fact}`);
  lines.push('');
  lines.push('**必答主张：**');
  lines.push('');
  for (const claim of item.requiredClaims) {
    lines.push(`- \`${claim.id}\` [${claim.severity === 'must' ? '必须' : '建议'}] ${claim.text}`);
  }
  lines.push('');
  lines.push('**允许的不同表达：**');
  lines.push('');
  lines.push(item.allowedExpressions.map(value => `\`${value}\``).join('、'));
  lines.push('');
  lines.push('**错误主张：**');
  lines.push('');
  for (const wrong of item.wrongClaims) {
    lines.push(`- [${wrong.severity === 'major' ? '重大' : '轻微'}] ${wrong.text}（${wrong.reason}）`);
  }
  lines.push('');
  lines.push(`**评分入口：** 必须覆盖 ${item.judging.mustPass.map(id => `\`${id}\``).join('、')}。${item.judging.notes}`);
  lines.push('');
});

lines.push('## 6. 默认回归门槛');
lines.push('');
lines.push('`npm run regression:debate` 现在默认加载这份 V1 标准，并对每题额外做一次');
lines.push('标准答案评分。通过门槛必须同时满足：');
lines.push('');
lines.push('1. 辩论执行 `COMPLETED`；');
lines.push('2. 主裁判后端是 `model`，且裁判没有参加该场辩论；');
lines.push('3. `factualAccuracy` 不是 `supported`，事实仍标 `model-assessed`；');
lines.push('4. 评分模型给出的 `questionType` 与标准分类一致；');
lines.push('5. 所有 `must` 级必答主张都被覆盖；');
lines.push('6. 没有出现 `major` 错误主张；');
lines.push('7. `CONTEXTUAL` 题给出了边界条件；');
lines.push('8. 标准分不低于 70。');
lines.push('');
lines.push('标准评分器在 `src/main/debate/standard-rubric.ts`。它只负责把候选回答和');
lines.push('人工标准对齐；`backend: model` 表示“模型应用了标准”，不是“事实已核验”。');
lines.push('缺 must、major 错误、CONTEXTUAL 缺边界、分类不一致都会由代码封顶，');
lines.push('不能让模型用一句“回答不错”绕过。');
lines.push('');
lines.push('');

fs.writeFileSync(target, lines.join('\n'), 'utf8');
console.log(target);
