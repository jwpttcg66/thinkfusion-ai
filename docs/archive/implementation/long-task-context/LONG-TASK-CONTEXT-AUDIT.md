# 长任务与上下文压缩 · 现状审计（LT-P0-01 输出）

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：未开始  
基线：`main` · `<commit>` · `<date>`  
上游：[架构](../../architecture/LONG_TASK_AND_CONTEXT_COMPACTION-2026-11-24.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

> 本文是 `LT-P0-01` 的产出模板。实施时按当时 `main` 重新核对，
> 不沿用旧提交号。

## 1. 基线

| 项 | 值 |
| --- | --- |
| 仓库 | `jwpttcg66/thinkfusion-ai` |
| 分支 | `main` |
| 提交 | 待填 |
| 日期 | 待填 |
| 审计人 | 待填 |

## 2. 核对清单

| 项 | 期望 | 实际 | 结论 |
| --- | --- | --- | --- |
| `TaskStatus` 与 `ALLOWED` | 当前状态机 | 待填 | 待填 |
| `reconcileInterrupted()` | 当前恢复行为 | 待填 | 待填 |
| `TaskEventEnvelope` | taskId/runId/roundId/stepId/attemptId | 待填 | 待填 |
| `AgentStore` 配额 | 800/5000/KEEP_FOREVER | 待填 | 待填 |
| `ModelRequest` | question/context/system | 待填 | 待填 |
| `ModelUsage` | 可为 null | 待填 | 待填 |
| `contextTokens` | 可为 null | 待填 | 待填 |
| `ExecutionPool` | ask/askStream | 待填 | 待填 |
| Memory 注入 | 只改 system | 待填 | 待填 |
| 旧文档状态 | 是否与代码一致 | 待填 | 待填 |

## 3. 已有能力

| 能力 | 代码位置 | 结论 |
| --- | --- | --- |
| 任务状态机 | 待填 | 待填 |
| 执行编排 | 待填 | 待填 |
| 事件持久化 | 待填 | 待填 |
| 多模型执行 | 待填 | 待填 |
| 记忆召回 | 待填 | 待填 |
| 取消 | 待填 | 待填 |

## 4. 缺口

| 缺口 | 证据 | 影响 |
| --- | --- | --- |
| 无统一压缩 | 待填 | 待填 |
| 日志裁剪 ≠ 压缩 | 待填 | 待填 |
| 入口生命周期不同 | 待填 | 待填 |
| 窗口信息不完整 | 待填 | 待填 |
| 中断恢复粗 | 待填 | 待填 |

## 5. 与文档的冲突

| 文档 | 声称 | 代码事实 | 处理 |
| --- | --- | --- | --- |
| 待填 | 待填 | 待填 | 待填 |

## 6. 结论

- 可以直接复用的模块：待填
- 需要新增的模块：待填
- 必须先决策的问题：待填
- 不能进入实现的阻塞项：待填

## 7. 证据

- 提交号：待填
- 文件/行号：待填
- 测试命令：待填
