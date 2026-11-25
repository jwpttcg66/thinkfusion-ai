# ThinkFusion V3 动态多模型协作与贡献对齐（DMOCA）

**文档版本：** V1.0  
**任务编号：** DMOCA-V3  
**参考审计基线：** `e903c56854e1bfb6c5b9afd38b234803ca917f2f`  
**定位：** Collaboration Engine 内部的动态协作决策与贡献管理能力——**不是**第二套 Agent Runtime。

正式实施任务书见：[`../spec/V3-DMOCA-TASK-BOOK.md`](../spec/V3-DMOCA-TASK-BOOK.md)。

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
