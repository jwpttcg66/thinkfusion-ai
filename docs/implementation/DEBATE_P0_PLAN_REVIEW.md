# 辩论策略 P0 计划审核

- 审核对象：`ThinkFusion 远端模型优先的辩论策略验证与后续研发实施计划 V1.1`
- 当前代码：`c54b66e`（`main`）
- 审核日期：2026-11-14
- 结论：**P0-00 可立即执行；P0-01 先按“单 Provider + 多模型”做，两个 Provider 需补 Key；P0-05/06/07 暂不能按原文通过。**

---

## 1. 计划方向

方向正确：

- 先验证远端模型，不先做 Web；
- 六种策略必须真跑，不以 Prompt 存在为完成；
- 多模型、多轮、停止条件、人工盲评；
- 复用 DebateOrchestrator，不重建辩论引擎；
- 不把 Mock 当真实模型结果；
- 不把 5 题当 24 题验收。

这与当前代码结构相符：六种策略是真实 profile，`DebateOrchestrator` 已有多轮、角色、争议、修订、裁判、落盘和事件。

---

## 2. 当前代码核对

| 计划判断 | 当前代码 | 判断 |
| --- | --- | --- |
| 基线 c54b66e | 当前 HEAD 一致 | 正确 |
| 六种策略存在 | `strategies.ts` 六个非 legacy profile | 正确 |
| 策略改变行为 | focus / roles / disputeOrder 均不同；有测试 | 正确 |
| 多轮、收敛、提前停止 | `maxRounds`、`convergenceStop`、`earlyStopOnStall`、时间预算 | 正确，但无 Token 预算 |
| 云端成员可参与 | `debateCandidates` 含 local/cloud，`planLead` 支持 cloud | 正确 |
| 辩论记录持久化 | `DebateStore` + events | 正确 |
| 真实远端测试 | 现有测试全部用 mock `ask` | **未实现** |
| 策略组合 | `DebateConfig.strategy` 是单值 | **未支持** |
| Token/Provider/Model 可观测 | `DebateMessage` 没有 usage/provider/model | **缺失** |
| 24 题人工标注 | `debate-labels.mjs` 13 条，labelSource 只有 rule/seed | **未完成** |

---

## 3. P0 阻断项

### P0-1：两个远端 Provider 的账号前提没有满足

当前本机只配置了：

- `opencode-go`
- 一个 API Key
- 多个模型（deepseek/glm/grok/claude 等）

计划要求：

- 两个 Provider；
- 至少三个模型。

**当前只能满足“一个 Provider + 三个模型”，不能满足“两个 Provider”。**

建议：

- 先按 `opencode-go` 的三个模型做 P0-01-A，标注为 `SINGLE_PROVIDER`；
- 第二个 Provider 配好 Key 后做 P0-01-B；
- 在第二个 Provider 未配置前，不能把 P0-01 写成“多 Provider 验证通过”。

### P0-2：策略组合没有数据结构

计划 P0-05 要求：

- truth + adversarial；
- expert + assumption；
- solution + adversarial；
- discovery + truth；
- expert + solution；
- truth + assumption + adversarial。

当前 `DebateConfig.strategy` 是**单个** `DebateStrategy`，没有组合字段、阶段计划或角色合并规则。

不能在 `prompts.ts` 里拼两段 system 就算实现组合，因为：

- 两种策略的 focus 可能冲突；
- 争议排序只能有一个顺序；
- 角色分配只能有一个 lead/other；
- 轮数和停止条件不同。

**建议**：

- 先写 `StrategyCombination` ADR：组合是“阶段计划”还是“角色分工”；
- 明确每阶段的 strategy、rounds、roles、disputeOrder；
- 再实现 P0-05；
- 当前 P0-05 标记 `BLOCKED`。

### P0-3：可观测性缺 Token/Provider/Model

计划要求每条记录包含：

- provider；
- model；
- tokenUsage；
- duration；
- terminationReason；
- convergence；
- finalConclusion。

当前 `DebateMessage` 只有：

- text / reasoning / role / citations / createdAt / startedAt / endedAt。

`SubAgentAnswer.usage` 在 `orchestrator.ts` 构造 message 时**没有落盘**。

`quality.ts` 还明确写着“Token / 费用：三条通道都不报用量”，但当前云端 Provider 实际有 usage，只是辩论层丢掉了。

**建议**：

- `DebateMessage` 增加可选 `providerId`、`modelId`、`usage`、`latencyMs`；
- `DebateState` 增加聚合 `usage` / `terminationReason`；
- `DebateStore` 兼容旧记录（字段可选，不迁移）；
- `quality.ts` 只有在 usage 缺失时才说 unavailable，不能对所有云端都说没有。

### P0-4：24 题人工标注集不存在

当前 `scripts/fixtures/debate-labels.mjs`：

- 13 条；
- `labelSource` 只有 `rule` / `seed`；
- 没有 `human`。

计划要求 24 题、人工标注、预标注预期结果，不能用模型自己生成答案。

**建议**：

- P0-06 先建 `benchmarks/debate/p0/`；
- 24 题按六策略各 4 题；
- `expected-results` 必须人工确认；
- 在完成前，P0-06/P0-07 只能 `PENDING/BLOCKED`。

### P0-5：协作组织方式与辩论策略混在一起

计划第六节列：

- normal / parallel / debate / progressive / full / auto；
- 六种辩论策略。

但当前：

- `CollaborationStrategy` 属于会话执行配置；
- `DebateConfig` 只有 `strategy`（六种辩论策略）；
- 辩论面板没有 `collaborationStrategy` 字段。

需要明确：

- “Cloud + debate + adversarial” 中的 `debate` 是协作组织方式；
- 它不是 `DebateConfig.strategy` 的值；
- 如果本轮要验证这些组合，需要先把协作组织方式传进辩论入口，或者明确只验证“Cloud + 辩论策略”。

**建议**：P0-03/P0-04 先只验证 `Cloud + 六种策略`，协作组织方式另列 P1，不要混在一个验收表里。

---

## 4. 其他风险

### 4.1 六种策略的真实差异仍需实测

当前测试证明：

- focus 文案不同；
- roles 不同；
- disputeOrder 不同；
- 策略不改变裁判口径。

但还没有证明：

- 远端模型在 `adversarial` 下真的提出具体反例；
- `assumption` 真的检查前提不成立时结论是否仍成立；
- `solution` 真的建立比较维度；
- `discovery` 真的区分新发现/推测。

这些只能靠 P0-02 真实模型样本判断。

### 4.2 “单模型执行”与“多模型”要分开

计划要求每种策略先单模型、再双模型、再多轮。当前 `DebateOrchestrator` 支持单参与者自辩（`plan.warnings` 会写明同一模型兼任）。需要确保：

- 单模型不等于“多角色独立模型”；
- 双模型必须来自不同 Provider/模型；
- 报告不能把同一模型自辩写成“多模型交叉验证”。

### 4.3 停止条件没有 Token 预算

当前只有：

- `maxRounds`；
- `convergenceStop`；
- `earlyStopOnStall`；
- `totalMs`；
- `maxConcurrency`。

计划提到预算/Token；云端真实测试应增加：

- 单场 token 上限；
- 单次调用 token 上限；
- 超限后的结束原因。

### 4.4 远端模型失败与降级

当前辩论 `askWithin` 失败会把成员记入 `round.failures`，不会让整场崩掉。但需要验证：

- 一个模型失败时是否还能形成有效辩论；
- 两个模型都失败时是否明确 `FAILED`；
- 是否会把单边辩论写成“双方结论”。

### 4.5 角色体系不足

当前 `DebateRole` 只有：

- proposer / critic / peer / domain_expert / evidence_reviewer。

计划 P0 的多角色（提出者/反方/综合分析者）可以映射，但如果要 Architect / Implementer / Security / Performance，当前类型没有；本轮不要扩，先按现有角色验收。

---

## 5. 批准建议

| 任务 | 建议 |
| --- | --- |
| P0-00 基线检查 | **立即批准** |
| P0-01 远端 Provider 验证 | **有条件批准**：先做单 Provider + 3 模型；第二 Provider 配 Key 后补 |
| P0-02 六种策略真实运行 | P0-01 后批准 |
| P0-03 双模型/三模型 | P0-02 后；先双模型 |
| P0-04 多轮与停止 | P0-03 后；先不加 Token 预算也可，但要记录缺口 |
| P0-05 策略组合 | **暂缓**，先写组合 ADR |
| P0-06 24 题 | **暂缓**，先建人工标注集 |
| P0-07 人工盲评 | 数据集完成后再批 |
| P1～P6 | 后置 |

---

## 6. 最终意见

这份计划的方向和验收意识是对的，尤其是：

- 不把 Prompt 存在当策略完成；
- 不把 Mock 当真实模型；
- 不把 5 题当 24 题；
- 不先做 Web。

执行前必须先解决四个现实问题：

1. 当前只有一个远端 Provider Key；
2. 策略组合没有数据结构；
3. 辩论记录没有 Token/Provider/Model；
4. 24 题人工标注集不存在。

**建议先执行 P0-00，再做 P0-01-A（单 Provider + 3 模型）；P0-05/06/07 在 ADR 和数据集完成前不能标通过。**
