# ThinkFusion V3 整体架构：Goal → TDL → Cycle → Execution + ECO + DMOCA

**版本：** V2.0  
**文档角色：** Goal/TDL/ECO 目标架构设计；当前实现状态见 [STATUS](../implementation/STATUS.md)。<br>
**原则：** 复用现有 Orchestrator / Journal / GDC / TDL / DMOCA / ContextManager；不另建 Runtime。

## 四个核心业务层

| 层 | 职责 | 权威落点 |
| --- | --- | --- |
| L0 Goal | 用户目标、成功标准、约束、目标版本 | `goal.fit` / GDC 投影 |
| L1 TDL | L0–L3 任务树、依赖、验收、真实进度 | `work.*` 事件 |
| L2 Cycle | 分析→设计→辩论→计划→实现→审核→结论 | `cycle.snapshot` + GDC |
| L3 Execution | 模型/工具/插件实际执行 | Orchestrator + Provider |

## 两个横向机制

| 机制 | 职责 | 边界 |
| --- | --- | --- |
| **ECO** | 工程上下文包、充分度、事实分类、补充请求 | 不调度任务、不定角色 |
| **DMOCA** | 动态选模、角色、贡献对齐、按需辩论审核 | 不认证工程事实真伪 |

长任务管理（持久化 / 压缩 / 检查点 / 恢复）为跨层基础设施，复用 `main/context/`。

## 关系

```
User Request → Goal → TDL → Cycle → Execution
                 ↑              |
                 +-- 回退/重规划 +
横向：ECO（能否正确参与）∥ DMOCA（谁参与、交什么）∥ LT（状态可恢复）
```

## 不可妥协

1. 进度来自事件与验收证据，不来自模型自报。
2. 旁听不等于具备正式架构裁决资格——须 ECO 充分度。
3. 正式决策引用固定贡献快照与上下文版本。
4. 禁止第二套 Runtime / Journal / Verifier / 权限系统。

## 当前实现对照（2026-11-26）

目标架构与已落地实现必须分开读；本节目的是防止把设计当成现状重复开发。

| 层/机制 | 已实现的权威落点 | 与目标架构的差距 |
| --- | --- | --- |
| Goal | `ConversationGoal` + GDC `EngineeringGoalView`；`AgentTask.goalId/goalVersion` 由创建时写入 | 目标尚未有独立的用户修订界面；确认流程只在 IPC 层可用 |
| TDL | `shared/task-decomposition.ts` 的 WorkTask（L0–L3）、状态机、依赖、验收、CAS；种树走 `seedWorkEventsFromPlan` | 复杂任务缺 `decomposition` 时用「写入目标目录」结构化归纳；归纳不出来标 `NEEDS_ANALYSIS` 并取消自动批准，不会自动再问模型 |
| Cycle | `cycle.snapshot` + `projectWorkCycleFromEvents` 投影；每个 L2 有独立 `cycleId`，步骤生命周期推进 `cycle.subtask.snapshot` | 子任务循环仍复用主任务的执行轮次，没有独立调度器（这是刻意约束）；跨子任务冲突只在报告收尾时报告 |
| ECO | `shared/eco.ts` 上下文包、充分度、六类类型化补充请求；`main/engineering/eco-explore.ts` 真读文件/目录/符号/调用/测试/diff；代码或目标变化发 `eco.context.invalidated` | 符号/调用查询是正则级定位，不是 AST/类型绑定；解析不到时如实跳过 |
| DMOCA | `shared/dmoca.ts` 参与决策、贡献版本、决策快照；工程与 General/Knowledge 都走 `snapshotFromExchanges` 钉版本 | 会话侧决策快照已落事件，但界面尚未展示每一轮钉住的是哪一稿 |
| 版本一致性 | `shared/version-consistency.ts` 逐层比对 Goal → WorkTask → ECO → 贡献 → 决策；`resume` 发 `version.consistency` 并改写继续提示词 | 目标变化判 `needs_replan`；运行时循环（`until`）等场景不在本层判定范围 |

**版本关系（已落地）**：

```
AgentTask.goalVersion
      ↓ 种树继承
WorkTask.goalId / goalVersion（L0–L3 全量）
      ↓ 目标修订
planGoalRevision → 影响闭包 → work.task.upserted（受影响任务 revision+1）
      ↓
work.breakdown.replanned
```

版本链自动对齐：`shared/version-consistency.ts` 逐层比对 `Goal → WorkTask → ECO → 贡献 → 决策`，
不兼容时向下游传播作废；目标/分解变化判 `needs_replan`（优先），只有上下文过期判
`needs_context_refresh`。`resume` 发 `version.consistency` 并据此改写继续提示词，
不兼容的旧结论不得静默复用。
