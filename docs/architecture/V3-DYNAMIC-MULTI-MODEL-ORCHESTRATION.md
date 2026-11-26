# ThinkFusion V3 动态多模型协作与贡献对齐（DMOCA）

**文档版本：** V1.0  
**任务编号：** DMOCA-V3  
**文档角色：** DMOCA 目标设计；当前实现状态见 [STATUS](../implementation/STATUS.md)。<br>
**定位：** Collaboration Engine 内部的动态协作决策与贡献管理能力——**不是**第二套 Agent Runtime。

正式实施任务书见：[`../spec/V3-DMOCA-TASK-BOOK.md`](../archive/spec/task-books/dmoca/V3-DMOCA-TASK-BOOK.md)。

## 为何是核心协作升级

整合：动态模型选择、角色分配、多模型异步输出、贡献版本、辩论/审核控制、工程任务分解（TDL）与目标驱动循环（GDC）。

最终目标：**按需参与、角色动态分配、贡献可追溯、异步对齐、争议按需、审核按风险、结论基于证据。**

## 两个子系统

| 子系统 | 职责 |
| --- | --- |
| Dynamic Model Orchestration | 能力匹配、人数、角色、预算、加入/退出/替换 |
| Model Contribution Alignment | 输出适配、版本、对齐快照、决策引用 |

## 必须复用

AgentOrchestrator、Collaboration Engine、Planner、Provider、TaskGrant、Debate、Review、Verifier、Journal、GDC、TDL、Permission、现有预算与事件。

## 禁止

第二套 Runtime / Scheduler / 任务状态机 / Journal / EvidenceStore / 权限 / Verifier / 与 GDC·TDL 重复的工作流。

## 十项不可妥协原则（摘要）

1. 不固定三模型参与  
2. 不固定模型永久角色  
3. 不统一模型内部思考流程  
4. 不把流式输出当正式贡献  
5. 不覆盖历史贡献版本  
6. 不要求所有模型同步完成  
7. 无实质争议不启动辩论  
8. 普通小任务不强制模型审核  
9. 预算不足不得静默跳过高风险门禁  
10. 不新建重复基础设施  

## 与现有能力的关系

| 已有 | DMOCA 用法 |
| --- | --- |
| CB（`assessCollaborationRisk` / `shouldDebatePlan` / `shouldModelReviewExecution`） | 风险与辩论/审核门禁的默认策略源 |
| GDC | 阶段权威；DMOCA 按阶段选人，不另建循环 |
| TDL WorkTask | 参与策略绑定子任务 |
| `planLead` / `debateCandidates` | 候选与健康检查入口，扩展而非替换 |
| Journal / AgentEvent | 扩展事件，单一权威 |

## 当前实现对照（2026-11-26）

| 能力 | 已实现 | 边界 |
| --- | --- | --- |
| 参与 vs 职责 | `applyEcoGateToDecision` 只收窄**正式职责**（architect/reviewer/verifier/adjudicator），用户钉住的人仍参与 | 上下文不足/过期时被摘角色的人只能旁听、辅助分析；`roleEligibility` 供派发前复核 |
| 角色限制可审计 | `blockedRoles` 与 `ecoGate.restrictions` 随 `model.participation.selected` 落事件 | 界面已区分「仅旁听/辅助分析」与正式角色 |
| 正式贡献快照 | 方案评审后 `snapshotFromExchanges` 生成 artifact/snapshot/decision，钉住每人最后一版终稿 | 工程评审与 General/Knowledge 共用这一条出口；会话侧由 `conversationDecisionSnapshot` 调用 |
| 快照完整性 | `assertDecisionSnapshotIntegrity` 检查缺失、版本不符、已被覆盖、未完成 | 发现问题是记警告，不自动改数据 |
| 三场景统一 | 会话轮次结束发 `model.decision.snapshot`（含 artifacts），`projectDmocaFromConversationEvents` 与工程投影产出同一视图结构 | 单模型时结论成立但标 `singleModel`，不做交叉验证声明；界面尚未展示会话决策快照 |
| 失败/超时不阻塞 | 失败成员照常记入 `unresolvedIssues`，结论照常给出；没有正文时不造决策 | 超时的成员不会被等待补答，也不假装参与过 |

**明确不做**：为「看起来在协作」固定每任务三模型；把流式片段当正式贡献；用新 Runtime 承载 Workflow。
