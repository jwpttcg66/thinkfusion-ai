# Debate V3 24 题自动回归结果

- 日期：2026-11-14
- 数据集：`desktop-agent-macos/scripts/regression/debate-dataset.json`
- 数据集版本：`1.0.0`
- SHA-256：`ebd15b7e5ec73965e820e2ae1a5ef5b3d874e90ee74f9fa60e967f64eab6ba3f`
- 最终明细：`docs/implementation/regression/debate-regression-latest.json`
- 自动生成表：`docs/implementation/regression/debate-regression-latest.md`
- 初始完整运行：`docs/implementation/regression/debate-regression-2026-11-14T04-32-50-472Z.json`
  （保留 `cache-invalidation` 回退规则版的原始记录，便于对照修复前后）

## 1. 运行条件

- Provider：`opencode-go`
- 模型：用户配置的
  - `deepseek-v4.1-flash`
  - `gpt-6-luna`
  - `kimi-k2.7-code`
- 每题只有两位模型辩论，第三位当裁判；
- 裁判按题在数据集里的固定位置轮换，每位模型各判 8 题；
- 每题 2 轮；
- 单次调用 180 秒，整场 300 秒；
- 没有人工改答案，没有模型生成的参考标准。

## 2. 总体结果

| 项 | 结果 |
| --- | --- |
| 题目数 | 24 |
| 执行结果 | `COMPLETED` 24/24 |
| 裁判后端 | `model` 24/24 |
| 独立裁判 | 24/24（`sharedWith = 0`） |
| 质量状态 | `passed` 16，`inconclusive` 8 |
| 事实维度 | `model-assessed` 24（没有一条标成 `supported`） |
| anchor 烟测 | 8/8 命中（不是事实准确率） |
| 超时 / 失败 | 0 |

`quality = inconclusive` 的原因是裁判标了 `undetermined`，不是执行失败。
这符合“证据不足时保留不确定”的规则。

## 3. 六种策略

| 策略 | 题数 | 完成 | 模型裁判 | 独立 | 平均用时 |
| --- | --- | --- | --- | --- | --- |
| truth | 4 | 4 | 4 | 4 | 137 秒 |
| adversarial | 4 | 4 | 4 | 4 | 132 秒 |
| expert | 4 | 4 | 4 | 4 | 130 秒 |
| assumption | 4 | 4 | 4 | 4 | 171 秒 |
| solution | 4 | 4 | 4 | 4 | 183 秒 |
| discovery | 4 | 4 | 4 | 4 | 141 秒 |

`assumption` 和 `solution` 仍然是最慢的两组，但这次没有超时或 PARTIAL。

## 4. 回归中发现的问题

### 4.1 裁判模型偶尔不输出 JSON

第一次跑到 `cache-invalidation` 时，`kimi-k2.7-code` 作为裁判返回了分析文本，
没有可解析的 JSON，`JudgeEngine` 按原设计退回了规则版。

修复：

- 只对“解析失败”重试一次；
- 第二次要求“不要 Markdown、不要解释、只输出 JSON”；
- `judgeAttempts` 记录实际问了 1 次还是 2 次；
- 两次都失败才退回规则版，不把 prose 硬解析成裁决。

修复后用原来的裁判模型单独重跑了这道题：这次第一次就返回了合法 JSON
（`judgeAttempts = 1`），`backend = model`。重试分支本身由
`npm run test:judge` 的单测覆盖，不依赖这次网络运气。

### 4.2 规则版回退被误标成模型评估

退回规则版时，`argumentQuality` 是规则算的文本线索，但质量报告曾经写成
“模型裁判论证质量均值”。这会让读者以为发生过模型评审。

修复：

- 退回规则版时 `logicalValidity = unknown`；
- `criticalIssues` 明确写“裁判退回规则版”；
- `factualAccuracy` 仍然只能是 `unknown` / `insufficient`。

### 4.3 协作组织方式落盘

`LeadPlan` 增加 `collaboration`：

- 单模型 / 双模型 / 专家角色 / 多模型；
- 轮内并行、轮间递进；
- 是否允许交叉质疑；
- 裁判是否要求独立。

老记录没有这个字段，读回时按 `undefined` 处理。

### 4.4 只重跑一题时裁判会变

最初 `--only` 按“本次第几个”轮换裁判，重跑 `cache-invalidation` 时裁判
从 `kimi` 变成了 `deepseek`，结果不可比。

修复：裁判按题在完整数据集里的固定位置轮换，只重跑一题也还是原来那位裁判。

## 5. 这些结果能说明什么

能说明：

- 24 道题都能真实进入辩论编排器；
- 六种策略各 4 题都能完成两轮；
- 三位模型轮换裁判时，裁判都没有参加该场辩论；
- 质量报告和 Final Judge 都能生成；
- 没有一条把模型评审写成事实准确率；
- 规则质量门槛全部通过；
- anchor 烟测全部命中。

不能说明：

- 回答符合世界事实；
- 模型真正理解了每一道题；
- anchor 命中等于正确；
- 单一 Provider 下模型多样性等于故障域独立；
- 自动质量通过等于 `PRODUCTION_READY`。

## 6. 复现

```bash
cd desktop-agent-macos
npm run build:test
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox
```

只重跑一题并合并：

```bash
./node_modules/.bin/electron scripts/regression/run-debate-regression.cjs --no-sandbox \
  --only=cache-invalidation --suffix=rerun \
  --merge-into=../docs/implementation/regression/debate-regression-latest.json
```
