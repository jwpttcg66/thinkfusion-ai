# 24 题回归逐题对比

- 基线：`docs/implementation/regression/debate-regression-v1-1-completeness-latest.json`
- 本次：`docs/implementation/regression/debate-regression-gate0-cloud-latest.json`
- 基线生成时间：2026-11-14T16:25:46.723Z · workers=3 · completeness=true
- 本次生成时间：2026-11-16T03:32:41.858Z · workers=3 · completeness=true · incremental=null
- 本次代码：commit 4403514f4be9fbcfb854e7d04ef38caf24ebe58f · runner 2.1.0 · prompt 1.1.0 · 裁决入口 main/judge/adjudicate.adjudicateDebate

## 汇总

- 基线通过：18/24
- 本次通过：19/24
- 新增通过：2 · 退化：1 · 不变：21 · 缺题：0

> `passed` 是 V1 标准答案评分过关，不等于事实正确；`quality` 是规则/评审状态，两者分开看。

## 逐题

| 题 | 策略 | 基线 | 本次 | 差异 | 质量（基线→本次） | 裁判（本次） |
| --- | --- | --- | --- | --- | --- | --- |
| acid | discovery | fail | fail | 不变 | passed → passed | model |
| array-map | adversarial | pass | pass | 不变 | passed → passed | model |
| btree-index | solution | pass | pass | 不变 | passed → passed | model |
| cache-invalidation | expert | pass | pass | 不变 | passed → passed | model |
| compression | adversarial | pass | pass | 不变 | passed → passed | model |
| csrf-xss | adversarial | pass | pass | 不变 | passed → passed | model |
| distributed-lock | discovery | pass | pass | 不变 | passed → passed | model |
| feature-flag | adversarial | pass | pass | 不变 | passed → passed | model |
| float-equality | truth | pass | pass | 不变 | passed → passed | model |
| git-rebase | expert | pass | pass | 不变 | passed → passed | model |
| http-methods | expert | pass | pass | 不变 | passed → passed | model |
| index-generation | assumption | pass | pass | 不变 | passed → passed | model |
| jwt-revoke | truth | fail | fail | 不变 | passed → passed | model |
| memory-leak | solution | fail | fail | 不变 | passed → passed | model |
| monolith-microservices | discovery | pass | pass | 不变 | passed → passed | model |
| mq-delivery | solution | fail | pass | **新增通过** | passed → passed | model |
| observability | assumption | pass | pass | 不变 | passed → passed | model |
| process-thread | assumption | pass | fail | **退化** | passed → passed | model |
| rate-limit | expert | pass | pass | 不变 | passed → passed | model |
| schema-migration | truth | fail | fail | 不变 | passed → passed | model |
| tcp-udp | assumption | pass | pass | 不变 | passed → passed | model |
| testing-pyramid | solution | pass | pass | 不变 | passed → passed | model |
| timezone | truth | pass | pass | 不变 | passed → passed | model |
| unicode-utf8 | discovery | fail | pass | **新增通过** | passed → passed | model |

## 退化题的原因（照原文记，不改写）

- process-thread：无报错，评分未过（质量 passed → passed）

