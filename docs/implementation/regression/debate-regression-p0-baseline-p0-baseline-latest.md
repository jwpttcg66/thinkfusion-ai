# Debate V4.1 P0 基线报告

- 生成时间：2026-11-16T05:43:35.354Z
- 代码基线：370bb0457e340da931fd175ee4ad3d8357772e97（tag：debate-v4.1-p0-baseline-20261116）
- Runner：2.2.0 · 重试策略 1.0.0
- 模型：deepseek-v4.1-flash、gpt-6-luna、claude-haiku-5-5
- Backend：opencode-go · Provider：opencode-go
- 数据集：1.0.0 · `ebd15b7e5ec7…`
- Prompt：1.1.0
- 运行：3/3 次 × 24 题（workers=3，providerConcurrency=6）
- 采样：temperature=0，seed=42（accepted）

## 总体

| 项 | 值 |
| --- | --- |
| 完整运行 | 71/72（98.6%） |
| PARTIAL | 1 |
| FAILED / CANCELLED | 0 / 0 |
| V1 通过 | 52/72（72.2%） |
| 质量报告通过 | 72/72（100%） |
| 稳定通过题 | 12 |
| 波动题 | 11 |
| 稳定未通过题 | 1 |
| Provider 不可用 | 1 次 |

## 每次运行

| 运行 | 开始 | 结束 | COMPLETED | PARTIAL | V1 通过 | V1 失败 | structuralOk |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| run-1 | 2026-11-16T05:43:35.380Z | 2026-11-16T06:04:57.105Z | 24 | 0 | 16/24 | 8 | 否 |
| run-2 | 2026-11-16T06:04:57.110Z | 2026-11-16T06:29:36.683Z | 23 | 1 | 15/24 | 9 | 否 |
| run-3 | 2026-11-16T06:29:36.689Z | 2026-11-16T06:51:53.214Z | 24 | 0 | 21/24 | 3 | 否 |

## 逐题统计

| 题目 | 策略 | 完整运行 | V1 通过 | 通过率 | PARTIAL | Provider 不可用 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| float-equality | truth | 3/3 | 1/3 | 33.3% | 0 | 0 |
| array-map | adversarial | 3/3 | 1/3 | 33.3% | 0 | 0 |
| http-methods | expert | 3/3 | 1/3 | 33.3% | 0 | 0 |
| tcp-udp | assumption | 3/3 | 3/3 | 100% | 0 | 0 |
| btree-index | solution | 3/3 | 3/3 | 100% | 0 | 0 |
| acid | discovery | 3/3 | 2/3 | 66.7% | 0 | 0 |
| jwt-revoke | truth | 3/3 | 1/3 | 33.3% | 0 | 0 |
| csrf-xss | adversarial | 3/3 | 3/3 | 100% | 0 | 0 |
| cache-invalidation | expert | 3/3 | 3/3 | 100% | 0 | 0 |
| index-generation | assumption | 3/3 | 1/3 | 33.3% | 0 | 0 |
| mq-delivery | solution | 3/3 | 2/3 | 66.7% | 0 | 0 |
| distributed-lock | discovery | 3/3 | 3/3 | 100% | 0 | 0 |
| schema-migration | truth | 2/3 | 2/3 | 66.7% | 1 | 1 |
| feature-flag | adversarial | 3/3 | 3/3 | 100% | 0 | 0 |
| rate-limit | expert | 3/3 | 3/3 | 100% | 0 | 0 |
| observability | assumption | 3/3 | 3/3 | 100% | 0 | 0 |
| testing-pyramid | solution | 3/3 | 2/3 | 66.7% | 0 | 0 |
| unicode-utf8 | discovery | 3/3 | 0/3 | 0% | 0 | 0 |
| timezone | truth | 3/3 | 3/3 | 100% | 0 | 0 |
| compression | adversarial | 3/3 | 3/3 | 100% | 0 | 0 |
| git-rebase | expert | 3/3 | 3/3 | 100% | 0 | 0 |
| process-thread | assumption | 3/3 | 1/3 | 33.3% | 0 | 0 |
| memory-leak | solution | 3/3 | 3/3 | 100% | 0 | 0 |
| monolith-microservices | discovery | 3/3 | 2/3 | 66.7% | 0 | 0 |

## 波动题

- float-equality：1/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- array-map：1/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- http-methods：1/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- acid：2/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- jwt-revoke：1/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- index-generation：1/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- mq-delivery：2/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- schema-migration：2/3 次通过，执行状态 COMPLETED / PARTIAL / COMPLETED
- testing-pyramid：2/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- process-thread：1/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED
- monolith-microservices：2/3 次通过，执行状态 COMPLETED / COMPLETED / COMPLETED

> `V1 通过` 是标准答案评分，不等于事实正确；PARTIAL 题的评分单独计入，不表示完整运行通过。