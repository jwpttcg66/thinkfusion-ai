# ADR 0011：目标契约驱动的证据闭环

- 状态：Accepted（设计冻结；未实现，运行时状态见 `docs/implementation/STATUS.md`）
- 日期：2026-11-27
- 设计基线：`main@9026e0e`
- 相关：[架构设计](../architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)
  · [契约](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)
  · [实施任务书](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md)

## 背景

当前 V3 已有 Goal、TDL、GDC、ECO、DMOCA、Orchestrator、Journal、Verifier 等模块，但生产闭环仍主要围绕“计划—执行—报告—修复”运转：

- `projectEngineeringGoal()` 把用户原话同时当作 `intent` 和 `desiredOutcome`，缺少成功标准时用任务摘要生成标准；
- `assessGoalFit()` 用整体 `verified/fullyVerified/needsFix` 判断目标符合度，不能逐条回答成功标准；
- `decideNextEngineeringAction()` 只有 `complete/repair/fail_budget/fail_delivery`，无法区分重新分析、重新设计、重新规划、澄清目标或等待用户；
- GDC 阶段主要从执行事件投影，投影不能证明阶段真实发生；
- `9026e0e` 已区分文本回读与代码验证，说明“执行完成 / 验证通过 / 目标达成”必须分层。

## 决策

采用**目标契约驱动的证据闭环**：

1. 用户目标形成结构化 Goal Contract；用户原话、模型推断、工程事实和系统约束分开标注来源。
2. 成功标准成为独立 Criterion，并可逐条绑定证据；禁止用 task summary 自动生成强制标准。
3. Goal Fit 从逐条 Criterion 汇总，不沿用单一布尔判断。
4. Cycle 与 Round 分离；每个完整 Cycle 复核目标、分析、设计、计划、执行、审核、证据和目标符合度。
5. Cycle Decision 扩展为 `CONTINUE/REPAIR/REPLAN/REDESIGN/REANALYZE/CLARIFY_GOAL/CHANGE_PROPOSED/WAIT_USER/BLOCKED/COMPLETE/ABORT`。
6. 严格区分 `Execution Completed`、`Verification Passed`、`Goal Achieved`；完全权限下的未验证收尾保留 `UNVERIFIED` 与缺口。
7. 继续复用现有 Orchestrator、AgentStore、Journal、Evidence、Verifier、ContextManager；不新建第二套 Runtime、存储、审批或验证体系。
8. 分级目标确认：简单任务理解后可自动进入 `ACTIVE`；复杂、重大变更、高风险任务要求用户确认。
9. Goal Reasoning 按需升级：每个完整 Cycle 复核目标，但只有冲突、信息缺口或重大风险才调用更多模型。
10. 达成状态细分：`ACHIEVED`、`ACHIEVED_WITH_RISKS`、`PARTIAL_ACHIEVEMENT`、`UNVERIFIED` 不共用 `completed`。

## 后果

正面：

- 目标理解、任务分解、模型协作、证据和最终结论共享同一套版本与引用；
- 用户能看到每条成功标准是否满足，而不是只看到“任务完成”；
- 修复、重规划、重设计、重分析和澄清成为可解释的真实决策；
- 现有执行事实仍由 Journal/Evidence 提供，避免“模型自报完成”。

代价：

- Goal/Criterion/Evidence/Cycle 的版本链更复杂；
- 需要新增或扩展事件、UI 和恢复检查；
- 旧任务与旧事件需要兼容读取；
- 在 UI 未完成前只能逐批接线，不能宣称整体闭环完成。

## 约束

- 不新增第二套 Agent Runtime、Journal、EvidenceStore、Approval、Verifier 或权限系统。
- 不改变用户原始问题，不用提示词伪装目标理解。
- 不把模型推断写成用户确认，不把任务摘要写成成功标准。
- 不把执行完成写成目标达成，不把模型自报完成写成证据。
- 不把阶段投影写成真实发生；不把 L2 独立 ID 写成物理并行。
- 无进展时停止自动循环，不只用轮数上限掩盖重复失败。
- 工程实施使用独立 worktree/分支，未经授权不推送 `main`。
