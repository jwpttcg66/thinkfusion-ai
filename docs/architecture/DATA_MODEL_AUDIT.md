# 数据模型与持久化审计（Phase A）

审计日期 2026-11-04。路径相对 `desktop-agent-macos/`。

## 存储：一个 JSON 文件，全量重写

`src/main/store.ts:36` 的 `AgentStore`，文件在
`app.getPath('userData')/agent-store.json`（`src/main/index.ts:1573`）。

`persist()` 在 `store.ts:79-90`：

```
mkdir -p → 打开 <file>.<pid>.tmp → writeFileSync(JSON.stringify(this.state))
         → fsync → close → rename 覆盖
```

同一目录内 `rename` 是原子的，所以不会出现半截文件。
`src/main/atomic-write.ts:22` 的 `writeFileAtomic()` 是同类实现，注释解释了
为什么不能直接 `writeFileSync`（`O_TRUNC` 会先抹掉旧字节）。

**关键性质：每一次 mutation 都序列化整个 state。** 现在数据少，没问题；
Phase G 的辩论会用最坏的方式暴露它：3 模型 × 3 轮，每轮新增 N 条消息，
每条都全量写一次。文件到几 MB 之后，写盘成本随历史线性增长。

`store.ts:30-32` 的注释明确写了 v0.6.0 **刻意不用 SQLite**：
`better-sqlite3` 会把 node-gyp 拖进安装链路，且运行时和主进程都要能读。
这与 `ARCHITECTURE.md` 11.7「SQLite 是前置」矛盾，是既有文档冲突，
已在 `docs/audits/2026-11-04-upgrade-proposal.md` 里指出。

**裁决**：Phase G 之前先按天分文件（只改路径生成，不动读写逻辑），
实测不够再考虑 append-only NDJSON。不上 SQLite（项目书决策 9：渐进式迁移）。

## 数据结构

`src/shared/conversation.ts`（189 行）是链路 A 的契约：

| 位置 | 结构 | 要点 |
| --- | --- | --- |
| `:9` | `ConversationStatus` | 状态机 |
| `:19` | `Conversation` | `conversationId` / `title` / `intent` / `intentReason` / `status` / `channels[]` / `answered?[]` / `threads?{}` / `taskId?` / 时间戳 / `error?` |
| `:68` | `MessageRole` | `user` / `channel` / `synthesis` / `system` |
| `:70` | `ConversationMessage` | 每条消息带来源与消息 ID，供 `Claim.sources` 引用 |
| `:86` `:93` `:101` `:106` | `Claim` / `Dispute` / `Gap` / `Synthesis` | 见 `SYNTHESIS_AUDIT.md` |
| `:130` | `ChannelPhase` | `resetting / asking / answered / failed / busy` |
| `:132` | `ConversationEvent` | 事件推送 |
| `:180` | `ChannelStatus` | 通道健康 |

`src/shared/contracts.ts`（626 行）是链路 B + IPC 契约：`AgentTask` `:127`、
`AgentRound` `:146`、`StoredPlan` `:161`、`ExecutionReport` `:210`、
`AgentEvent` `:231`、诊断类型 `:276` / `:286`。用 zod 做运行时校验
（`PlanSchema` `:43`、`WireMessageSchema` `:84`）。

## 兼容性现状：可选字段 + 读时兜底

**没有迁移机制，也没有 schema 版本号。** 新字段一律写成可选，读不到的
地方按「不知道」处理。`Conversation.answered?` 和 `threads?` 的注释
（`conversation.ts:38-56`）把这个约定写得很清楚：

- `channels` 是「问过谁」，`answered` 是「谁真的答了」，`threads` 是
  `channelId → 该站点上的会话 URL`（删除时靠它找同一行，不能靠标题猜）。
- 缺 `answered` 视为「无法判断」，等同 `threads` 为空。

`AgentStore` 启动时若 journal 损坏，会保留坏文件供排查、从空 state 启动
（`store.ts:68`），不让应用起不来。

## Phase E 要加 `executionConfig` 的落位

项目书 6.1 要求执行模式**存在每个 Conversation 里**，不是全局设置。
落位就是 `src/shared/conversation.ts:19` 的 `Conversation` 加一个可选字段，
以及 `conversation:submit` 的输入结构。

两条必须遵守：

1. **老会话读到缺字段时视为**
   `{ executionMode: 'web', fallbackEnabled: false, privacyMode: 'allow-cloud' }`。
   现有会话全部由网页通道产生，默认成 `local-only` 会让老对话一打开就处于
   违规状态。
2. **`web` 与 `local-only` 互斥**：项目书 6.3 规定 `local-only` 禁止向网页
   Channel 发送内容，而 web 模式的全部内容都发往网页。裁决是 web 模式下
   `privacyMode` 恒为 `allow-cloud`，UI 不提供 `local-only` 选项，
   **不禁用 web 模式**。

两条已由用户于 2026-11-04 确认，见
`docs/implementation/MULTI_MODEL_UPGRADE_PLAN.md` 第三、五节。

## 并发写与取消

- 所有写都走同一个 `AgentStore` 实例（主进程单线程），没有跨进程写冲突。
- `ConversationRunner.reconcile()` `conversation-runner.ts:279` 在应用重启后
  把「进行中」状态对账成终态，避免界面永远转圈。
- 取消是 `cancel(requestId)` 一路传到页面，但**网页通道只是不等了**
  （`give-up`）；已写入的消息不会被回滚。

## Phase G 新增数据前的检查清单

1. 辩论轮次是否复用 `ConversationMessage`（`role` 要不要加 `debate`？）
2. 每轮的 `DebateRound` 是否独立落库，还是塞进一条消息的 JSON 里；
3. 少数派观点、被否定观点的存储位置，保证不被后续轮次覆盖；
4. `Claim.sources[].messageId` 是否仍指向未改动过的原始回答（决策 6）；
5. 按天分文件后，`conversation:list` / `conversation:messages` 的读取路径
   是否需要跨文件合并——这是分文件方案最容易漏的一步。
