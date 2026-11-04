# Phase B 实施记录：统一 Provider 抽象

对应项目书第三章、第十五章 Phase B。日期 2026-11-04。

## 先决裁决（对应审计报告第 4 节）

| 冲突 | 裁决 | 依据 |
| --- | --- | --- |
| 目录 | `src/main/providers/`，不建 `src/providers/` | ARCHITECTURE 11.9；20 个检查脚本按现有路径 import |
| 存储 | 沿用 JSON journal，不上 SQLite；辩论落库前再评估 | `store.ts` 已有注释说明 `better-sqlite3` 会把 node-gyp 拖进安装链路 |
| 综合结构 | 保留 `Claim[]`，在其上扩字段，不退化成 `string[]` | 项目书决策 6 与 9.3 要求可溯源 |
| 网页提取 | 第十章降级为「暂无输入源」 | 仓库无 Fetcher/Extractor |

## 做了什么

新增三个文件，**没有改动任何现有代码**：

- `src/main/providers/types.ts` — `ModelProvider` / `ProviderCapabilities` / `ModelRequest` / `ModelResponse` / `ProviderHealth` / `ProviderError`
- `src/main/providers/web-channel.ts` — `WebChannelProvider`，把现有 `SubAgent` 只读适配成 `ModelProvider`
- `src/main/providers/registry.ts` — `ProviderRegistry`：注册、替换、健康汇总、模型汇总

测试：`scripts/check-providers.mjs`，15 条，已接入 `npm test`（总计 193 条）。

## 与项目书 3.2 / 3.3 的差异（都是刻意的）

| 项目书写法 | 这里 | 原因 |
| --- | --- | --- |
| `supportsCancellation: boolean` | `cancellation: 'abort' \| 'give-up' \| 'none'` | 网页通道能「不等了」，不能「让它别写了」。压成 `true` 会让上层以为取消能省配额 |
| `capabilities.available` | `health().available` | 能力是静态的，可用性是那一秒的。放一起每次判断都要重取能力 |
| `ModelRegistry` 另立一份 | 不建，`registry.models()` 现取 | 模型挂在 Provider 下，另存一份就是需要同步的缓存 |
| `type: "local" \| "cloud"` | `ProviderType = 'web' \| 'local' \| 'cloud'` | 网页通道两者都不是。压成两值后，执行模式判断会把 web 误算成 cloud，而 cloud 是允许外发的档位——这正好是隐私边界上最不该模糊的一处 |
| 无 | 接口里没有 `newConversation` | 那是网页特有的生命周期，本地/云端每次请求本来就是新的 |

网页通道的能力描述刻意写成：`streaming: false`、`cancellation: 'give-up'`、`modelDiscovery: 'unknown'`、`contextTokens: null`、`usage: {input: null, output: null}`。这五项都不是「暂时没实现」，而是「网页确实不提供」——写死一个假的数字，上层的上下文切分和费用估算会跟着错，而且错得很安静。

## 验收对照（项目书 Phase B）

| 要求 | 状态 |
| --- | --- |
| 实现 Provider 接口 | ✅ |
| Provider Registry | ✅ |
| 能力描述 | ✅ |
| 统一错误模型 | ✅（`ProviderError` 带 `code`，原始错误挂 `cause`） |
| 超时与取消 | ✅（`AbortSignal` → `cancelAll` + race） |
| 保留现有 Web Channel | ✅（未改一行现有代码） |
| 现有 Web Channel 正常运行 | ✅ 已补真机回归（见下节，过程中修掉一处短问题回显） |
| 新接口不破坏原有调用流程 | ✅（尚未接线，物理上不可能影响） |
| Provider 可独立注册与检测状态 | ✅（测试覆盖） |

## 真机回归（2026-11-04 补做）

用 CDP 连到运行中的应用，走真实 `agentAPI.submitConversation`，三个已登录通道
（ChatGPT / Kimi / Gemini）各问一句 `17 乘 3`，等综合完成，再删除并双侧回读。

**第一轮**发现一处既有问题：Kimi、ChatGPT 都回了 `51`，唯独 Gemini 那条
「回答」是提问原文。查下来是 `containsEcho()` 对短提问有 40 字门槛（防短
needle 误命中），而测试题去空白后正好 39 字，差一个字没过检查，页面把提问
气泡当成了回答收下来。短问题恰恰最常见，这不是测试题的特殊性。

**修复**：`page-driver.ts` 新增导出的 `isOwnPromptEcho(candidate, sentText)`，
判据是「候选是不是提问的子集」，与长度无关；只在候选 ≥4 字时生效，避免把
`51` 这类两字答案误杀。`waitForAnswer` 在清洗之后多挡一道。新增 2 条单测
（`check-adapter.mjs` 52 条），另有一条断言把「39 字」这个边界写死，防止
以后有人顺手调门槛又把它放过去。

**第二轮**（重新构建、重启应用）：三通道全部返回 `51`，`status: answered`，
消息为 `user 1 / channel 3 / system 1 / synthesis 1`。

**清理**（用户硬性规则）：删前先读提问内容确认是本次测试题，再
`deleteConversation()`；结果 `cleaned / reset` 均含三站、`failed: []`；
应用侧会话回到 0 条、原有会话一条没动；三站网页侧 `innerText` 都不再含测试
标记。两轮都没有留下测试会话。

## 没做的

- **没有把 `WebChannelProvider` 接进 `main/index.ts`**。项目书 Phase B 的验收只要求「可注册、可检测」，接线属于 Phase E（执行模式）。现在接进去，等于在没有 Cloud 的情况下先改一遍调度路径。
- **没有实现 CloudProvider**，那是 Phase D。

## 下一步

Phase C（Ollama）已完成，见 `PHASE-C.md`。按次序下一个是 Phase D（Cloud API）。
Phase E 之前必须先定「执行模式存在 Conversation 的哪个字段」和「两份名单谁是
唯一名单」，这两条都在 `MULTI_MODEL_UPGRADE_PLAN.md` 里挂着。
