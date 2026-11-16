# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-16T06:51:53.219Z
- 结构化通过：否
- 执行结果：{"COMPLETED":24}
- 裁判：模型 24/24，独立 24/24，sharedWith 0
- 质量状态：{"passed":24}
- 事实维度：{"model-assessed":24}
- anchor 烟测：8/8（不是事实准确率）
- V1 门槛：passed 21/24，failed 3，unavailable 0，平均分 96
- V1 分类匹配：24/24

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 76s |
| array-map | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 146s |
| http-methods | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 196s |
| tcp-udp | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 80s |
| btree-index | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 138s |
| acid | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 108s |
| jwt-revoke | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 104s |
| csrf-xss | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 136s |
| cache-invalidation | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 247s |
| index-generation | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 125s |
| mq-delivery | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 209s |
| distributed-lock | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 193s |
| schema-migration | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 138s |
| feature-flag | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 169s |
| rate-limit | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 144s |
| observability | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 63s |
| testing-pyramid | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 234s |
| unicode-utf8 | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 138s |
| timezone | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 139s |
| compression | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 192s |
| git-rebase | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 180s |
| process-thread | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 105s |
| memory-leak | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 266s |
| monolith-microservices | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 157s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
