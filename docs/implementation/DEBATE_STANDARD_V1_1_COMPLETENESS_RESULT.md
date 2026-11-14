# V1.1 完整 24 题：完整性复核 + 修订结果

- 日期：2026-11-15
- 模型池：`deepseek-v4.1-flash` / `gpt-6-luna` / `claude-haiku-5-5`
- Prompt：`1.1.0`
- 运行：单进程 3 worker，`--completeness`
- 明细：`docs/implementation/regression/debate-regression-v1-1-completeness-latest.json`

## 1. 总结

| 项 | 结果 |
| --- | --- |
| 题目数 | 24 |
| 执行 | COMPLETED 21 / PARTIAL 3 |
| 主裁判 | model 24 / rules 0 |
| 独立裁判 | 24 / 24 |
| 质量 | passed 24 / inconclusive 0 |
| 事实维度 | model-assessed 24 / unknown 0 |
| V1 | **passed 18 / failed 6** |
| 平均分 | 92 |
| 分类匹配 | 24 / 24 |
| 结构化通过 | 否 |

## 2. 完整性复核

- 复核出缺口：20 / 24 题
- 实际修订：20 题
- 修订后独立 Judge 为 model：20 / 20
- 复核/修订提示词不包含 24 题标准答案

## 3. V1 未通过 6 题

| 题目 | 执行 | score | 缺失 must | 是否修订 |
| --- | --- | --- | --- | --- |
| `acid` | COMPLETED | 69 | c3 | original |
| `jwt-revoke` | COMPLETED | 69 | c3 | revised |
| `mq-delivery` | COMPLETED | 60 | c3, c4 | revised |
| `schema-migration` | COMPLETED | 60 | c2, c3 | revised |
| `unicode-utf8` | COMPLETED | 69 | c3 | revised |
| `memory-leak` | COMPLETED | 69 | c2 | revised |

## 4. 3 道 PARTIAL

- `float-equality`：gpt-6-luna：连不上 https://opencode.ai/inference/go/openai/v1；claude-haiku-5-5：连不上 https://opencode.ai/inference/go/openai/v1
- `array-map`：deepseek-v4.1-flash：连不上 https://opencode.ai/inference/go/openai/v1；claude-haiku-5-5：连不上 https://opencode.ai/inference/go/openai/v1
- `http-methods`：deepseek-v4.1-flash：连不上 https://opencode.ai/inference/go/openai/v1；gpt-6-luna：连不上 https://opencode.ai/inference/go/openai/v1

## 5. 部分重跑

对 3 道 PARTIAL 单独重跑：`float-equality`、`array-map`、`http-methods`。

- `array-map`：COMPLETED，V1 通过；
- `http-methods`：COMPLETED，V1 失败；
- `float-equality`：仍为 PARTIAL，V1 通过。

这次重跑没有合并进主结果，避免把“21 完成 + 3 PARTIAL”的单一全量结果改成混合口径。

## 6. 结论

- 完整性复核/修订把 V1 从可信增量的 16/24 提升到本次 18/24；
- 24 题全部由独立模型裁判；质量 24/24 passed；
- 执行层仍有 3 道连接失败导致的 PARTIAL；
- 仍有 6 题缺 must/边界，没有 major 错误主张；
- 不能写 24/24，也不能把修订后的 V1 通过写成事实正确。

## 7. 限制

- 单次全量样本，不是稳定性重复实验；
- 完整性复核/修订是 model-assessed；
- 最多一次修订；
- 仍然只有一个 Provider，故障域独立性未验证。
