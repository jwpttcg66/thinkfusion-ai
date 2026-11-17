# P3-F 结果：语义规则已固化，真实回归仍未通过

- 分支 / 工作树：`p3f-semantics` / `/Users/yalla/data/localLab/thinkfusion-ai-p3f`
- 数据集：`pack-judge-regression-v1.1.json`（原 12 题 + F01–F08）
- 模型：`deepseek-v4.1-flash`（当前唯一配置）
- 结论：**P3-F 未通过；不改数据集答案。**

---

## 1. 实际执行的两轮

| 指标 | P3-F 第一轮 | P3-F 第二轮（代码级 Claim 规则） |
| --- | ---: | ---: |
| 真实调用 | 61（一次 JSON 重试） | 60 |
| 模型成功 | 100% | 100% |
| 非法 ID 接受 | 0 | 0 |
| 禁止方向接受 | 0 | **1** |
| 来源错配 | 0 | 0 |
| context 准确率 | 92.3% | 84.6% |
| supports 准确率 | 66.7% | 88.9% |
| contradicts 准确率 | 83.3% | 91.7% |
| 一致率 | 80% | 65% |
| 无判断 | 2 | 5 |
| rejected | 2 | 4 |

分组（第二轮）：

| 组 | context | supports | contradicts | 无判断 | 一致率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原 12 题 | 83.3% | 100% | 100% | 3 | 75% |
| F01–F08 | 86.7% | 66.7% | 83.3% | 2 | 50% |

报告：

- `pack-judge-regression-p3f-2026-11-17T06-30-53-799Z.*`
- `pack-judge-regression-p3f-2026-11-17T06-53-50-607Z.*`
- 两份 `*-summary.md`

---

## 2. 为什么仍未通过

### 2.1 `E10-distractor-evidence` 数据集本身有冲突

原 P3-E 的 E10：

- Claim：这段代码会把任务重试三次；
- 允许关联的主证据：`for (let i = 0; i < 3; i += 1) attempt();`
- 数据集预期：`context`。

第二轮模型判 `supports`。这是**数据集预期与证据内容冲突**，不是模型单独犯错：
主证据确实直接展示三次循环。把“干扰证据”设计成“主证据也支持”是数据集构造问题。

按约定没有修改原数据集答案；P3-F 需要先裁决 E10 的预期或 fixture。

### 2.2 `F03/F04` 的 Claim 层级仍有歧义

- F03 Claim：`方法 run 会重试三次`
- F04 Claim：`方法 run 会重试三次`（完整方法只调用一次）

模型两轮都倾向 `context`，理由是“没有运行时执行结果”。第一轮 supports 0%，第二轮 88.9%，仍不稳定。
根因是自然语言没有明确“代码级 Claim”还是“运行级 Claim”。只靠 Prompt 规则不足以稳定区分。

### 2.3 evidenceId 格式错误导致合法证据被拒

第二轮有 4 次 rejected：

```text
未提供的 claim/evidence 组合：c1 / pack_...:item_...
未提供的 claim/evidence 组合：c1 / item_...
```

模型省略了 `pack:` 前缀。校验器按约定拒绝，不自动补全；但这会造成“无判断”，不能算正确。
Prompt 需要更强要求逐字复制 evidenceId，或后续决定是否允许规范化（当前不允许）。

### 2.4 无判断不伪装成正确

两轮分别有 2/5 次没有 accepted 判断。报告中单独计数，没有计为正确。

---

## 3. 语义规则状态

已固化：

- absence of evidence ≠ evidence of absence；
- TODO/纯注释只能是 context；
- contradicts 必须展示直接反向实现与覆盖范围；
- 运行级 Claim 只有静态片段时只能是 context；
- 代码级 Claim 可由完整方法/分支结构判断（但真实模型仍不稳定）。

规则文档：`DEBATE_V4_1_P3_F_SEMANTICS.md`。

---

## 4. 结论与下一步

P3-F 不能标记完成。需要先做三个裁决，而不是继续跑模型：

1. **E10**：原数据集预期 `context` 与主证据内容冲突，是否修订 fixture/预期？（不能由模型结果反推）
2. **Claim scope**：给数据集/产品增加显式 `claimScope: 'code' | 'runtime'`，而不是靠 Prompt 猜自然语言；
3. **evidenceId 格式**：坚持逐字匹配，还是在关联层做安全规范化并记录？

在这三个裁决之前，继续调 Prompt 只会在不同题之间来回摆动：第一轮 F 组 supports 0%，第二轮 88.9%，但原 12 题 hard gate 又从 0 变成 1。

P3-G（UI）不应开始；UI 只会把不稳定的判断展示得更漂亮。
