# 上下文检查点存储设计

状态：设计冻结，待 `LT-P0-03` 正式评审  
基线：`main` · `e336ae4` · 2026-11-24  
相关：[契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [架构](LONG_TASK_AND_CONTEXT_COMPACTION.md) · [任务书](../implementation/LONG-TASK-CONTEXT-TASK-BOOK.md)

> 本文回答一个具体问题：压缩摘要与检查点放在哪里，如何原子提交，
> 崩溃后如何恢复，旧 Journal 如何兼容。本文推荐方案 B；最终以
> `LT-P0-03` 的 ADR 为准。

## 1. 需求

| 需求 | 说明 |
| --- | --- |
| 原子性 | 任务状态与检查点不能出现“任务已使用摘要但摘要文件不存在” |
| 崩溃安全 | 任意时刻断电，重启后要么用旧上下文，要么用完整新检查点 |
| 大小 | 摘要可能几十 KB；不能每次任务写入都重写全部事件 |
| 保留 | 保留最近检查点与证据引用；原始事件不删 |
| 兼容 | 旧 `agent-store.json` 无新字段时可读 |
| 可清理 | 未提交/过期检查点可安全删除 |
| 可备份 | 进入现有备份/恢复流程 |
| 可审计 | 哪个任务、哪次运行、哪段事件、哪个模型、多少 Token |

## 2. 方案对比

### 方案 A：全部放进 `agent-store.json`

做法：`StoreState` 增加 `contextCheckpoints` 数组。

优点：

- 与任务状态同一次原子写；
- 只有一个文件，恢复顺序简单。

缺点：

- 摘要大，`agent-store.json` 会随任务数增长；
- 每次任务状态变化都可能重写大数组；
- 事件裁剪与检查点清理容易互相影响；
- 启动加载变慢。

结论：不推荐作为默认方案。

### 方案 B：独立检查点文件 + Journal 指针

做法：

- `agent-store.json` 继续保存任务、轮次、计划、报告、事件；
- 新增 `userData/context/owners/<ownerType>/<ownerId>.json` 保存该 owner 的检查点；
- `AgentTask` / `Conversation` 增加 `contextId` / `checkpointId` / `activeRunId` 作为**活动指针**；
- Journal 只保存指针与审计事件，不保存摘要正文。

优点：

- Journal 保持轻量；
- 摘要独立读写；
- 检查点可单独清理；
- 崩溃恢复只需核对指针与文件。

缺点：

- 两份文件需要一致性协议；
- 备份/恢复要同时处理；
- 需要 GC。

结论：**推荐方案 B**。

## 3. 文件布局

```text
<userData>/
  agent-store.json                  # 任务、轮次、计划、报告、事件、指针
  context/
    owners/
      agent-task/<taskId>.json      # Engineering 上下文检查点
      conversation/<conversationId>.json
    archive/
      agent-task/<taskId>/<archiveId>.jsonl
      conversation/<conversationId>/<archiveId>.jsonl
    .tmp/                           # 原子写临时文件
```

`<ownerType>/<ownerId>.json`：

```ts
interface ContextOwnerFile {
  contractVersion: 1;
  owner: ContextOwner;              // 不再是单一 taskId/runId
  checkpoints: ContextCheckpoint[];
  /**
   * 仅可重建缓存，不是提交/恢复权威。G3 可删除；Journal 指针才是权威。
   * 如保留，必须每次从 Journal 重建，不能反向覆盖 Journal。
   */
  activeCache?: { runId: string; checkpointId: string } | null;
  updatedAt: number;
}
```

约束：

- 一个任务/会话可以有多个 `runId` 的检查点；
- 文件根不再保存单一 `runId`；
- 恢复只加载 **Journal 活动指针** 的 `runId/checkpointId`；
- `owner` 是权威，`taskId/conversationId` 是兼容镜像；
- `activeCache` 只能由 Journal 指针重建，不能参与提交/恢复决策。

约束：

- 只存摘要、引用、范围、状态、Token、模型；
- 不存完整事件正文、完整代码、完整测试日志；
- 单条摘要建议上限 64 KB，超出截断并记录；
- 每个任务保留最近 `N=20` 个 committed 检查点（可配置）；
- 活动 `checkpointId` 指向的检查点永不自动删除。

## 4. 提交协议

采用“先写 prepared 文件、再原子写 Journal、最后确认活动指针”的顺序：

```text
1. 生成摘要并通过校验
2. 写入 <ownerType>/<ownerId>.json：
   - 新检查点 status=prepared
   - 临时文件 → fsync 文件 → rename → fsync 父目录
3. 调用 `commitContextCheckpoint()`，在同一次 Journal persist 中原子更新：
   - owner.contextId
   - owner.checkpointId
   - owner.activeRunId
   - context.compaction.committed 事件
4. 确认 Journal 指向的检查点存在且 hash 匹配
5. 异步清理未提交/过期检查点
```

关键点：

- 文件 `status=prepared` 不等于活动检查点；**Journal 指针才是提交权威**；
- Journal 指针与 `committed` 事件必须在同一次持久化中写入；
- 检查点文件写入需要父目录 `fsync`，不能只 `fsync` 文件；
- 同一 `ownerType/ownerId` 的检查点写入必须串行化；
- 同一任务多个 `runId` 不能覆盖对方的活动指针；
- 不得用多个独立 `upsertTask()` / `appendEvent()` 模拟事务；
- 删除任务/会话时，先清指针，再延迟清理检查点与归档。

为什么不是“先写 Journal”：

- 如果 Journal 先指向一个不存在的摘要，恢复时任务会处于不可用状态；
- 先写文件，最坏情况是产生一个未被引用的孤儿检查点，可安全清理。

### 4.1 Journal 原子提交接口

```ts
interface CommitContextCheckpointInput {
  owner: ContextOwner;
  runId: string;
  contextId: string;
  checkpointId: string;
  checkpointHash: string;
  sourceEventIdsPreview: string[];
  archiveRef: string;
  inputTokensBefore: number | null;
  inputTokensAfter: number | null;
}

/**
 * 一次持久化完成：
 * - owner.contextId/checkpointId/activeRunId
 * - context.compaction.committed 事件
 * - 写入前校验 checkpointHash 与 archiveRef
 */
commitContextCheckpoint(input: CommitContextCheckpointInput): Promise<void>;
```

实现要求：

- `AgentStore` 新增专用方法，不能用多个公开 setter 拼接；
- 更新 owner（AgentTask 或 Conversation）与追加事件在同一次 `persist()`；
- `persist()` 增加父目录 `fsync`；
- 提交前确认归档段存在且 hash 匹配；
- 失败不改变 Journal 指针。

### 4.2 两套事件流

必须同时保护：

| 流 | 来源 | 当前行为 |
| --- | --- | --- |
| `events` | `AgentEvent`（工程任务） | 每任务 800 条 + `KEEP_FOREVER` |
| `runEvents` | `TaskEventEnvelope`（General/Knowledge） | 全局 5000 条，直接 splice |

归档协议必须：

1. 对两套流分别记录 eventId/runId/sequence；
2. 归档段格式 `jsonl`，每行一个事件 + `archiveHash`；
3. 归档前先查重（同一事件已归档则复用）；
4. `trimEvents()` 与 `appendRunEvent()` 裁剪前检查引用；
5. 不能只保护工程事件而忽略 runEvents；
6. 若 ConversationMessage 已保存同一正文，先确定上下文权威来源，避免重复归档正文；
7. 启动时校验归档段存在与 hash；不一致标记 stale。

### 崩溃场景

| 崩溃点 | 结果 | 恢复 |
| --- | --- | --- |
| 摘要生成中 | 旧检查点仍有效 | 使用旧上下文 |
| 文件已写（prepared）、Journal 未更新 | 孤儿 prepared 文件 | 任务仍用旧检查点；GC 清理孤儿 |
| Journal 已更新、文件未写完 | Journal 指针无对应文件 | 不应发生：文件先于 Journal；若发生，回退旧检查点并记录 stale |
| Journal 指针已写、committed 事件未写 | 同一次 persist 不应拆分 | 若发生，按指针推导事件 |
| 文件写一半 | 临时文件残留 | 忽略 `.tmp`，旧文件有效 |
| 父目录未 fsync 就断电 | rename 可能丢失 | 恢复旧文件/旧指针；记录 |
| 清理时崩溃 | 最多残留文件 | 下次 GC 继续 |

### 原子写

- 写 `<ownerType>/<ownerId>.json.tmp-<pid>-<random>`；
- `fsync` 文件；
- `rename` 覆盖目标；
- `fsync` 父目录；
- 失败删除临时文件；
- 不使用“先删除再写”；
- 同一 owner 的写入串行化（进程内锁 + 文件锁）。

## 5. Journal 变更

`AgentTask` / `Conversation` 增加可选字段：

```ts
contextId?: string;
checkpointId?: string;
/** 恢复时必须同时匹配 runId；P0-05 冻结字段名 */
activeRunId?: string;
```

事件：

```ts
type ContextEvent =
  | 'context.budget.warning'
  | 'context.compaction.started'
  | 'context.compaction.summary.ready'
  | 'context.compaction.committed'
  | 'context.compaction.failed'
  | 'context.compaction.stale'
  | 'context.recovered';
```

事件 payload 只带：

- `contextId`
- `checkpointId`
- `sourceEventIds`（可截断为前 20 个 + 计数）
- `inputTokensBefore/After`
- `modelId/providerId`
- `reason`

不把摘要正文放进事件。

## 6. 恢复流程

```text
加载 owner（AgentTask 或 Conversation）
  ↓
读取 context/owners/<ownerType>/<ownerId>.json？没有 → 无上下文
  ↓
找到 active { runId, checkpointId }
  ↓
只加载 active.runId 对应的检查点
  ↓
校验 summaryHash、完整 sourceEventIds 存在、archiveRef 可用
  ↓
校验 retainedEventIds / evidenceRefs
  ↓
过期或缺失 → 回退到上一个 committed，或未压缩
  ↓
返回 PreparedContext
```

不自动重跑工具；只恢复上下文。

## 7. 清理与保留

| 对象 | 保留 |
| --- | --- |
| 原始事件 | 按现有 `KEEP_FOREVER` / 每任务配额；不由本模块删除 |
| committed 检查点 | 每任务最近 20 个，活动指针永久 |
| 未引用检查点 | 7 天后清理 |
| `.tmp` 文件 | 启动时清理超过 1 小时 |
| 失败/stale 检查点 | 保留最近 5 个用于排查，之后清理 |
| Evidence | 由 Evidence Store 管理，不随检查点删除 |
| 归档段 | 被任何 committed 检查点引用时不得删除 |
| 展示预览 | 可随事件裁剪，不影响完整性 |

清理前检查：

1. 不是 `task.checkpointId`；
2. 没有事件/报告引用；
3. 没有证据引用；
4. 不是当前 run 的唯一检查点。

## 7.5 事件归档与 Journal 裁剪

当前 `AgentStore` 仍有 `MAX_EVENTS_PER_TASK=800` / `MAX_RUN_EVENTS=5000`，
会裁剪非关键事件。长任务不能承诺“所有原始事件永久留在 Journal”。

协议：

1. Context Manager 不主动删除原始事件；
2. 压缩前把来源范围写入
   `context/archive/<ownerType>/<ownerId>/<archiveId>.jsonl`；
3. 归档段带 `archiveHash`、`sourceStream`（events/runEvents）、范围；
4. 检查点 `archiveRef` 指向归档段，`sourceEventIds` 保存完整引用；
5. Journal 裁剪前检查：被任何 committed 检查点引用的 `eventId`
   必须已有归档段；
6. `trimEvents()` 与 `appendRunEvent()` 都必须遵守同一保护；
7. 归档失败 → 不提交检查点 / 不允许裁剪该段；
8. 事件 payload 只带 `sourceEventIdsPreview`（前 20 个），
   完整列表在检查点文件；
9. 归档段只追加，不重写；清理按检查点引用计数；
10. 启动恢复、重复归档识别、hash 校验、故障注入都必须可测。

这解决：

- “检查点引用已裁剪事件”；
- “摘要完整性依赖截断预览”；
- “原始历史永久保留”与现有配额冲突。

## 8. 备份与恢复

现有备份流程需要加入：

- `context/owners/` 与 `context/archive/` 目录；
- 备份清单记录设备上的检查点数量与大小；
- 恢复时先在临时目录恢复 Journal 与 context，校验指针/文件/hash 后再切换正式目录；
- 恢复时先恢复 Journal，再恢复 context 文件；
- 若 context 文件缺失，任务按未压缩恢复，不阻塞；
- 若 Journal 指向的检查点缺失，记录 `context.compaction.stale`，回退到上一个。

## 9. 性能

| 指标 | 目标 |
| --- | --- |
| 单任务检查点文件 | < 2 MB |
| 单条摘要 | < 64 KB |
| 启动加载 | 不扫描所有任务检查点；按需读取 |
| 写入 | 异步，不能阻塞 UI 事件循环 |
| 清理 | 启动后延迟执行，低优先级 |

不把检查点放进 `agent-store.json`，避免每次任务更新重写大文件。

## 10. 旧数据兼容

- 旧 `agent-store.json` 无 `contextId/checkpointId`：按未压缩；
- 旧任务/会话没有 `context/owners/<ownerType>/<ownerId>.json`：不创建空文件；
- 旧报告无 `ContextCheckpoint`：不迁移、不补造；
- 新任务首次压缩时才创建文件；
- 删除任务/会话时：
  1. 先清 Journal 指针；
  2. 再标记检查点/归档待清理；
  3. 异步删除文件；
  4. 不能先删文件再清指针。

## 11. 安全

- 摘要不写入 API Key、token、Cookie；
- 摘要中如出现敏感路径，按现有日志脱敏规则处理；
- 检查点文件权限与 userData 一致；
- 不把检查点写入项目工作区，避免被提交；
- 备份文件同样脱敏。

## 12. 测试

| 测试 | 断言 |
| --- | --- |
| 原子写 | 模拟中断后旧文件可读 |
| Journal 更新失败 | 任务仍用旧检查点 |
| 孤儿检查点 | GC 清理，不影响任务 |
| 活动检查点 | 永不清理 |
| 摘要缺失 | 回退未压缩，不崩溃 |
| 旧数据 | 无字段可读 |
| 备份/恢复 | 检查点与指针一致 |
| 并发写 | 同一任务串行，跨任务独立 |

## 13. 待 ADR 定稿

1. 每个任务保留 20 个检查点是否合适；
2. 检查点文件按任务聚合，还是按 checkpoint 分文件；
3. Journal 指针更新与事件追加是否要合并一次写；
4. 备份是否包含未提交检查点；
5. 删除任务时立即删文件还是延迟 GC。

推荐默认值已写在文中，`LT-P0-03` 只做确认或调整。
