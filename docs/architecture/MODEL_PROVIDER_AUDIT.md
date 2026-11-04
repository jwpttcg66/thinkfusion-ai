# 模型 Provider 层审计（Phase A）

审计日期 2026-11-04。路径相对 `desktop-agent-macos/`。

## 结论先说

项目书第三章想引入的 `ModelProvider`，**仓库里已经有一个承担了同样职责的
接口**：`SubAgent` / `SubAgentPool`。它不是「网页特有的一层」，而是完整的
模型来源抽象——只是名字里带 Agent，且只实现了网页这一种来源。

所以 Phase B 做的是**适配**，不是从零造接口，更不是替换。Phase E 的接线
只需要让 `MasterAgent` 从一份能同时容纳 Web / Local / Cloud 的名单里取成员，
现有并发和失败隔离逻辑可以整段保留。

## 现有接口

`src/main/agents/types.ts`

| 位置 | 定义 | 职责 |
| --- | --- | --- |
| `:53` | `SubAgent` | 单个模型来源：`health()` `:58`、`ask()` `:59`、`cancel()` `:69` |
| `:35` | `SubAgentTask` | 输入：`question`、`stage`（initial / followup / challenge）、`timeoutMs` |
| `:49` | `SubAgentAnswer` | 输出：继承 `AdapterAnswer`，带 `agentId`、`text`、`receivedAt` |
| `:80` | `SubAgentPool` | 名单与分发：`all()` `:82`、`available()` `:83`、`ask()` `:84`、`newConversation()` `:85`、`deleteConversation()` `:87`、`cancel()` `:88` |

`src/main/agents/registry.ts:32` 的 `SubAgentRegistry implements SubAgentPool`：
`replaceAll()` `:53`（设置里开关站点后换整份名单但保留实例）、
`statuses()` `:66`（`Promise.all` 并发探活）、`available()` `:88`、
`ask()` `:94`、`cancel()` `:108`、`cancelAll()` `:113`。

`src/main/agents/provider-agent.ts:22` 的 `ProviderSubAgent` 是**唯一实现**：
把 `BrowserAdapter` 包成 `SubAgent`。`ask()` `:53` 直接转给 adapter，
`health()` `:42` 转 `status()`，`newConversation()` `:72` / `deleteConversation()`
`:77` 是网页特有的会话生命周期。`normalizeAnswer()` `:99` 在这里清页面壳。

## 调度层

`src/main/master-agent.ts:104` 的 `MasterAgent` 只有一个方法
`research()` `:107`，做四件事：

1. 向 `SubAgentPool` 取可用成员；
2. `:189` 用 `Promise.all` 同时问所有成员，**逐通道隔离失败**
   （`ChannelOutcome` 在 `:70`）；
3. `:153` 把收到的回答交给 `synthesize()`；
4. 通过 `ResearchSink` 把阶段、答案、状态写回 `ConversationRunner`。

没有重试、没有按意图选通道、没有提示词包装。原问题原样发出这一条是用户的
硬性规则，见项目记忆；不要在这里「顺手加个系统提示」。

`src/main/index.ts:261` 建 `SubAgentRegistry`，`:290` 为每个来源建
`ProviderSubAgent`；`conversation-runner.ts:337` 在每轮研究里 `new MasterAgent(registry)`。

## 与项目书 3.2 / 3.3 的逐项对照

| 项目书 | 现状 | 处理 |
| --- | --- | --- |
| `listModels()` | 无 | Phase B 已加，网页通道返回「默认模型」占位，`contextTokens: null` |
| `getCapabilities(modelId)` | 无 | Phase B 简化为 `capabilities()`（provider 级）；网页通道如实写 `streaming:false`、`cancellation:'give-up'`、`maxConcurrency:1` |
| `generate(request, signal)` | `SubAgent.ask(task)` | 语义一致，只是没有 `AbortSignal`（现在用 `cancel(requestId)`） |
| `stream()` | 无 | 网页通道不支持，接口设为可选、不实现 |
| `healthCheck()` | `SubAgent.health()` | 一致 |
| `supportsCancellation: boolean` | 无 | 改成三态 `'abort' / 'give-up' / 'none'`，网页是 `give-up` |
| `available` 放 capabilities | 无 | 挪到 `health()`：能力静态、可用性动态 |
| `maxContextTokens` | 无 | 网页写 `null`，不编 8192 |
| `ModelRegistry` 另立一份 | 无 | 不建，`ProviderRegistry.models()` 现取 |

理由都写在 `src/main/providers/types.ts` 头部和
`docs/implementation/PHASE-B.md`。

## 哪些逻辑将来要挪，哪些不要

**要挪（到 Phase E 的选人逻辑）**：`MasterAgent.research()` 里「取所有可用成员」
这一步换成按 `ConversationExecutionConfig` 过滤。其余三件事不动。

**不要挪**：

- `SubAgentRegistry.replaceAll` 的语义（开关站点后保留实例）——Phase E 的
  Provider 名单会面对同样的问题。
- `ChannelOutcome` 的逐通道失败隔离——本地模型挂掉不能拖垮网页通道。
- `ResearchSink` 的事件口径——UI 已经按它渲染，换 Provider 不该换事件。
- `newConversation` / `deleteConversation`——这两个是网页特有生命周期，
  统一接口里刻意没有它们（Phase B 已确认）。

## Phase C 之后的新增

`src/main/providers/ollama.ts` 的 `OllamaProvider` 是第一个真正独立于网页的
实现，`src/main/providers/local-admission.ts` 管本地并发。两者都**没注册进
`main/index.ts`**，也不被 `MasterAgent` 引用——接线属于 Phase E。

`ProviderRegistry`（`src/main/providers/registry.ts:14`）与
`SubAgentRegistry`（`src/main/agents/registry.ts:32`）目前是两份互不引用的名单。
Phase E 必须定清「谁是唯一名单」，否则会出现「设置里关掉的模型还在回答」。
