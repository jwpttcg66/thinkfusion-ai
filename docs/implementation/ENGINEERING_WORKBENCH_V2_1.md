# 工程工作台 V2.1 实施方案（多任务并行 · 多模型独立输出 · 全链路可观测）

状态：**P0–P6 已落地，P7 真机验收见 §9（部分用例受本机环境限制，逐条标注）**
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
| 无 `participantId/modelCallId` | 事件层完全没有 | **已补（P1b）**：`participantId/attemptId` 进 `AgentEventBase`，`modelCallId` 进 round 事件 |
| `step.*` 无 `roundId/callId`（仅 preparing 有） | `contracts.ts:1358-1444` | **已补（P1b）**：`step.started/completed/failed` 加可选字段，主干按 preparing 索引补齐 |
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

## 4. 阶段与验收（状态截至 2026-11-22 真机）

| 阶段 | 目标 | 验收 | 状态 |
| --- | --- | --- | --- |
| P0 | 审计 + 契约 + 迁移清单 | 本文件 | **DONE（文档）** |
| P1 | 统一骨架 + 对话进度容器 | 四页可切；切页/切任务不重启执行；普通会话不回归 | **IMPLEMENTED + TESTED**：`EngineeringWorkbenchBar`（固定任务头 + 同时在跑 + 四页签）、`TaskProgressCard`；真机切页/切任务后任务继续执行 |
| P1b | 事件身份字段 | 新字段在真机事件里可见；旧事件不报错 | **IMPLEMENTED + TESTED**（`43e27c7`）：`shared/event-identity.ts` + `test:event-identity` 9 条，typecheck 三套绿 |
| P2 | 多任务并行总览 | A 等待审批时 B 继续；A 取消不影响 B | **IMPLEMENTED + TESTED**：真机两条任务并发（A `awaiting_approval` 期间 B 独立走到同一状态，A 批准执行后 B 状态未受影响）；「同时在跑」按 `ACTIVE_STATUSES` + 30 分钟窗口列举 |
| P3 | 多模型独立输出 | 三模型同时流式不串流；单模型失败不冻结其他 | **IMPLEMENTED + TESTED**：`reduceTaskMembers` 按 `participantId` 分桶 + `streamId` 隔离；`test:task-members` 11 条；真机云端模型 + Qoder CLI 两张卡并行、各自耗时/字数独立。三模型受本机可用 Key 数量限制，见 §9 |
| P4 | 持久化与恢复 | 刷新/重启恢复每模型输出与主任务进度 | **IMPLEMENTED + TESTED**：`MAX_EVENTS_PER_TASK=800` + `KEEP_FOREVER`、delta 2 秒节流落盘、`memberAdapter` 重建；真机重启后计划 3/3 步、两张成员卡、轨迹/统计全部恢复 |
| P5 | 轨迹与统计 | 轨迹可定位输出；指标可追溯原始事件 | **IMPLEMENTED + TESTED**：`TaskTrajectory`（工具链按 `callId` 聚三阶段 + 阶段时间线 + 点击定位到输出页）、`TaskStats`（任务/按模型/按工具/验证四层，缺失写「未提供」） |
| P6 | 视觉收口 | 宽屏多列/窄屏单列或横向滚动；无信息丢失 | **IMPLEMENTED + TESTED**：单列/两列/三列 + 聚焦；1240px/900px 两处断点；主题变量（`--ok/--warn/--danger/--member-*`）替换硬编码 |
| P7 | 端到端验收 | §5 用例全通过 | **见 §9**：21 条逐条记录，已验 15 条、部分 2 条、因环境未验 4 条 |

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

---

## 9. P7 真机验收记录（2026-11-22）

### 9.1 环境与可用回答源

| 项 | 实测值 |
| --- | --- |
| 机器 / 系统 | 本机 macOS 26.3，Electron 本地构建（`npm run build`） |
| 数据目录 | `~/Library/Application Support/thinkfusion-ai`（`index.ts` 无条件 `setPath`，`--user-data-dir` 不生效） |
| 工作区 | `~/Downloads`（工程空间，`executionMode=cloud`） |
| 云端模型 | 1 个可用：`opencode-go:deepseek-v4.1-flash` |
| CLI 来源 | 1 个可用：`qoder`（成员 id `cli:qoder`），另有一个已关闭的 `claude` |
| 网页通道 | ChatGPT（**未登录态**，只用于负面验证） |
| 驱动方式 | `electron --remote-debugging-port=9333` + CDP `Runtime.evaluate`，无鼠标 E2E |

**结论先说**：本机只有 1 个云端 Key + 1 个 CLI，因此「三模型同时流式」只能以**两路并行**验证；
需要的键（`taskId + roundId + participantId`、`streamId`）与两路/三路无关，两路不串流即证明键生效。

### 9.2 任务级证据（四次真机任务）

| 轮次 | 任务 | 成员 | 结果 |
| --- | --- | --- | --- |
| R1 | 「新建 `tf-verify.txt` 内容 hello 并读回」 | 单成员 | 3 步全部 completed，文件内容 `hello` |
| R2 | 「新建 `tf3.txt` 内容 hi3 并读回」 | 云端模型 + Qoder CLI | 两张卡并存，各自耗时/字数独立；`tf3.txt=hi3` |
| R3 | 「新建 `tf5.txt` 内容 hi5 并读回」 | 云端模型 + Qoder CLI | 两轮（`user_prompt` + `execution_report`）**都**问了两成员；`round.answer` 两轮各一条；`tf5.txt=hi5` |
| R4 | A/B 两条任务并发（`tfA.txt` / `tfB.txt`） | 各 2 成员 | A 在 `awaiting_approval` 期间 B 独立走到同一状态；A 批准后执行，B 状态未受影响；`tfA.txt=hiA`、`tfB.txt=hiB` |

### 9.3 §5 用例逐条结论

| # | 用例 | 结论 | 证据 / 说明 |
| --- | --- | --- | --- |
| 1 | A 等待审批时 B 继续；A 变化不影响 B | 已验 | R4：两任务并发，「同时在跑」互相可见，A 批准执行后 B 仍 `awaiting_approval` |
| 2 | 三模型同时流式不串流 | **部分** | R2/R3/R4 两路并行互不串流（`reduceTaskMembers` 分桶 + `streamId` 隔离，`test:task-members` 11 条）；三路受本机 Key 数量限制未构造 |
| 3 | 完成时间不同，已完成卡片保留结果 | 已验 | R3：Qoder 15.1 s 先完成，主导 46.2 s 后完成，两张卡各自保留全文与耗时 |
| 4 | 某模型超时/限流，错误只落该卡 | **未验** | 未构造限流场景；错误隔离有单测（`失败隔离` 用例） |
| 5 | 工具参数/结果/发起模型可追溯 | 已验 | 轨迹页每条链带「发起：opencode-go:deepseek-v4.1-flash」；输出页有原始参数与结果 |
| 6 | 同模型连调多工具，`callId` 独立三阶段 | 已验 | R1/R3：`fs.list` / `fs.writeFile` / `fs.readFile` 三条链各自「准备 / 开始 / 完成」 |
| 7 | 汇总/评审后原始输出仍完整可查 | 已验 | 输出页保留 reasoning 历史与原始回答；评审后未覆盖 |
| 8 | 切页/切任务不中断执行 | 已验 | 执行期切到轨迹/统计再切回，任务照常到 `completed` |
| 9 | 刷新/重启恢复每模型输出与任务状态 | 已验 | 重启后：计划 3 / 3 步、两张成员卡、轨迹与统计全部重建；`KEEP_FOREVER` 保住 `plan.ready` |
| 10 | 统计页分模型 Token 与工具消耗 | 已验 | 统计页四层（任务 / 按模型 / 按工具 / 验证），工具按 `callId` 去重聚合 |
| 11 | 无 reasoning/Token 显式「未提供」 | 已验 | 成员卡与统计表 Token、思考均写「未提供」，不填 0 |
| 12 | 取消作用范围准确 | **未验** | 本轮未点取消；隔离性由用例 1 间接覆盖 |
| 13 | 只停留对话页即可知道状态/阶段/步骤/下一步/最近活动 | 已验 | 进度卡五字段齐全（含「完成态下一步」修正） |
| 14 | 任务启动即出现反馈，不等首 Token | 已验 | 提交后 1 s 内出现「理解与规划」+ 成员「准备中」 |
| 15 | 多模型并行时主任务进度同步更新 | 已验 | 并行期间进度卡「最近活动 / 正在等待」持续更新 |
| 16 | 某模型无响应时其他仍更新并标明等待对象 | **未验** | 未构造挂死成员；「正在等待：<成员>」已在 UI |
| 17 | 步骤完成/失败/重试/审批/交付在对话时间线可见 | 部分 | 步骤、审批、交付、`plan_repair` 重试（A 任务第 3 轮）均可见；「步骤失败」未构造 |
| 18 | 长等待显示等待对象与持续时长 | 已验 | 「正在等待 你审批计划 · 已等 4 分 45 秒」 |
| 19 | 切走再回对话页连续且不重复调用 | 已验 | 切任务回来仍是 3 / 3 步，未新增 `round.started` |
| 20 | 进度数字与真实 DAG 一致；无可信总量不显示百分比 | 已验 | 3 / 3 与三条 `step.completed` 一致；无计划时写「已执行 N 步」不算百分比 |
| 21 | V1 知识问答多模型独立输出回归 | **未验（真机）** | 本轮未在真机跑知识空间；`npm run verify` 内 `test:knowledge-*` 绿 |

合计：已验 15 条，部分 2 条（2、17），未验 4 条（4、12、16、21，其中 21 有单测覆盖）。

### 9.4 本轮真机暴露并修掉的问题

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 审批后整任务失败「ChatGPT 页面尚未就绪」 | 进程重启后 `planningAdapters` 为空，`adapterFor` 退回网页 adapter，报告发给未登录页面 | `OrchestratorDeps.memberAdapter` + `rebuildAdapter()`，按 `debateAgentIds[0]` 重建 CLI/Provider 适配器 |
| 2 | 报告轮失败「计划校验失败：未知的协议 type：undefined」 | 主导模型回了缺 `type` 的 JSON，直接判整轮失败 | `answerUsable()` + `askWithPeers` 换第一个可用旁听，并 emit `round.peer failed` 写明换人原因 |
| 3 | 报告轮之后「计划」整块消失、步骤退回「已执行 N 步」 | `round.started` 无条件 `plan: null`，而报告轮问的是**同一份**计划 | 只有 `user_prompt` / `plan_repair` 清计划；`execution_report` / `clarification_answer` 保留（`test:task-view` 新增 2 条） |
| 4 | 进度卡「最近活动 · round.peer」 | 直接渲染事件类型名 | `EVENT_LABEL` 换成「并行成员作答」等中文，认不出的原样保留 |
| 5 | 完成态「下一步：查看最终交付」，但交付卡没渲染 | 交付卡只在有改动/验证/评审时出现 | 进度卡新增 `hasDelivery`，无交付时指向「输出页的执行记录」 |
| 6 | 交付卡重复整段评审结论；「验证：未通过」其实三项都 skipped | 直接拼 `verdict`；`verified=false` 被当成失败 | 交付卡改为「需修复 · N 处问题（详见下方评审卡）」；三项全 skipped 时写「未执行」 |
| 7 | 「新对话」后主区域仍挂在上一条任务、输入框被它禁用，多任务并发在界面上不可达 | `startNewConversation` 没清 `activeId`，而 `disabled` 按 `activeTask` 算 | 一并清 `activeId / events / derived / clarifyText`；旧任务继续在后台跑，进「同时在跑」 |
| 8 | 统计页状态列漏出 `interrupted` | 各组件各写一份文案 | `TASK_MEMBER_STATUS_LABEL` 收进 `shared/task-stream.ts`，卡片与统计共用 |
| 9 | 轨迹页每条链都印出一个空的「失败」阶段 | 四格阶段常驻，未命中也渲染 | 只渲染真实发生的阶段；一个都没有时写「没有阶段时间，只有结果」 |

### 9.5 已知遗留（不阻塞本版本）

- **三路并行未构造**：本机只有 1 个云端 Key + 1 个 CLI。补第三个来源后按 R3 流程重跑即可，代码路径无差别。
- **限流 / 挂死成员**：需要人为制造 429 或断网；隔离逻辑有单测，真机未跑（用例 4、16）。
- **取消作用范围**（用例 12）：未点取消，靠用例 1 的独立性间接覆盖。
- **报告轮拿不到协议 JSON 时任务标 `failed`**：R5 的 A 任务即此情形（产物 `tfA.txt=hiA` 已生成，模型连改两轮仍未回协议）。当前文案「回答中没有找到可执行计划，已停止自动执行」是诚实的，但后续可考虑把报告轮收敛成「完成 / 继续」两种结构化结论，减少这类假失败。
- **两个实例重叠运行会互相覆盖 `agent-store.json`**：本轮排查中出现过一次历史任务丢失，发生在同一 userData 上两个实例重叠的窗口内（我的重启脚本与后台任务各起了一次），单实例连续重启两次未复现。产品侧只有 `requestSingleInstanceLock`，没有写锁；若要更强保证，需要给 store 加 pid 锁或版本号校验。
