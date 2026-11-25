# V3 分层任务分解（TDL）实施进度

基线：`main`（合入 CB 后）· 分支：`feat/v3-task-decomposition`  
架构：`docs/architecture/V3-TASK-DECOMPOSITION-LAYER.md`  
任务书：`docs/spec/V3-TASK-DECOMPOSITION-TASK-BOOK.md`

| 阶段 | 状态 | 事实 |
| --- | --- | --- |
| 架构说明书 | DESIGN 完成 | `V3-TASK-DECOMPOSITION-LAYER.md` |
| 实施任务书 | DESIGN 完成 | `V3-TASK-DECOMPOSITION-TASK-BOOK.md` |
| TDL-P0 审计 | 文档完成 | 见下方审计表 |
| TDL-P1 契约 | IMPLEMENTED / TESTED | `shared/task-decomposition.ts` + `test:tdl-contract` |
| TDL-P2 投影 | IMPLEMENTED / TESTED | `projectWorkBreakdownFromEvents` + `test:tdl-project` |
| TDL-P3 写入 | IMPLEMENTED / TESTED | `seedWorkEventsFromPlan` / `work.task.status` + `test:tdl-write`；`plan.ready` 后种子；`step.*` → status |
| TDL-P4 GDC/协作挂钩 | IMPLEMENTED / TESTED | `collaborationPolicyFor`；契约测覆盖 low / high_risk |
| TDL-P5 UI 面板 | IMPLEMENTED / TESTED | `WorkBreakdownPanel` 挂主活动区；点击过滤轨迹活动流 |
| TDL-P6 局部重规划 | IMPLEMENTED / TESTED | `impactedByReplan` 闭包；契约测覆盖 |
| TDL-P7 真机验收 | VERIFIED | `npm run test:tdl:live` → `evidence/V3-TDL-ENGINEERING-LIVE.json`（0/1→1/1，`.work-breakdown` 可见，`work.*`+`step.*`） |

## P0 审计表（对照实现前 main）

| 资产 | 路径 | 结论 |
| --- | --- | --- |
| AgentTask | `shared/contracts.ts` | 有 taskId/maxRounds/maxSteps；无 parent/child/依赖/验收 |
| AgentPlan.steps | 同文件 StepSchema | L3 执行步骤；上限 30；不是 WorkTask |
| GDC 投影 | `shared/goal-driven-cycle.ts` | Goal/Cycle/Artifact/Decision 有；**无 WorkTask** |
| GDC 说明书 | `architecture/V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md` §七§八 | 逻辑已提 WorkTask；运行时未落地 |
| ConversationTeamTask | `shared/conversation.ts` | 会话看板有 dependsOn/revision/evidence；owner≠Work |
| team.task.* | contracts + capabilities | 工具层会话任务板；不可直接当工程分解权威 |
| Progress 五段 | `shared/progress.ts` + ProgressPanel | 计划执行可见性；不覆盖子任务分解面板 |
| Task 列表合并 | `shared/task-list.ts` | 历史任务列表；无树形 |

**缺口结论（P0）：** 有步骤、有循环投影、有会话任务板，缺 Engineering Work 级分层分解与可绘制汇总进度。

**落地后：** Journal 写 `work.*`；UI 投影 `WorkBreakdownView`；无 work 事件时从 `plan.ready`+`step.*` 派生。
