# Phase E 实施记录：统一执行模式与接线

对应项目书第六章、第十五章 Phase E。日期 2026-11-04。这是分水岭：
之前三种 Provider 只是「能调用」，从这里开始才真正接进现有链路。

## 最小改动路径

项目书决策 3 要求不重写 Web Channel。所以**没有把 `MasterAgent` 改成
认识 Provider**，而是反过来：把新 Provider 包成 `SubAgent`。

```
renderer  submitConversation({ text, executionConfig })
   ↓  preload / IPC（原样透传，runner 里收敛非法值）
ConversationRunner.start()  存 executionConfig
   ↓  poolFor(config, registry)
selectParticipants()        按模式 + 隐私裁名单（唯一隐私边界）
   ↓
ExecutionPool              原网页注册表 + 本地/云端成员，只放行选中的
   ↓
MasterAgent.research()      一行未改
```

`SubAgentRegistry` 仍是唯一的执行名单；`ProviderRegistry` 只回答「有谁、
什么类型、有没有 Key」，不参与调度。这解决了计划里挂着的「两份名单谁是
唯一名单」——没有第二份调度名单。

## 新增

| 文件 | 职责 |
| --- | --- |
| `src/shared/conversation.ts` | `ExecutionMode` / `PrivacyMode` / `ConversationExecutionConfig` / `normalizeExecutionConfig`，`Conversation` 加可选字段 |
| `src/main/execution/provider-sub-agent.ts` | `ModelProvider` → `SubAgent` 适配 |
| `src/main/execution/execution-pool.ts` | 过滤后的 `SubAgentPool` |
| `src/main/execution/policy.ts` | 按模式选人 + `local-only` 硬边界 |
| `src/main/conversation-runner.ts` | 存配置、`poolFor`、删除时区分网页/非网页 |
| `src/main/index.ts` | 注册三类 Provider、4 个新 IPC |
| `contracts.ts` / `preload` / `mock-api` | `getExecutionOptions` / `setApiKey` / `removeApiKey` / `getProviderHealth` |

## 四条已裁决的规则在这里落地

1. **老会话**没有 `executionConfig` → `normalizeExecutionConfig()` 一律返回
   `{web, fallbackEnabled:false, allow-cloud}`。现有会话全是网页产生的，
   默认成 `local-only` 会让老对话一打开就违规。
2. **`web` 模式保留**，但与 `local-only` 互斥：web 下强制归一成
   `allow-cloud`（网页本来就外发），UI 不给 `local-only` 选项。
3. **`local-only` 在选人阶段生效**：`policy.ts` 把网页和云端全部排除，
   后面没有任何路径能把它们加回来；即使显式 `selectedWebChannels`、
   或开了 `fallbackEnabled`，也不放行。末尾还有一道防御性抛错。
4. **非法 IPC 输入**一律退回默认，不让拼错的字符串进 `undefined` 分支。

## 真机验证（两轮）

启动应用，CDP 调真实 `agentAPI`：

- `getExecutionOptions()` 返回四种模式、3 个网页通道、1 个本地模型、
  1 个云端模型、5 个 provider（只有 `hasKey` 布尔，没有 Key）。
- `getProviderHealth()`：三个网页 + Ollama 可用，云端「还没有配置 API Key」。
- `local` + `local-only` 提交 `23 乘 2`：`channels` / `answered` 都只有
  `ollama:qwen2.5:7b`，回答 `46`，`status: answered`。**没有向任何网页发送内容**。
- 保存的配置确实是 `{executionMode:'local', fallbackEnabled:false, privacyMode:'local-only'}`。

**第一轮**发现删除时的错误提示：本地模型没有 threadUrl，却被报成
「这条会话没有记录网页地址，网页里的那份请手动删除」。修法是
`isPageChannel()` 判据，非网页成员既不需要删网页副本，也不需要重置页面。
**第二轮** `failed: []`。

两轮测试数据都当场删干净：应用侧会话回到 0 条、原有会话一条没动。

## 验收对照（项目书 Phase E）

| 要求 | 状态 |
| --- | --- |
| 新建对话可以选择四种执行模式 | ⚠️ 数据与 IPC 已通，**UI 选择器在 Phase J** |
| 每个对话独立保存配置 | ✅ 真机确认存进 Conversation |
| 切换模式不丢失历史 | ✅ 配置是会话字段，消息不变 |
| Local-only 不会发生云端降级 | ✅ 单测 + 真机（local-only 下只走 Ollama） |
| 老对话仍能正常打开 | ✅ 默认配置兜底，测试覆盖 |
| Provider 选择 / Model 选择 | ✅ `selected*` 三组过滤；UI 在 J |
| Fallback Policy | ✅ 只在非隐私模式下退回网页 |

## 测试

```
npm run test:execution   13 条，全绿
npm test                 242 条全绿
npm run typecheck / build 通过
```

钉住的反例：`web + local-only` 归一、非法值退回默认、四种模式的来源集合、
`hybrid + local-only` 只剩本地、显式选网页/云端也不放行、fallback 不突破
隐私、空数组表示「一个都不选」、名单外的人连问都不让问、删除本地会话
不提示手动删网页记录、老会话收到默认 web。

## 没做的

- **UI 选择器、模型勾选、Provider 开关界面**（Phase J）。
- **没有真机验证 cloud 模式**（没有 API Key），`getProviderHealth()` 如实显示
  「还没有配置 API Key」。
- **协作策略（Smart / Parallel / Sequential）** 属于 Phase F，这里只留了
  `strategy` 字段位置，不提前实现。

---

## 2026-11-05 附记：执行模式重新定义（用户裁决）

**原设计错了方向。** Phase E 把 `executionMode`（web/local/cloud/hybrid）做成
「这一轮问谁」——四种模式是四种**回答来源**的组合。用户裁决：执行模式不包含
回答，**第一手回答永远来自网页通道**；执行模式只决定回答都回来之后做什么。

### 新语义

| 模式 | 回答 | 回答之后 |
| --- | --- | --- |
| `direct` 直接 | 网页通道 | 本地规则综合即最终答案，不请任何模型处理 |
| `summary` 汇总 | 网页通道 | 本地模型读完全部回答，写【结论/一致/分歧/存疑】 |
| `lead` 主导辩论 | 网页通道 | 指定的主导（网页回答者或云端模型）读全部回答，指出错误、比较优劣、给最终答案；未指定时退化为汇总 |
| `auto` 自动主导 | 网页通道 | 本地模型按「问题 + 答案质量」自动选一位回答者主导 |

- **回答名单** = 网页通道（`selectedWebChannels` 裁）。
- **执行名单** = 云端模型（`selectedCloudModels` 裁）：不参与第一轮回答，
  只可能当主导读全部回答。`ExecutionPool` 变成双名单：`all()/available()`
  只给回答者，`ask()` 放行回答者与执行者。
- **本地模型**两份名单都不进：它不是来源，只在汇总（`summarizeLocal`）和
  自动选主导（`pickLead`）时出场，那两处直接持有 Provider 引用。
- **隐私模式废弃**：回答必发网页，「仅本地」没有成立的前提。字段保留是为
  老数据不崩，normalize 一律归一 `allow-cloud`，界面不再提供选项。
- **老会话映射**（读取时归位，不回写）：web/local/cloud→`direct`，
  hybrid→`auto`（它原本就是自动主导）。

### 代码落点

| 文件 | 改动 |
| --- | --- |
| `shared/conversation.ts` | `ExecutionMode` 四档重定义 + 老值映射 + privacy 归一 |
| `main/execution/policy.ts` | 重写：返回 `answerIds` + `executorIds` 双名单 |
| `main/execution/execution-pool.ts` | 双名单：第一轮只问网页，`ask` 放行执行者 |
| `main/conversation-runner.ts` | `conduct` 按 mode 编排 lead/summary；`runLead` 允许云端主导（没参与回答也能读全部回答） |
| `main/index.ts` | `poolFor` + `executorIdsFor` 接线 |
| UI | 四档新文案、主导下拉只出现在 `lead` 档、隐私段移除、底栏与会话头部标签更新 |

测试：`test:execution` 11 条重写（默认 direct、老值映射、双名单、pool 放行
矩阵），`test:runner` 新增 4 条（direct 不请模型 / summary 汇总 / lead 云端
主导 / auto 选主导），`test:scenarios` 1–4 与 14 重写。全套 `npm test` 357
条全绿。
