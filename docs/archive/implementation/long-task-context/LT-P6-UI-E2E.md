# LT-P6 · UI 与长任务验收

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：未开始  
阶段目标：把上下文压缩与长任务状态变成用户可见、可验证、可回滚的能力。  
依赖：LT-P4、LT-P5  
上游：[UI 规格](../../../spec/LONG_TASK_CONTEXT_UI.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- 对话页显示上下文压力、检查点、压缩状态；
- 轨迹页显示压缩事件与详情；
- 统计页显示 Token/费用/压缩指标，未知不为 0；
- 30 步长任务 E2E 通过；
- 崩溃/摘要失败/溢出恢复可复现；
- 验收报告与状态板真实。

## 2. 任务

### LT-P6-01 主页面上下文状态

| 项 | 内容 |
| --- | --- |
| 目标 | 任务页显示上下文与压缩状态 |
| 依赖 | P4-04、P5-02 |
| 接触 | `TaskProgressCard.tsx`、`TaskConversation.tsx`、`style.css` |
| 验收 | normal/warning/compaction/committed/failed/stale 可区分 |
| 测试 | UI 投影；真机截图 |
| 回滚 | 隐藏卡片 |

内容：

- 百分比；
- 输入估算 / 压缩后；
- 最近检查点；
- 后台摘要状态；
- 未知“未提供”。

不显示假 Token，不用摘要冒充进度。

### LT-P6-02 轨迹压缩详情

| 项 | 内容 |
| --- | --- |
| 目标 | 轨迹页展示压缩过程 |
| 依赖 | P3-05、P4-04 |
| 接触 | `TaskTrajectory.tsx`、`EventInspector.tsx`、observability |
| 验收 | warning/started/ready/committed/failed/stale 可查 |
| 测试 | 投影；真机 |
| 回滚 | 隐藏事件 |

详情：

- 前后 Token；
- 范围；
- 摘要；
- 保留历史；
- Evidence；
- 模型/费用；
- 失败/过期原因。

### LT-P6-03 统计指标

| 项 | 内容 |
| --- | --- |
| 目标 | 统计页显示上下文成本与效果 |
| 依赖 | P4-03 |
| 接触 | `TaskStats.tsx`、`task-view.ts` |
| 验收 | 0 与未知区分 |
| 测试 | 投影；真机 |
| 回滚 | 隐藏指标 |

指标：

- 输入/输出 Token；
- 压缩前/后；
- 压缩次数；
- 摘要费用；
- 溢出恢复；
- 估算误差。

### LT-P6-04 长任务故障注入 E2E

| 项 | 内容 |
| --- | --- |
| 目标 | 验证 30 步、压缩、失败、崩溃恢复 |
| 依赖 | P4-04、P5-05 |
| 接触 | `scripts/` 新 E2E、夹具 |
| 验收 | 已完成步骤不重复；未完成可继续；证据完整 |
| 测试 | E2E |
| 回滚 | 标记 skip |

场景：

1. 30 步真实工程任务；
2. 触发 65/75/85%；
3. 摘要模型失败；
4. 应用中断；
5. 恢复；
6. 验证文件/Git/测试/证据；
7. 验证不重复写。

### LT-P6-05 验收报告与状态板

| 项 | 内容 |
| --- | --- |
| 目标 | 汇总实现、验证、限制 |
| 依赖 | P6-01..04 |
| 接触 | `docs/implementation/LONG-TASK-CONTEXT-ACCEPTANCE.md`、任务书 |
| 验收 | 文档与代码一致 |
| 测试 | 文档评审 |
| 回滚 | 无 |

内容：

- 每任务 IMPLEMENTED/VERIFIED/TESTED；
- 真机证据；
- 已知限制；
- 回滚演练；
- 修正 `UNIFIED-TASK-RUNTIME` 状态。

## 3. PR 切片

| PR | 内容 |
| --- | --- |
| LT-P6-A | P6-01 主页面 |
| LT-P6-B | P6-02 轨迹 + P6-03 统计 |
| LT-P6-C | P6-04 E2E |
| LT-P6-D | P6-05 验收报告 |

## 4. 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:task-conversation
npm run test:task-trajectory
npm run test:task-stats
npm run test:long-task-context-e2e
```

真机：

1. OpenIDEA 启动；
2. 执行 30 步任务；
3. 观察压缩；
4. 中断/恢复；
5. 交付完整。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| UI 显示假数据 | 只读真实事件/字段 |
| 压缩过程被隐藏 | 轨迹详情 |
| E2E 太慢 | 分层：单元 + 集成 + 少量真机 |
| 恢复测试破坏工作区 | 临时仓库/夹具 |
| 未知值显示 0 | 明确“未提供” |

## 6. 状态清单

- [ ] P6-01 主页面
- [ ] P6-02 轨迹
- [ ] P6-03 统计
- [ ] P6-04 E2E
- [ ] P6-05 验收报告
