# 工程工作台 V2.1 实施方案（多任务并行 · 多模型独立输出 · 全链路可观测）

状态：**P0 契约已定，代码未动（全部 SPECIFIED）**
依据：《ThinkFusion 工程工作台 多任务多模型并行与可观测性 完整设计实施计划 V2.1》（2026-11-22）
基线：`main` `92adef53a09ffc80acea0148e1bc243a38a65f74`（本地与 `origin/main` 一致）
任务分支：`workbench-v21`，工作树 `../thinkfusion-ai-workbench-v21`

> 与既有文档的关系：`UNIFIED-TASK-RUNTIME.md` 管**任务生命周期与事件唯一性**，本文件管**工程工作台的界面分层与模型级可观测**。
> 两者共用 `AgentTask` 聚合根与 `TaskEvent` 信封，不新建第三套运行时。V2.1 §16（对话页必须持续显示主任务进度）
> 优先于前文的任何歧义描述。

---

## 1. 现状审计（逐文件，2026-11-22）

审计只覆盖本任务涉及的文件，符合 AGENTS §7「不重建基线、任务级审计」。

### 1.1 六条决定实施路径的硬事实

| # | 事实 | 证据 | 对实施的含义 |
| --- | --- | --- | --- |
| 1 | 会话与任务是**互斥渲染**，不是页签关系 | `renderer/src/App.tsx:543` `showingConversation = activeConversation !== null && !activeConversation.taskId`；`App.tsx:1307` 有 taskId 时切任务工作台 | P1 必须先拆这个二分，否则四页无处安放 |
| 2 | V1 多模型卡片**已存在且通用**，但子组件未导出、状态写死在 App | `components/ConversationView.tsx:835` `ChannelGrid`、`:768` `LiveChannelGrid`、`:715` `AnswerCard`；delta 状态在 `App.tsx:337-339` | P3 复用的是**视觉与交互**，状态容器需重写为按 participant 索引 |
| 3 | 任务侧流是**单流模型**，多模型同轮互相覆盖 | `shared/task-stream.ts:11-35` 只有一对 `roundId/streamId`；`shared/task-view.ts:62` `modelTrace` 以 roundId 为 key | P3 的核心改造点就在这里，不是加组件就完事 |
| 4 | 事件里**没有模型调用身份** | `shared/contracts.ts:1330-1347` 无 `participantId/modelCallId`；`step.completed/failed` 无 `roundId/callId`（`:1426-1444`）；`attemptId` 有字段无写入方 | P1b 必须先补契约，否则「哪个模型发起的工具调用」无从追溯 |
| 5 | `observability.ts` 具备统一投影能力，但**只接线了 1/3** | 三个投影在 `shared/observability.ts:59/107/124`；应用内只有 `App.tsx:512` 用到 `fromAgentEvent`；另两个仅测试引用 | P4/P5 直接接线，不重写投影 |
| 6 | 轨迹/统计**只服务会话**，任务视图没有入口 | 数据源 `getTrace` 按 conversationId（`contracts.ts:2320`）；挂载点仅在 `App.tsx:2137/2140` 的会话分支 | P5 要按 taskId 取轨迹，或复用 runEvents 重建 |

### 1.2 需要保留的既有能力（禁止重建）

- `AgentOrchestrator` / `runtime` 的执行治理、审批、Grant、Worktree、Verifier：`main/orchestrator.ts`、`agent/index.ts`
- `AgentStore`（`userData/agent-store.json`，原子重写）：`main/store.ts:7-105`
- `TraceStore`（`userData/traces/<conversationId>.jsonl`，追加 + fsync）：`main/trace/trace-store.ts:18-46`
- `execution-timeline` 的 `buildTimeline`（stepId 聚合）：`shared/execution-timeline.ts:193`
- `observability` 的分类/去重/排序/脱敏：`shared/observability.ts:144-183`

### 1.3 已知缺口清单（按阶段归属）

| 缺口 | 现状 | 归属阶段 |
| --- | --- | --- |
| 无 `participantId/modelCallId` | 事件层完全没有 | P1b |
| `step.*` 无 `roundId/callId`（仅 preparing 有） | `contracts.ts:1358-1444` | P1b |
| `TraceEntry.modelId` 从不写入 | `trace-recorder.ts:278-320` 支持，无调用方 | P1b |
| 多模型流互相覆盖 | `task-stream.ts` 单流 | P3 |
| 每模型输出不持久化 | `store.ts:254-275` delta 只留最新快照、不 persist | P4 |
| `MAX_EVENTS=5000` 全局裁剪 | `store.ts:36` | P4 |
| 任务侧无 token/失败率统计 | `App.tsx:2169` 只数 step.completed | P5 |
| 卡片不含状态/耗时/token | `ConversationView.tsx:717-727` | P3（对齐 §5.2） |
| 无布局切换（单列/两列/三列/聚焦） | 只有 `auto-fit`（`style.css:2833`） | P6 |
| 颜色硬编码，主题变量不全 | `style.css:1479` `#fff`、`5736` | P6 |
| 轨迹/统计在任务视图无入口 | `App.tsx:2137/2140` | P5 |
| 会话生命周期卡不订阅增量 | `ConversationView.tsx:97-102` 只拉一次 | P1 |

---

## 2. 契约（P0 产出，后续阶段不得擅自改动）

### 2.1 事件身份字段（在既有 `AgentEvent` 上增补，不改必填语义）

| 字段 | 适用事件 | 语义 | 约束 |
| --- | --- | --- | --- |
| `participantId` | `round.*`、`step.*`、模型事件 | 参与本次任务的成员 id（模型/CLI/网页通道） | 与 CollaborationState 的 participant 一致，不另造 id |
| `modelCallId` | `round.started/delta/answer` | **一次模型调用**，与 roundId 区分（同轮可多次调用） | 由发起方生成，重试产生新 id |
| `callId` | `step.preparing/started/completed/failed` | 一次工具调用，三阶段同键贯穿 | preparing 已有；补齐后三个事件必须同键 |
| `roundId` | `step.completed/failed` | 归属轮次 | 现缺失，需补以保证跨轮不串 |
| `attemptId` | `step.*` | 同一步骤的重试序号 | 有字段无写入，本阶段补 |

**兼容策略**：全部可选字段。旧事件缺字段时按「单流/单模型」退化显示，不报错、不伪造。写入端集中在 `main/index.ts:1071` `emit()` 与 `orchestrator.ts:531`，读端在 `shared/task-stream.ts` / `shared/task-view.ts`。

### 2.2 流隔离键

- 模型流：`taskId + roundId + modelCallId`（**不再是 `roundId` 单键**）
- 工具流：`taskId + callId`
- 展示排序：全局 `sequence`；卡片内部保留各自到达顺序
- delta 与 snapshot 必须区分：`reset: true` 表示整段替换，否则追加

### 2.3 页面职责（V2.1 §16.6，作为验收依据）

| 页面 | 必须显示 | 定位 |
| --- | --- | --- |
| 对话 | 用户消息、**主任务状态/阶段/步骤/下一步/最近活动**、主任务阶段输出、每模型独立卡片、关键工具结果摘要、阻塞/审批/重试、最终交付 | 执行期默认主界面 |
| 输出 | 模型原始流、工具完整参数与结果、stdout/stderr、完整 Diff、审批与原始事件 | 明细与诊断 |
| 轨迹 | 阶段、DAG、模型调用、工具调用、依赖与时间关系 | 执行路径回放 |
| 统计 | 任务/模型/工具/Token/耗时/失败率/验证结果，未知显式「未提供」 | 量化分析 |

### 2.4 展示状态枚举（模型卡片）

`Queued / Preparing / Streaming / CallingTool / Waiting / Completed / Failed / Cancelled / Interrupted`

与现有 `ChannelPhase` 的差异：现有枚举缺 `Waiting/Interrupted`，且 `channel.phase` 类型未声明 `at`
（`conversation.ts:434` 与 `runner:2158`、`App.tsx:745` 不一致）。**修类型漂移属于 P1 的一部分**，不新增第三套枚举。

---

## 3. 迁移清单（改哪些文件，按阶段）

| 阶段 | 文件 | 动作 |
| --- | --- | --- |
| P1 | `renderer/src/App.tsx` | 拆 `showingConversation` 二分；抽出 `EngineeringWorkbenchLayout`；顶栏页签从 3 改 4 |
| P1 | `renderer/src/components/`（新增） | `EngineeringWorkbenchHeader/Tabs/OutputPage/ConversationPage` |
| P1 | `components/ConversationView.tsx` | 生命周期卡改订阅增量；导出 `channel-card` 子组件供复用 |
| P1 | `shared/conversation.ts` | 修 `channel.phase` 缺 `at`、`ChannelPhase` 缺值 |
| P1b | `shared/contracts.ts` | 补 `participantId/modelCallId/attemptId`；`step.completed/failed` 补 `roundId/callId` |
| P1b | `main/index.ts` `emit()`、`main/orchestrator.ts`、`agent/index.ts` | 写入新字段 |
| P1b | `main/trace/trace-recorder.ts` | `beginStep` 传 `modelId` |
| P3 | `shared/task-stream.ts` | 单流 → `Map<modelCallId, StreamState>` |
| P3 | `shared/task-view.ts` | `modelTrace` key 改 `(roundId, participantId)` |
| P3 | 新增 `components/output/ModelOutputGrid/Card/…` | 复用 `.channel-card` 视觉，补状态/耗时/token |
| P2 | 新增 `components/engineering/EngineeringTaskOverview/TaskCard` | 多任务总览与切换 |
| P4 | `main/store.ts` | delta 快照按 `taskId+roundId+modelCallId` 保留；裁剪改按任务 |
| P4 | `main/index.ts` `task:events` | 回放含每模型流快照 |
| P5 | `components/TrajectoryPanel.tsx` `StatsPanel.tsx` | 支持 taskId 数据源；分层统计 |
| P6 | `style.css` | 主题变量覆盖卡片/状态色；布局切换样式 |

**不动的文件**：`main/orchestrator.ts` 的编排逻辑、`agent/*` 的工具执行、`evidence-pack/*`、`judge/*`、辩论链路。只加字段读取，不改判定。

---

## 4. 阶段与验收（状态：全部 SPECIFIED）

| 阶段 | 目标 | 验收 | 状态 |
| --- | --- | --- | --- |
| P0 | 审计 + 契约 + 迁移清单 | 本文件 | **DONE（文档）** |
| P1 | 统一骨架 + 对话进度容器 | 四页可切；切页/切任务不重启执行；普通会话不回归 | SPECIFIED |
| P1b | 事件身份字段 | 新字段在真机事件里可见；旧事件不报错 | SPECIFIED |
| P2 | 多任务并行总览 | A 等待审批时 B 继续；A 取消不影响 B | SPECIFIED |
| P3 | 多模型独立输出 | 三模型同时流式不串流；单模型失败不冻结其他 | SPECIFIED |
| P4 | 持久化与恢复 | 刷新/重启恢复每模型输出与主任务进度 | SPECIFIED |
| P5 | 轨迹与统计 | 轨迹可定位输出；指标可追溯原始事件 | SPECIFIED |
| P6 | 视觉收口 | 宽屏多列/窄屏单列或横向滚动；无信息丢失 | SPECIFIED |
| P7 | 端到端验收 | §5 用例全通过 | SPECIFIED |

---

## 5. 验收用例（编号固定，后续逐条勾）

**并行与隔离**

1. 两个任务同时执行，A 进审批时 B 继续；A 状态变化不影响 B（§10.1-1）
2. 三模型同任务并行，各自独立 reasoning/text delta，互不串流（§10.1-2）
3. 完成时间不同：已完成卡片保留结果，其余继续（§10.1-3）
4. 某模型超时/限流，其他继续；错误只落在该卡片与任务事件（§10.1-4）

**工具与追溯**

5. 工具参数、结果、发起模型可追溯（§10.1-5）
6. 同模型连调多工具，每 `callId` 独立，三阶段状态正确（§10.1-6）
7. 汇总/评审后原始输出仍完整可查（§10.1-7）

**交互与恢复**

8. 切页/切任务/折侧栏不中断后台执行（§10.1-8）
9. 刷新或重启恢复已持久化的模型输出、工具结果、任务状态（§10.1-9）
10. 统计页分模型展示 Token 与工具消耗，不混淆来源（§10.1-10）
11. 无 reasoning/Token 时显式「未提供」，不填假数据（§10.1-11）
12. 取消作用范围准确，不误伤其他任务/模型（§10.1-12）

**V2.1 §16.7 增补（对话页）**

13. 只停留对话页即可知道状态/阶段/步骤/下一步/最近活动
14. 任务启动即出现反馈，不等首 Token
15. 多模型并行时主任务进度同步更新
16. 某模型无响应时其他仍更新，并标明等待对象
17. 步骤完成/失败/重试/审批/解除阻塞/交付在对话时间线可见
18. 长等待显示等待对象与持续时长，不出现空白假死
19. 切走再回对话页，状态与流连续且不重复调用
20. 进度数字与真实 DAG/步骤一致，无可信总量时不显示百分比
21. V1 知识问答多模型独立输出通过回归

---

## 6. 非目标（V2.1 §12，逐条对齐）

- 不重建 `AgentOrchestrator` / Runtime / 审批 / 权限 / 任务状态库；
- 不新建第二套 `TraceStore` / `EvidenceStore` / Memory；
- 不改模型路由与协作策略的解耦关系；不强制所有模型参与；不强制辩论；
- 不合并模型输出为无来源文本；不合并多任务事件为全局日志；
- 不伪造 reasoning / 原生工具准备事件 / Token / 进度；
- 不因 UI 需要擅自创建、删除、切换 Worktree；
- 不推送远端 `main`，不签名、不发布、不做基线重置。

---

## 7. 风险与回退

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 事件字段增补改变既有契约 | 旧事件回放异常 | 全部可选 + 缺字段退化单流显示；`test:task-events`/`test:observability` 补回归 |
| `ConversationView` 拆组件影响知识空间 | V1 回归 | 先导出复用、后改调用方；`test:features` + 手工 V1 验证 |
| 单流改多流影响辩论/汇总 | 主流程回归 | 保留单流路径作为「单 participant」特例，不删旧分支 |
| 轨迹/统计改数据源 | 历史轨迹不可读 | 双读（conversationId 或 taskId），不做数据迁移 |

回退点：每个阶段单独提交，`workbench-v21` 分支可整支丢弃；不触碰 `main` 直到阶段验收通过。

---

## 8. 实施顺序（V2.1 §16.8）

P0（本文件）→ P1（骨架 + 对话进度契约）→ P1b（事件字段）→ P2（多任务）→ P3（多模型独立输出）→ P4（持久化恢复）→ P5（轨迹/统计）→ P6（视觉收口）→ P7（端到端）。

每阶段：先提交实施清单 → 改代码 → `npm run typecheck` + 相关 `test:*` → 记录状态（SPECIFIED/IMPLEMENTED/INTEGRATED/VERIFIED/TESTED）。
