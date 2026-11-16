# Debate V4.1 P0 基线冻结报告

- 冻结标签：`debate-v4.1-p0-baseline-20261116`（tag 指向本报告提交）
- 运行时提交：`370bb0457e340da931fd175ee4ad3d8357772e97`（runner + 重试 + 采样框架）
- 分支 / 工作树：`0.2.9` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.9`
- 运行日期：2026-11-16 05:43–06:52 UTC
- 样本：**3 次完整 24 题**（`sampleCount=3`，未提前停止）
- 结论：**基线已冻结，但 24 题通过数在 15–21 之间波动；单次结果不能作为回归门槛。**

---

## 1. 固定运行口径

| 项 | 值 |
| --- | --- |
| Runner | `2.2.0` |
| Prompt | `1.1.0` |
| Backend / Provider | `opencode-go` / `opencode-go` |
| 模型 | `deepseek-v4.1-flash`、`gpt-6-luna`、`claude-haiku-5-5` |
| 数据集 | `1.0.0` · `ebd15b7e5ec7…` |
| 标准答案 | `49692cb651e4…`（sha256 侧车按文件字节） |
| 并发 | `workers=3` · `providerConcurrency=6` |
| 超时 | stage 180s · total 300s · wait 380s · judge 240s |
| 完整性 | `--completeness` 开启 |
| 增量 | 未使用（`--runs=3` 禁止 `--incremental`） |
| 采样 | `temperature=0`（accepted）· `seed=42`（accepted，enforcement 未验证） |
| 重试策略 | `1.0.0` |

采样探测结果：

```json
{"temperature":{"value":0,"support":"accepted","enforcement":"unverified"},
 "seed":{"value":42,"support":"accepted","enforcement":"unverified"},
 "evidence":["temperature+seed accepted in one probe"],"requests":1}
```

**seed 只证明网关接受字段，不能证明它决定了输出。** 3 次运行的分差（16/15/21）说明随机性仍在，报告不能写成“已可复现”。

---

## 2. 重试策略执行情况

策略 `1.0.0`：

| 错误 | 处理 |
| --- | --- |
| 403 Endpoint is unavailable | 不重试，标 unavailable / PARTIAL |
| 429 | 按 Retry-After 或退避，最多额外 3 次 |
| 5xx | 最多额外 2 次 |
| 网络中断 / 超时 | 最多额外 2 次 |
| 400 / 模型不存在 / 取消 | 不重试 |
| 任何情况 | 不更换模型 |

本次 3 轮共 **72 次题目执行、0 次重试**：

- 没有出现 429/5xx/超时；
- 唯一一次 403 是 `run-2` 的 `schema-migration`，`claude-haiku-5-5` 返回
  `Upstream request failed: Endpoint is unavailable.`；
- 该题按策略**不重试**，记为 `PARTIAL`，失败原因带
  `[retry:endpoint-unavailable]`，没有被伪装成 COMPLETED。

---

## 3. 总体结果

| 运行 | COMPLETED | PARTIAL | V1 通过 | 平均分 |
| --- | ---: | ---: | ---: | ---: |
| `run-1` | 24 | 0 | 16/24 | 90 |
| `run-2` | 23 | 1 | 15/24 | 88 |
| `run-3` | 24 | 0 | 21/24 | 96 |
| **合计 / 均值** | **71/72（98.6%）** | **1** | **52/72（72.2%）** | — |

其他：

- Judge 模型：72/72；
- 独立裁判：72/72；
- 质量报告：72/72 passed；
- 事实维度：72/72 `model-assessed`（没有任何 `fact-verified`）；
- Provider 不可用：1 次（403）。

**不能把 21/24 写成“当前能力”，也不能把 15/24 写成“回归”。** 这三次是同一份代码、同一配置下的三个样本。

---

## 4. 逐题统计

| 题目 | 完整运行 | V1 通过 | 通过率 | PARTIAL | Provider 不可用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| float-equality | 3/3 | 1/3 | 33.3% | 0 | 0 |
| array-map | 3/3 | 1/3 | 33.3% | 0 | 0 |
| http-methods | 3/3 | 1/3 | 33.3% | 0 | 0 |
| tcp-udp | 3/3 | 3/3 | 100% | 0 | 0 |
| btree-index | 3/3 | 3/3 | 100% | 0 | 0 |
| acid | 3/3 | 2/3 | 66.7% | 0 | 0 |
| jwt-revoke | 3/3 | 1/3 | 33.3% | 0 | 0 |
| csrf-xss | 3/3 | 3/3 | 100% | 0 | 0 |
| cache-invalidation | 3/3 | 3/3 | 100% | 0 | 0 |
| index-generation | 3/3 | 1/3 | 33.3% | 0 | 0 |
| mq-delivery | 3/3 | 2/3 | 66.7% | 0 | 0 |
| distributed-lock | 3/3 | 3/3 | 100% | 0 | 0 |
| schema-migration | 2/3 | 2/3 | 66.7% | 1 | 1 |
| feature-flag | 3/3 | 3/3 | 100% | 0 | 0 |
| rate-limit | 3/3 | 3/3 | 100% | 0 | 0 |
| observability | 3/3 | 3/3 | 100% | 0 | 0 |
| testing-pyramid | 3/3 | 2/3 | 66.7% | 0 | 0 |
| unicode-utf8 | 3/3 | 0/3 | 0% | 0 | 0 |
| timezone | 3/3 | 3/3 | 100% | 0 | 0 |
| compression | 3/3 | 3/3 | 100% | 0 | 0 |
| git-rebase | 3/3 | 3/3 | 100% | 0 | 0 |
| process-thread | 3/3 | 1/3 | 33.3% | 0 | 0 |
| memory-leak | 3/3 | 3/3 | 100% | 0 | 0 |
| monolith-microservices | 3/3 | 2/3 | 66.7% | 0 | 0 |

汇总：

- 稳定通过（3/3）：**12 题**；
- 波动（1/3 或 2/3）：**11 题**；
- 稳定未通过（0/3）：**1 题**（`unicode-utf8`）。

波动题清单：

```text
float-equality 1/3 · array-map 1/3 · http-methods 1/3 · acid 2/3
jwt-revoke 1/3 · index-generation 1/3 · mq-delivery 2/3
schema-migration 2/3 · testing-pyramid 2/3 · process-thread 1/3
monolith-microservices 2/3
```

---

## 5. 已知失败项复核

### 5.1 两道历史 PARTIAL

| 题 | 本次结果 | 说明 |
| --- | --- | --- |
| `mq-delivery` | 3/3 COMPLETED | 历史 PARTIAL 未复现 |
| `schema-migration` | 2/3 COMPLETED + 1 PARTIAL | run-2 的 `claude-haiku-5-5` 403 Endpoint unavailable；按策略不重试，记 PARTIAL |

结论：403 是 Provider 端点不可用，不是模型推理失败；本次 72 次里出现 1 次。是否增加备用端点/模型是独立策略，本次未启用，避免把备用模型结果混进原模型基线。

### 5.2 五道历史 V1 未通过

| 题 | 本次通过 | 未通过时的实际原因（rubric 原文摘要） |
| --- | ---: | --- |
| `acid` | 2/3 | run-1 缺 c3：未说明数据库默认隔离级别不一定是可串行化 |
| `jwt-revoke` | 1/3 | run-1/2 缺 c3：未说明密钥轮换只能使一批令牌失效，不能单独撤销某个令牌 |
| `schema-migration` | 2/3 | run-2 缺 c2/c3：未提在线 DDL 的短元数据锁；未处理旧实例只写旧结构导致的新旧数据不一致 |
| `process-thread` | 1/3 | run-1/2 缺 c3：未提 Linux `task_struct`；未限定 GIL 结论只适用于默认 CPython |
| `memory-leak` | 3/3 | 历史失败未复现 |
| `unicode-utf8` | **0/3** | 三次分别缺 c3 的不同覆盖点：重复编码、字节截断、有损替换/U+FFFD 与诊断需原始字节 |

两个必须说清的事实：

1. **历史“五道失败”不是稳定失败**：其中 4 道在本次 3 次里至少过 1 次，`memory-leak` 3/3 全过。
2. **本次唯一的稳定失败是 `unicode-utf8`**，而它在历史基线里是通过的。

因此，“修完五道失败就能提高基线”这个判断不成立；真正需要先处理的是波动来源和 `unicode-utf8` 的 c3 覆盖。

标准答案与数据集没有改动（`git diff` 为空，sha256 未变）。

---

## 6. 产物与校验

报告：

- `docs/implementation/regression/debate-regression-p0-baseline-p0-baseline-2026-11-16T05-43-35-354Z.json`
- `…-p0-baseline-latest.json` / `.md`
- 逐轮：`…-p0-run1-2026-11-16T05-43-35-354Z.json`（run2、run3 同）
- sha256 侧车：`…-p0-baseline-2026-11-16T05-43-35-354Z.sha256`

侧车内容（摘要）：

```text
79797aff…  baseline.json
63d5dbdc…  debate-dataset.json
49692cb6…  debate-standard-answers-v1.json
7b31bad5…  run1.json
4f5ac5a9…  run2.json
16b7d08c…  run3.json
```

报告里的 `config.runner.commit` 是运行时提交 `370bb04`；tag 指向包含本报告与产物的提交。两者不是同一个哈希，因为报告只能在运行结束后提交；tag 的说明里会同时写出运行时提交。

---

## 7. P0 出口条件

| 条件 | 状态 | 依据 |
| --- | --- | --- |
| 基线代码已打 tag，报告引用 tag | 满足（tag 见文首） | annotated tag |
| 403/429/5xx 重试策略确定，runner 已升级 | 满足 | 策略 `1.0.0`，runner `2.2.0` |
| N 次 24 题、逐题通过次数与波动完整 | 满足 | 3 次，见 §3/§4 |
| 两道 PARTIAL 原因与策略确定 | 满足 | §5.1；403 不重试 |
| 五道 V1 未通过逐条有原因、门槛未降 | 满足 | §5.2；标准答案 diff 为空 |
| 不混旧 commit / 不同 runner / 单题重跑 | 满足 | 同 commit、同配置、无增量、无单题重跑 |

**P0 完成。** 但这不等于“24 题质量稳定”：3 次分数相差 6 分（15–21），稳定通过只有 12/24。

---

## 8. 对 P1 的直接影响

1. **回归门槛改成逐题稳定性**：后续对比看“稳定通过题是否下降”和“波动题是否恶化”，不看单次 24 题总数。
2. **`unicode-utf8` 是唯一稳定失败**，应先查它的 c3 是否把多个必答点压在同一个 claim 上；先确认评分粒度，不允许直接降低门槛。
3. **`jwt-revoke`、`process-thread`、`index-generation`、`http-methods`、`float-equality`、`array-map` 都是 1/3**，属于高波动内容；不要用单次通过/失败判断修复是否有效。
4. **seed 未证明生效**：如果后续需要可复现，必须在 Provider 侧确认 seed 语义，或接受分布基线。
5. **报告没有保存完整模型原文**：目前只能看到 rubric 原因和裁决摘要；需要逐字复盘时得重跑。P6/P7 应补 answer excerpt，不能再假设历史报告能还原原文。
