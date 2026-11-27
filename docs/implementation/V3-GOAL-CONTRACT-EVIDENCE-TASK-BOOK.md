# V3 目标契约证据闭环实施任务书

**状态：** `P0 完成 / P1 进行中`。本文只定义任务、门禁和回滚；实现状态见 [STATUS.md](STATUS.md)。  
**设计基线：** `main@9026e0e`  
**设计说明：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](../architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**契约：** [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)  
**决策记录：** [ADR 0011](../adr/0011-goal-contract-evidence-cycle.md)

## 0. 轨道关系

本任务书是 V3 核心闭环专项，不取代 TDL、GDC、DMOCA、GTEC 任务书。共享文件只能有一个主要责任任务；禁止并行重写同一文件。

| 文件 | 主要所有权 | GCE 边界 |
| --- | --- | --- |
| `conversation.ts` / `goal-driven-cycle.ts` | GDC 目标投影 | 扩展 Criterion、契约状态与决策类型，不复制投影 |
| `task-decomposition.ts` / `subtask-cycle.ts` | TDL | 追加 criterionIds、cycleId 与覆盖检查 |
| `orchestrator.ts` | 生产编排 | 接入 CycleDecision，不新增 Runtime |
| `version-consistency.ts` | 版本治理 | 纳入 Goal/Criterion/Evidence 版本 |
| `eco.ts` / `dmoca.ts` | 上下文与参与 | 作为正式参与资格与贡献版本来源 |
| `TaskConversation.tsx` | 对话流 | 按真实事件展示目标/证据/决策，不恢复卡片堆叠 |
| `AgentStore` / Journal | 事实与事件 | 保持事件权威，不建平行存储 |

## 1. 已确定的设计选择

1. 分级目标确认：简单任务理解后可自动 `ACTIVE`；复杂/重大/高风险任务必须用户确认。
2. 按需 Goal Reasoning：每完整 Cycle 复核目标，只有冲突/信息缺口/重大风险才升级模型分析。
3. 严格区分达成状态：`ACHIEVED`、`ACHIEVED_WITH_RISKS`、`PARTIAL_ACHIEVEMENT`、`UNVERIFIED` 不共用 `completed`。

## 2. 任务总览

| ID | 名称 | 依赖 | 状态 | 主要交付 |
| --- | --- | --- | --- | --- |
| GCE-P0 | 现状与事件映射核对 | — | NOT STARTED | 生产链路图、真实事件/投影清单、缺口表 |
| GCE-P1 | Goal Contract | P0 | 进行中（纯函数层 TESTED；未接线） | 六维目标、Criterion、确认/变更入口 |
| GCE-P2 | Criterion ↔ Evidence 闭环 | P1 | NOT STARTED | 逐条 Goal Fit、三种完成状态 |
| GCE-P3 | Cycle 生命周期与决策引擎 | P1,P2 | NOT STARTED | Work/Cycle/Round 分离、完整决策出口 |
| GCE-P4 | TDL 与动态协作接入 | P2,P3 | NOT STARTED | 覆盖门禁、ECO 资格、DMOCA 版本绑定 |
| GCE-P5 | UI 与长任务验收 | P3,P4 | NOT STARTED | 三场景回归、真机长任务证据 |

## 3. GCE-P0：现状与事件映射核对

**目标：** 在不改行为的前提下确认哪些阶段是真实事件、哪些只是投影，避免基于错误现状实施。

动作：

- 追 `ConversationRunner` / `Orchestrator` / `goal-driven-cycle.ts` / `task-decomposition.ts` 生产调用链。
- 标注 `task.completed`、`report.ready`、`goal.fit`、`work.breakdown.replanned` 的真实语义。
- 核对 `9026e0e` 的文本回读验证和完全权限未验证收尾。
- 更新 status 快照基线和专项验收基线。

**验收：**

- 产出 events-to-stage 映射表，标明“真实事件 / 投影 / 缺失”。
- 列出 `projectEngineeringGoal`、`assessGoalFit`、`decideNextEngineeringAction` 的现有缺口，并能用测试或代码行号核对。
- 不改动生产行为；typecheck 与现有回归保持绿。

**回退：** 仅文档和审计脚本，可回退提交。

## 4. GCE-P1：Goal Contract

**目标：** 用户原话与结构化目标分离；目标来源、确认、Criterion 可被下游消费。

动作：

- 实现六维 `GoalDimension` 与 `GoalSource`。
- 删除“无标准时用 summary 生成标准”的路径；缺失标准时进入 `CLARIFYING` 或 `UNKNOWN`。
- 增加 Criterion 创建、更新、版本与豁免。
- 增加目标确认与重大变更入口，遵循分级确认策略。
- 保持 `question` 原话不变，不新增隐藏话术。

**验收：**

- 测试断言 `MODEL_INFERRED` 不升级为 `USER_CONFIRMED`。
- 测试断言任务摘要不生成 `MUST` Criterion。
- 测试覆盖 `DRAFT→UNDERSTANDING→READY_FOR_CONFIRMATION→CONFIRMED→ACTIVE`。
- 测试覆盖用户拒绝目标变更后旧版本仍有效。
- 真机：简单任务不弹确认；高风险任务有可见确认。

**回退：** 保留原 ConversationGoal 路径，通过 feature flag 或入口分支切回；不删除历史任务数据。

## 5. GCE-P2：Criterion ↔ Evidence 闭环

**目标：** 每条成功标准能逐条验证，执行/验证/达成三者分开。

动作：

- Criterion 映射到 `WorkTask.criterionIds[]`。
- Evidence 映射到 `criterionId` 与 `goalVersion`。
- 实现 `GoalFitAssessment` 逐条汇总。
- 接入 `verification.ts`：按改动类型选择验证方法；保留文本回读与代码验证区别。
- 完全权限未验证交付保留 `UNVERIFIED` 与缺口摘要。

**验收：**

- 每条 MUST 标准有证据或明确缺口；`MET` 不能只有 `MODEL_CLAIM`。
- 文本回读算验证，代码回读不算；先读后写不算回读验证。
- `execution.COMPLETED + verification.UNVERIFIED` 不能得出 `goal.MET`。
- 真机：一次文本改动、一次代码改动分别核对验证结论。

**回退：** Criterion/Evidence 关联可关闭，旧 `goal.fit` 投影保留；不覆盖既有 Evidence。

## 6. GCE-P3：Cycle 生命周期与决策引擎

**目标：** 系统能决定下一步应修复、重规划、重设计、重分析、澄清或等待，而不是只有 complete/repair。

动作：

- 明确 Work / Goal / Cycle / Round / WorkTask / Evidence 身份。
- 为真实阶段发 `cycle.stage.started/completed/skipped`，`SKIPPED` 必须有原因。
- 扩展 `decideNextEngineeringAction()` 为完整决策类型，保留旧四出口兼容映射。
- 接入无进展检测：重复问题、证据指纹、失败步骤、Criterion 停滞。
- 每轮结论包含 Goal Fit 与决策原因。

**验收：**

- 重放事件可重建 Cycle 阶段历史；投影不伪造真实阶段。
- 测试覆盖 REDESIGN / REANALYZE / CLARIFY_GOAL / WAIT_USER / BLOCKED。
- 重复失败不靠轮数上限收敛，而是产生明确决策。
- 真机：一次需要重新设计的任务不会继续机械修复。

**回退：** 新决策层可 bypass，回退到旧 `complete/repair/fail_*` 分支；不删除已落库事件。

## 7. GCE-P4：TDL 与动态协作接入

**目标：** 目标、任务、上下文、模型贡献、证据版本一致。

动作：

- L2 任务绑定 `criterionIds` 与 `cycleId`。
- 分解门禁检查覆盖、依赖、重复、循环、无承接 Criterion。
- ECO 充分度作为正式参与者资格，不足时只给有限意见。
- DMOCA 按阶段与贡献缺口动态选模，贡献绑定 Goal/Cycle/ECO 版本。
- 设计/审核阶段按真实分歧决定是否辩论，无分歧记录跳过原因。

**验收：**

- 强制 Criterion 无任务承接时阻断，不假装计划完整。
- ECO 不足的模型不会被写成正式架构裁决者。
- 贡献快照、采纳/拒绝理由和最终决策可追溯。
- 无真实争议时不产生伪造辩论事件。

**回退：** 关闭新增门禁后旧 TDL/DMOCA 路径保持可用；不回滚历史任务树。

## 8. GCE-P5：UI 与长任务验收

**目标：** 连续文档式主活动区展示真实目标、标准、证据和决策；长任务恢复不丢目标决策状态。

动作：

- 目标区显示 Goal Version、Criterion 状态、风险与未确认假设。
- 主对话流按真实事件顺序显示目标理解、分析、设计、协作、计划、执行、审核、证据、结论、目标符合度、下一步决策。
- 目标变更提供正式确认入口。
- 检查点恢复纳入 Goal Contract、Cycle、TDL revision、ECO、贡献、Evidence 与决策版本。
- 完成 General、Knowledge、Engineering 三场景回归和真实工程长任务验收。

**验收：**

- UI 每项进度可追到真实事件；没有发生的阶段显示未发生。
- 目标变更可操作，拒绝后旧目标仍有效。
- 恢复后不会复用过期 Goal/Criterion/ECO/贡献/证据。
- 真机报告写明启动配置、任务 ID、证据路径和缺口。
- 对话流保持最新连续文档式，不增加独立定位轨或大卡片堆叠。

**回退：** UI 可按组件开关回退到当前对话流；不删除历史事件和检查点。

## 9. 串行集成规则

- 每个批次独立 worktree/分支；完成、测试、真机证据后再合并。
- 先合并批次依赖；后合并分支负责冲突解决与回归修复。
- 未经用户明确授权不推送远程，不执行发布、签名、公证或正式分发。
- 状态只在 [STATUS.md](STATUS.md) 更新，不在本任务书维护第二张完成度表。
