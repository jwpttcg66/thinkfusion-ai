# LT-P5 · 暂停、恢复与中断

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：未开始  
阶段目标：长任务可暂停、停止、取消、恢复；重启不重复副作用。  
依赖：LT-P0、LT-P3、LT-P4  
上游：[契约](../../../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [存储](../../architecture/CONTEXT_CHECKPOINT_STORAGE-2026-11-24.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- `paused / interrupted / budget_exhausted / blocked` 可用；
- `reconcileInterrupted` 标记 `interrupted`，不是 `failed`；
- 暂停不调度新步骤；停止只取消当前请求；取消是终态；
- 恢复从检查点开始，不重做已完成写操作；
- 未知副作用步骤标 `needs_reconciliation`；
- 并发恢复安全。

## 2. 任务

### LT-P5-01 TaskStatus 扩展

| 项 | 内容 |
| --- | --- |
| 目标 | 落新状态与转换表 |
| 依赖 | P0-04 |
| 接触 | `contracts.ts`、`task-manager.ts`、`task-lifecycle.ts`、`coding-workflow.ts` |
| 验收 | 非法转换被拒；旧任务可读；重启显示中断 |
| 测试 | `check-state-machine`、持久化 |
| 回滚 | 回退旧状态 |

要点：

- `interrupted ≠ failed`；
- `blocked` 只表示外部阻塞；
- 恢复回到暂停前状态；
- UI 文案同步。

### LT-P5-02 Pause / Resume / Stop / Cancel

| 项 | 内容 |
| --- | --- |
| 目标 | 用户可暂停、继续、停止当前模型、取消 |
| 依赖 | P5-01 |
| 接触 | `orchestrator.ts`、`task-manager.ts`、`preload/index.ts`、`App.tsx` |
| 验收 | 四种操作语义不同；暂停无新步骤 |
| 测试 | 状态机 + IPC；真机 |
| 回滚 | 隐藏入口，保留取消 |

语义：

| 操作 | 行为 |
| --- | --- |
| 暂停 | 不调度新步骤；保存检查点 |
| 停止当前模型 | 只取消 requestId |
| 取消任务 | 终态，清理待处理工作 |
| 继续 | 从检查点恢复 |

网页 `give-up` 如实显示，不写“已停止”。

### LT-P5-03 Checkpoint Resume

| 项 | 内容 |
| --- | --- |
| 目标 | 从最近检查点恢复 |
| 依赖 | P3-04、P5-02 |
| 接触 | `orchestrator.ts`、`task-manager.ts`、`context/recovery.ts` |
| 验收 | 不重复写；未知步骤显式标记 |
| 测试 | fake tool + 崩溃恢复 |
| 回滚 | 关闭恢复入口 |

流程：

1. 加载 owner（AgentTask 或 Conversation）+ active `{runId, checkpointId}`；
2. 只加载当前 runId 的检查点；
3. 已完成步骤可复用；
4. 不确定步骤 `needs_reconciliation`；
5. 不自动重跑副作用；
6. 发恢复事件。

同一 task 多个 runId 时，不能把旧 run 的检查点当成本次活动上下文。

### LT-P5-04 副作用核对

| 项 | 内容 |
| --- | --- |
| 目标 | 核对文件/Git/测试/shell 的实际副作用 |
| 依赖 | P5-03 |
| 接触 | `evidence-pack/*`、`engineering/snapshot.ts`、`task-worktree.ts` |
| 验收 | 已完成写不重做；半完成可识别 |
| 测试 | 故障注入；真实小任务 |
| 回滚 | 停止自动恢复，人工确认 |

核对：

| 类型 | 依据 |
| --- | --- |
| 文件写 | 存在性、内容、hash |
| Git | 分支、提交、status |
| 测试 | 已执行结果、证据 |
| shell | 退出码、输出、是否可重复 |
| 危险命令 | 不自动重跑 |

### LT-P5-05 并发与取消保护

| 项 | 内容 |
| --- | --- |
| 目标 | 多任务/多模型/压缩/恢复互不干扰 |
| 依赖 | P5-02、P5-04 |
| 接触 | `orchestrator.ts`、`context/manager.ts`、`checkpoint/*` |
| 验收 | 上下文不串；取消不留半检查点 |
| 测试 | 并发/取消 |
| 回滚 | 串行化压缩与恢复 |

要点：

- 按 taskId/contextId 隔离；
- 摘要竞争检测；
- 取消压缩不提交；
- 同任务单恢复；
- 幂等。

## 3. PR 切片

| PR | 内容 |
| --- | --- |
| LT-P5-A | P5-01 状态 |
| LT-P5-B | P5-02 操作 |
| LT-P5-C | P5-03 恢复 |
| LT-P5-D | P5-04 副作用 + P5-05 并发 |

## 4. 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:state-machine
npm run test:task-persistence
npm run test:context-recovery
npm run test:engineering
```

真机：

1. 执行中暂停；
2. 关闭应用；
3. 重启显示 interrupted；
4. 继续不重复写；
5. 未知步骤显示待核对。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 重复副作用 | 默认不自动重跑；核对 |
| 状态迁移断裂 | 兼容旧值；P0 转换表 |
| 恢复死循环 | 同任务单恢复 + 上限 |
| 网页 give-up 误导 | 文案区分 |
| 并发压缩冲突 | context 版本隔离 |

## 6. 状态清单

- [ ] P5-01 状态
- [ ] P5-02 操作
- [ ] P5-03 恢复
- [ ] P5-04 副作用
- [ ] P5-05 并发
- [ ] 真机恢复通过
