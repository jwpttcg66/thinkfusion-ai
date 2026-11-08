# DeepSeek Harness 调研：借鉴什么，不依赖什么

调研对象：`github.com/deepseek-ai/deepseek-harness`（MIT，开发者预览版），本地副本 `~/data/dsh-src`，
提交 `ce7073d5`（包版本 0.2.2-alpha.2）。本机安装的 `DeepSeek Harness.app` 为 `com.deepseek.dsh` 0.2.1-rc.5。

**这份文档是参照研究，不是依赖清单。** 我们的代码里没有任何 `@deepseek-ai/*` 的 import，`dependencies` 是空的。
下面每一条的价值都在于「它验证过什么形状能用」，而不是「我们要装它」。

## 结论

v0.6.0 手写的 3740 行里，**约七成是 dsh 已经做过、而且做得更好的部分**：agent loop、工具注册与执行流水线、
计划审批、会话日志、沙箱、权限策略、持久化。继续按原来的路子自己写，等于维护一个劣化版。

但「它做得更好」不等于「我们要装它」。dsh 自称未来会有破坏兼容性的变更，而它是一个 232 MB 的 pnpm
monorepo、跑在 node ≥24.9 上、需要 cordis 插件体系。把它变成我们的运行时底座，换来的是一整条我们控制不了的
依赖链，去解决我们并不存在的问题。

**采纳设计，不采纳依赖。** 具体分三层：

| 层 | 处置 |
| --- | --- |
| 协议词汇（块类型、chunk 种类、失败码、终止原因） | **抄形状，自己定义**。`packages/llm-web-page/src/protocol.ts` |
| 分层思路（契约中立 / 适配器管 wire；工具调用逐次审批；模型可见即已记录） | **抄思路，自己实现**。指导 v0.6.0 之后的改造方向 |
| 包、进程、插件框架、构建链 | **不引入上游实现**。宿主契约只有三个成员（`host.ts`）；插件框架 2026-11-08 起自研轻量注册表，见下方修订 |

好处是具体的：改一个字段不用 fork monorepo；上游改协议我们不会跟着断；形状仍保持一致，将来真要接进
dsh，写的是十几行桥接层，不是重写。

## dsh 值得抄的设计（有据可查）

| 能力 | 位置 | 值得抄的点 |
| --- | --- | --- |
| Agent 主循环 | `packages/core/agent-loop` | 轮次/步骤语义固定：`turn/start → step → agent/request → llm/stream → tool/call → tools/execute → step/end` |
| 工具注册与流水线 | `packages/core/tools` | `tools/pre-execute` / `execute` / `post-execute` 三级瀑布事件——**审批与拦截必须挂在每一次工具调用上，而不是整批计划上** |
| 计划模式 | `packages/plan/plan-mode` | `exit_plan_mode` 提交计划：批准 / 按反馈继续规划；批准后在步骤边界停用规划模式 |
| 权限与守卫 | `packages/guard` | 超时、重复调用提醒等以独立单元挂载，而不是写进主循环 |
| 沙箱 | `packages/sandbox` | 在 spawn 之前包 argv，而不是事后检查路径（我们一直没做这一层） |
| 会话日志 | `packages/core/session` | 仅追加事件 + `deriveMessages()` 投影模型历史；「模型可见即已记录」 |
| 工具集 | `docs/tool-catalog.zh.md` | `read`/`write`/`edit`/`apply_patch`、`bash`、`glob`/`grep`、`ask_user_question`、`run_code`(PTC) |
| 程序化工具调用 | `packages/ptc-runtime` | 只向模型暴露 `run_code`，其余能力在运行时 SDK 里声明（截图里那个「PTC 模式」） |
| 桌面壳 | `apps/desktop` + `apps/desktop-host` | Electron 以 Node 模式启动 host 进程，窗口加载打包后的 Web 资源 |

## 我们的模块 → 参照对象

「处置」一列读作**我们怎么自己改**，不是「换成 dsh 的哪个包」。

| 我们 v0.6.0 | 参照 | 处置 |
| --- | --- | --- |
| `main/task-manager.ts` 状态机 | `SessionEvent` + `turn/*`、`step/*` 持久事件 | 自研：事件日志为主，状态由事件投影得出，而不是另存一份状态机 |
| `main/store.ts` JSON journal | `SessionPersistence`（JSONL，带迁移与压缩） | 自研：保留原子写，补版本号与迁移 |
| `shared/protocol.ts` 的 plan 协议 | `exit_plan_mode` + 审批 seam | 自研：协议退化为适配器内部的翻译层 |
| `orchestrator.ts` 闭环 | `agent-loop` | 自研：轮次/步骤语义对齐，去掉我们自造的状态跳转 |
| `agent/index.ts` + `policy.ts` + `verify.ts` | `tools/pre-execute` 瀑布 + 沙箱包装 | 自研：把审批从「批准整份计划」下沉到「每次工具调用」 |
| `deepseek-adapter.ts` 页面收发 | `ctx.llm` 适配器 seam | **已迁移**到 `packages/llm-web-page` |
| 三栏 UI | `apps/desktop` 的布局 | 已按截图重做，继续自研 |

## 适配器契约（已核对源码，2026-10-31 修订）

这份词汇现在由我们自己拥有（`src/protocol.ts`），形状与 dsh 的 `packages/llm/llm/src/types.ts` 一致：

```ts
interface GenerateOptions {
  provider: string; model: string;
  messages: RequestMessage[];      // 含 system 首条
  system?: string;
  tools?: ToolSchema[];            // name/description/parameters(JSON Schema)
  temperature?: number; maxTokens?: number; stop?: string[];
  signal?: AbortSignal;
}
type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
```

**上一版本文档在这里写错了三处，已按源码更正**：

1. 工具块的 `blockType` 是 `'tool-call'`，不是 `'tool_use'`（`ContentBlockMap` 的键）。
2. `block-end` 的 `block.arguments` 是**原始 JSON 字符串**，与 `argumentsDelta` 逐字节一致；不是解析后的 `input` 对象。
3. `FinishReason` 是判别联合对象：`{ kind: 'tool-calls' }` / `{ kind: 'stop' }` / `{ kind: 'max-tokens' }` / `{ kind: 'aborted' | 'error'; failure }`，不是裸字符串。`TokenUsage` 的字段是 `inputTokens` / `outputTokens`。

适配器是**抽象类**（不是接口），唯一必须实现的方法是 `stream(options): AsyncIterable<StreamChunk>`；
`providerInfo` / `listModels` / `resolveModel` 都有默认实现。我们照这个形状定义了 `LlmAdapter`。

**我们刻意只取子集**：不抄 retry policy、image pricing、`prepareCall` 的 generation 绑定。我们没有使用场景，
而抄一堆永远不跑的机制，正是「借鉴」变成「无人维护的 fork」的方式。

## 关键设计判断：不要造 `run_plan` 大工具

把整份计划塞进一个工具，审批就退化成「批准整批」，每个步骤都绕过了观察策略、沙箱包装和超时策略。
这是 v0.6.0 的弱点，不该带进新结构。正确做法是让网页回答直接翻译成**逐个** `tool-call` 块。

## 决定（2026-10-31）

1. **不产生依赖关系**：不引入 `@deepseek-ai/*` 任何包，不构建 dsh monorepo，不要求 node ≥24.9。
2. **协议词汇本地化**：`src/protocol.ts` 自己定义，形状对齐，供将来桥接。
3. **v0.6.0 自研代码保留**：作为可回退的参照实现，等新链路端到端跑通再决定下线。

## 修订（2026-11-08）：插件这件事改成自研，不装 cordis

用户裁决「所有本地能力和保存，都看齐 deepseek harness 都是插件」。这不推翻上面
「采纳设计、不采纳依赖」的结论，而是把上表里「插件框架不引入」这一格拆开：

- **不引入**的仍是 dsh 的**实现**：cordis、包、进程与构建链。
- **采用的是 dsh 的形状**：每个能力是一个插件（`run` + 登记信息 + 声明式依赖），
  宿主按 id 查表分派，注册可逆，清单可见、可单独停用。
- 自研的 `CapabilityRegistry` 只有注册、查表、执行、开关四件事，在
  `src/shared/capabilities.ts`；Runtime 与主进程各装载一半。32 个内置能力
  （29 个本地工具 + 工程证据读取 + 2 个保存动作）全部登记。
- 仍然**不开放第三方插件**，理由见 ROADMAP「明确不排期的事」。

实现与验证见 `docs/implementation/CAPABILITY_PLUGINS.md`。

## 风险

- 借鉴的是**快照**：`ce7073d5` 之后 dsh 会变。我们不会自动跟进，需要在升级时重新读一遍对照表。
- 网页 DOM 是启发式的，这点不因架构选择而消失。
- 适配器是「高延迟、无真流式」的通道：页面一次吐完整回答，delta 只能整段发；取消要映射成「停止生成」按钮。
- 抄设计时容易顺手抄进不必要的复杂度（见上「刻意只取子集」）。

## 里程碑与状态

- **M1**：适配器把网页回答翻成 `tool-call` 块，跑通一次 `read` 调用。
  **代码已完成**：`packages/llm-web-page`，69 项行为测试 + 8 项 spike 断言全过，零依赖。
  `examples/mount.mjs` 走通两轮对话（一次工具调用 + 一次总结），宿主是我们的 `InMemoryLlmRegistry`。
  **未完成**：真实登录态下的 DOM 选择器（属 M3），以及把 `WebPage` 接到 `WebContentsView`。
- **M2**：把审批下沉到每次工具调用（对齐 `tools/pre-execute` 的思路），去掉「批准整批计划」。
- **M3**：Electron 壳内嵌 DeepSeek 页面，用 `WebContentsView` 实现 `WebPage`。
  选择器从 v0.6.0 的 `src/main/deepseek-adapter.ts` 迁移，必须在真机登录态核对。
- **M4**：评估 v0.6.0 自研 loop 是否下线。
