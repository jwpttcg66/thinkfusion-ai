# Pack Judge 回归对比

- 基线：`../docs/implementation/regression/pack-judge-regression-p3f1-2026-11-17T07-42-15-864Z.json`
- 本次：`../docs/implementation/regression/pack-judge-regression-p3f1-2026-11-17T08-03-49-580Z.json`

## 指标

| 指标 | 基线 | 本次 |
| --- | ---: | ---: |
| modelSuccessRate | 100 | 100 |
| jsonFirstAttempt | 100 | 100 |
| fallbackRate | 0 | 0 |
| invalidIdAccepted | 0 | 0 |
| forbiddenAccepted | 0 | 1 |
| sourceMismatch | 0 | 0 |
| consistencyRate | 66.7 | 85.7 |

## 逐题方向

| 题 | 期望 | 基线 | 本次 | 变化 |
| --- | --- | --- | --- | --- |
| A1-code-exists-not-called | context | context / context / context | context / context / context | 否 |
| A2-cache-write-not-hit | context | context / context / context | context / context / context | 否 |
| A3-catch-not-all-errors | context | context / context / context | context / context / context | 否 |
| B4-condition-branch | supports | supports / supports / supports | supports / supports / supports | 否 |
| B5-param-validation | supports | supports / supports / supports | supports / supports / supports | 否 |
| C6-else-branch-contradicts | contradicts | none / contradicts / contradicts | contradicts / contradicts / contradicts | 是 |
| C7-limit-has-cap | contradicts | contradicts / contradicts / contradicts | contradicts / contradicts / contradicts | 否 |
| D8-call-without-implementation | context | context / context / context | context / context / context | 否 |
| D9-static-code-runtime-claim | context | context / context / context | context / context / context | 否 |
| E10-CODE | supports | supports / supports / supports | supports / supports / supports | 否 |
| E10-RUNTIME | context | context / none / context | context / context / context | 是 |
| E11-illegal-relation | context | context / none / context | context / supports / context | 是 |
| E12-valid-id-irrelevant | context | context / context / context | context / context / context | 否 |
| F01-no-retry-code | context | context / none / context | context / context / context | 是 |
| F02-todo-retry | context | context / context / none | context / context / context | 是 |
| F03-complete-three-retries | supports | context / supports / supports | context / supports / context | 是 |
| F04-complete-single-attempt | contradicts | contradicts / contradicts / contradicts | contradicts / context / contradicts | 是 |
| F05-caller-only | context | context / context / none | context / context / context | 是 |
| F06-retry-five | contradicts | contradicts / contradicts / contradicts | contradicts / contradicts / contradicts | 否 |
| F07-comment-only | context | context / context / context | context / context / context | 否 |
| F08-other-module-uncovered | context | context / context / context | context / context / context | 否 |

> 方向取自每次运行的第一个 accepted Pack 判断；`none` 表示模型没有给出可接受判断。
