# LT-P2 · 工具结果裁剪

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：基础层完成（P2-01/02；P2-03 未接线）  
阶段目标：在不调用模型的情况下，先裁剪可丢弃的工具输出。  
依赖：LT-P1 完成  
上游：[契约](../../../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- 工具调用与结果能稳定配对；
- 大输出可裁剪，原始结果仍可查；
- 重复内容去重；
- 未完成/失败调用不丢；
- 裁剪前后 Token 可统计；
- 不调用摘要模型。

## 2. 任务

### LT-P2-01 ToolHistoryAdapter

| 项 | 内容 |
| --- | --- |
| 目标 | 把工具事件配对成可裁剪历史 |
| 依赖 | P1-02 |
| 接触 | `context/adapters/tool-history.ts`、`shared/task-events.ts`（只读） |
| 验收 | started/completed/failed 按 stepId/attemptId 配对；未完成不裁剪 |
| 测试 | 配对、失败、重试 |
| 回滚 | 关闭裁剪 |

输出：

```ts
interface ToolHistoryEntry {
  stepId: string;
  attemptId?: string;
  tool: string;
  args: string;
  result: string;
  status: 'completed' | 'failed' | 'unknown';
  resultRef?: string;
  evidenceRefs: string[];
}
```

规则：

- 没有结果的调用保留；
- 失败调用保留错误；
- 同一 stepId 多次 attempt 不合并；
- 结果原文位置保留。

### LT-P2-02 确定性 Pruner

| 项 | 内容 |
| --- | --- |
| 目标 | 不调用模型，裁剪大输出与重复内容 |
| 依赖 | P2-01 |
| 接触 | `context/compaction/pruner.ts` |
| 验收 | 原始输出可定位；命令/退出码/统计保留 |
| 测试 | 大输出、重复、失败 |
| 回滚 | 关闭 pruner |

裁剪规则：

| 内容 | 处理 |
| --- | --- |
| 大终端输出 | 保留命令、退出码、前后 N 行、统计、原始位置 |
| 重复文件内容 | 只留首次 + 引用 |
| 已进 Evidence Pack 的代码 | 只留 EvidenceRef |
| 已结构化测试日志 | 保留统计与失败摘要 |
| 未完成工具 | 不裁剪 |

禁止：

- 用语义摘要代替工具结果；
- 丢错误/退出码；
- 删除原始存储。

### LT-P2-03 接线与观测

| 项 | 内容 |
| --- | --- |
| 目标 | Builder 超阈值时先裁剪，并记录指标 |
| 依赖 | P2-02、P1-04 |
| 接触 | `context/builder.ts`、`manager.ts`、Trace |
| 验收 | 裁剪后请求可发；统计可见；原始结果可查 |
| 测试 | Builder 集成；UI 占位 |
| 回滚 | 关闭 pruner |

要点：

- L1/L2 触发先裁剪；
- 裁剪不足再进 P3 摘要；
- 记录 `prunedTokens`、`prunedEntries`；
- 不改变问题原文。

## 3. PR 切片

| PR | 内容 |
| --- | --- |
| LT-P2-A | P2-01 工具历史 |
| LT-P2-B | P2-02 Pruner |
| LT-P2-C | P2-03 接线与统计 |

## 4. 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:context-pruner
npm run test:context-builder
npm run test:execution-timeline
```

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 裁剪丢错误 | 保留退出码/错误/原始引用 |
| 调用与结果拆散 | 配对失败不裁剪 |
| 重复内容误删 | 只删完全重复，保留首次 |
| 原始结果不可查 | EvidenceRef/事件 ID 指针 |

## 6. 状态清单

- [x] P2-01 工具历史
- [x] P2-02 Pruner
- [ ] P2-03 接线与统计
- [ ] 阶段回归通过
