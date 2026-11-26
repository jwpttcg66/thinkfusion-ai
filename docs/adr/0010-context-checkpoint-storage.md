# ADR 0010：上下文检查点存储

- 状态：Accepted / IMPLEMENTED
- 决策日期：2026-11-24
- 当前运行状态：[implementation/STATUS.md](../implementation/STATUS.md)
- 规范字段：[LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)

## 背景

压缩摘要可能较大，而 `agent-store.json` 同时承担任务和事件 Journal。若每次提交检查点都把完整摘要放入
Journal，会增加写放大；若检查点文件和 Journal 没有明确提交顺序，崩溃后可能出现 Journal 指向不存在文件。

## 决策

采用**owner 隔离的检查点/归档文件 + AgentStore Journal 活动指针**：

- 检查点和来源事件归档存于 userData 下独立 `context-checkpoints/`；
- AgentTask / Conversation 保存 `contextId`、`checkpointId`、`activeRunId` 指针；
- 文件缓存不是权威，Journal 活动指针是唯一提交事实；
- 提交顺序是归档来源 → 原子写检查点 → 一次 Journal 写入指针与事件 → 回读核验；
- 恢复按 owner/run/checkpoint、摘要 hash 和归档完整性核验；不完整时标 stale，不使用半成品；
- 摘要只作为模型输入数据，不作为执行事实；恢复以报告和工作区副作用核对为准。

存储布局和崩溃窗口见 [CONTEXT_CHECKPOINT_STORAGE.md](../archive/architecture/CONTEXT_CHECKPOINT_STORAGE-2026-11-24.md)。

## 后果

- Journal 不必因摘要正文而膨胀；老任务缺少新字段时仍可按无压缩路径读取。
- 文件与 Journal 需要一致性核验；故障时允许留下未引用孤儿文件，不允许保留悬空活动指针。
- 备份/恢复必须把 Journal 与 `context-checkpoints/` 一并纳入；清理策略不能删除活动指针引用的检查点。
- Context Manager 默认关闭；启用策略见 STATUS，不因本 ADR 自动改变用户默认行为。

## 实现与验证

实现位于 `desktop-agent-macos/src/main/context/checkpoint/`、`context/recovery/` 和 `main/store.ts`。
自动化与真实任务记录见 [长任务验收](../implementation/acceptance/long-task-context/ACCEPTANCE.md)。

## 后续运维事项

检查点保留期限、孤儿文件 GC 与正式备份/恢复演练属于运维策略；它们不改变本 ADR 冻结的提交权威和恢复不变量，完成状态以 STATUS 为准。
