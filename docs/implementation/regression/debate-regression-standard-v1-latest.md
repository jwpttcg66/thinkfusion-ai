# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T05:15:10.752Z
- 结构化通过：是
- 执行结果：{"COMPLETED":3}
- 裁判：模型 3/3，独立 3/3，sharedWith 0
- 质量状态：{"passed":3}
- 事实维度：{"model-assessed":3}
- anchor 烟测：0/0（不是事实准确率）

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cache-invalidation | expert | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 151s |
| mq-delivery | solution | gpt | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 198s |
| distributed-lock | discovery | kimi | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | - | 110s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
