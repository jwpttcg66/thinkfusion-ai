# Phase 5：质量指标、历史复用与成本

对应任务书 Phase 5（回归集、指标、历史知识、成本优化）与 AC-15 的延伸。
分支 `0.1.1`，接在 Phase 4 之后。

这一阶段最容易做成两件假事：编一个「综合质量分」，和把没有数据来源的
Token/费用算出一个数字。两个都没做。指标只算从落盘数据里真能算出来的，
没有分母时给 `null` 而不是 `0`。

## 交付了什么

| 文件 | 变更 |
| --- | --- |
| `src/main/debate/metrics.ts`（新增） | 单场指标 + 汇总指标；`roundProgress` 判定无效轮 |
| `src/main/debate/history.ts`（新增） | 相似历史辩论查询（词袋 jaccard），只提示不自动复用 |
| `src/main/debate/eval.ts`（新增） | 标注集评分：档位一致、关键词、错误前提纠正、校准度不适用 |
| `src/main/debate/types.ts` | `DebateState.metrics`；`DebateConfig.earlyStopOnStall` |
| `src/main/debate/orchestrator.ts` | 收尾算指标；连续两轮空转可提前收尾（默认关） |
| `src/main/index.ts` / `preload` / `contracts.ts` | `debate:related` 只读接口；`RelatedDebateView` |
| `src/renderer/src/components/ResearchPanel.tsx` | 指标块、历史相似辩论、成本开关 |
| `scripts/fixtures/debate-labels.mjs`（新增） | 4 条示例标签（`labelSource: seed`） |
| `scripts/check-debate-metrics.mjs`（新增） | 9 条 |
| `scripts/check-debate-eval.mjs`（新增） | 1 条，跑完产出 `docs/reports/DEBATE_METRICS.md` |

## 1. 指标：五项能算的，三项算不了的

| 指标 | 定义 | 数据来源 |
| --- | --- | --- |
| 证据可追溯率 | 被判定的主张中，至少有一条 `page-link` 且非同源转载证据的比例 | `judgments` + `evidence` |
| 无效辩论率 | 除首轮外，没有新证据、没有接受/修正/撤回、也没有新争议的轮次占比 | `rounds` + `evidence` + `revisions` + `disputes` |
| 少数派保留率 | 少数派原文仍在最终记录里逐字存在的比例（设计上恒 100%） | `minorities` |
| 成本与延迟 | 总耗时、平均每轮耗时、发言次数、失败次数 | `rounds.startedAt/endedAt` |
| 分歧保留（结构性） | 少数派条数，随结论一起看 | `minorities` + `verdict` |

算不了的三项，原因都写在报告里：

- **事实准确率**：需要人工标注的正确答案。本仓库只有 4 条示例标签。
- **错误前提纠正率**：可以在标注集里算（见下），但只有带 `wrongPremise`
  标签的用例才算，不能推广成「系统纠正错误前提的能力」。
- **校准度**：五档结论不带置信度。要做得先让裁判输出概率，再有基准集；
  现在给任何数字都是编的。

`rate` 在分母为 0 时是 `null`：`traceability.rate === null` 的意思是「没有
可判主张」，不是「一条都不可追溯」。这两个状态混成 0% 会让人以为辩论质量
差，其实是没跑起来。

## 2. 历史复用：只提示，不自动跳过

`relatedDebates(states, question)` 用与综合层同一套词袋算相似度（≥ 0.45），
返回问题、相似度、当时的结论与策略。界面在「辩论」页显示成一行提示，
点进去看当时的报告。

**刻意不做自动复用**：同一句话隔一周问，版本、证据、前提都可能变了；把旧
结论静默当新结论，比重复跑一遍危险。也不做「相似就降轮数」——省下的调用
换来的是一次看起来跑过、其实没验的结论。

## 3. 成本：能省的是调用，不是证据

- 轮数、并发、单次超时、整场时长从 Phase 2 起就有（`budget`）。
- 新增 `earlyStopOnStall`：**连续两轮**没有新增证据、没有实质修订（接受/
  修正/撤回）、也没有新争议时收尾。默认关闭，界面默认不勾——「打满 N 轮」
  是调用方的预期，改它得有人明确选。
- 只「坚持（defend）」不算进展：那正是无效轮的定义。
- Token 与费用仍然不做：网页通道与本地 Ollama 都不报用量，云端只有部分
  返回。算出来的数字会让预算变成假的。

## 4. 标注集与评测

`scripts/fixtures/debate-labels.mjs` 四条用例：有页面出处、只有断言、错误
前提、少数派有强证据。每条都写 `labelSource: 'seed'`，报告里 seed 与 human
分开统计。

`evaluateCases` 的输出：

- `accuracy`：五档结论与标签一致的比例；`expectVerdict: null` 的要求是
  「不是 supported」。
- `premiseCorrection`：只看带 `wrongPremise` 的用例里有没有说出正确说法，
  **与结论档位无关**。原因：一句算术常识没有页面链接时，裁判会如实给
  `insufficient_evidence`，把它和「没纠正前提」算在一起会误判。
- `calibration: 'not-applicable'` + 一句原因，不留空字段让人猜。

## 5. 验证

- `npm run test:debate-metrics`，9 条：无主张时比率为 `null`；页面来源算可追溯、
  自称出处不算；同源转载不算第二条；无效轮判据（含 defend 不算进展）；少数派
  丢失即回归；汇总只有算术没有总分；提前收尾打开时 5 轮停在第 3 轮、关闭时
  跑满；历史复用能找到同类、排除不相关、`exclude` 生效。
- `npm run test:debate-eval`：4 条用例跑完整链路，断言「只有断言不得判
  supported」「少数派有可复现来源时胜出」，产出报告。
- `npm test` 全绿；`npm run typecheck`、`npm run build` 通过。

## 6. 这些数字不能说明什么

- 回放用的是写好的发言，不是真模型：它证明链路和判定规则在变，不证明模型
  会这么回答。
- 4 条用例的标签是按本仓库规则写的示例标签，100% 只说明「标签和规则一致」。
- 只有 4 条用例、每条 1 轮，统计上没有代表性；它的用处是让指标随代码变化，
  不是给系统打分。
- 一次真机（引擎级）运行里，47 条主张没有一条有页面链接，可追溯率是 0%：
  那不是链路坏了，是本地模型不会给链接——网页通道才可能给。这也说明这个
  指标衡量的是「来源可核验」，不是「答案对不对」。
