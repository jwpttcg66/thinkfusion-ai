# 任务对话流 · 流式输出实施规格

文档角色：工程空间对话页的**实施计划**——对照参考设计的四层模型，记录已核实的代码现状、架构边界、差距和改造顺序。它不是已生效契约；本文件描述的字段与行为，须在对应阶段的实现和测试落地后才成为约束。

本版已按 2026-11-26 审核意见修订：明确事件源与投影的分层、补齐稳定身份与双状态语义、纠正 diff 数据来源、增加聚合连续性规则与流式 Markdown 约束、把子 Agent 与 TDL 概念分开。

**代码基线（V1.1 重新核对，2026-11-26）**：`main@2538104`。阶段 A/B 已落地并有单测
（A 另有 `docs/spec/evidence/stage-a/` 真机证据），本轮不重复实现；待办见 §3：
阶段 1 逐文件 Diff 数据 → C1/C2/C3/C4 → D1，D2 独立立项。真机验收以 `AGENTS.md` §10
为准（见 §5）。

> **落地进度（2026-11-26）**：
> - 阶段 A / B：`IMPLEMENTED / TESTED`，A 另有真机证据（`docs/spec/evidence/stage-a/`）。
> - 阶段 1（逐文件 Diff）：`IMPLEMENTED / TESTED`——`parseNumstat` 一次解析同时产出
>   总数与 `diffFiles`；`contracts`/`schemas` 放行；未跟踪文件导致明细不完整时标
>   `diffFilesAvailable:false`，不伪造清单。
> - C1（subtype 映射）/ C2（连续 step 聚合）/ C3a 胶囊 / C3b 变更块 / C3c 产物卡片 /
>   C4（MarkdownBody，流式降级）：`IMPLEMENTED / TESTED`，接线断言守住渲染层真的调用；
>   真机冒烟见 `docs/spec/evidence/stage-c/`（样本未触发 diff/表格数据，边界如实记录）。
> - **未做**：D1 子 Agent 卡片（`code.team.run` 数据够，但投影层未抽 `kind:'agent'`）；
>   D2 并行对话浮层（独立立项）。
> - `npm run typecheck` / `npm run build` 通过，`test:task-conversation` 55 条全绿。
> 实现状态以 [STATUS](../implementation/STATUS.md) 为准，
> 本节行号是写作时的工作树快照，实施时按实际文件核对。

对照来源：2026-11-26 的六个界面截图（已完成态、执行中态、富文本态、diff 胶囊、侧边浮层、文件变更块与交付产物）。核心结论：所谓「流式输出」不是字符逐个吐出，而是**一棵带类型的事件树，通过三条更新轨道持续演进**。

相关：[长任务 UI](LONG_TASK_CONTEXT_UI.md) · [对话流投影实现](../../desktop-agent-macos/src/shared/task-conversation.ts) · [对话组件](../../desktop-agent-macos/src/renderer/src/components/engineering/TaskConversation.tsx)

## 1. 模型：一条事件源，三轨投影

最重要的架构决策先写死：

> **底层事件保持可追溯，中间投影支持三轨演进，UI 根据类型和状态呈现。**

### 1.1 三层边界

| 层 | 职责 | 关键性质 |
| --- | --- | --- |
| **事件源** | Append-only Event Journal：每次工具执行、文件变化、模型输出、状态变化都保留真实事件 | 只追加，不修改、不删除 |
| **投影** | `Conversation Projection`：从事件源构建主流 / 并行浮层 / 会话聚合三类条目 | 可重复计算，不依赖 UI 内存状态 |
| **呈现** | UI 按 `(类型 × 状态)` 与轨道类型决定折叠、计时、计数、胶囊 | 不持有业务状态 |

**in-place update 只发生在投影层，绝不修改底层历史事件。**

以**会话聚合胶囊**为例：第一次报告 `15 个文件已修改 +1,025 / -320`，第二次 `18 个文件已修改 +1,253 / -390`。UI 里是同一个聚合条目被改写，但事件源里两次真实事件都保留，且都能单独查到。注意这与第六张图的「文件变更块」是两个不同元素（见 2.5），不要把后者当成本例的展开态。

### 1.2 四层模型（投影与呈现的内部结构）

| 层 | 含义 | 参考设计里的形态 |
| --- | --- | --- |
| 载荷层 | 块带语义类型，不是纯文本 | 文本、思考、工具、子 Agent、授权、系统事件 |
| 状态层 | 呈现状态横切所有块，业务状态原样保留 | `pending → running → completed / failed`，另有 `skipped / cancelled` |
| 组织层 | 三条轨道的更新方式不同 | 主流按序追加；侧栏独立挂载；聚合项原地改写 |
| 呈现层 | UI 只按 `(类型 × 状态)` 决定呈现 | 折叠、计时、状态色、计数合并、胶囊 |

- **时间轴主流**：append-only，每个节点有生命周期；
- **侧边浮层**：并行对话线，不打断主流也不占主流位置；
- **会话聚合**：in-place update，同一节点被改写，不产生新消息，也**不改变它的时间轴位置**。

### 1.3 聚合条目的身份与顺序

新增 `AggregateEntry` 显式字段，聚合归属和顺序不靠猜：

```ts
interface AggregateEntry {
  aggregateKey: string;    // 决定是否属于同一聚合项
  firstEventId: string;    // 起算事件
  lastEventId: string;     // 最近一次更新事件
  firstAt: number;         // 决定时间轴位置，永不改写
  updatedAt: number;       // 仅表示最近更新时间
}
```

规则：`updatedAt` 更新**不得**让条目重新排序到时间轴末尾；位置只由 `firstAt` 决定。

### 1.4 与 V3 架构的边界

本任务属于 **UI 对话流投影专项**，不是业务执行引擎。`TaskConversation` 是各模块的统一呈现层：

| V3 现有模块 | 对话流负责展示 | 不重新实现 |
| --- | --- | --- |
| Goal / GDC | 目标、阶段、循环决策 | Goal 状态机 |
| TDL | 任务分解、进度、子任务 | WorkTask 管理 |
| ECO | 上下文采集、上下文状态 | 工程资源读取 |
| DMOCA | 模型参与、角色、贡献 | 模型调度 |
| Collaboration Engine | 辩论、审核、结论 | 辩论和审核逻辑 |
| AgentOrchestrator | 执行步骤、工具调用 | 工具执行 |
| Journal | 事件来源 | 第二套事件日志 |

本任务与《架构一致性整改实施任务书》属于**不同层级**：前者是工程空间对话流 UI 投影专项，后者是 V3 核心协作架构整改。二者衔接但**不合并成一个巨大改造任务**。

## 2. 代码现状（已核实）

以下行号对应当前工作树，实施时以实际文件为准。

### 2.1 载荷层：齐全但内聚不足

`ConversationEntry` 有 10 种 kind（`user / note / member / step / plan / debate / verification / review / bridge / conclusion`），比参考的 6 种更丰富。问题有三：

1. `note` 是大杂烩：上下文、任务分解、模型参与、循环决策、目标符合度、澄清回答全部塞进同一个 `text + detail` 结构，生成点遍布 `task-conversation.ts:641, 885, 900, 916, 934, 953, 973, 995, 1009, 1100`。呈现层靠 `noteEmphasis`（`TaskConversation.tsx:265`）的前缀正则分辨轻重，仍需靠 `startsWith` 判类型。
2. 正文一律 `<pre>` 纯文本（`TaskConversation.tsx:160, 365, 373`）。项目已有 `MarkdownBody.tsx:83-84` 和 `.md-table` 样式（`style.css:4678-4714`），但对话流未接入——参考图里的落点表格画不出来。
3. `code.team.run` 只是一个 step（`execution-timeline.ts:68`），没有独立子 Agent 卡片块。

### 2.2 状态层：各自定义，没有横切

- `StepStatus` 五态 `preparing / waiting / running / completed / failed`（`execution-timeline.ts:10`），`StepCard` 还带 `approval / risk / durationMs`；
- `member` 四态（streaming/completed/failed/cancelled）、`debate` 四态（running/completed/stopped/skipped）；
- `note / plan / bridge / verification / review / conclusion` **只有 `tone`，没有 `status`**；
- 呈现层按 kind 写死分支（`TaskConversation.tsx:472-580`），不是 `(类型 × 状态)` 驱动。

各业务状态**不等价**：`debate.stopped` ≠ `debate.skipped`，`member.cancelled` ≠ `failed`。统一状态只能用于呈现，不能覆盖业务语义。

计时方面：`step.started` 已写 `startedAt`（`execution-timeline.ts:345`），`completed/failed` 写 `durationMs`，老事件用起止补（`execution-timeline.ts:423-426`）。**运行中**的步骤原先界面没用 `now - startedAt`——参考图「正在执行中 · 8秒」在 step 上看不到。这一条已在阶段 A 修掉：`stepElapsedMs` + `liveElapsedText` 出「执行中 · 8 秒」，`needsLiveTimer` 把「有步骤在跑」也算进每秒重画条件；计时仍只在 UI 现算，不写回 Journal。

### 2.3 组织层：主流已有，另两轨缺失

- **主流**：`buildTaskConversation` 按 `at` 排序，✅ 已具备。
- **定位轨**：`buildStreamLandmarks`（`task-conversation.ts:1394`）和 `wrapAnchor` 的 `data-stream-anchor`（`TaskConversation.tsx:272-283`）早已写好，但**渲染层原先没有调用方**；阶段 A 已把 `LocateRail` 接上（只调 `buildStreamLandmarks` / `landmarkTone` / `activeLandmarkId` / `shouldShowLandmarkRail`，高亮由 IntersectionObserver 收集可视锚点后交给纯函数算）。CSS 里 `.chat-locate-track`（连续竖轨）是**刻意** `display: none`，注释写明「定位只靠节点短记」，接线时恢复的是短记列表，不是那条竖轨。另有 `UserMsgLocateRail.tsx` 基于 `[data-user-msg]` 自算短杠，服务普通会话历史提问，与 StreamLandmark 无关，不要混改。
- **会话聚合**：完全没有。`ExecutionReport` 只有 `changedFiles: number` 与 `changedPaths?: string[]`（`contracts.ts:1701-1702`），**没有 insertions / deletions / diff 字段**。

**已纠正的技术错误**：`diffStats()` 的签名是 `diffStats(hunks: readonly UnifiedHunk[])`（`unified-diff.ts:114`），输入是补丁 hunk 数组，**不是文件路径数组**。从 `changedPaths` 调 `diffStats()` 算增删行数不成立；文件路径本身不含增删信息。

### 2.4 呈现层：基础够用，缺三种能力

已有：`<details>` 折叠、`.chat-step-dot` 四色状态点（`style.css:6783-6786`）、`.chat-stream-badge` 999px 胶囊（`style.css:6608`）、`.spinner`、`.pill` 状态色。

缺：
- **计数合并**：每个 step 单独一张 `<details>`（`TaskConversation.tsx:393-426`），没有「执行工具 12次，其中 1次失败」这种聚合行；
- **diff 胶囊＋文件变更块**：都无等价组件；两者是**不同的 UI 元素**，见 2.5 与 C3a/C3b；
- **富文本渲染**：见 2.1。

### 2.5 文件变更块与交付产物（第六张图，2026-11-26 补充）

**先纠正一处误读**：这张图不是「胶囊的展开态」。它是一个**独立的文件变更块**——
聊天流里一条带外框的完整卡片，自带标题、总数、逐文件列表、动作按钮和收起入口；
而第四张图那个「15 个文件已修改 +1,025 -8」是**会话聚合胶囊**，inline 压缩计数、原地改写。
两者形态不同、出现位置不同、生命周期不同，**不假定是同一组件的两种状态**，分别按 C3b / C3a 实现。

文件变更块（图中主体）：

- 卡片头：图标 + 标题「已编辑 8 个文件」，下一行汇总 `+38` / `-38`（绿 / 红）；
  右侧「审阅」按钮（独立动作入口）；
- 每个文件一行：完整路径 + 该文件自己的 `+N` / `-M`（如 `BilliardShellJson.java +1 -1`、
  `32-匹配入口设计交付实施验证.md +29 -29`）；路径过长时尾部省略，hover 应能看全；
- 底部「收起文件 ⌃」；
- 上方两张 MD 文件卡片：文件名 + `MD` 类型标签 + `···` 菜单，图标带 `M↓` 角标。

**当前代码差距**：`diff-stats.ts` 的 `parseNumstat` 已经逐行解析出「增 / 删 / 路径」，
但 `NumstatTotal` 只累加总数，`detail` 只存命令说明——**逐文件明细被丢了**。
所以 B3 的「全局 +38 / -38」能画，块内「每个文件 +1 -1」画不出来。
交付文件卡片则对应 `conclusion.deliverables`，当前是纯文本列表，没有卡片样式。

## 3. 改造顺序

按依赖和风险排列，每阶段独立可验收。**先接线、再补数据、后改呈现**；D1 提前到 C 之后，D2 独立立项最后做。

### 阶段 A · 恢复现有能力（零数据改动，低风险）

> **状态（2026-11-26）：A1 / A2 已接线，`IMPLEMENTED / TESTED / VERIFIED`。**
> 判断逻辑全部收进 `shared/task-conversation.ts` 的纯函数，渲染层只调用：
> `buildStreamLandmarks` / `landmarkTone` / `streamAnchorId` / `activeLandmarkId` /
> `shouldShowLandmarkRail` / `stepElapsedMs` / `liveElapsedText` / `needsLiveTimer`。
> 测试入口 `npm run test:task-conversation`（当前 48 条，其中 7 条是这批接口、
> 1 条守住「渲染层真的调了」）。真机证据在 `docs/spec/evidence/stage-a/`：
> `01/02` 执行中秒数、`04` 定位轨跳转，见该目录 `EVIDENCE.md`。

**A1 定位轨接线**
- 渲染层调用 `buildStreamLandmarks(entries)`，消费已有的 `data-stream-anchor` 做跳转；
- 锚点必须**稳定**：以 `entry.key` 为身份，禁止用数组下标；投影重算后同一条目的锚点不变；
- 接线的是短记列表（`.chat-locate-list` / `.chat-locate-tick`）；`.chat-locate-track` 那条连续竖轨
  保持隐藏，不要为了让轨道「看起来完整」把它放回来；
- 不改 `UserMsgLocateRail.tsx`，它服务的是普通会话；
- `scripts/check-task-conversation.mjs:1065` 已有地标断言，先跑通再加渲染断言。

**A2 步骤执行中计时**
- `StepMessage`（`TaskConversation.tsx:393`）在 `card.status === 'running'` 时用 `now - card.startedAt` 显示「执行中 · N 秒」，复用 member 的 `elapsedText`；
- `TaskConversation` 的秒级 timer 目前只在 `hasLive` 时启动（`TaskConversation.tsx:457-461`），需把「有 running 步骤」也纳入触发条件；
- 计时只在 UI 现算，不写 Journal。

验收：`npm run test:task-conversation` 通过；真机截图能看到定位轨和执行中秒数。

### 阶段 B · 补齐数据契约（向后兼容）

> **状态（2026-11-26）：B1 / B2 / B3 数据层已落地，`IMPLEMENTED / TESTED`。**
> 单测在 `npm run test:task-conversation`（48 条，其中 B 组 6 条）。
> **与下面草案的两处偏离，都是实测后改的：**
> 1. 统一状态字段叫 **`conversationStatus`**，不叫 `status`。`member.status` /
>    `debate.status` 本身就是业务状态，改名会波及 24 处读取，还会把
>    `debate.stopped` 顺手写成 `completed`。语义与 §1.3 要求一致：统一状态只做呈现，
>    业务状态原文保留。
> 2. 聚合条目落在 `note` 上：`{ subtype:'diff', aggregate:{…}, diff:{…} }`。
>    胶囊/变更块样式属于 C3，**这一步不渲染占位行**（`TaskConversation` 里直接跳过），
>    免得先出现一条半成品纯文本。

**B1 稳定身份 + 统一状态**
```ts
type ConversationStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

// 对外条目 = 投影条目 + 这两个字段（normalizeEntries 统一补齐）
type ConversationEntryView = ConversationEntry & {
  id: string;                    // 与 key 同源，重复时确定性加 `#2`
  conversationStatus: ConversationStatus;
};
```
- 业务状态原样保留在各自字段，如 `{ kind:'debate', status:'stopped', conversationStatus:'cancelled' }`；
- `id` 来源是既有 `key`（事件内容决定），不是数组下标；重算投影两次结果一致；
- 状态从旧事件推导：step 的 preparing/waiting→pending，member 的 streaming→running，
  debate 的 stopped→cancelled（`stopped ≠ completed`）；呈现层本阶段不切换，B1 无 UI 变化。

**B2 Note subtype**
- 给 `note` 加 `subtype` 字面量（context / breakdown / participation / decision / goal-fit / clarification / system 等），在生成点直接标注；
- 呈现层仍可用 `noteEmphasis`，但新代码禁止再靠 `text.startsWith` 判类型。

**B3 Aggregate 与 Diff 数据**
- `ExecutionReport` 增加可选字段：
```ts
interface ExecutionReport {
  changedFiles: number;
  changedPaths?: string[];
  insertions?: number;
  deletions?: number;
  diffAvailable?: boolean;
}
```
- **数据采集发生在执行报告形成阶段**：读取真实 git diff 或由工具结果提供真实统计；投影层 `buildTaskConversation` 只消费已有数据，**不得反复读 Git 或现算 diff**；
- 展示规则：有真实统计显示 `+1253 / -390`；只有路径只显示文件数；没有修改报告不显示胶囊/变更块；diff 获取失败显示「统计不可用」，不显示 0；
- 逐文件明细（`diffFiles`）与总数在同一次 numstat 解析里产出，不新增命令；文件变更块的每个 `+N / -M` 必须取这份明细；
- `AggregateEntry` 用 1.3 的字段，`aggregateKey` 决定归属，`firstAt` 决定位置，`updatedAt` 只表示最近更新；照抄 `upsertDebate`（`task-conversation.ts:551`）的 Map 原地更新模式，同一 key 只留最新一条且不挪位置；
- 投影必须是纯函数：重算后聚合结果一致，不依赖仅存在于 UI 内存的状态。

**已落地（2026-11-26）**：
- 采集：`main/engineering/diff-stats.ts`。`Orchestrator` 在 `runPlan` 返回、`insertReport`
  之前调 `collectDiffStats`（`git diff --numstat HEAD`，无 HEAD 退回工作区 diff），
  二进制记数跳过，失败只标 `diffAvailable:false`。命令执行器是注入的，纯逻辑可单测。
- 契约：`ExecutionReport.verification` 增 `insertions? / deletions? / diffAvailable?`，
  `schemas.ts` 的 `.strict()` 同步放行（老报告缺字段仍通过）。
- 投影：`diffSummaryOf` + `diffText` 三种文案（真数字 / 统计不可用 / 只有文件数），
  报告事件按 `aggregateKey:'diff'` 原地改写，`at` 恒等于 `firstAt`。
- 渲染（本轮补）：有完整 `diffFiles` → C3b 独立变更块；只有汇总/统计不可用 → C3a 胶囊；
  两者是独立组件，变更块不是胶囊的展开态。产物路径进 C3c 交付卡片。

**阶段 1（本轮新增，逐文件明细）**：
- `NumstatTotal.files: DiffFileStat[]`——`parseNumstat` 一次遍历同时产出总数与逐文件，
  行数之和恒等于总数；路径按 tab 切分，含空格路径整段保留；二进制 `binary:true`、行数 0。
- `filesComplete(files, changedPaths)`：报告清单里有路径没出现在 numstat 里
  （典型：未跟踪文件）就标 `filesAvailable:false`，不伪造清单；老报告无 changedPaths 时
  以 numstat 本身为准。
- `ExecutionReport.verification` 增 `diffFiles? / diffFilesAvailable?`，`schemas.ts` 放行；
  投影 `DiffSummary.fileStats / filesAvailable` 透传，明细不完整不出 `fileStats`。

验收：55 条单测覆盖新字段、逐文件之和=总数、未跟踪文件不伪造、旧事件兼容、
聚合位置不变、投影可重复计算；真机见 `docs/spec/evidence/stage-c/`。

### 阶段 C · 呈现层改造（保持原始输出与历史事件不变）

> **状态（2026-11-26）：C1 / C2 / C3a / C3b / C3c / C4 已落地，`IMPLEMENTED / TESTED`。**
> 真机冒烟见 `docs/spec/evidence/stage-c/`；本轮任务样本未触发 diff 改动与 Markdown 表格，
> 相关边界在该证据里如实标注，未冒充已验证。

**C1 类型 × 状态驱动**
呈现层改为按 `(kind × status)` 选样式，替换 `TaskConversation.tsx:472-580` 的一长串 if；`noteEmphasis` 前缀正则退为兼容兜底。统一状态不得丢失原业务状态。

**C2 Step 聚合的连续性规则**
连续 step 压成「执行工具 N 次，其中 M 次失败」一行，但必须满足全部条件：
- 同一任务或同一执行批次；
- 相同或兼容的 step 类型；
- 时间轴上连续；
- 中间**没有**用户消息、重要结论、审批事件等需要保留的节点；
- 不跨越不同 Cycle 或不同子任务。

失败输出保留必须**写入测试**，不能只靠 UI 约定：
```
执行工具 4 次，其中 1 次失败
  ├── 读取文件 ✓
  ├── 执行搜索 ✓
  ├── 运行测试 ✗
  │     └── 展开查看真实 stdout / stderr
  └── 读取配置 ✓
```

**C3 拆成三个独立元素**，分别对应不同的 UI 元素和轨道，不互相冒充：

**C3a 会话聚合胶囊**（第四张图）
会话聚合轨的 inline 压缩计数：转圈图标 + `N 个文件已修改` + `+绿 / -红`，独立 ⌄ 展开入口；
沿用 `.chat-stream-badge` 的 999px 基础；数字只来自 B3 的真实数据；原地改写、不追加消息、
不因 `updatedAt` 重排位置。它只承载汇总数，**不展示逐文件明细**。

**C3b 文件变更块**（第六张图，不是胶囊、也不是 C3a 的展开态）
聊天流里一条独立卡片，按 `aggregateKey:'diff'` 的聚合条目渲染：

```
┌ 已编辑 8 个文件                    [审阅] ┐
│ +38  -38                                  │
├───────────────────────────────────────────┤
│ .../billiard/BilliardShellJson.java  +1 -1 │
│ .../billiard/ShellSnapshot.java      +1 -1 │
│ .../BilliardShellJsonTest.java       +3 -3 │
│ .../32-匹配入口设计交付实施验证.md  +29 -29 │
│ 收起文件 ⌃                                │
└───────────────────────────────────────────┘
```

- 标题用**文件数**，总数单独一行 `+绿 / -红`；两者都来自真实 numstat；
- 每个文件行的 `+N / -M` 必须来自 B3 新增的逐文件明细，**不能按总数平均分配**；
  路径过长省略尾部，但保留文件名与可访问的完整路径；
- 「审阅」是独立动作入口，本阶段只预留按钮与 IPC 契约，具体审阅面板另行定义——
  不要为了凑齐形态塞一个空面板；
- 「收起文件 ⌃」只折叠卡片本身，不改聚合条目、不回退到胶囊、不写 Journal；
- C3a 与 C3b 是否同时出现、如何布局，由实施时按真实条目决定；规格只要求各自数据正确、语义独立。

**C3c 交付产物卡片**（第六张图上方两张）：`conclusion.deliverables` 从纯文本列表改为文件卡片——
文件名 + 类型标签 + 操作菜单；点击打开真实文件，没有文件就不出卡片。

**B3 需补的逐文件字段**（沿用 `git diff --numstat` 已有的解析结果，不新增命令）：

```ts
interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary?: boolean;
}
// ExecutionReport.verification 增加 diffFiles?: DiffFileStat[]
```

`parseNumstat` 改为同时返回 `files: DiffFileStat[]`，`NumstatTotal` 的累加逻辑不变；
失败依旧 `available:false`，不填 0。投影层只透传，不重算。

**C4 流式 Markdown**
对话流正文接 `MarkdownBody`，约束：
- 允许流式阶段的不完整 Markdown；未闭合代码块不得让组件崩溃；
- 表格未完成时允许临时降级显示，流式结束后再完整排版；
- 批量刷新，不要每收到一个字符就对整段做昂贵完整渲染；复用现有流式更新机制；
- Markdown 渲染不得改变用户原始输入或模型原始输出（套话回显的坑：套话越长越难从转录里剥掉）；
- 保留安全过滤，接入富文本不得允许任意 HTML 执行。

验收：`npm run test:task-conversation` + 真机 CDP 逐条对照截图；C2 必须验证失败步骤展开后仍有真实输出；C3b 必须验证文件变更块逐文件数字之和等于汇总总数、收起不改聚合条目，C3a 必须验证胶囊原地更新不改位置，两者不得互相冒充；C4 必须验证半截表格不崩溃且原文不丢。

### 阶段 D1 · 子 Agent 卡片（C 之后立即做）

**概念不能混**：WorkTask 是用户目标下的工作单元，Agent 是执行主体，AgentRun 是某 Agent 的一次运行，ConversationEntry 是 UI 展示内容。代码现状只有 `WorkTask.agentTaskId`（`task-decomposition.ts:34-65`），**尚无 AgentRun 类型**——不为卡片新造一套身份，引用真实 `agentTaskId` 或现有执行标识即可。

卡片展示：Agent 名称、承担任务、当前状态、开始时间、耗时、真实输出、对应 WorkTask（如果存在）。没有真实数据就不出卡片，不把普通 `code.team.run` step 改个名字冒充。

### 阶段 D2 · 并行对话浮层（独立专项，最后做）

涉及 App 层面板、状态管理、并行消息和中断交互（`App.tsx:2448-2469` 目前是 `chat | trajectory | stats` 单面板切换）。单独立项，不与 A–D1 捆绑。

## 4. 不变量与验收要求

沿用原有五条：

1. **只画发生过的事**：没有事件不出块，没有报告不出胶囊/变更块，没有结论文本就写「没有给出结论文本」。
2. **单源不伪造交叉验证**：所有改造不改变辩论单源自辩的既有口径。
3. **新一轮不清空上一轮**：成员按 `roundId + memberId` 累积，聚合条原地更新不等于删除历史条目。
4. **步骤输出不丢**：折叠只改呈现，`chat-step-output` 的真实 stdout/stderr 必须可展开看到。
5. **原话逐字发送**：任何展示层改动都不得往用户问题里加角色行、引导语、挑战话术。

按审核意见新增十条：

6. 聚合更新只改变投影，不修改底层历史事件。
7. 聚合条目更新后保持原始时间轴位置（由 `firstAt` 决定，不受 `updatedAt` 影响）。
8. 所有条目具有稳定 ID，不依赖数组下标作为身份。
9. 统一状态不能丢失原业务状态（如 `stopped` 不能被 `completed` 吞掉）。
10. 运行中计时不能依赖频繁写入 Journal，由 UI 现算。
11. diff 数字必须来源于真实 diff 或执行报告，不从路径数组推算。
12. 子 Agent 卡片必须引用真实执行主体和运行记录，不伪造。
13. Markdown 渲染不能改变用户原始输入或模型原始输出。
14. 不完整流式内容必须能够安全渲染。
15. 重新构建 Conversation Projection 后聚合结果必须可重复计算，不依赖仅存在于 UI 内存的状态。
16. 文件变更块的逐文件增删之和必须等于其汇总总数；两者同源，不允许各自计算；它不依赖胶囊存在。
17. 产物卡片只展示真实交付文件，点击必须能打开对应文件；胶囊原地更新与变更块收起都不改事件、不写 Journal。
18. 会话聚合胶囊与文件变更块是两个独立 UI 元素：前者 inline 压缩计数、原地改写；后者是带逐文件明细的独立卡片。不得把变更块实现成胶囊的展开态，也不得用胶囊替代变更块。

**特别防止三种错误**：
- 把聚合更新做成历史事件覆盖；
- 把 UI 展示状态变成第二套业务状态机；
- 把模型输出和执行记录混合成无法追溯的纯文本。

## 5. 禁区

- 不改 `shared/verification-evidence.ts` 与 `debate/judges.ts`：会让 `quality.ts:79` 的 `recomputable` 翻红历史辩论。
- 不重启「全量回归」概念；验收用单测 + 针对具体改动的真机 CDP 复验。
- 不动 `UserMsgLocateRail.tsx`（普通会话定位，与工程流无关）。
- 不把本任务与《架构一致性整改实施任务书》合并。
- **真机验收服从 `AGENTS.md` §10.2**（权威规则，优先于任何旧验收脚本）：默认只用一套数据目录
  （`~/Library/Application Support/thinkfusion-ai`），**禁止**设置 `THINKFUSION_USER_DATA`、
  禁止复制用户数据做隔离、禁止 `--user-data-dir` 另开副本。需要独占窗口时先停现有实例，
  启动前向用户说明会中断当前窗口。只有用户明确要求隔离且知情同意时才用隔离目录，
  用完立即删除。旧的隔离式验收脚本（含 sha256 断言）不得默认运行。
- 真机走 `AGENTS.md` §10.3 的 Run 配置（ThinkFusion Dev / `npm run dev:local`），
  不在对话 shell 里另起 Electron 实例（单实例锁会干扰主进程）。截图与 CDP 结果留存证据目录。

## 6. 测试入口

```bash
npm run typecheck
npm run test:task-conversation   # build:test + node --test scripts/check-task-conversation.mjs
```

阶段 A/C 另需真机 CDP 复验，证据留存路径由实施时按当次任务编号确定。
