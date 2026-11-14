# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T16:31:16.041Z
- 结构化通过：否
- 执行结果：{"PARTIAL":1,"COMPLETED":2}
- 裁判：模型 3/3，独立 3/3，sharedWith 0
- 质量状态：{"passed":3}
- 事实维度：{"model-assessed":3}
- anchor 烟测：3/3（不是事实准确率）
- V1 门槛：passed 2/3，failed 1，unavailable 0，平均分 90
- V1 分类匹配：3/3

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| float-equality | truth | deepseek-v4.1-flash | PARTIAL | 2/2 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 48s |
| array-map | adversarial | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | hit | 227s |
| http-methods | expert | claude-haiku-5-5 | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | fail | 69 | hit | 308s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
