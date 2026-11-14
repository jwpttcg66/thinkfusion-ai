# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T04:39:10.413Z
- 结构化通过：是
- 执行结果：{"COMPLETED":24}
- 裁判：模型 24/24，独立 24/24，sharedWith 0
- 质量状态：{"passed":16,"inconclusive":8}
- 事实维度：{"model-assessed":24}
- anchor 烟测：8/8（不是事实准确率）

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 92s |
| array-map | adversarial | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 104s |
| http-methods | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 116s |
| tcp-udp | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 114s |
| btree-index | solution | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 150s |
| acid | discovery | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 97s |
| jwt-revoke | truth | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 182s |
| csrf-xss | adversarial | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 122s |
| cache-invalidation | expert | kimi | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 174s |
| index-generation | assumption | deepseek | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 220s |
| mq-delivery | solution | gpt | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 223s |
| distributed-lock | discovery | kimi | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 159s |
| schema-migration | truth | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 130s |
| feature-flag | adversarial | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 178s |
| rate-limit | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 138s |
| observability | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 179s |
| testing-pyramid | solution | gpt | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 191s |
| unicode-utf8 | discovery | kimi | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | hit | 175s |
| timezone | truth | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | hit | 143s |
| compression | adversarial | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 125s |
| git-rebase | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 92s |
| process-thread | assumption | deepseek | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 173s |
| memory-leak | solution | gpt | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 167s |
| monolith-microservices | discovery | kimi | COMPLETED | 2/4 | model | inconclusive | model-assessed | insufficient_evidence | hold | - | 131s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
