# 上下文检查点存储

本文记录已接受并实现的存储决策。schema 见
[长任务契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)，ADR 与决策理由见
[ADR 0010](../adr/0010-context-checkpoint-storage.md)，当前实现状态见
[STATUS.md](../implementation/STATUS.md)。

## 1. 存储布局

默认 userData 下使用独立 `context-checkpoints/` 目录：

```text
context-checkpoints/
├── owners/<ownerType>/<ownerId>.json
└── archive/<ownerType>/<ownerId>/<checkpointId>.jsonl
```

- owner 可为 `agent-task` 或 `conversation`；文件按 owner 隔离。
- Owner 文件保留完整检查点摘要、sourceEventIds、retainedEventIds、hash 和归档引用。
- Archive 保存被压缩的原始事件；完整性由 archive hash 核验。
- Journal 中 `contextId/checkpointId/activeRunId` 是唯一的活动提交指针；owner 文件内的缓存只可重建。

实现入口：`src/main/context/checkpoint/{store,archive,commit}.ts`。

## 2. 提交顺序

```text
write immutable source archive
→ atomic owner/checkpoint file write (tmp + fsync + rename + parent fsync)
→ AgentStore.commitContextCheckpoint(pointer + context event in one persist)
→ verify Journal pointer resolves to checkpoint and summary hash matches
```

Journal 指针提交前失败，旧上下文仍有效；最坏情况是留下未被引用的孤儿归档/检查点。指针提交后发现
文件或 hash 不匹配，恢复必须标 stale，不能使用半成品。

## 3. 恢复与保留

- `recoverContext()` 只接受匹配的 owner、runId、Journal 活动指针、摘要 hash 和来源归档。
- 恢复判断按真实执行报告和工作区路径核对；摘要只用作模型输入数据。
- 删除/裁剪历史前必须确保被引用事件已有归档。
- 备份需同时包含 AgentStore 和 `context-checkpoints/`；仅恢复其中一个时，恢复流程应显式报 stale/缺件。
- 未知窗口/Token/费用仍保持 `null`。

具体字段和事件 payload 不在本文复制，唯一 schema 来源是
[LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)。
