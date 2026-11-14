# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T11:19:52.138Z
- 结构化通过：否
- 执行结果：{"PARTIAL":7,"COMPLETED":17}
- 裁判：模型 23/24，独立 23/24，sharedWith 0
- 质量状态：{"passed":23,"inconclusive":1}
- 事实维度：{"model-assessed":23,"unknown":1}
- anchor 烟测：8/8（不是事实准确率）
- V1 门槛：passed 13/24，failed 11，unavailable 0，平均分 84
- V1 分类匹配：24/24

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek | PARTIAL | 2/2 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 29s |
| array-map | adversarial | gpt | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 242s |
| http-methods | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 65 | hit | 164s |
| tcp-udp | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 210s |
| btree-index | solution | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 135s |
| acid | discovery | kimi | COMPLETED | 2/4 | rules | inconclusive | unknown | insufficient_evidence | hold | fail | 69 | hit | 127s |
| jwt-revoke | truth | deepseek | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 323s |
| csrf-xss | adversarial | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 180s |
| cache-invalidation | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 159s |
| index-generation | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 216s |
| mq-delivery | solution | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 196s |
| distributed-lock | discovery | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 155s |
| schema-migration | truth | deepseek | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 284s |
| feature-flag | adversarial | gpt | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 294s |
| rate-limit | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 181s |
| observability | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 221s |
| testing-pyramid | solution | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 270s |
| unicode-utf8 | discovery | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | hit | 114s |
| timezone | truth | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 248s |
| compression | adversarial | gpt | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 306s |
| git-rebase | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | - | 146s |
| process-thread | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 222s |
| memory-leak | solution | gpt | PARTIAL | 2/3 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 60 | - | 333s |
| monolith-microservices | discovery | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 189s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
