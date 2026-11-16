# V4.1 P1 评审修复记录

- 分支 / 工作树：`0.2.9` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.9`
- 输入：P1-A/P1-B 评审的 7 项意见
- 约束：不重跑 24 题，不改写 P0 冻结产物

---

## 1. 修复清单

| # | 项 | 处理 | 位置 |
| --- | --- | --- | --- |
| 1 | N 次基线比较 | 新增 `compare-baselines.cjs`，按逐题分类比较；数据集、标准答案、runner、重试策略、模型池、样本数、temperature/seed 任一不同就拒绝 | `scripts/regression/compare-baselines.cjs` |
| 2 | Runner 版本 | `2.2.0 → 2.3.0`；单轮与多轮报告都写 `standard.version/sha256` | `run-debate-regression.cjs` |
| 3 | 标准答案比较 | `compare-results.cjs` 增加标准答案 SHA 检查；旧报告缺字段直接拒绝 | `scripts/regression/compare-results.cjs` |
| 4 | 关联方向冲突 | 同一 pair 只保留一条；优先级 `contradicts > supports > context`；校验器对同 pair 多条直接报错 | `src/main/debate/claim-evidence-links.ts` |
| 5 | 重算脚本覆盖 | 输出路径不可能等于输入；无时间戳文件名也另写 `-stats-corrected` | `recompute-baseline-stats.cjs` |
| 6 | 模型裁判职责 | 唯一写入入口 `refreshClaimEvidenceLinks`；`claimEvidenceLinksSource = 'rules-judge'`；模型裁决不写关联并在契约里写明原因 | `claim-evidence-links.ts`、`orchestrator.ts`、`types.ts` |
| 7 | Pack 来源误标 | `origin === 'repo-snapshot'` 不自动生成 author 关联；裁判引用仍可写 judge | `claim-evidence-links.ts` |

---

## 2. 关键语义

### 2.1 方向冲突

```text
同一 (claim, evidence)：
  contradicts > supports > context
同方向：
  judge > pack > reviewer > author
```

反例/反驳优先于支持；同方向时裁判优先。校验器不再按「关系 + 来源」分别去重，而是按 pair 唯一，出现两条直接报 `同一对证据出现多条关联`。

### 2.2 规则裁判与模型裁判

- 规则裁判：`conclude()` 调 `refreshClaimEvidenceLinks`，写入关联并标 `rules-judge`。
- 模型裁判：`JudgeVerdict.evidence` 是消息级数据（`messageId`），没有 `evidenceId`；
  当前不写关联，也不改 `claimEvidenceLinks`。最终结论以 Verdict 为准。
- 如果 P3 要让模型裁决也写关联，必须先给 Verdict 增加 claim/evidence 引用契约，
  再扩展唯一入口，不能从消息级证据猜。

### 2.3 Pack 来源

`repo-snapshot` 证据的 `claimIds` 由 Pack 映射提供，不代表「作者引用了它」。
P1-B 自动关联跳过它；P2 必须显式给出 `source: 'pack'` 的关联输入。

---

## 3. 验收

新增 / 调整测试：

| 命令 | 结果 |
| --- | --- |
| `npm run test:compare-baselines` | 7/7 |
| `npm run test:claim-evidence-links` | 11/11 |
| `npm run test:regression-baseline` | 10/10 |
| `npm run test:debate-standard-answers` | 8/8 |
| `npm run test:debate-rubric` | 12/12 |

全量：

```text
npm run typecheck  → 三套 tsconfig 全绿
npm test           → 104 个文件全过（27.2s）
```

未执行：

- 未重跑 24 题；
- 未改写 P0 原始冻结 JSON/MD；
- 未 push、未合并。

---

## 4. 对合并的输入

- `compare-baselines.cjs` 可以直接读取 P0 的 `-stats-corrected` 与后续 P1 基线；
- 下一次基线必须使用 runner `2.3.0`、标准答案 `1.1.0`；
- 旧单轮报告与旧标准答案报告会被比较工具拒绝，这是预期行为，不是故障。
