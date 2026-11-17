# Pack Judge 真实模型回归

- 数据集：1.0.0 · `3d8913f6bcdf…`
- 模型：deepseek-v4.1-flash
- 每次运行：3 次 × 12 题
- 真实调用：37 次

## 指标

| 指标 | 值 |
| --- | --- |
| 模型成功 | 36/36（100%） |
| 一次 JSON 成功 | 97.2% |
| 最终解析成功 | 100% |
| 回退规则版 | 0% |
| 非法 ID 接受 | 0 |
| 禁止方向接受 | 0 |
| 来源快照错配 | 0 |
| 方向一致率 | 75% |
| 限制关键词命中 | 97.2% |
| 平均耗时 | 20040ms |

## 方向准确率

- context: 83.3%
- supports: 100%
- contradicts: 100%

## 逐题

| 题 | 期望 | run-1 | run-2 | run-3 | 一致 |
| --- | --- | --- | --- | --- | --- |
| A1-code-exists-not-called | context | context | context | context | 是 |
| A2-cache-write-not-hit | context | context | context | context | 是 |
| A3-catch-not-all-errors | context | contradicts | context | context | 否 |
| B4-condition-branch | supports | supports | supports | supports | 是 |
| B5-param-validation | supports | supports | supports | supports | 是 |
| C6-else-branch-contradicts | contradicts | contradicts | contradicts | contradicts | 是 |
| C7-limit-has-cap | contradicts | contradicts | contradicts | contradicts | 是 |
| D8-call-without-implementation | context | context | context | context | 是 |
| D9-static-code-runtime-claim | context | context | context | context | 是 |
| E10-distractor-evidence | context | context | context | - | 否 |
| E11-illegal-relation | context | context | context | context | 是 |
| E12-valid-id-irrelevant | context | context | contradicts | contradicts | 否 |

> 这是真实模型调用；模拟 JSON 测试不进入本报告。
