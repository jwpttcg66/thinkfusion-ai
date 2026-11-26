# V3 GDC · P0 架构审计（四类清单）

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


基线：`origin/main@d152137`  
分支：`feat/v3-goal-driven-cycle`  
对照：[`V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md`](../../../architecture/V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md)

> 本文件只记代码事实。GDC 落地为薄协调/投影，禁止另建 Runtime。

---

## 1. 已有能力

| 能力 | 路径 | 接线事实 |
| --- | --- | --- |
| Collaboration `Goal` | `main/collaboration/domain/types.ts`、`engine.ts` | 含 statement / constraints / acceptance |
| `ConversationGoal` + IPC | `shared/conversation.ts`、`main/index.ts` | goal.create/get/update |
| Team board | `main/team-board.ts` | 依赖、CAS、完成证据 |
| Planner / Scheduler / Runner | `main/collaboration/{planner,scheduler,runner}/` | DAG 与执行 |
| Replan | `main/collaboration/adapt/replanner.ts` | 有上限 |
| Debate（按需） | `main/debate/`、`engineering/plan-debate*` | 无争议不伪造 |
| Review + disposition | `main/engineering/review.ts`、事件 `review.*` | 写回 Journal |
| Verifier | `main/collaboration/verifier.ts` | 主张验证 |
| Coding 迭代预算 | `shared/coding-workflow.ts` | maxIterations |
| AgentOrchestrator | `main/orchestrator.ts` | 授权、工具、评审钩子 |
| TaskGrant / Journal | `shared/contracts.ts`、`main/store.ts` | 权威执行与事件 |
| Checkpoint | `main/context/checkpoint/` | LT 恢复设施 |
| 结果投影 / UI | `shared/collaboration-result.ts`、`CollaborationResultPanel.tsx` | U7 去重已合入 |

---

## 2. 缺失能力

| 缺口 | 说明 |
| --- | --- |
| 统一 EngineeringGoalView | ConversationGoal 与 collab Goal 未统一投影 |
| WorkCycle / 阶段派生 | 无单一 cycle 视图；迭代散落 coding round / replan / debate |
| 结论类型枚举 | 无 ACCEPTED / NEEDS_FIX … 与下一轮决策的统一投影 |
| 目标符合度字段 | Review 偏技术；目标达标未结构化 |
| Artifact supersedes 投影 | 多轮 plan/review 历史未统一版本视图 |
| 主活动区目标/循环区 | 结果面板无「当前轮次/阶段/下一步」专用区 |

---

## 3. 需修改的契约

| 契约 | 动作 |
| --- | --- |
| 新增 `shared/goal-driven-cycle.ts` | Goal / Cycle / Artifact / Decision **视图**类型 + 投影函数 |
| 可选扩展 AgentEvent | 仅当派生不足时；优先纯投影 |
| `CollaborationResultView` 或并列 CycleResult | 供 UI 挂目标/循环/下一步 |
| 测试脚本 | `test:gdc-goal` / `test:gdc-cycle` |

**不改：** TaskGrant 语义、Orchestrator 主循环权威地位、Journal 存储形态。

---

## 4. 实施依赖顺序

1. P1 Goal 投影（无 UI 也可测）  
2. P2 Cycle 派生（依赖事件序列）  
3. P3 Artifact/Decision 投影（依赖 P2）  
4. P4 观察点接入（读投影，少写状态）  
5. P5 与 Checkpoint 字段对齐  
6. P6 UI  
7. P7 真机  

---

## 5. 禁止事项（审计结论）

- 第二套 AgentOrchestrator / TaskManager / Journal / Approval / Verifier  
- 用提示词驱动「阶段导演」  
- 任务开场冻结流程基线  
