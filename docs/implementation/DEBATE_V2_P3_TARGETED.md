# Debate V2.0 P3：6 道失败题 + 3 道 PARTIAL 定向回归

- 分支：`0.2.5`
- 日期：2026-11-15
- 代码：P0（单模型角色/Judge 独立性/降级）+ P1（多模型 Judge 选择）之后
- 基线：`60ada0e` 的 18/24 不变
- 本结果**不合并**进 18/24 全量，保持原口径

## 1. 范围

9 题：

- 6 道 V1 失败：acid、jwt-revoke、mq-delivery、schema-migration、unicode-utf8、memory-leak
- 3 道 PARTIAL：float-equality、array-map、http-methods

运行：

```bash
electron scripts/regression/run-debate-regression.cjs --no-sandbox \
  --workers=3 --completeness \
  --only=acid,jwt-revoke,mq-delivery,schema-migration,unicode-utf8,memory-leak,float-equality,array-map,http-methods \
  --suffix=p3-targeted
```

## 2. 结果

| 项 | 结果 |
| --- | --- |
| 题目数 | 9 |
| 执行 | COMPLETED 6 / FAILED 3 |
| 主裁判 | model 9 / rules 0 |
| 独立裁判 | 9 / 9 |
| 质量 | passed 6 / needs_revision 3 |
| V1 | passed 6 / failed 3 |
| 平均分 | 90 |
| 分类匹配 | 9 / 9 |

3 道 FAILED 都是连接失败（float-equality、array-map、http-methods），不是内容结论。

## 3. 6 道原失败题

| 题目 | 本次执行 | 本次 V1 | 说明 |
| --- | --- | --- | --- |
| `acid` | COMPLETED | FAIL | 仍缺 c3 |
| `jwt-revoke` | COMPLETED | FAIL | 仍缺 c3 |
| `mq-delivery` | COMPLETED | PASS | 修复 |
| `schema-migration` | COMPLETED | PASS | 修复 |
| `unicode-utf8` | COMPLETED | PASS | 修复 |
| `memory-leak` | COMPLETED | PASS | 修复 |

所以 6 道内容失败中，4 道通过，2 道仍失败。

## 4. 3 道 PARTIAL

| 题目 | 本次执行 | 本次 V1 |
| --- | --- | --- |
| `float-equality` | FAILED（连接） | PASS |
| `array-map` | FAILED（连接） | PASS |
| `http-methods` | FAILED（连接） | FAIL |

这些仍属于连接稳定性问题，不能合并进 18/24 主结果。

## 5. 3 道连接失败的单题重跑

对 `float-equality`、`array-map`、`http-methods` 用 `--workers=1 --completeness` 单独重跑：

| 题目 | 重跑执行 | 重跑 V1 |
| --- | --- | --- |
| `float-equality` | COMPLETED | PASS |
| `array-map` | PARTIAL | PASS |
| `http-methods` | COMPLETED | PASS |

3/3 V1 通过；`array-map` 仍是 PARTIAL（连接问题）。

这次重跑同样**没有合并**进 18/24 主结果，也没有合并进 targeted 主结果。

## 6. 结论

- P0/P1 改动后，定向回归没有出现内容大回退；
- mq-delivery、schema-migration、unicode-utf8、memory-leak 已通过；
- acid、jwt-revoke 仍是内容缺口；
- 3 道 PARTIAL 仍是连接问题；单独重跑后 3/3 V1 通过，但未合并；
- 本轮没有降低 must，没有修改 18/24 历史结果。
