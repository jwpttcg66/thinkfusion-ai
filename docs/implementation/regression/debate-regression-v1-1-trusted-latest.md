# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T15:32:12.161Z
- 结构化通过：否
- 执行结果：{"COMPLETED":24}
- 裁判：模型 24/24，独立 24/24，sharedWith 0
- 质量状态：{"passed":24}
- 事实维度：{"model-assessed":24}
- anchor 烟测：8/8（不是事实准确率）
- V1 门槛：passed 16/24，failed 8，unavailable 0，平均分 88
- V1 分类匹配：24/24

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 48s |
| array-map | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 166s |
| http-methods | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | hit | 211s |
| tcp-udp | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 64s |
| btree-index | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 122s |
| acid | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 201s |
| jwt-revoke | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 75s |
| csrf-xss | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 254s |
| cache-invalidation | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 186s |
| index-generation | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 90s |
| mq-delivery | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 210s |
| distributed-lock | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 144s |
| schema-migration | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 70s |
| feature-flag | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 150s |
| rate-limit | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 181s |
| observability | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 76s |
| testing-pyramid | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 139s |
| unicode-utf8 | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 177s |
| timezone | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 70s |
| compression | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 111s |
| git-rebase | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 136s |
| process-thread | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 64s |
| memory-leak | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 195s |
| monolith-microservices | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 163s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
