# LT-P0 · 契约与存储冻结

状态：未开始  
进入条件：G0–G6 全局一致性门禁通过（`V3-GLOBAL-CONSISTENCY-REVIEW.md`）
阶段目标：在写运行时之前，冻结类型、状态、存储与文档冲突。  
上游：[架构](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md) · [契约](../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [存储](../architecture/CONTEXT_CHECKPOINT_STORAGE.md)  
总任务书：[LONG-TASK-CONTEXT-TASK-BOOK.md](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- `src/shared/context.ts` 类型冻结；
- `ContextCheckpoint` / `ContextBudget` / `ContextEvent` / `PreparedContext` 可编译；
- 检查点存储方案 ADR 通过；
- `TaskStatus` 新增状态与转换表定稿；
- `ContextOwner` 跨空间身份与多 run 指针冻结；
- Journal 事件裁剪/归档/检查点完整来源策略冻结；
- 文档只有一个状态板，基线统一；
- `UNIFIED-TASK-RUNTIME.md` 中“重启恢复已完成”的错误被修正；
- 旧数据兼容规则写清；
- 未写任何压缩运行时。

## 2. 任务

### LT-P0-01 现状审计与基线冻结

| 项 | 内容 |
| --- | --- |
| 目标 | 核对设计引用的文件、函数、状态、事件、存储限制 |
| 依赖 | 无 |
| 产出 | `docs/implementation/LONG-TASK-CONTEXT-AUDIT.md` |
| 接触 | 只读代码与文档 |
| 验收 | 每个关键接口有真实路径/函数；列出已有/缺口/冲突 |
| 测试 | 文档评审 |
| 回滚 | 删除审计文档 |

审计清单：

1. `TaskStatus`、`ALLOWED`、`reconcileInterrupted()`；
2. `TaskEventEnvelope` 字段与 `phaseOfEvent`；
3. `AgentStore` 配额、`KEEP_FOREVER`、原子写；
4. `ModelRequest` / `ModelUsage` / `ModelMetadata.contextTokens`；
5. `ExecutionPool.ask/askStream` 与 `ProviderBackedSubAgent`；
6. Memory 注入链路与“记忆不是证据”；
7. `UNIFIED-TASK-RUNTIME.md` 状态板与代码事实的冲突；
8. 当前测试脚本与可复用夹具。

### LT-P0-02 契约类型冻结

| 项 | 内容 |
| --- | --- |
| 目标 | 落类型与纯函数签名，不接运行时 |
| 依赖 | P0-01 |
| 接触 | `src/shared/context.ts`、`contracts.ts`、`task-events.ts` |
| 验收 | 三套 typecheck；旧数据可读；契约单测通过 |
| 测试 | 新增 `test:context-contracts` |
| 回滚 | 删除类型与字段 |

实现要点：

- `ContextBudget`、`PreparedContext`、`ContextCheckpoint`、`ContextSummary`、`ContextEvent`；
- `AgentTask` 可选 `runId/contextId/checkpointId`；
- `TaskStatus` 扩展先定义、不启用以避免 UI 断裂；
- 所有新字段可选；
- 不写 `manager.ts` 行为。

### LT-P0-03 检查点存储 ADR

| 项 | 内容 |
| --- | --- |
| 目标 | 确认方案 B（独立文件 + Journal 指针）或给出反例 |
| 依赖 | P0-01 |
| 接触 | `docs/adr/`、`src/main/store.ts`（只读） |
| 验收 | 原子提交顺序、崩溃恢复、GC、备份、旧数据兼容全部写清 |
| 测试 | ADR 评审；模拟崩溃表 |
| 回滚 | ADR 标记 superseded |

必须回答：

1. 文件布局与命名；
2. 写文件/写 Journal/发事件的顺序；
3. 崩溃在任意一步的结果；
4. 保留数量与清理；
5. 备份/恢复；
6. 旧任务无检查点。

### LT-P0-04 状态机与文档冲突决策

| 项 | 内容 |
| --- | --- |
| 目标 | 定义暂停/中断/预算/阻塞状态与转换；修正文档状态板 |
| 依赖 | P0-01 |
| 接触 | `task-manager.ts`（只读）、`contracts.ts`、`task-lifecycle.ts`、`UNIFIED-TASK-RUNTIME.md` |
| 验收 | 合法/非法转换表完整；`interrupted ≠ failed`；文档不再误报 |
| 测试 | 评审；P5 补状态机测试 |
| 回滚 | 恢复旧转换表 |

实现要点：

- `paused / interrupted / budget_exhausted / blocked`；
- 保留 `awaiting_approval / awaiting_clarification`；
- 恢复回到暂停前状态；
- `reconcileInterrupted` 改 `interrupted`；
- UI 文案与动作。

### LT-P0-05 上下文所有权与跨空间身份

| 项 | 内容 |
| --- | --- |
| 目标 | 冻结 `ContextOwner`，AgentTask 与 Conversation 都可有上下文 |
| 依赖 | P0-02、P0-04 |
| 接触 | `context.ts`、`contracts.ts`、`conversation.ts`、`task-events.ts`、存储设计 |
| 验收 | 不伪造 AgentTask；多 runId 不覆盖；跨空间恢复测试 |
| 测试 | 契约 + 跨空间恢复 |
| 回滚 | 回到 taskId-only（不推荐） |

### LT-P0-06 Journal 事件保留、归档与检查点引用

| 项 | 内容 |
| --- | --- |
| 目标 | 解决“永久保留”与 800/5000 配额冲突 |
| 依赖 | P0-03、P0-05 |
| 接触 | `store.ts`（只读）、`context/archive/*`、契约 |
| 验收 | 来源可追溯；未归档不得裁剪；归档失败不提交 |
| 测试 | 归档/裁剪/stale |
| 回滚 | 停止归档，保留旧配额 |

### LT-P0-07 跨文档状态、基线与测试门禁

| 项 | 内容 |
| --- | --- |
| 目标 | 单一状态板、统一基线、历史规格标记、测试脚本登记 |
| 依赖 | P0-01 |
| 接触 | `STATUS.md`、README、ROADMAP、PRODUCT、UNIFIED、`package.json` |
| 验收 | 状态不再互相矛盾；基线一致；`test:context-*` 落地关系明确 |
| 测试 | 文档评审；`npm run verify` |
| 回滚 | 恢复旧文档（不推荐） |

### LT-P0-08 LT 灰度/回滚演练设计

| 项 | 内容 |
| --- | --- |
| 目标 | LT 独立开关、灰度、备份恢复、回滚演练 |
| 依赖 | P0-03、P0-07 |
| 接触 | `operations/LONG-TASK-CONTEXT-ROLLOUT.md`、ADR |
| 验收 | 开关可回退；备份恢复不破坏任务；演练可执行 |
| 测试 | 桌面演练；P6 真机复验 |
| 回滚 | 关闭开关 |

## 3. PR 切片

| PR | 内容 | 合并条件 |
| --- | --- | --- |
| LT-P0-A | P0-01 审计 + P0-04 决策 | 文档评审通过 |
| LT-P0-B | P0-02 类型 + P0-03 ADR | typecheck + 契约测试 |

## 4. 测试与命令

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:context-contracts   # P0-02 新增
```

P0 不要求真实模型调用。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 类型设计过度 | 只落当前 P1–P5 需要的字段 |
| 状态扩展破坏旧 UI | 新状态先定义不启用；P5 再接线 |
| 存储方案反复 | ADR 一次定稿；P3 不再改 |
| 审计与代码漂移 | 实施前重新核对 `main` |

## 6. 状态清单

- [ ] LT-P0-01 审计完成
- [x] LT-P0-02 类型冻结（类型层 + `test:context-contracts`）
- [ ] LT-P0-03 ADR 通过
- [ ] LT-P0-04 状态决策
- [x] LT-P0-05 所有权/身份（类型层 + Conversation 可选字段）
- [ ] LT-P0-06 归档/事件保留
- [ ] LT-P0-07 状态/基线统一
- [ ] LT-P0-08 回滚演练设计
- [ ] P0 评审通过
