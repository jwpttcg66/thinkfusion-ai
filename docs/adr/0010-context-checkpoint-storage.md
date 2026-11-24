# ADR 0010：上下文检查点存储

- 状态：Accepted（设计冻结，未实施；G6 文档级评审通过，实现前由 LT-P0-03 复核）
- 日期：2026-11-24
- 决策者：待定
- 相关：[长任务与上下文压缩](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md)
  · [存储设计](../architecture/CONTEXT_CHECKPOINT_STORAGE.md)
  · [契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)
  · [任务书](../implementation/LONG-TASK-CONTEXT-TASK-BOOK.md)

## 背景

上下文压缩会生成摘要检查点。摘要可能几十 KB，且只在模型请求前使用。
当前 `agent-store.json` 是任务、轮次、计划、报告、事件的单一 JSON Journal，
已经承担事件裁剪与原子写；把大摘要也放进去会让每次任务写入重写大文件。

需要决定：

1. 检查点与 Journal 放一起还是分开；
2. 崩溃时如何保证“任务指针”和“摘要文件”一致；
3. 旧任务如何兼容；
4. 检查点如何清理与备份。

## 决策

采用**独立检查点文件 + Journal 指针**：

- `agent-store.json` 继续保存任务与事件；
- 新增 `<userData>/context/owners/<ownerType>/<ownerId>.json` 保存检查点；
  覆盖 `agent-task` 与 `conversation` 两类 owner；
- `AgentTask` / `Conversation` 只增加 `contextId` / `checkpointId` / `activeRunId` 指针；
- 检查点文件 `activeCache` 只能由 Journal 指针重建，不是权威；
- 提交顺序：
  1. 归档来源事件（`events` 与 `runEvents` 两套流）；
  2. 写检查点文件（临时文件 + fsync + rename + 父目录 fsync，status=prepared）；
  3. 调用 `commitContextCheckpoint()`，在同一次 Journal persist 中更新
     `contextId/checkpointId/activeRunId` + committed 事件；
  4. 确认 Journal 指针指向的文件存在且 hash 匹配；
  5. 异步清理旧检查点。

这样最坏情况是产生未被引用的孤儿检查点，可以安全清理；不会出现
“任务指向一个不存在的摘要”。

## 后果

正面：

- Journal 保持轻量；
- 摘要独立读写与清理；
- 崩溃恢复只需核对指针与文件；
- 旧任务无需迁移。

负面与风险：

- 两份文件需要一致性协议；
- 备份/恢复要同时处理；
- 需要 GC；
- 删除任务时要处理检查点文件。

## 约束

- 摘要不写事件正文，事件只带 `checkpointId`；
- Journal 指针是提交权威，文件 `status=prepared` 不等于活动检查点；
- 同一 owner 的检查点写入串行化；多 runId 活动指针互不覆盖；
- 活动 `checkpointId` 永不自动删除；
- 被压缩引用的原始事件先归档到 `context/archive/...`，再允许 Journal 裁剪；
- `events` 与 `runEvents` 都必须有归档保护；`trimEvents()` / `appendRunEvent()`
  不能在未归档时删除引用事件；
- `persist()` 增加父目录 fsync；`commitContextCheckpoint()` 是唯一事务入口；
- 检查点写入失败不阻塞任务，回退未压缩；
- 旧 `agent-store.json` 无字段时按未压缩读取；
- 检查点不写工作区，权限与 userData 一致；
- 备份包含 `context/owners/` 与 `context/archive/`；恢复时 Journal 优先、文件缺失不阻塞。

## 未决

- 每 owner 保留 20 个检查点是否合适；
- 按任务聚合还是按 checkpoint 分文件；
- Journal 指针更新与事件追加是否合并写；
- 备份是否包含未提交检查点；
- 删除任务是立即删文件还是延迟 GC。

这些由 `LT-P0-03` 定稿；未定稿前不进入 P3 实现。
