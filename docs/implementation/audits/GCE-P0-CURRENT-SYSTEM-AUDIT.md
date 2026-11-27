# GCE-P0：现有生产链路与事件映射审计

**基线：** `main@9026e0e`（2026-11-27）  
**范围：** Goal、GDC、TDL、Orchestrator、Verification、相关事件与 UI 投影  
**状态：** 审计完成；未改生产行为  
**结论：** 现有 V3 已有目标/循环/分解/协作模块，但生产闭环仍以“执行—报告—修复”为主；设计中的 Goal Contract、逐条 Criterion、Evidence 关联和完整 Cycle Decision 尚未实现。

## 1. 生产链路

```text
ConversationRunner（工程分流）
  → AgentOrchestrator.submit / driveRound
  → plan.ready / plan.debated
  → TaskGrant + Runtime
  → step.* / report.ready
  → review.ready
  → projectGoalDrivenWorkbench()
      → projectWorkCycleFromEvents()
      → assessGoalFit()
      → projectEngineeringGoal()
  → decideNextEngineeringAction()
  → cycle.snapshot / goal.fit
  → task.completed / report_pending / repair
```

关键位置：

| 责任 | 代码 |
| --- | --- |
| 目标/周期/Goal Fit 投影 | `desktop-agent-macos/src/shared/goal-driven-cycle.ts` |
| 编排与决策落点 | `desktop-agent-macos/src/main/orchestrator.ts` |
| TDL 任务树 | `desktop-agent-macos/src/shared/task-decomposition.ts` |
| 子任务循环 | `desktop-agent-macos/src/shared/subtask-cycle.ts` |
| 验证 | `desktop-agent-macos/src/agent/verification.ts` |
| 事件契约 | `desktop-agent-macos/src/shared/contracts.ts` |

## 2. 真实事件与投影

| 展示/视图 | 真实来源 | 是否真实阶段事件 | 结论 |
| --- | --- | --- | --- |
| `round.started` | Journal | 是（模型轮次） | 不能证明目标推理/设计独立发生 |
| `plan.ready` / `plan.debated` | Journal | 是 | 计划事件，不等于设计产物 |
| `step.started/completed` | Journal/Runtime | 是 | 实现与工具执行事实 |
| `report.ready` | Runtime | 是 | 执行报告，不等于目标达成 |
| `review.ready` | 独立评审 | 是 | 评审结论，不等于用户验收 |
| `goal_reasoning/analysis/design` 阶段 | `projectWorkCycleFromEvents()` 推导 | **否** | 当前没有对应的真实阶段开始/结束事件 |
| `cycle.snapshot` | Orchestrator 写入 | 是，但由推导后的状态生成 | 是快照，不是阶段事实 |
| `goal.fit` | Orchestrator 写入 | 是，但输入来自整体验证/评审布尔值 | 不是逐条 Criterion 评估 |
| `task.completed` | TaskManager | 是 | 任务生命周期终态，不是目标达成 |

`contracts.ts` 当前没有 `cycle.stage.started/completed/skipped`；GDC 阶段只能从轮次、计划、步骤和评审事件推导。

## 3. 审计发现

### F1. Goal 仍是视图投影，不是结构化目标理解

`projectEngineeringGoal()`（`goal-driven-cycle.ts:292`）把 `conversationGoal.text` 或用户原话同时写入 `intent` 和 `desiredOutcome`，`successCriteria` 缺省时使用：

```ts
input.summary?.trim() ? [`任务摘要可核对：${input.summary.trim().slice(0, 120)}`] : []
```

这会把任务摘要伪装成可核对标准，无法证明系统理解了用户目标。也没有六维目标、来源标注或目标确认状态。

### F2. Goal Fit 仍是整体布尔汇总

`assessGoalFit()`（`:254`）只接收 `successCriteria: string[]`、`verified`、`fullyVerified`、`needsFix`、`openReviewIssues`，返回 `pending/met/gap/unknown`。它不能逐条回答每条标准是否满足，也不能要求每条标准绑定证据。

`projectGoalDrivenWorkbench()` 还把 `input.summary` 当作唯一成功标准（`:669-675`），进一步放大 F1。

### F3. Cycle Decision 只有四个出口

`decideNextEngineeringAction()`（`:140`）只返回：

```text
complete | repair | fail_budget | fail_delivery
```

无法表达重新分析、重新设计、重规划、澄清目标、等待用户、阻塞或放弃。`Orchestrator` 在修复闸门关闭时把所有情况压成 `observe` 或 `repair`，不能区分问题层级。

### F4. 阶段投影不能证明阶段真实发生

`projectWorkCycleFromEvents()`（`:347`）从 `round.started` 推断 `analysis`、从 `plan.ready` 推断 `planning`、从 `step.*` 推断 `implementation`、从 `review.ready` 推断 `review`，并直接为 `goal_reasoning/design` 等阶段生成状态。它适合展示，但不能证明系统每轮真的做了目标推理和设计。

### F5. 目标达成仍被任务完成覆盖

`Orchestrator` 在 `complete` 分支直接发出：

```ts
fit: 'met',
notes: ['验证通过且无待修评审；目标符合度暂记为已满足（仍以用户最终验收为准）']
```

即使附注保留“用户最终验收”，事件层仍把 `goal.fit` 标成 `met`。这与“执行完成 ≠ 验证通过 ≠ 目标达成”冲突。

### F6. TDL 缺少 Criterion 级映射

`WorkTask` 有 `goalId`、`goalVersion`、`acceptanceCriteria`，但没有 `criterionIds[]` 或证据到 Criterion 的关联；`acceptanceCriteria` 是文本，不是可逐条判定的 Goal Criterion。

### F7. 最新验证口径已分层，但 Goal 层未接

`verification.ts:218-243` 已区分非代码改动的回读验证与代码验证：文本文件写入后回读可算该类验证；代码文件回读不算编译/运行。这是正确方向，但上层仍把整体 `verified/fullyVerified` 汇总成 Goal Fit，未把 `FILE_READBACK` 等证据类型映射到 Criterion。

## 4. 已确认的正向变化

- `9026e0e` 已让完全权限下的未验证收尾不再停在人工闸门，但摘要明确写“存在未验证缺口”。
- 非代码文件回读可作为该类改动的验证证据；代码回读被排除。
- Cycle 投影已能重放并显示阶段/结论，但只能作为视图，不可作为阶段事实。
- TDL 已有 `goalId`、`goalVersion`、`cycleId` 基础字段，可扩展而非另建任务树。

## 5. 对后续批次的影响

| 批次 | 必须先解决的问题 |
| --- | --- |
| P1 Goal Contract | F1；删除 summary 冒充标准；新增来源/确认/版本 |
| P2 Criterion/Evidence | F2/F6/F7；逐条标准与证据关联；三种完成状态 |
| P3 Cycle Decision | F3/F4/F5；真实阶段事件；完整决策出口；Goal Fit 不再由 complete 覆盖 |
| P4 TDL/DMOCA | F6；任务覆盖检查；ECO/DMOCA 版本绑定 |
| P5 UI/恢复 | 目标确认、逐条标准、决策原因；恢复版本一致性 |

## 6. 本次审计未做

- 未修改生产代码、事件契约或 UI。
- 未跑真实工程任务；本审计只核对代码和现有测试事实。
- 未把 `cycle.snapshot` 阶段称为真实阶段执行。

下一步：按 [GCE 任务书](../V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md) 从 P1 Goal Contract 开始；先落纯类型/状态机与回归测试，再接线 Orchestrator 和 UI。
