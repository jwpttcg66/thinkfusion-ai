# 辩论系统 V3.0（取消人工评审）计划审核

- 审核对象：`/Users/yalla/Downloads/制定辩论主题方案 (12)-20261114-0959-2.md`
- 当前代码：`8f8fb13`（`main`）
- 审核日期：2026-11-14
- 上一轮：`DEBATE_P0_PLAN_REVIEW.md`

---

## 1. 结论

**方向可以继续，但不能把“取消人工评审”理解成“事实正确性已经自动验证”。**

建议：

- **P0-00 至 P0-04：有条件批准**；
- **P1/P2：暂缓编码**，先补自动评估的有效性边界、独立 Judge 隔离和消息元数据；
- **P3～P5：后置**；
- 自动评估可以替代人工做**结构、一致性、回归**，不能替代外部事实验证。

一句话：**模型可以自治评估，但不能自证事实。**

---

## 2. 这份计划的正确之处

- 保留六种策略、执行模式、协作组织方式三个维度；
- 不新建 Debate Runtime，复用 DebateOrchestrator / DebateStore / Judge；
- 区分辩论执行成功和质量通过；
- 不把模型一致当事实正确；
- 不把模型自评 `passed` 当 `PRODUCTION_READY`；
- 自动测试集明确说“不代表客观真理”；
- 记录 provider/model/token/latency 的目标正确；
- Web 后置，不阻塞远端模型辩论。

这些原则与当前代码方向一致。

---

## 3. 当前代码与计划的差距

| 计划要求 | 当前代码 | 状态 |
| --- | --- | --- |
| 六种策略真实存在 | `strategies.ts` 六个 profile | 已有 |
| 多轮、收敛、提前停止 | `maxRounds` / `convergenceStop` / `earlyStopOnStall` | 已有 |
| 三模型真实调用 | 已跑 truth 三模型，glm 第二轮超时 | 部分 |
| 六种策略双模型 | 4/6 完整，adversarial/solution 各一条超时 | 部分 |
| DebateMessage 记录 provider/model/usage | 未落盘 | 缺失 |
| 全局 PARTIAL/FAILED/CANCELLED | 只有 round.failures；state 仍 completed | 缺失 |
| 协作组织方式 | `DebateConfig` 只有 strategy，没有 collaboration planner | 缺失 |
| 独立 Judge | 现有 JudgeEngine 在无独立模型时会复用参与者 | 需隔离 |
| 自动质量评估 | 现有 `quality.ts` 只做规则门槛 | 起步 |
| 自动测试集 | 没有固定自动集 | 未完成 |

---

## 4. P0 需要先修的 5 件事

### P0-1：取消人工评审后，必须重定义“事实准确性”

计划把 `factualAccuracy` 放进自动质量维度，但模型 Judge 只能判断：

- 主张是否有引用；
- 引用是否被当前证据支持；
- 是否存在明显矛盾；
- 是否有未解决的反例。

它不能独立证明“事实正确”。如果没有外部可验证来源，自动 Judge 的 `factualAccuracy` 只能叫：

```text
model-assessed factual consistency
```

不能叫事实准确率，也不能用它宣布 `PRODUCTION_READY`。

**建议**：

- 自动质量报告分三栏：
  - `rule-confirmed`：规则/源码/测试直接确认；
  - `model-assessed`：模型评审；
  - `unknown`：没有依据。
- `factualAccuracy` 只能基于 `rule-confirmed` 或可点击来源；
- 没有来源时只能 `insufficient_evidence`。

### P0-2：Independent Judge 必须真正独立

当前 `JudgeEngine` 的选人逻辑：

- 优先找未参与辩论的本地/云端成员；
- 找不到时复用参与者，并在 `sharedWith` 里标明。

计划要求 Judge “不参与前面的辩论”。如果模型池只有 2–3 个模型，且全部参与辩论，就会没有独立 Judge。

**建议**：

- P1 前先增加一个**未参与辩论的 Judge 模型**，或者明确 `sharedWith` 并降低结论可信等级；
- Cross-Model Reviewer 不能与主 Judge 是同一个模型；
- 同 Provider 不同模型可以复用，但必须记录 Provider/Model，不能声称“独立故障域”。

### P0-3：消息级元数据必须先落盘

计划要求：

- providerId
- modelId
- requestId
- inputTokens/outputTokens
- latencyMs
- retryCount
- outcome
- failureReason

当前 `DebateMessage` 没有这些字段，`SubAgentAnswer.usage` 在 orchestrator 里没有保存。

**建议**：

- 先扩 `DebateMessage`（全部可选，兼容旧记录）；
- `DebateState` 增加聚合 usage/terminationReason；
- `DebateStore` 旧文件读回不迁移；
- 没有 Token 记 `null`，不记 0。

### P0-4：全局状态需要区分 PARTIAL / FAILED

当前：

- 单模型超时 → `round.failures`；
- 整场 `status` 仍然是 `completed`。

计划要求区分 COMPLETED/PARTIAL/FAILED/CANCELLED。

**建议**：

- 增加 `DebateOutcome`：
  - 全轮完成且无失败 → COMPLETED；
  - 有成员失败但仍有双方有效发言 → PARTIAL；
  - 无有效辩论/无结论 → FAILED；
  - 用户停止 → CANCELLED。
- `partial` 不能显示成“正常完成”。

### P0-5：协作组织方式还没有数据结构

计划列了：

- 单模型分析；
- 双模型交锋；
- 三模型协作；
- 多模型并行；
- 多轮递进；
- 专家角色评审；
- 独立裁判；
- 交叉复核。

当前 `DebateConfig` 只有 `strategy`、`participants`、`leadMode`，没有 `collaboration` 字段或 planner。

**建议**：

- 先定义 `DebateCollaborationPlan`，再实现 P0-03/P0-04；
- 不要让 P3 的“自动协作规划”提前混进 P0；
- 双模型/三模型先用固定 participants 验证。

---

## 5. P1/P2 的关键设计问题

### 5.1 `DebateQualityReport` 不要覆盖现有 Verdict

当前已有：

- `judgeDebate` / `JudgeVerdict`；
- `ClaimJudgment` / `Verdict`；
- `quality.ts`；
- `DebateState.verdict`。

计划的 `DebateQualityReport` / `FinalDebateDecision` 与这些重叠。

**建议**：

- 质量报告作为 `JudgeVerdict` 的扩展/伴随对象；
- `FinalDebateDecision` 映射到现有 `Verdict`，不要新增第三套“结论状态”；
- `QualityDimension` 带 `basis` / `evidenceIds` / `status`，不要只有一个 confidence 分数。

### 5.2 “置信程度”不是概率

模型给出的 confidence 没有校准，不能当概率。

建议改名：

```text
assessment: 'supported' | 'contradicted' | 'insufficient' | 'unknown'
```

并记录“基于哪些证据/规则”。

### 5.3 自动测试集只能做回归

计划说测试题由模型生成、不能用生成模型的参考答案当标准。这个限制正确。

但还需要：

- 固定 `dataset.json` 的版本/hash；
- 每个问题固定测试条件；
- 用规则/源码/公开来源标注可验证事实；
- 自动 Judge 只能比较结构、引用、分歧、修正；
- 自动测试通过只能标记 `TESTED`，不能标记 `PRODUCTION_READY`。

### 5.4 P3 自动优化不能形成自我强化

自动策略/模型选择如果直接用 Judge 分数优化，会形成“模型喜欢什么就选什么”的反馈回路。

需要：

- 固定基准集/版本；
- 优化前后对照；
- 人类可覆盖；
- 不能自动改核心策略代码或生产配置（计划已写，保留）。

---

## 6. 真实运行现状

已经真实验证：

- `opencode-go` 下 `deepseek-v4.1-flash`、`glm-5.3`、`claude-haiku-5-5`、`qwen3.8-max` 可用；
- 三模型 truth 辩论跑通 2 轮，glm 第二轮超时；
- 六种策略双模型各 2 轮：
  - truth / expert / assumption / discovery：完整；
  - adversarial / solution：各一条 deepseek 超时。

所以 P0-02/P0-03 目前是 **PARTIAL**，不能写成六种策略全部双模型通过。

---

## 7. 批准建议

| 阶段 | 建议 |
| --- | --- |
| P0-00 重新检查 main | 立即批准 |
| P0-01 远端模型稳定性 | 批准；单 Provider + 3 模型足够 |
| P0-02 六策略真实运行 | 批准；先修超时/重试 |
| P0-03 三模型协作 | 批准；先补 collaboration plan |
| P0-04 异常与状态 | 批准；先加全局 PARTIAL/FAILED |
| P1 自动质量评估 | 暂缓，先补元数据/Judge 隔离/评估边界 |
| P2 Final Judge | 暂缓，先定与现有 Verdict 的映射 |
| P3 自动策略/模型选择 | 后置 |
| P4 Web | 后置 |
| P5 自动优化/UI | 后置 |

---

## 8. 最终意见

取消人工评审可以作为研发效率选择，但不能取消**可验证性**。

建议把“质量验收”拆成三层：

1. **规则/源码/测试可确认**：可以自动判；
2. **模型评审**：只能标 `model-assessed`；
3. **未知/无来源**：必须 `insufficient_evidence`。

P0 先把六种策略、双/三模型、超时、状态和元数据做稳；P1/P2 再在“模型评审不等于事实正确”的约束下建设自动质量引擎。
