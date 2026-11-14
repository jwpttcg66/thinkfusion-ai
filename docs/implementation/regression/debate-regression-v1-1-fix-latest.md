# Debate V3 24 题自动回归结果

- 数据集版本：`1.0.0`
- 数据集 SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 生成时间：2026-11-14T14:17:28.037Z
- 结构化通过：是
- 执行结果：{"COMPLETED":2}
- 裁判：模型 2/2，独立 2/2，sharedWith 0
- 质量状态：{"passed":2}
- 事实维度：{"model-assessed":2}
- anchor 烟测：0/0（不是事实准确率）
- V1 门槛：passed 2/2，failed 0，unavailable 0，平均分 100
- V1 分类匹配：2/2

| 题目 | 策略 | 裁判 | 执行 | 轮/条 | 裁判后端 | 质量 | 事实 | 结论 | 处理 | V1 | 评分 | anchor | 用时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mq-delivery | solution | gpt-6-luna | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 173s |
| process-thread | assumption | deepseek-v4.1-flash | COMPLETED | 2/4 | model | passed | model-assessed | partially_supported | accept_with_caveats | pass | 100 | - | 97s |

> `anchor` 只检查回答里是否出现人工列出的规则可查词，不能代表事实正确。
