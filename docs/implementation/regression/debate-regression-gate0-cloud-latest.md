# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-16T03:32:41.880Z
- 结构化通过：否
- 执行结果：{"COMPLETED":22,"PARTIAL":2}
- 裁判：模型 24/24，独立 24/24，sharedWith 0
- 质量状态：{"passed":24}
- 事实维度：{"model-assessed":24}
- anchor 烟测：8/8（不是事实准确率）
- V1 门槛：passed 19/24，failed 5，unavailable 0，平均分 93
- V1 分类匹配：24/24

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 56s |
| array-map | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 193s |
| http-methods | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 139s |
| tcp-udp | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 107s |
| btree-index | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 209s |
| acid | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 146s |
| jwt-revoke | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 76s |
| csrf-xss | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 211s |
| cache-invalidation | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 253s |
| index-generation | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 95 | - | 140s |
| mq-delivery | solution | gpt-6-luna | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 264s |
| distributed-lock | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 229s |
| schema-migration | truth | deepseek-v4.1-flash | PARTIAL | 2/2 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 105s |
| feature-flag | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 157s |
| rate-limit | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 163s |
| observability | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 61s |
| testing-pyramid | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 266s |
| unicode-utf8 | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 173s |
| timezone | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 102s |
| compression | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 224s |
| git-rebase | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 174s |
| process-thread | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 75s |
| memory-leak | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 319s |
| monolith-microservices | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 179s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
