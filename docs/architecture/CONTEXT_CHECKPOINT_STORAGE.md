# 上下文检查点存储设计

状态：设计冻结，待 `LT-P0-03` 正式评审  
基线：`main` · `e31b6a3` · 2026-11-24  
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
- 新增 `userData/context/tasks/<taskId>.json` 保存该任务的检查点；
- `AgentTask` 增加 `contextId` / `checkpointId` 作为**活动指针**；
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
    tasks/
      <taskId>.json                 # 该任务的检查点数组
    .tmp/                           # 原子写临时文件
```

`<taskId>.json`：

```ts
interface ContextTaskFile {
  contractVersion: 1;
  taskId: string;
  runId: string;
  checkpoints: ContextCheckpoint[];
  updatedAt: number;
}
```

约束：

- 只存摘要、引用、范围、状态、Token、模型；
- 不存完整事件正文、完整代码、完整测试日志；
- 单条摘要建议上限 64 KB，超出截断并记录；
- 每个任务保留最近 `N=20` 个 committed 检查点（可配置）；
- 活动 `checkpointId` 指向的检查点永不自动删除。

## 4. 提交协议

采用“先写文件、后写 Journal 指针、最后发事件”的顺序：

```text
1. 生成摘要并通过校验
2. 写入 <taskId>.json（新检查点 status=committed）
   - 临时文件 + fsync + rename
3. 更新 agent-store.json 中任务：
   - contextId
   - checkpointId
4. 追加 context.compaction.committed 事件
5. 旧检查点按保留策略清理（不删活动指针与证据引用）
```

为什么不是“先写 Journal”：

- 如果 Journal 先指向一个不存在的摘要，恢复时任务会处于不可用状态；
- 先写文件，最坏情况是产生一个未被引用的孤儿检查点，可安全清理。

### 崩溃场景

| 崩溃点 | 结果 | 恢复 |
| --- | --- | --- |
| 摘要生成中 | 旧检查点仍有效 | 使用旧上下文 |
| 文件已写、Journal 未更新 | 孤儿 committed 文件 | 任务仍用旧检查点；GC 清理孤儿 |
| Journal 已更新、事件未写 | 任务用新检查点 | 恢复时可补审计事件或只读推导 |
| 文件写一半 | 临时文件残留 | 忽略 `.tmp`，旧文件有效 |
| Journal 写一半 | 原子 rename 保证旧/新二选一 | 按旧/新状态恢复 |
| 清理时崩溃 | 最多残留文件 | 下次 GC 继续 |

### 原子写

- 写 `<taskId>.json.tmp-<pid>-<random>`；
- `fsync` 文件；
- `rename` 覆盖目标；
- 失败删除临时文件；
- 不使用“先删除再写”。

## 5. Journal 变更

`AgentTask` 增加可选字段：

```ts
contextId?: string;
checkpointId?: string;
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
加载 Task
  ↓
读取 context/checkpoints？没有 → 无上下文
  ↓
读取 <taskId>.json
  ↓
找到 task.checkpointId
  ↓
校验 status=committed、summaryHash、sourceEventIds 存在
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

清理前检查：

1. 不是 `task.checkpointId`；
2. 没有事件/报告引用；
3. 没有证据引用；
4. 不是当前 run 的唯一检查点。

## 8. 备份与恢复

现有备份流程需要加入：

- `context/tasks/` 目录；
- 备份清单记录设备上的检查点数量与大小；
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
- 旧任务没有 `context/tasks/<taskId>.json`：不创建空文件；
- 旧报告无 `ContextCheckpoint`：不迁移、不补造；
- 新任务首次压缩时才创建文件；
- 删除任务时删除对应 context 文件（或标记待清理）。

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
