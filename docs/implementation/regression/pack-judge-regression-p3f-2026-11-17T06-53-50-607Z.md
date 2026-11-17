# Pack Judge 真实模型回归

- 数据集：1.1.0 · `53557d5e36af…`
- 模型：deepseek-v4.1-flash
- 每次运行：3 次 × 20 题
- 真实调用：60 次

## 指标

| 指标 | 值 |
| --- | --- |
| 模型成功 | 60/60（100%） |
| 一次 JSON 成功 | 100% |
| 最终解析成功 | 100% |
| 回退规则版 | 0% |
| 非法 ID 接受 | 0 |
| 禁止方向接受 | 1 |
| 来源快照错配 | 0 |
| 方向一致率 | 65% |
| 限制关键词命中 | 85% |
| 平均耗时 | 19757ms |

## 方向准确率

- context: 84.6%
- supports: 88.9%
- contradicts: 91.7%

## 逐题

| 题 | 期望 | run-1 | run-2 | run-3 | 一致 |
| --- | --- | --- | --- | --- | --- |
| A1-code-exists-not-called | context | context | context | context | 是 |
| A2-cache-write-not-hit | context | context | context | context | 是 |
| A3-catch-not-all-errors | context | context | context | context | 是 |
| B4-condition-branch | supports | supports | supports | supports | 是 |
| B5-param-validation | supports | supports | supports | supports | 是 |
| C6-else-branch-contradicts | contradicts | contradicts | contradicts | contradicts | 是 |
| C7-limit-has-cap | contradicts | contradicts | contradicts | contradicts | 是 |
| D8-call-without-implementation | context | context | - | context | 否 |
| D9-static-code-runtime-claim | context | context | context | - | 否 |
| E10-distractor-evidence | context | supports | - | context | 否 |
| E11-illegal-relation | context | context | context | context | 是 |
| E12-valid-id-irrelevant | context | context | context | context | 是 |
| F01-no-retry-code | context | context | context | context | 是 |
| F02-todo-retry | context | context | context | context | 是 |
| F03-complete-three-retries | supports | supports | supports | context | 否 |
| F04-complete-single-attempt | contradicts | context | contradicts | contradicts | 否 |
| F05-caller-only | context | context | context | context | 是 |
| F06-retry-five | contradicts | contradicts | contradicts | contradicts | 是 |
| F07-comment-only | context | context | - | context | 否 |
| F08-other-module-uncovered | context | - | context | context | 否 |

> 这是真实模型调用；模拟 JSON 测试不进入本报告。
