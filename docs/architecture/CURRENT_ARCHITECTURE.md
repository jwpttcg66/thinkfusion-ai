# 当前架构（Phase A 审计）

审计日期 2026-11-04。基线 `main@88c27d6` 切出的 `0.1.0`，Phase B 已提交。
所有路径相对 `desktop-agent-macos/`，行号按审计时的文件。

这份文档只写**代码里真实存在的东西**。项目书第十章说的「网页内容提取流程」
不在这里，因为仓库里没有对应实现，见 `WEB_CHANNEL_AUDIT.md` 最后一节。

## 进程与窗口

| 层 | 入口 | 职责 |
| --- | --- | --- |
| main | `src/main/index.ts`（1638 行） | 窗口、IPC、WebContentsView、所有业务逻辑 |
| preload | `src/preload/index.ts` | `contextBridge` 暴露 `agentAPI`，逐条 `ipcRenderer.invoke` |
| renderer | `src/renderer/src/App.tsx` + `components/` | React 界面，只通过 `agentAPI` 读写 |
| 内嵌页面 | 每通道一个 `WebContentsView` | `persist:<sourceId>` 独立分区，登录态持久 |

关键装配位置：`src/main/index.ts:261`（`SubAgentRegistry`）、`:290`
（`new ProviderSubAgent`）、`:206`（`createElectronDriver`）、`:1573`
（`AgentStore`）、`:1597`（`ConversationRunner`）。

`WebContentsView` 与 renderer 是**两层不同的页面**：renderer 画应用界面，
WebContentsView 画各家 AI 网站，主进程通过 `executeJavaScript` 操作后者。

## 两条业务链路

### A. 多通道问答（本项目升级的主战场）

```
renderer  conversation:submit
   ↓
preload   agentAPI.submitConversation
   ↓
main      index.ts 的 ipcMain.handle
   ↓
ConversationRunner.start()            src/main/conversation-runner.ts:169
   ↓
MasterAgent.research()                src/main/master-agent.ts:107
   ├─ 并发分发所有可用通道             src/main/master-agent.ts:189  Promise.all
   ├─ 每个通道 → SubAgentPool.ask      src/main/agents/registry.ts:94
   │     → ProviderSubAgent.ask        src/main/agents/provider-agent.ts:53
   │     → PageBrowserAdapter.ask      src/main/adapters/browser/page-adapter.ts:100
   │     → ChatPageDriver              src/main/adapters/browser/page-driver.ts:1781
   └─ synthesize(所有回答)             src/main/master-agent.ts:153
   ↓
AgentStore.appendMessage / upsertConversation
   ↓
renderer  conversation:messages / 事件推送
```

`ConversationRunner` 管生命周期（新建、追问、取消、删除、重启对账
`reconcile()` 在 `conversation-runner.ts:279`），`MasterAgent` 只管一轮研究里
的并发与综合。这个分工在 Phase E 之前不要改。

### B. Agent 任务执行（计划 → 审批 → 工具）

```
task:submit → AgentOrchestrator.submit()   src/main/orchestrator.ts:80
   → approve() :108 / reject() :187 / cancel() :195
   → src/agent/ 下的运行时、src/shared/protocol.ts 的解析与提示构造
```

这条链路与多通道问答**共用 `AgentStore`，但互不调用**。项目书的 Hybrid /
辩论属于链路 A，不要落到 `AgentOrchestrator` 里。

## IPC 边界

`src/main/index.ts` 有 39 个 `ipcMain.handle`，按前缀分组：

| 组 | 通道 | 用途 |
| --- | --- | --- |
| `conversation:*` | submit / classify / followup / list / get / messages / cancel / delete | 链路 A |
| `task:*` | submit / get / history / events / approve / reject / cancel / answer / delete | 链路 B |
| `channel:*` `deepseek:*` | statuses / status / diagnose | 页面健康与诊断 |
| `app:*` `sources:*` `page:*` | platform / identity / sources / reload / detach / reattach / state / learn-selectors / bounds / layout / split / drag-page | 配置与窗口 |
| `permission:*` `ax:*` `agent:*` | get / set / snapshot / choose-directory | 权限与辅助功能 |

安全边界：preload 用 `contextBridge`，renderer 拿不到 `ipcRenderer` 本体，
也拿不到 `fs`。`src/main/index.ts` 里对 UI 来源有 `trustedUiSender()` 校验。
**Phase D 的 API Key 必须留在 main 进程**，理由就在这里。

注意 `deepseek:*` 是历史命名，实际按 `sourceId` 查任意通道（Phase B 之前的
一次修正），不是只查 DeepSeek。

## 目录职责

| 目录 | 内容 |
| --- | --- |
| `src/shared/` | 无运行时依赖的契约：`conversation.ts`（对话数据结构）、`contracts.ts`（任务/IPC 类型）、`synthesizer.ts`（规则版综合）、`text.ts`（网页回答清洗）、`selectors.ts`、`sources.ts`、`protocol.ts` |
| `src/main/agents/` | `SubAgent` / `SubAgentPool` 接口、`ProviderSubAgent`、`SubAgentRegistry` |
| `src/main/adapters/browser/` | `PageBrowserAdapter`、`ChatPageDriver`（2579 行，最大的文件）、页面脚本与错误类型 |
| `src/main/providers/` | Phase B 新增的统一 Provider 抽象，只读适配网页通道；Phase C 新增 Ollama |
| `src/main/synthesis/` | 待接线的观点融合模块（`claim-extractor` / `clusterer` / `relations`） |
| `src/agent/` | 链路 B 的 agent 运行时与工具 |
| `src/renderer/src/components/` | 10 个组件，含 `DiagnosticsPanel`、`ConversationView`、`SourceRail` 等 |

## 依赖方向

`shared` 不依赖 `main`；`main` 依赖 `shared`；`renderer` 只依赖 `shared` 的类型
和 `agentAPI`。`src/shared/synthesizer.ts` 被 `master-agent.ts` 和两个待接线模块
共同引用，但**逻辑写在 shared**，所以新引擎可以并存而不必先搬文件。

## 技术债（审计结论）

1. **`page-driver.ts` 2579 行**，选择器脚本、CDP 操作、删除流程、轮询调优
   全在一个文件里。它是 Web Channel 唯一的实现，Phase E 之前不要动。
2. **单一 JSON journal**：`AgentStore.persist()` 每次全量序列化整个 state
   （`src/main/store.ts:79-90`），靠临时文件 + `fsync` + `rename` 保证原子性
   （`src/main/atomic-write.ts:22`）。辩论每轮新增 N 条消息会放大这个成本。
3. **没有数据迁移机制**：新字段一律写成可选，读时按缺失处理
   （`Conversation.answered?` / `threads?` 的注释明确说明了这一点）。
4. **两套名单并存**：`SubAgentRegistry`（现有调度）与 `ProviderRegistry`
   （Phase B 新抽象）目前互不引用，接线在 Phase E。
5. **`src/main/synthesis/` 四个文件未接线、无测试**，属于 Phase I 的前置材料。
6. **无端到端测试**：现有 210 条测试都是逻辑级，Web Channel 的真机回归靠
   `scripts/` 下的 CDP 脚本手动跑，不在 `npm test` 里。
