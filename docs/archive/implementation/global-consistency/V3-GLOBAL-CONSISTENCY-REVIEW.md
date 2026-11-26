# V3 全局一致性评审记录（G6）

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：文档级评审通过；运行时代码未实施  
日期：2026-11-24  
基线：`main@6f871e2`  
任务书：[V3-GLOBAL-CONSISTENCY-TASK-BOOK.md](V3-GLOBAL-CONSISTENCY-TASK-BOOK.md)  
审计：[V3-GLOBAL-CONSISTENCY-AUDIT.md](V3-GLOBAL-CONSISTENCY-AUDIT.md)  
架构：[V3-GLOBAL-ARCHITECTURE.md](../../architecture/V3-GLOBAL-ARCHITECTURE-2026-11.md)

> 本记录评审 G0–G5 的文档与契约，不评审运行时代码，因为本轮没有实现代码。
> 结论只允许进入 LT-P0 的契约/设计工作，不代表长任务功能已可用。

## 1. 评审范围

| 项 | 文档 |
| --- | --- |
| G0 审计 | `V3-GLOBAL-CONSISTENCY-AUDIT.md` |
| G1 架构 | `architecture/V3-GLOBAL-ARCHITECTURE.md` |
| G2 上下文契约 | `spec/LONG_TASK_CONTEXT_CONTRACTS.md` |
| G3 存储/归档 | `architecture/CONTEXT_CHECKPOINT_STORAGE.md`、ADR 0010 |
| G4 V3/LT 协调 | `TASK-BOOK.md`、`LONG-TASK-CONTEXT-TASK-BOOK.md` |
| G5 状态/测试 | `STATUS.md`、`LONG-TASK-CONTEXT-TEST-PLAN.md` |

## 2. 检查结果

| # | 检查 | 结果 | 证据 |
| ---: | --- | --- | --- |
| 1 | 基线是否为 6f871e2 | 通过 | 审计/文档头 |
| 2 | 代码相对 e336ae4 是否变化 | 无变化 | `git diff` 空 |
| 3 | product-v3 是否独立领先 | 否；main 领先 234 | `git rev-list` |
| 4 | 三空间生命周期 | 通过 | G1 §1 |
| 5 | 四态分离 | 通过 | G1 §3 |
| 6 | ContextManager recover owner-aware | 通过 | 契约 §3.6/4.4 |
| 7 | Prepare/Finalize 支持两类 owner | 通过 | 契约 §3.6 |
| 8 | Conversation runId 语义 | 通过（设计） | 契约 §4.5 |
| 9 | 活动指针唯一权威 | 通过 | 契约 §4.6；存储 §3/4 |
| 10 | 两套事件流归档 | 通过 | 存储 §4.2/7.5 |
| 11 | Journal 原子提交 | 通过 | 存储 §4.1 |
| 12 | 父目录 fsync | 通过（设计） | 存储 §4/4.1 |
| 13 | 裁剪保护 | 通过 | 存储 §7.5 |
| 14 | V3/LT 文件所有权 | 通过 | TASK-BOOK 0.0 |
| 15 | 唯一状态板 | 通过 | STATUS.md |
| 16 | 测试脚本登记要求 | 通过（未来脚本已标注） | 测试计划 |
| 17 | ADR 0010 | 设计通过，未实施 | ADR |
| 18 | 是否修改运行时代码 | 否 | git status |

## 3. 结论

**G6 文档级评审通过。**

> 2026-11-25 更新：下面 4 条是当时的代码事实，已被后续实现推翻——
> `src/main/context/` 已落地、`Conversation` 已带 runId/contextId/checkpointId、
> 检查点提交与归档保护已实现、测试脚本已加入 `scripts/`。保留本节作为历史评审记录，
> 当前状态请看 [STATUS.md](../../../implementation/STATUS.md) §4。

可以进入 LT-P0 的契约与存储设计工作，但必须记住：

1. `src/main/context/` 仍不存在；
2. `Conversation` 仍没有 runId/contextId/checkpointId；
3. `AgentStore` 仍没有归档保护/`commitContextCheckpoint()`/父目录 fsync；
4. 测试脚本仍是未来脚本，未加入 `test:all`；
5. ADR 0010 只代表设计接受，不代表实现完成。

LT-P0 开工前仍需：

- 在独立 worktree 中先做 LT-P0-01 复核；
- P0-03 按 ADR 0010 复核实现约束；
- 不直接开始 LT-P1/LT-P3 代码。

## 4. 遗留事项

| 项 | 负责阶段 |
| --- | --- |
| Conversation 运行身份落地 | LT-P0-05 / LT-P5 |
| 两套事件流归档实现 | LT-P0-06 / LT-P3 |
| `commitContextCheckpoint()` | LT-P0-03 / LT-P3 |
| 父目录 fsync | LT-P0-03 / LT-P3 |
| 测试脚本登记 | LT-P0-07 / 各阶段 |
| 状态板与任务书联动 | 每次合并 |

## 5. 评审性质

本记录由本轮文档实施者完成，属于**文档级自审**，不是独立第三方评审。
如果项目要求独立评审，LT-P0 开始前应再由另一位评审者复核 G2/G3。

## 6. 未修改

- 未修改 `src/`；
- 未修改 `scripts/`；
- 未修改 `package.json`；
- 未提交运行时代码；
- 未推送远程。
