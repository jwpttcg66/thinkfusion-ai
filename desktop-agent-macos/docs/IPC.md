# IPC 接口

渲染进程拿到的能力是**枚举的**，不是通用的：`preload` 里没有 `invoke(channel, …)` 这类逃生口，也没有 `ipcRenderer` 直通。`window.agentAPI` 就是全部。

代码：`src/preload/index.ts`（暴露面）、`src/main/index.ts`（处理器）、`src/shared/contracts.ts`（`AgentApi` 类型）、`src/shared/schemas.ts`（Zod）。

## 信任检查

每个处理器第一行都是 `trustedUiSender(event)`：

1. `event.sender.id` 必须等于主窗口的 webContents id
2. 必须来自主 frame（不是内嵌页，也不是 iframe）
3. frame 的 URL 必须是 `file://` 或 dev server 的 localhost

不满足就抛 `IPC sender rejected`。这样即使内嵌的 DeepSeek 页面被注入脚本，它也调不到任何能力——它根本不在同一个 webContents 里，而且内嵌视图是 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。

参数一律按 `unknown` 接收，再用 Zod 解析。**没有"相信渲染进程"的分支。**

## 对话（主路径）

一次提问的第一站是这里，不是 `task:submit`。路由由主进程做，渲染进程不需要先知道这是问答还是文件操作。

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `conversation:submit` | `{ text, workspaceRoot?, permissionPreset? }` | `Conversation` | 立刻返回，答案通过事件流回来 |
| `conversation:followup` | `{ conversationId, text }` | `Conversation` | 追问；网页保留上下文，问题原样发出 |
| `conversation:list` | — | `Conversation[]` | 按 `updatedAt` 倒序 |
| `conversation:get` | `conversationId` | `Conversation \| null` | |
| `conversation:messages` | `conversationId` | `ConversationMessage[]` | 切换对话时重建界面 |
| `conversation:cancel` | `conversationId` | `void` | 中断当前等待 |
| `conversation:delete` | `conversationId` | `void` | 只删本地记录 |
| `channel:statuses` | — | `ChannelStatus[]` | 每个通道是否可用的原因 |

`conversation:submit` **不能**同步等回答：一个网页版 AI 的回答可能要一分钟，一个阻塞一分钟的 IPC 调用和卡死没有区别。它创建记录后立刻返回，进度通过 `conversation:event` 推。

`workspaceRoot` / `permissionPreset` 只在路由判定为 `workspace` 时才会被用到。渲染进程传它们是因为同一次提交可能落到执行链路，而不是因为问答需要工作区。

## 任务

| 通道 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `task:submit` | `SubmitPromptInput` | `AgentTask` | 创建任务并开始第一轮规划 |
| `task:get` | `taskId` | `AgentTask \| null` | |
| `task:history` | — | `AgentTask[]` | 按 `updatedAt` 倒序 |
| `task:events` | `taskId` | `AgentEvent[]` | 已持久化事件的回放，用于切换任务时重建界面 |
| `task:approve` | `ApprovePlanInput` | `void` | `approved` 必须是字面量 `true` |
| `task:reject` | `{ taskId, planId, reason? }` | `void` | |
| `task:cancel` | `taskId` | `void` | 置取消标志并中断等待 |
| `task:answer` | `{ taskId, answer }` | `void` | 回答澄清问题，开启新一轮 |
| `task:delete` | `taskId` | `void` | 只删本地记录 |

`task:approve` 的 `approved: true` 是刻意的：拒绝走单独的 `task:reject`。一个布尔开关会让"传错值"变成"批准"。

## 环境

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `permission:get` | — | `PermissionPreset` |
| `permission:set` | `PermissionPreset` | `{ preset, approvalPolicy: 'ask' }` |
| `agent:choose-directory` | — | `string \| null` |
| `app:platform` | — | `string` |
| `ax:snapshot` | — | `AccessibilitySnapshot` |

`permission:set` 回显 `approvalPolicy: 'ask'` 不是冗余：它让界面无法呈现"已关闭审批"这种状态，因为这个版本不存在这种状态。

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

`sourceId` 只能是 `shared/sources.ts` 里列出的 id；不认识的值直接抛错，不猜。

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
