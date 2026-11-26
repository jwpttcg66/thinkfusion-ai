# DMOCA-P0 架构审计

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**审计日：** 2026-11-25  
**代码：** `origin/main@e903c56`（含 TDL merge；worktree `feat/v3-dmoca`）  
**规则：** `AGENTS.md`（参与者由任务决定、不静默减员、真机验收、worktree 分支）

## Existing（已实现，可复用）

| 能力 | 路径 | 说明 |
| --- | --- | --- |
| 候选与健康 | `main/index.ts` `debateCandidates`；`debate/lead.ts` `planLead` | 按 local/cloud/web 归属；排除原因可见 |
| 用户选模 | `contracts` execution options；`App.tsx` / ResearchPanel | `selectedCloudModels` / debateAgentIds |
| 风险分级 + 辩论门禁 | `engineering/plan-review.ts` `assessCollaborationRisk` / `shouldDebatePlan` / `planReviewRounds` | CB：L0 auto 跳过五段 |
| 模型审核门禁 | `engineering/review.ts` `shouldModelReviewExecution` | 验证通过小任务不调模型 |
| 意见去重 | `shared/collaboration-result.ts` `selectKeyOpinions` | 展示≠原始 |
| GDC | `shared/goal-driven-cycle.ts`；orchestrator `continueAfterReport` | 阶段与 complete/repair |
| TDL | `shared/task-decomposition.ts`；`collaborationPolicyFor` | WorkTask + debate/review 策略字段 |
| 流式 vs 完成 | `round.delta` / `round.answer` / `round.peer` | delta 有 mode snapshot\|delta；正式回答在 answer/peer |
| Usage | `main/memory/usage.ts` 等 | 有调用用量记录，非统一 ModelRun |
| 主活动区 | `CollaborationResultPanel`；TaskConversation | 目标/循环/结论/意见 |
| 预算 | `CODING_BUDGET`；CB 轮次；协作设置 | **未**统一覆盖所有 Provider 入口 |

## Partial

| 项 | 现状 | 缺口 |
| --- | --- | --- |
| 动态人数 | Planner/planLead 有理由，但 Engineering 常固定选中列表 | 缺按阶段/角色的 ParticipationDecision |
| 角色 | 辩论有 lead/challenger 语义；工程无统一 Role 契约 | 缺任务级动态角色绑定 |
| 贡献版本 | Journal 事件保留全文；无 ContributionArtifact 版本链 | 决策难引用「选定版本」 |
| 对齐快照 | 无 ContributionSnapshot / DecisionSnapshot | 综合依赖最新文本 |
| 三场景入口 | General/Knowledge 走 conversation-runner；Engineering 走 orchestrator | 选人路径不统一 |
| TDL collaborationPolicy | 有 debate/review 枚举 | 未接到 shouldDebatePlan / review 门禁 |

## Missing（DMOCA 需补）

1. ModelCapability 统一视图（复用 Provider，不重维护可用性）
2. ParticipationDecision 可追溯记录与事件
3. ModelRun / ContributionArtifact / Snapshot 契约与投影
4. 异步对齐状态机（READY/DEGRADED/BLOCKED）
5. 阶段切换后角色重评与替换生命周期
6. 主活动区「谁参与 / 交了什么版本 / 对齐状态」
7. 统一预算维度接入所有追加调用入口

## Duplicate risks

- 勿再造选人模块替代 `planLead`/`debateCandidates`
- 勿再造风险分级替代 `assessCollaborationRisk`
- 勿再造循环状态机替代 GDC
- 勿再造 Work 状态机替代 TDL
- 贡献文本勿双写：用 contentRef 指 Journal/事件

## Call chains（摘要）

- Engineering 计划评审：`orchestrator.reviewPlanWithDebate` → `shouldDebatePlan` →（非 L0）`debatePlan` → `buildPlanReviewLeadAsk` 五段 → 有辩题才辩
- Engineering 执行后审核：`orchestrator` → `deps.review` → `reviewExecution` → `shouldModelReviewExecution` → rules\|model
- Knowledge 辩论：`index.ts` debate:start → `planLead` → DebateOrchestrator
- 会话协作：`conversation-runner` → Collaboration planner/behaviors

## 预算覆盖（P0 关键三问之一）

| 入口 | 是否受 CB/CODING 约束 |
| --- | --- |
| 方案评审五段+辩论 | ✅ shouldDebatePlan + planReviewRounds |
| 执行后模型审核 | ✅ shouldModelReviewExecution |
| 会话多通道并行提问 | ⚠️ 主要靠用户选模与 planLead，无 L0–L3 统一门禁 |
| 修复轮再规划 | ⚠️ maxRounds；无边际收益停 |

## 完成事件区分（P0 关键三问之二）

| 信号 | 含义 |
| --- | --- |
| `round.delta` | 流式中间；`mode: snapshot\|delta` |
| `round.answer` / `round.peer` completed | 该成员本轮正式文本 |
| `plan.ready` / `report.ready` | 结构化交付 |
| 无 `ContributionArtifact.final` | **缺**统一「正式贡献已封版」标记 |

## TDL/GDC/Journal 贡献关联（P0 关键三问之三）

- GDC：有 cycle/goal 投影与 snapshot 事件；**无**贡献 artifact 引用
- TDL：WorkTask 有 evidence 数组；**无** model run / contribution id
- Journal：事件权威在；**可扩展**，勿新建第二权威库

## Recommended reuse map

| DMOCA 阶段 | 扩展点 |
| --- | --- |
| P1 | 新 `shared/dmoca.ts` decideParticipation；包装 assessCollaborationRisk + 用户选模 |
| P2 | Participation 生命周期状态机（纯函数）+ 事件 |
| P3–P4 | 从 AgentEvent 投影 ModelRun/Contribution/Snapshot |
| P5 | 接线 TDL collaborationPolicy → shouldDebatePlan/review；会话侧复用 CB |
| P6 | CollaborationResultPanel 增加参与/对齐区；绑定 workTaskId |
| P7 | 自动化 + L0/L2 真机 |

## Open questions

1. 会话侧是否在本专项把 L0–L3 门禁接到 conversation-runner（建议 P5）？
2. Contribution contentRef 用 event id 还是独立 blob（建议 event id + 可选裁剪）？
3. TDL 分支 `feat/v3-task-decomposition` 与 main 已含 TDL merge——以 main 为准。
