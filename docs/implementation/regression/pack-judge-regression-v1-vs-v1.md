# Pack Judge 回归对比

- 基线：`../docs/implementation/regression/pack-judge-regression-2026-11-17T05-41-56-377Z.json`
- 本次：`../docs/implementation/regression/pack-judge-regression-2026-11-17T05-51-58-729Z.json`

## 指标

| 指标 | 基线 | 本次 |
| --- | ---: | ---: |
| modelSuccessRate | 100 | 100 |
| jsonFirstAttempt | 100 | 97.2 |
| fallbackRate | 0 | 0 |
| invalidIdAccepted | 0 | 0 |
| forbiddenAccepted | 2 | 0 |
| sourceMismatch | 0 | 0 |
| consistencyRate | 75 | 75 |

## 逐题方向

| 题 | 期望 | 基线 | 本次 | 变化 |
| --- | --- | --- | --- | --- |
| A1-code-exists-not-called | context | context / context / context | context / context / context | 否 |
| A2-cache-write-not-hit | context | context / context / context | context / context / context | 否 |
| A3-catch-not-all-errors | context | context / context / context | contradicts / context / context | 是 |
| B4-condition-branch | supports | supports / supports / supports | supports / supports / supports | 否 |
| B5-param-validation | supports | supports / supports / supports | supports / supports / supports | 否 |
| C6-else-branch-contradicts | contradicts | contradicts / supports / contradicts | contradicts / contradicts / contradicts | 是 |
| C7-limit-has-cap | contradicts | contradicts / contradicts / contradicts | contradicts / contradicts / contradicts | 否 |
| D8-call-without-implementation | context | context / context / context | context / context / context | 否 |
| D9-static-code-runtime-claim | context | context / context / context | context / context / context | 否 |
| E10-distractor-evidence | context | none / context / none | context / context / none | 是 |
| E11-illegal-relation | context | context / context / supports | context / context / context | 是 |
| E12-valid-id-irrelevant | context | contradicts / contradicts / contradicts | context / contradicts / contradicts | 是 |

> 方向取自每次运行的第一个 accepted Pack 判断；`none` 表示模型没有给出可接受判断。
