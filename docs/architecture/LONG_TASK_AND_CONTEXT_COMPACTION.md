# 长任务与上下文压缩架构

本文说明上下文管理在现有任务/会话链路中的职责和流程，不重定义任务状态、事件类型或检查点 schema。
规范唯一来源见 [LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)，存储决策见
[ADR 0010](../adr/0010-context-checkpoint-storage.md)，当前实现状态见
[implementation/STATUS.md](../implementation/STATUS.md)。

## 1. 设计边界

- Context Manager 只负责请求前的上下文组装、预算、确定性裁剪、摘要和检查点恢复；它不调度任务、不审批工具、不执行副作用。
- TaskManager / ConversationRunner 持有任务和会话生命周期；AgentStore 持有主 Journal；Execution Runtime 持有真实工具执行结果。
- Memory 是跨会话记忆，Evidence 是本轮可核验材料，Context Summary 是模型输入压缩表示。三者不能互相冒充。
- 原始问题逐字不改。Memory 只进 system；Web 保持原话，CLI 不伪造 system turn。
- Provider 上下文窗口/Usage 未知时保留 `null`，不能构造百分比或费用。
- 摘要生成/校验/提交失败时保留旧上下文，不阻塞原请求。

## 2. 请求准备链路

```text
owner + current question + scoped history
  → entry policy（Master / Collaboration / Engineering / Debate）
  → ContextBuilder + TokenEstimator + BudgetManager
  → deterministic tool-output pruning
  → threshold reached: summarize immutable source range
  → archive source events + write prepared checkpoint
  → Journal pointer + committed event (single authoritative commit)
  → send summary + retained recent history to supported Provider
```

Web/CLI 没有可注入的 system/context 时维持各自原请求语义。工程 Provider 规划器和模型池入口可使用
Context Manager；进入评审前须等本轮并行模型收尾，避免未完成输出与评审并行。

## 3. 检查点与恢复

1. 来源事件先归档，完整 `sourceEventIds` 留在检查点；展示事件只允许预览。
2. 检查点文件原子写入；Journal owner 指针是唯一提交权威，文件缓存不是权威。
3. 恢复按 owner、runId、checkpointId 核验文件、摘要 hash 和来源归档。
4. 读取执行报告，核对已记录的写路径：存在、缺失、或需要人工核对；“路径仍存在”不声称内容 hash 一致。
5. 指针不匹配或文件/归档过期时返回 stale，停止自动恢复；摘要永远不是执行事实，不自动重做已完成写操作。

存储布局、崩溃窗口和事务顺序见 [CONTEXT_CHECKPOINT_STORAGE.md](../archive/architecture/CONTEXT_CHECKPOINT_STORAGE-2026-11-24.md)。

## 4. 代码职责

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| Builder / Budget / Estimator / Manager | `desktop-agent-macos/src/main/context/` | 输入装配、预算决策、压缩协调 |
| Pruner / Summarizer / Summary Validator | `src/main/context/compaction/` | 大工具结果裁剪、摘要生成和校验 |
| Checkpoint / Archive / Commit | `src/main/context/checkpoint/` | 文件归档、Journal 原子提交和恢复读取 |
| Task recovery / side-effect ledger | `src/main/context/recovery/` | 检查点校验与副作用核对 |
| Entry policy | `src/main/context/entry-policy.ts` | Master/Collaboration/Engineering/Debate 的上下文范围 |
| Provider preparation | `src/main/execution/`、`src/main/orchestrator.ts` | 支持上下文的模型请求适配 |

## 5. 当前运行限制

- Context Manager 默认关闭；运维环境变量优先于 `context-manager.json`，默认值保持关闭。
- 未知 Provider 上下文窗口仍按保守策略处理，但不显示伪造使用率。
- Web 与 CLI 按原话/无 system turn 契约执行，不注入内部历史。
- 功能状态、测试与剩余缺口统一见 [STATUS.md](../implementation/STATUS.md)；详细的早期设计快照归档于
  [`../archive/architecture/`](../archive/architecture)。
