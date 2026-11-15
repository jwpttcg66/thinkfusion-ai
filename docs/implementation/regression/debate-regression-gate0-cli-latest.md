# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-15T11:13:13.959Z
- 结构化通过：否
- 执行结果：{"COMPLETED":24}
- 裁判：模型 24/24，独立 24/24，sharedWith 0
- 质量状态：{"passed":23,"inconclusive":1}
- 事实维度：{"model-assessed":24}
- anchor 烟测：8/8（不是事实准确率）
- V1 门槛：passed 20/24，failed 4，unavailable 0，平均分 93
- V1 分类匹配：24/24

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 228s |
| array-map | adversarial | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 237s |
| http-methods | expert | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 30 | hit | 114s |
| tcp-udp | assumption | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 188s |
| btree-index | solution | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 300s |
| acid | discovery | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 158s |
| jwt-revoke | truth | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 332s |
| csrf-xss | adversarial | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 206s |
| cache-invalidation | expert | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 271s |
| index-generation | assumption | deepseek-flash | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | pass | 100 | - | 289s |
| mq-delivery | solution | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 206s |
| distributed-lock | discovery | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 260s |
| schema-migration | truth | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 203s |
| feature-flag | adversarial | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 151s |
| rate-limit | expert | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 197s |
| observability | assumption | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 191s |
| testing-pyramid | solution | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 145s |
| unicode-utf8 | discovery | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 176s |
| timezone | truth | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 214s |
| compression | adversarial | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 259s |
| git-rebase | expert | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 229s |
| process-thread | assumption | deepseek-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 125s |
| memory-leak | solution | qwen3-8-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 215s |
| monolith-microservices | discovery | kimi-k2-8-preview | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 278s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
