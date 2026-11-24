# 长任务与上下文压缩 · 文档集

状态：设计冻结，未实施  
基线：`main` · `e336ae434978211138879688031a9d40c1a27cd7` · 2026-11-24

这套文档回答两件事：

1. 长任务怎样持续执行、暂停、恢复，且不重复副作用；
2. 上下文接近模型上限时怎样裁剪、摘要、提交检查点、恢复，且不丢证据。

## 先读顺序

| 顺序 | 文档 | 回答什么 |
| ---: | --- | --- |
| 1 | [架构](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md) | 为什么这样设计、四态分离、总体流程、正式决议 |
| 1.5 | [STATUS.md](STATUS.md) | 唯一阶段状态板；文档/代码事实以此为准 |
| 2 | [契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md) | 类型、不变量、状态机、事件、API |
| 3 | [存储](../architecture/CONTEXT_CHECKPOINT_STORAGE.md) · [ADR 0010](../adr/0010-context-checkpoint-storage.md) | 检查点放哪、如何原子提交、崩溃恢复、GC |
| 4 | [UI 规格](../spec/LONG_TASK_CONTEXT_UI.md) | 主页面/轨迹/统计怎样展示，未知值怎么处理 |
| 5 | [总任务书](LONG-TASK-CONTEXT-TASK-BOOK.md) | 35 个任务、依赖、验收、回滚 |
| 6 | 阶段任务书 | 每阶段的详细施工清单 |
| 7 | [测试计划](LONG-TASK-CONTEXT-TEST-PLAN.md) | 测试矩阵、长任务 E2E、故障注入 |
| 8 | [灰度/回滚](../operations/LONG-TASK-CONTEXT-ROLLOUT.md) | 开关、迁移、监控、发布门禁 |

## 阶段任务书

| 阶段 | 文档 | 内容 |
| --- | --- | --- |
| LT-P0 | [LT-P0-CONTRACTS.md](LT-P0-CONTRACTS.md) | 审计、类型、存储 ADR、状态决策 |
| LT-P1 | [LT-P1-CONTEXT-MANAGER.md](LT-P1-CONTEXT-MANAGER.md) | 模块骨架、Builder、Estimator、Budget、Provider |
| LT-P2 | [LT-P2-TOOL-PRUNING.md](LT-P2-TOOL-PRUNING.md) | 工具历史配对、裁剪、接线 |
| LT-P3 | [LT-P3-COMPACTION-CHECKPOINTS.md](LT-P3-COMPACTION-CHECKPOINTS.md) | 摘要、检查点、恢复、事件 |
| LT-P4 | [LT-P4-PROVIDER-WIRING.md](LT-P4-PROVIDER-WIRING.md) | ExecutionPool 接线、入口策略、Usage |
| LT-P5 | [LT-P5-PAUSE-RESUME.md](LT-P5-PAUSE-RESUME.md) | 暂停、恢复、中断、副作用核对 |
| LT-P6 | [LT-P6-UI-E2E.md](LT-P6-UI-E2E.md) | UI、统计、30 步 E2E、验收 |

任务产出模板：

- P0-01：[LONG-TASK-CONTEXT-AUDIT.md](LONG-TASK-CONTEXT-AUDIT.md)
- P6-05：[LONG-TASK-CONTEXT-ACCEPTANCE.md](LONG-TASK-CONTEXT-ACCEPTANCE.md)

## 任务编号

`LT-P<阶段>-<序号>`，例如 `LT-P3-04`。

- 总任务书是任务清单的权威来源；
- 阶段任务书只细化施工，不新增未登记的任务；
- 新增任务先改总任务书，再改阶段文档。

## 阶段门禁

| 阶段 | 出口 |
| --- | --- |
| P0 | 类型/契约/存储 ADR/状态决策；不写运行时 |
| P1 | Builder/Estimator/Budget/Provider；开关关闭零变化 |
| P2 | 裁剪可用；原始结果可查 |
| P3 | 摘要/检查点/恢复；崩溃安全 |
| P4 | Provider 接线；边界回归 |
| P5 | 暂停/恢复/中断；真机不重复副作用 |
| P6 | UI + 30 步 E2E + 验收报告 |

未过门禁不进入下一阶段。

## 当前状态

| 项 | 状态 |
| --- | --- |
| 架构 | 设计冻结 |
| 契约 | 设计冻结 |
| 存储 | 推荐方案 B，待 P0-03 ADR 确认 |
| 任务书 | 35 个任务，未开始 |
| 实现 | 未开始 |
| 远程推送 | 文档集已推送 `e336ae4`；本次一致性修订待推送 |

## 实施前必须确认

1. `AgentStore` 检查点存储方案；
2. `paused/interrupted/budget_exhausted/blocked` 状态迁移；
3. `runId` 生成与恢复；
4. 未知窗口的保守默认值；
5. Web/CLI 是否参与摘要；
6. 摘要模型与费用归属；
7. Reviewer 上下文隔离边界；
8. 修正 `UNIFIED-TASK-RUNTIME.md` 的恢复状态板。
