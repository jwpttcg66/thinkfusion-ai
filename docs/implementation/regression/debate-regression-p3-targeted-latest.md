# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T17:48:39.296Z
- 结构化通过：否
- 执行结果：{"FAILED":3,"COMPLETED":6}
- 裁判：模型 9/9，独立 9/9，sharedWith 0
- 质量状态：{"needs_revision":3,"passed":6}
- 事实维度：{"model-assessed":9}
- anchor 烟测：6/6（不是事实准确率）
- V1 门槛：passed 6/9，failed 3，unavailable 0，平均分 90
- V1 分类匹配：9/9

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek-v4.1-flash | FAILED | 2/0 | model | needs_revision | model-assessed | partially_supported | hold | pass | 100 | hit | 18s |
| array-map | adversarial | gpt-6-luna | FAILED | 2/0 | model | needs_revision | model-assessed | partially_supported | hold | pass | 100 | hit | 51s |
| http-methods | expert | claude-haiku-5-5 | FAILED | 2/0 | model | needs_revision | model-assessed | partially_supported | hold | fail | 69 | hit | 80s |
| acid | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 122s |
| jwt-revoke | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 101s |
| mq-delivery | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 236s |
| schema-migration | truth | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 117s |
| unicode-utf8 | discovery | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 211s |
| memory-leak | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 279s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
