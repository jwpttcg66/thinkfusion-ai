# V3 主活动区重构 · U0 现状与数据链路审计

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：完成（审计文档已交付；后续质量缺口见 U7）  
审计日期：2026-11-24  
代码基线（审计当时）：`origin/main@cdc8308`  
功能分支（历史）：`feat/v3-main-activity-collab-result`（已合入 main）  
任务书：HISTORICAL · 收尾见 [`V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md`](../../spec/task-books/main-activity/V3-MAIN-ACTIVITY-U7-QUALITY-CONVERGENCE-TASK-BOOK.md)

> 本文件只记录**代码与调用链事实**，不把计划写成已实现。

---

## 1. 基线核对

| 项 | 事实 |
| --- | --- |
| 远程 `origin/main` | `cdc8308` — 与任务书基线一致 |
| 本地起点 | 干净工作区，自 `main` 拉出功能分支 |
| `docs/implementation/STATUS.md` 原基线 | 曾写 `e336ae4`（已过期，本阶段同步到 `cdc8308`） |

---

## 2. 事件 → 投影 → Renderer 真实链路

### 2.1 Engineering（工程主活动区）

```
Agent / Orchestrator / Plan Review / Verifier
  │  生产 AgentEvent（journal / store）
  ▼
shared/task-view.ts :: projectTaskView / applyTaskViewEvent
  │  派生 TaskView（plan / members / review / verification / changes …）
  ▼
shared/task-conversation.ts :: buildTaskConversation
  │  派生 ConversationEntry[]（user / member / plan / debate / step /
  │  verification / review / conclusion）
  ▼
renderer/.../engineering/TaskConversation.tsx
  │  按 entry.kind 渲染卡片
  ▼
App.tsx 另用 buildConclusion(events) 驱动「最终交付」等旁路展示
```

关键生产事件：

| 展示 | 生产端 | 事件 / 对象 | 投影入口 | 消费端 |
| --- | --- | --- | --- | --- |
| 结论 | `task.completed.summary` / 协议 summary / report+review 事实 | `buildConclusion` | `kind:'conclusion'` | `TaskConversation` 结论卡；`App` 交付卡 |
| 计划辩论摘要 | `orchestrator` → `plan.debated` | `PlanDebate` | `kind:'debate'` | `TaskConversation` 辩论卡 |
| 独立评审 | `orchestrator` → `review.ready` | `{reviewer,backend,verdict,issues[],needsFix}` | `kind:'review'` + `TaskView.review` | `ReviewMessage` |
| 验证 | `report.ready.verification` | checks / reasons | `kind:'verification'` + `TaskView.verification` | `VerificationMessage` |
| 步骤轨迹 | step.* 事件 | `buildTimeline` | `kind:'step'` | `StepMessage`；完整轨迹另走 `TaskTrajectory` |

### 2.2 General / Knowledge（对话主活动区）

```
多通道回答 / 主导综合 / DebateOrchestrator
  │
  ▼
shared/conversation.ts :: Conversation / Message / Synthesis / DebateSnapshot
  │  Synthesis = consensus / disputed / unique / gaps / recommendation /
  │              finalOpinion / fusion…
  │  DebateSnapshot = rounds[].messages（原文）
  ▼
renderer/.../ConversationView.tsx
  │  成员回答 + SynthesisCard + DebatePanel + DebateVerdictStrip
  ▼
轨迹 / 统计：TrajectoryPanel / StatsPanel（独立页，不重算结论）
```

注意：General/Knowledge **不走** `buildTaskConversation`。两套主活动区数据源不同，但任务书要求共享同一套结果语义——U1 必须做**语义统一投影**，不是硬合并两套存储。

### 2.3 另一套「协作引擎视图」（勿混淆）

`main/collaboration/view.ts` 的 `TaskView` / `PlanView` 是 Collaboration Engine 的计划/任务状态投影（goalId、assignments、attempts），**不是**主活动区结论视图，也不是 `shared/task-view.ts` 的 `TaskView`。

`main/collaboration/reviewer.ts` 的 `ReviewResult` 是计划规则/模型审核（`ok` + `notes[]`），与工程 `review.ready` 独立评审也不是同一对象。

---

## 3. 现有类型 vs 任务书语义映射

| 任务书语义 | Engineering 现状 | General/Knowledge 现状 | 缺口 |
| --- | --- | --- | --- |
| Conclusion | `ConversationEntry.conclusion` + `buildConclusion` | `Synthesis.recommendation` / `finalOpinion` | 无统一 `ConclusionView`；工程结论偏事实汇总，综合结论偏主导人文本 |
| Opinion | 成员 `kind:'member'` 全文；无结构化主张抽取 | `Claim`（consensus/unique）+ opinion-tag | 无 `position` / `rationale` / `evidenceRefs` 统一结构；工程侧几乎没有「核心意见」层 |
| Dispute | Debate 引擎有 `DebateDispute`（claimIds/type/reason），但对话卡只有 `PlanDebate.summary` | `Synthesis.disputed`（topic/positions/pivot） | 引擎争议未完整投影到主活动区；对话争议缺 exchanges/verdict/unresolvedReason |
| Review issue | `issues: string[]` + `verdict` + `needsFix` | 基本不走此路径 | **缺** title/description/severity/rationale/recommendation/disposition/resolutionRefs/verificationRefs/sourceRefs |
| Verification | `TaskView.verification` + 对话 verification 卡（含 checks） | 无对等结构 | 工程侧较完整；缺与评审问题的关联引用 |
| SourceReference | 事件本身可追溯；Synthesis.Claim.sources 有 channel/message | Claim.sources | 无跨场景统一 `SourceReference`；renderer 部分仍靠文案猜测来源标签 |
| Progress | `progress.ts` / `TaskProgressCard` / note 卡 | ConversationStatus | 进度信息偏多，易淹没结论（产品问题，非缺字段） |

---

## 4. 缺失字段 / 事件清单（U1–U3 输入）

### 4.1 必须补齐（优先 Review）

`review.ready` / `TaskView.review` / `ConversationEntry.review` 今日只有：

- `reviewer`, `backend`, `verdict`, `issues: string[]`, `needsFix`

缺失语义：

- issueId、title、description、severity、rationale、evidenceRefs
- recommendation、disposition、dispositionReason
- resolutionRefs、verificationRefs、sourceRefs、targetRef

原始评审文本：目前主要落在 `verdict` + `issues[]` 字符串；未见独立「完整评审原文」字段。需在 U1/U3 核对 `orchestrator` 生成 `review.ready` 时是否另有 journal 原文可挂 `sourceRefs`。

### 4.2 Debate 展示断层

| 层 | 有 | 主活动区实际看到 |
| --- | --- | --- |
| `debate/types.ts` | Claim / Dispute / Message / Evidence / Revision | 引擎内部 |
| `PlanDebate` | topics / summary / rounds / skippedReason | 工程对话「辩论卡」摘要 |
| `DebateSnapshot` | rounds 原文 | General DebatePanel |
| 裁决 | DebateVerdictStrip（按 debateId） | 有，但与争议对象未统一 |

结果：引擎已能表达争议，但 Engineering 主活动区默认只显示摘要状态；General 能看到轮次原文，却未必结构化成「争议对象 + 裁决」。

### 4.3 空辩论 / 状态卡生产点

| 现象 | 生产位置（代码事实） |
| --- | --- |
| 计划辩论 skipped 仍可能占对话位 | `plan.debated` + `PlanDebate.status='skipped'` → `kind:'debate'` |
| 评审只有状态感 | `ReviewMessage` 标题「第 N 次独立评审 · 需修复/通过」+ issues 列表；无处理闭环 UI |
| 进度淹没结论 | `TaskProgressCard` 事件文案；`kind:'note'`；General 侧大量状态块在 `ConversationView` / `App` |
| 重复综合感 | General：`recommendation` 与 `finalOpinion` 分字段已防覆盖，但 UI 仍可能叠 DebatePanel + SynthesisCard + VerdictStrip |

---

## 5. 测试覆盖与缺口

已有相关脚本（不完全列表）：

| 脚本 / npm | 覆盖 |
| --- | --- |
| `test:task-conversation` / `check-task-conversation.mjs` | `buildTaskConversation` 条目形态 |
| `test:task-view` / `check-task-view.mjs` | `projectTaskView` |
| `check-plan-review.mjs` / `check-plan-debate*` | 计划评审辩论 |
| `test:collaboration-reviewer` | 协作引擎计划审核（非工程 review.ready 内容闭环） |
| `test:collaboration-debate` | 协作引擎辩论行为 |
| Debate 引擎相关 check-* | Claim/Dispute 提取等 |

缺口（相对任务书 §9）：

- 无「无实质争议不启动辩论」的端到端主活动区断言。
- 无 Review disposition / 修正 / 验证关联的一致性测试。
- ~~无统一 `CollaborationResultView` 投影测试~~ → U1 已补 `test:collaboration-result`（仍缺乱序/去重与跨场景金样）。
- General 与 Engineering 结果语义一致性无共享测试夹具。
- 真机验收报告尚未开始（属 U6）。

---

## 6. U1 建议与落地对照

| 建议 | U1 状态 |
| --- | --- |
| 新建 `shared/collaboration-result.ts` | ✅ 已落地 |
| Engineering / Conversation 双适配器 | ✅ `projectEngineeringCollaborationResult` / `projectConversationCollaborationResult` |
| SourceReference 最小集 | ✅ 已定义 |
| Review issues 投影为完整形状，disposition 默认 pending | ✅ |
| Renderer 不另建权威状态 | ✅ UI 尚未接线（留给 U4/U5） |

---

## 7. 补充审计：主活动区信息层级与结构坍塌点

以下补记并行审计中、初版 U0 未写细的代码事实（仍以 `cdc8308` 为准）。

### 7.1 General / Knowledge 阅读顺序（易淹没结论）

`App.tsx` 对话页自上而下大致为：协作计划 → 参与者 / 证据 / 工作区 / 诊断 → **ProgressPanel** → **ConversationView**。  
ConversationView 内综合卡（SynthesisCard）被显式排在轮次末尾；其前还有生命周期卡、通道条、执行轮次、辩论面板等。

### 7.2 Engineering 阅读顺序与重复交付

1. `TaskProgressCard`（现在到哪）  
2. `TaskConversation`（事件时间线：… → verification → review → conclusion）  
3. 同页后续还有计划预览 / 等待卡 / **「最终交付」**（再次展示验证与评审状态）

「最终交付」与时间线里的 verification/review/conclusion **信息重复**，U5 应收敛到单一结论层。

### 7.3 结构在边界上被压成摘要

| 边界 | 事实 |
| --- | --- |
| 计划辩论 | `DebateOrchestrator` 有 Claim/Dispute/Verdict；`summarizePlanDebate` / `PlanDebate` 只保留 `summary` 等摘要字段进入 `plan.debated` |
| 独立评审 | `ReviewVerdict.verdict` 常为**模型全文**；`issues[]` 为启发式抽行，无 severity / disposition |
| General 裁决 | `DebateVerdictStrip` 可按 `debateId` 再取完整 `DebateView`；Engineering 辩论卡**未**做同等水合 |

### 7.4 命名易混（实施时勿接错）

| 名字 | 实际含义 |
| --- | --- |
| `shared/task-view.ts` · `TaskView` | 工程任务派生视图（主活动区在用） |
| `collaboration/view.ts` · `TaskView` | 协作引擎计划任务状态（主活动区未接） |
| `collaboration/reviewer.ts` | 计划门禁 notes，不是 `review.ready` |
| `CollaborationDetailsView` | V3 详情 DTO，主活动区只部分经面板露出 |
| `ModelOutputGrid` | 组件存在，App **未引用** |

### 7.5 U2 / U3 / U4–U5 优先序（由本补充导出）

1. **U2**：计划辩论边界停止只落 `summary`——事件携带结构化切片，或 Engineering 按 `debateId` 水合（与 VerdictStrip 同路），投影才能有真争议。  
2. **U3**：拆开 `rawVerdict` 与结构化 `ReviewIssue`；交付卡禁止只显示「通过/需修复 · N 处」。  
3. **U4**：General 主活动区把 Progress/面板降为紧凑层，结论与关键意见上移。  
4. **U5**：Engineering 去掉与时间线重复的「最终交付」堆叠，统一读 `CollaborationResultView`。

---

## 8. U0 验收对照

| 验收项 | 结果 |
| --- | --- |
| 最新 SHA / 文件 / 调用链真实 | ✅ `cdc8308`；链路见 §2、§7 |
| 核心意见 / 争议 / 评审 / 验证有生产端与消费端 | ✅ 已定位；评审内容与争议结构化展示不完整（见 §3–4、§7.3） |
| 字段映射表 | ✅ §3 |
| 缺失清单 | ✅ §4 |
| 测试缺口 | ✅ §5 |

**U0 结论：** 可以进入（且已进入）U1。最大风险仍是 Review 内容过瘦、计划辩论结构在 `PlanDebate` 边界坍塌，以及双场景数据源分裂；U4/U5 前必须先补 U2/U3 生产端结构，不能只靠 UI 重排。
