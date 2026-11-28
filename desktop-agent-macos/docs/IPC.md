# IPC 接口

渲染进程拿到的能力是**枚举的**，不是通用的：`preload` 里没有 `invoke(channel, …)` 这类逃生口，也没有 `ipcRenderer` 直通。`window.agentAPI` 就是全部。

代码：`src/preload/index.ts`（暴露面）、`src/main/index.ts`（处理器）、`src/shared/contracts.ts`（`AgentApi` 类型）、`src/shared/schemas.ts`（Zod）。

## 信任检查

每个处理器第一行都是 `trustedUiSender(event)`：

1. `event.sender.id` 必须等于主窗口的 webContents id
2. 必须来自主 frame（不是内嵌页，也不是 iframe）
3. frame 的 URL 必须是 `file://` 或 dev server 的 localhost

不满足就抛 `IPC sender rejected`。这样即使内嵌 Web 页面被注入脚本，它也调不到任何能力——它根本不在同一个 webContents 里，而且内嵌视图是 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

参数一律按 `unknown` 接收，再用 Zod 解析。**没有"相信渲染进程"的分支。**

## 对话（主路径）

一次提问的第一站是这里，不是 `task:submit`。路由由主进程做，渲染进程不需要先知道这是问答还是文件操作。

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `conversation:submit` | `{ text, workspaceRoot?, permissionPreset?, executionConfig?, workspaceMode?, taskKindOverride? }` | `Conversation` | 立刻返回，答案通过事件流回来 |
| `conversation:followup` | `{ conversationId, text, executionConfig?, taskKindOverride? }` | `Conversation` | 追问；网页保留上下文，问题原样发出 |
| `conversation:classify` | `text` | `{ intent, reason }` | 旧五类意图的只读预览 |
| `conversation:route` | `{ text, workspaceMode, hasProject, override? }` | `TaskRouting` | V2.1：纯函数路由预览，无副作用 |
| `conversation:config` | `{ conversationId, executionConfig }` | `Conversation` | 把研究设置存到会话上 |
| `workspace:get` | — | `WorkspaceState` | 上次使用的空间与项目 |
| `workspace:set` | `{ workspaceMode?, workspaceRoot? }` | `WorkspaceState` | 写入 `workspace-state.json` |
| `conversation:list` | — | `Conversation[]` | 按 `updatedAt` 倒序 |
| `conversation:get` | `conversationId` | `Conversation \| null` | |
| `conversation:messages` | `conversationId` | `ConversationMessage[]` | 切换对话时重建界面 |
| `conversation:cancel` | `conversationId` | `void` | 中断当前等待 |
| `conversation:delete` | `conversationId` | `void` | 只删本地记录 |
| `channel:statuses` | — | `ChannelStatus[]` | 每个通道是否可用的原因 |

`conversation:submit` **不能**同步等回答：一个网页版 AI 的回答可能要一分钟，一个阻塞一分钟的 IPC 调用和卡死没有区别。它创建记录后立刻返回，进度通过 `conversation:event` 推。

`workspaceRoot` / `permissionPreset` 只在需要执行链路时被用到。V2.1 之后，工程工作空间还会把 `workspaceRoot` 存进 `Conversation`，作为这条会话绑定的项目；知识空间不要求项目，也不要求权限。

`Conversation` 新增的可选字段：`workspaceMode`、`workspaceRoot`、`routing`、`engineeringEvidence`。老会话读不到这些字段时按知识空间处理，不需要数据迁移。

## 任务

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `task:submit` | `SubmitPromptInput` | `AgentTask` | 创建任务并开始第一轮规划 |
| `task:get` | `taskId` | `AgentTask \| null` | |
| `task:history` | — | `AgentTask[]` | 按 `updatedAt` 倒序 |
| `task:events` | `taskId` | `AgentEvent[]` | 已持久化事件的回放，用于切换任务时重建界面 |
| `task:executions` | `taskId` | `ExecutionRecord[]` | 只读投影（V4 M1-1）：一次执行＝一轮，取 store 而非界面事件流 |
| `task:context` | `taskId` | `ContextStateView` | 只读投影（V4 P1 M2-3）：当前 contextId、检查点存档、副作用核对、上次重建时间与原因，全部来自既有 `context.*` 事件 |
| `task:set-budget` | `{ taskId, maxRounds?, maxModelCalls?, maxTokens? }` | `{ budget, gate, status, state }` | 追加任务预算（V4 P1 M3-3）：只收正整数、只增不减；写 `task.budget.updated`，门禁放行且任务停在 `budget_exhausted` 时走常规 `resume` 接回循环。回执的 `status` 取 **resume 之后**重读的那一份（M3-4 修）：`tasks.get()` 是那一刻的快照，先取后跑就会把「已接回」报成「仍用尽」，界面那颗按钮跟着显示错的下一步 |
| `task:continue-round` | `{ taskId, instruction }` | `{ roundId, roundNumber, fromStatus, means, gate, status }` | 换手段再来一轮（V4 P1 M3-4b）：只对 `report_pending` 与 `awaiting_next_round` 开放（M3-4c 后后者是「无人值守关掉时停的地方」），指令非空白且 ≤2000 字；不重跑 GDC 判定（重跑只会再给一次 `stop_and_wait`），但要过 M3-3 的预算门禁；写 `task.round.user_continue`，新轮 `inputType='user_continue'`，用户原话与上一轮手段清单一起进计划请求 |
| `task:set-auto-continue` | `{ taskId, autoContinue }` | `{ autoContinue, previous, status }` | 无人值守续轮开关（V4 P1 M3-4c）：只收布尔，多余键拒；`previous` 回的是**生效值**（老任务没写过该字段，缺省按「自动开」算，不返回 `undefined`）。关掉后 GDC 判定为 `open_next_round` 时停在 `awaiting_next_round`——停在 `createRound` 之前，不会留下「已发回模型」却没发的轮次，并写 `task.round.await_user`（带判定原话与预算门禁读数）；回来有两条：`task:continue-round` 开新一轮，或 `task:accept-unverified` 就地按完成收尾（这一档手里已经有报告，原来只有白烧一轮和取消两条路，见 `DELIVERY_CLOSE_STATUSES`）。开关不管预算超限、空转、待审批这些停法 |
| `task:approve` | `ApprovePlanInput` | `void` | `approved` 必须是字面量 `true`。**回执要等整轮跑完**：`orchestrator.approve()` 末尾 `await executeApprovedPlan()`（`orchestrator.ts:768`），一轮 = 计划执行 + 复验 + 报告四次模型往返，分钟级；调用方不能把它当「点下去了」的确认（M3-4 真机第 7 次就在 B 段等这条回执等到 CDP 超时）。`task:continue-round` 没有这个问题：它 `void driveRound(...)` 后立刻回执 |
| `task:reject` | `{ taskId, planId, reason? }` | `void` | |
| `task:cancel` | `taskId` | `void` | 置取消标志并中断等待 |
| `task:answer` | `{ taskId, answer }` | `void` | 回答澄清问题，开启新一轮 |
| `task:delete` | `taskId` | `void` | 只删本地记录 |

`task:approve` 的 `approved: true` 是刻意的：拒绝走单独的 `task:reject`。一个布尔开关会让"传错值"变成"批准"。

M3-4 加的三条「为什么停」事件都只有一份来源（主进程 `fail()`/停在轮次开始前那一处），界面读同一份、不自己猜：

- `task.auto_continue.updated`：`{ taskId, autoContinue, previous, source }`（`source` 恒为 `user`，这个字段没有自动改的路径）。`previous` 同样是生效值，与 `task:set-auto-continue` 的回执一致，否则刷新前后会显示成两个状态。
- `task.round.await_user`：无人值守关掉后判定仍说要开下一轮时的停痕，带 `purpose`（GDC 原话）、`reason`（判定理由）、`gate`（M3-3 门禁读数）。没有这条事件时，界面只看得出轮数不涨。
- `task.fault.stopped`：`{ taskId, roundId?, kind, error, landedStatus, headline, howBack }`。`kind` 取 `classifyFault()` 的六类（`src/shared/task-fault.ts`），`landedStatus` 是这条故障把任务停在哪儿——通道故障 `interrupted`、计划不合规或网页源没打开 `blocked`，两者都能 `task:resume`；只有确实是任务本身的错才 `failed`。用户已在暂停/取消过程中时改由 `stopIntent()` 保住用户选的结局，此时 `headline` 说的是「按已取消/已暂停收口」而不是通道那句故障。

## 环境

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `permission:get` | — | `PermissionPreset` |
| `permission:set` | `PermissionPreset` | `{ preset, approvalPolicy: 'ask' }` |
| `agent:choose-directory` | — | `string \| null` |
| `app:platform` | — | `string` |
| `ax:snapshot` | — | `AccessibilitySnapshot` |

`permission:set` 回显 `approvalPolicy` 不是冗余：它告诉界面这一档实际怎么问。
取值来自 `shared/approval.ts`：`danger-full-access` 是 `autoApprovePlan: true + stepApproval: 'off'`（计划自动批准、步骤不再逐步问），其余档是人工确认 + `mutating`。所以"已关闭审批"确实存在，只是只对完全权限档开放。

## 内嵌页面

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `deepseek:status` | — | `DeepSeekStatus` |
| `deepseek:diagnose` | `sourceId?` | `DeepSeekDiagnostics` |
| `app:sources` | — | `SourcesState` |
| `app:set-source` | `sourceId` | `SourcesState` |
| `app:view-bounds` | — | `ViewBoundsMap` |

`deepseek:diagnose` 是排查用的：逐选择器命中数、命中选择器、回答预览，以及**原生视图的真实 bounds**（`view` / `dragging`）。

视图位置只在这里能看到。页面是 `WebContentsView`，不是元素，DOM 里查不到它——它当初能盖住应用列而无人察觉，就是因为这个数字没有出口。

`app:view-bounds` 把同一件事扩到所有页面：返回每个已创建视图的 `{x,y,width,height}`，键是来源 id。它是"右缘按钮为什么点不动"的唯一诚实答案——被压住的按钮不会抛错，只是不再响应。`x` 超过窗口宽度即为"停到窗口外"，也就是隐藏但还活着的页面。

`app:set-source` 只切换"哪一页在前台"，不负责加载：视图是首次用到时才创建的，创建和首屏加载都在后台进行，所以返回值会带着 `loading: true` 立刻回来，页面真正就绪后再补一条 `sources:changed`。让按钮等一个几秒钟的加载，等于让按钮看起来是坏的。

`sourceId` 必须存在于当前 SourcesState（内置或用户配置来源）；不认识的值直接抛错，不猜。`deepseek:*` IPC 名是历史兼容命名，部分处理器现已按 `sourceId` 工作，不代表只支持 DeepSeek。

## 布局

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `app:layout` | — | `LayoutInfo` |
| `app:set-split` | `number` | `LayoutInfo` |
| `app:drag-page` | `boolean` | `void` |

`app:set-split` 传的是**建议值**，夹取在主进程（`computeSplit`）。返回的是实际生效的宽度，渲染进程必须用返回值而不是自己的请求值，否则拖动过程中两侧会漂移。传 `0` 恢复默认比例。

`app:drag-page` 只在拖动开始和结束时调用。拖动期间主进程把视图停到窗口外：macOS 按原生命中测试派发鼠标事件，视图一旦压在边界上，向右拖的第一个像素就丢了，整个手势当场失效。

## 事件流（主进程 → 渲染进程）

| 通道 | 载荷 |
| --- | --- |
| `agent:event` | `AgentEvent`（任务、轮次、计划、步骤、报告、日志） |
| `deepseek:event` | `DeepSeekEvent`（状态、发送失败） |
| `layout:changed` | `LayoutInfo` |
| `sources:changed` | `SourcesState` |
| `conversation:event` | `ConversationEvent`（创建/更新、消息、通道阶段、综合结果、失败） |

`agent:event` 在发出前会先写入事件日志，所以界面回放和实时流看到的是同一份数据。持久化失败不会中断运行中的任务——事件日志是观测手段，不是任务状态。

订阅函数都返回取消函数，`App.tsx` 在卸载时调用，避免热更新时重复订阅。
