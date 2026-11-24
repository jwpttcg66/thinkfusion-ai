# 长任务与上下文压缩 · 验收报告

状态：部分验收完成，未达到“全部完成”  
日期：2026-11-24  
基线：`main@40c7fed` + 分支 `lt-p0-context-contracts`  
实现分支：`/Users/yalla/data/localLab/thinkfusion-ai-lt-p0`

> 本报告只写已经跑过的验证。未执行的 30 步真实工程任务、P5 检查点恢复接线、
> 副作用核对与并发保护，明确列为未完成。

## 1. 已实现

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| LT-P0 | Owner/预算/检查点/事件类型、运行字段 | TESTED |
| LT-P1 | Builder/Estimator/Budget/Provider/Manager | TESTED |
| LT-P2 | 工具历史配对/Pruner | TESTED |
| LT-P3 | 摘要校验/生成/检查点/归档/Journal 指针/恢复 | TESTED |
| LT-P4 | ExecutionPool contextState + prepare/finalize | TESTED；真实会话走通 |
| LT-P5 | 新状态、interrupted、暂停/继续 API/IPC/UI | 部分 |
| LT-P6 | 上下文行、轨迹事件、统计、组件级 30 条 E2E | 部分 |

## 2. 自动化验证

| 测试 | 结果 |
| --- | --- |
| `npm run typecheck` | 三套通过 |
| `test:context-contracts` | 6/6 |
| `test:context-manager` | 9/9 |
| `test:context-pruner` | 5/5 |
| `test:context-summary` | 8/8 |
| `test:context-checkpoint` | 3/3 |
| `test:long-task-context-e2e` | 1/1 |
| `test:state` | 8/8 |
| `test:task-conversation` | 20/20 |
| `test:ui-progress` | 3/3 |
| `test:execution-timeline` | 5/5 |

组件级 E2E 覆盖：

- 30 条历史；
- 大工具输出裁剪；
- 摘要校验；
- 检查点提交（归档 + 文件 + Journal 指针）；
- 恢复；
- 归档篡改 → stale。

## 3. 真机验证

启动：

```text
THINKFUSION_CONTEXT_MANAGER=active npm run dev -- --remoteDebuggingPort 9223
```

真实云端会话：

```text
请用一句话说明上下文压缩的作用
```

结果：

- 回答正常返回；
- 综合分析、裁判、结论正常；
- `agent-store.json` 写入：
  - `context.prepared`
  - `context.budget.warning`
- owner 为 `conversation`，`contextId` 已生成；
- 未知窗口保持 `contextWindow: null`、`usageRatio: null`。

证据：

```text
events:
  context.prepared
  context.budget.warning
ownerType: conversation
estimatedTokens: 34
contextWindow: null
usageRatio: null
level: unknown
```

## 4. 未完成

### P5

- 检查点恢复真正接回任务执行（当前 interrupted 继续是新开一轮，先检查工作区）；
- 工具副作用核对；
- 并发恢复/取消保护；
- 真实暂停/恢复真机场景。

### P6

- 统计页上下文指标已加，但未做历史数据回填；
- 30 步**真实工程任务**故障注入未执行（当前是组件级 30 条历史）；
- 长任务真实中断/恢复验收未执行；
- 全入口边界矩阵（Master/Collaboration/Engineering/Debate）未完成。

## 5. 结论

可以确认：

- ContextManager 基础层可用；
- 检查点/归档/恢复组件可用；
- 真实应用在开启开关时能正常回答并写入上下文事件。

不能确认：

- 全部 LT-P5/LT-P6 完成；
- 30 步真实工程任务可恢复；
- 所有入口都使用统一上下文策略。

因此状态保持 **PARTIAL**，不标记“全部完成”。

## 6. 下一步

1. 把检查点恢复接进 `AgentOrchestrator.resume`；
2. 做工具副作用核对与并发保护；
3. 跑 30 步真实工程任务故障注入；
4. 完成全入口策略与边界矩阵；
5. 再更新本报告为最终验收。
