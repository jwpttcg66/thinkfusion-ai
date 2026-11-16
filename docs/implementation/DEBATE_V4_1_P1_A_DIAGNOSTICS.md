# V4.1 P1-A：回归诊断能力补强

- 分支 / 工作树：`0.2.9` / `/Users/yalla/data/localLab/thinkfusion-ai-0.2.9`
- 依据：P0 审计中「单次总分不可当门槛」与 `unicode-utf8` 复合评分项问题
- 原则：**不重跑 P0，不修改已冻结的基线产物；修正统计口径与评分粒度，保留原始运行数据**

---

## 1. 统计口径修正

原 `stableFail` 只判断 `v1Pass === 0`，没有区分「三次都完整执行且 V1 失败」和「其中一次 Provider 不可用」。现在分成五类：

| 分类 | 判据 |
| --- | --- |
| `stable-pass` | 全部样本 COMPLETED，且 V1 全部通过 |
| `stable-fail` | 全部样本 COMPLETED，且 V1 全部失败 |
| `fluctuating` | 全部样本 COMPLETED，V1 有通过有失败 |
| `incomplete` | 存在 PARTIAL / FAILED / V1 UNAVAILABLE / 缺失结果 |
| `stablePass`（评分） | V1 全部通过（不要求每次 COMPLETED） |

`stablePass` 与 `stableCompletePass` 分开：

- `stablePass`：评分稳定通过；
- `stableCompletePass`：端到端完整且评分稳定通过。

用 P0 已冻结的三轮原始 `runs` 重算，**不重跑模型**：

| 指标 | 修正前 | 修正后 |
| --- | ---: | ---: |
| 稳定通过（评分） | 12 | 12 |
| 稳定通过（完整执行） | 未区分 | 12 |
| 稳定未通过（完整执行） | 1 | 1 |
| 波动（完整执行） | 11 | **10** |
| 不完整 | 未区分 | **1** |

唯一从「波动」移到「不完整」的是 `schema-migration`：run-2 是 403 PARTIAL，其余两次通过。它不属于「完整执行里的波动」。

修正产物（原始冻结文件不改写）：

- `docs/implementation/regression/debate-regression-p0-baseline-p0-baseline-2026-11-16T05-43-35-354Z-stats-corrected.json`
- 同名 `.md`
- `…-p0-baseline-stats-corrected.json` / `.md`

重算入口：

```bash
cd desktop-agent-macos
node scripts/regression/recompute-baseline-stats.cjs \
  ../docs/implementation/regression/debate-regression-p0-baseline-p0-baseline-2026-11-16T05-43-35-354Z.json
```

---

## 2. 逐题诊断粒度

### 2.1 `unicode-utf8` 的复合项拆分

标准答案版本升到 **`1.1.0`**，哈希从 `27a08d1f…` 变为 `2ee2a949…`。

`requiredClaims` 变化：

| 新 id | 严重级 | 覆盖点 |
| --- | --- | --- |
| `c3a` | must | 错误解码 |
| `c3b` | must | 重复编码 / 重复转码 |
| `c3c` | must | 字节截断 |
| `c3d` | must | 编码声明错误 |
| `c3e` | must | 有损替换（U+FFFD） |
| `c4a` | should | 诊断需要原始字节 |
| `c4b` | should | 诊断需要确认编码声明 |
| `c4c` | should | 乱码不一定可逆 |

没有降低门槛：`c3` 原来的五个必答点全部保留为独立 `must`，只有覆盖点拆开；`c4` 原本是 `should`，拆分后仍是 `should`。

### 2.2 报告保留可追溯摘录

后续运行（runner `2.2.0` 起）的每题结果新增：

- `debate.messageExcerpts`：每条发言的 `agentId / modelId / roundIndex / chars / excerpt(800 字)`；
- `answerExcerpt`：实际送去 rubric 的答案前 4000 字；`answerChars` 记录全文长度；
- `standard.claimResults`：逐条必答项的 `matched / missing / unassessed`，失败原因仍由 `standard.reason` 给出。

限制：P0 已冻结的三轮报告没有这些字段，不能事后补造；需要逐字复盘时只能重跑。

---

## 3. 测试

新增 / 修改：

| 文件 | 覆盖 |
| --- | --- |
| `scripts/check-regression-baseline.mjs` | 五类统计、PARTIAL 不混进波动、评分稳定与端到端稳定分开 |
| `scripts/check-debate-standard-answers.mjs` | c3a–c3e 全是 must、c4a–c4c 保持 should、拆项后关键词仍覆盖 |
| `scripts/check-debate-standard-rubric.mjs` | 缺 `c3e` 能单独定位；全部覆盖仍通过 |

命令与结果：

```bash
npm run test:regression-baseline      # 10/10
npm run test:debate-standard-answers  # 8/8
npm run test:debate-rubric            # 12/12
```

---

## 4. 对 P1-B 的交接

- 回归门槛改用 `stableCompletePass / stableFail / fluctuating / incomplete`，不再比较单次 24 题总数；
- 后续引用 P0 基线时，统计口径以 `stats-corrected` 为准，原始冻结文件只作为原始数据；
- 标准答案版本从 `1.0.0` 变为 `1.1.0`，新旧跑分不能直接逐题比较；下一次基线必须记录 `standard.version`。
