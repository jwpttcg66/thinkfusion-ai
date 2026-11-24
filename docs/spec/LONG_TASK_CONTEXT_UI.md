# 长任务与上下文压缩 · UI 规格

状态：设计冻结，未实施  
基线：`main` · `e336ae4` · 2026-11-24  
相关：[契约](LONG_TASK_CONTEXT_CONTRACTS.md) · [架构](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md) · [任务书](../implementation/LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 原则

1. **只画发生过的事**：没有事件就没有进度，没有执行就没有“已验证”。
2. **未知不是 0**：Token、费用、窗口未知显示“未提供”。
3. **压缩可见**：预警、摘要、提交、失败、过期都能在轨迹里查到。
4. **摘要不等于进度**：模型摘要不能替代步骤状态、工具结果和 Evidence。
5. **不打扰主流程**：上下文状态是辅助信息，不抢任务对话与执行记录的位置。

## 2. 页面结构

延续现有工程工作台：

- 对话页：任务进度、计划、时间线、交付；
- 输出页：计划树、活动流、事件详情、执行日志；
- 轨迹页：生命周期轨迹；
- 统计页：Token、费用、压缩指标。

新增内容只挂在已有页签，不新增一级导航。

## 3. 对话页

### 3.1 任务进度卡

在现有 `TaskProgressCard` 增加一行上下文状态：

```text
上下文  78%  ·  输入估算 156K  ·  压缩后 42K  ·  检查点 CP-003
```

状态：

| 状态 | 文案 |
| --- | --- |
| normal | 正常 |
| warning | 接近上限（65%） |
| compaction | 正在压缩 |
| committed | 已压缩（CP-003） |
| failed | 摘要失败，保留旧上下文 |
| stale | 摘要已过期，等待重新生成 |
| unknown | 窗口未提供；如配置了保守输入上限，显示“未提供（保守上限 X）”，不显示百分比 |

规则：

- 没有预算数据时显示“未提供”，不显示 0%；
- 窗口未知时不计算 65/75/85% 的使用率；只显示“未提供”或“保守上限”；
- 保守上限不能标成 Provider 窗口；
- 正在压缩时不得显示“已完成”；
- 摘要失败不隐藏任务其他进度。

### 3.2 压缩事件卡（时间线）

压缩不应打断对话流；建议以一条可展开的 note 出现：

```text
上下文压缩 · 68% → 31%
CP-003 · 摘要 2026-11-24 10:22 · 保留最近 12 条事件
```

展开后：

- 压缩前/后 Token；
- 被压缩事件范围；
- 摘要全文；
- 保留的最近事件；
- 引用 Evidence；
- 摘要模型与费用；
- 校验结果；
- 失败/过期原因。

### 3.3 暂停/中断卡

新增状态必须可读：

| 状态 | 文案 | 动作 |
| --- | --- | --- |
| paused | 已暂停 | 继续 |
| interrupted | 上次运行被中断 | 检查并继续 / 放弃 |
| budget_exhausted | 已达到预算 | 追加预算 / 结束 |
| blocked | 被外部条件阻塞 | 查看原因 / 重试 |

`interrupted` 不能显示成“失败”。

## 4. 输出页

活动流增加 `context` 分类：

- `context.budget.warning`
- `context.compaction.started`
- `context.compaction.summary.ready`
- `context.compaction.committed`
- `context.compaction.failed`
- `context.compaction.stale`
- `context.recovered`

事件详情显示：

- contextId / checkpointId；
- taskId / runId / roundId；
- 来源事件范围；
- 前后 Token；
- 模型与费用；
- 失败原因；
- 是否 stale。

## 5. 轨迹页

新增“上下文”分组：

| 时间 | 事件 | 说明 |
| --- | --- | --- |
| 10:21:10 | Context Warning | 达到 65% |
| 10:22:15 | Compaction Started | 生成后台摘要 |
| 10:22:48 | Summary Ready | 摘要生成完成 |
| 10:23:01 | Compaction Committed | 检查点 CP-003 提交 |
| 10:23:02 | Context Rebuilt | 下一次请求使用新上下文 |

点击一条记录打开详情，字段同 3.2。

## 6. 统计页

新增表格：

| 指标 | 说明 | 未知 |
| --- | --- | --- |
| 输入 Token | Provider 实际 | 未提供 |
| 输出 Token | Provider 实际 | 未提供 |
| 压缩前 Token | 估算/实际 | 未提供 |
| 压缩后 Token | 估算/实际 | 未提供 |
| 压缩次数 | committed 数 | 0 是真实 0 |
| 摘要费用 | 单独归集 | 未提供 |
| 溢出恢复次数 | Provider overflow 重试 | 0 |
| 估算误差 | 实际 - 估算 | 未提供 |

规则：

- 0 与未知分开；
- 费用未知不显示货币符号；
- 图表缺失数据留空，不插 0。

## 7. 状态与事件映射

| UI | 事件/字段 |
| --- | --- |
| 上下文百分比 | `BudgetDecision.usageRatio`；为 null 时显示“未提供” |
| 预警 | `context.budget.warning` |
| 正在压缩 | `context.compaction.started` |
| 摘要完成 | `context.compaction.summary.ready` |
| 已提交 | `context.compaction.committed` + `task.checkpointId` |
| 失败 | `context.compaction.failed` |
| 过期 | `context.compaction.stale` |
| 恢复 | `context.recovered` |
| 暂停/中断 | `task.status` + `interrupted` 事件 |

## 8. 文案

- “未提供”：Provider 没给，不是 0；
- “估算”：本地估算，不是 Provider 实际；
- “已压缩”：只表示本次请求使用摘要，不表示任务完成；
- “部分验证”：有检查通过，但没有覆盖全部完成条件；
- “摘要失败，保留旧上下文”：不是任务失败。

禁止：

- “模型已停止”用于网页 `give-up`；
- “测试通过”没有执行证据；
- “已压缩”但检查点未提交；
- “0 Token”代替未知。

## 8.5 数据来源与展示边界

必须区分五类数据，不能用一种冒充另一种：

| 来源 | 展示 |
| --- | --- |
| Provider 实际返回的 reasoning | 按现有策略展示或折叠；没有就“未提供” |
| 模型正文回答 | 正常展示 |
| 工具执行事件/参数/stdout/stderr | 执行记录/详情，不伪装成模型推理 |
| 系统生成的进度说明 | 标明是系统状态，不是模型原文 |
| 压缩摘要 | 标明“摘要”，不是 reasoning、不是执行事实 |

规则：

- Provider 没返回 reasoning 时，显示“未提供”，不生成一份假推理；
- 不得把系统摘要写进 reasoning 字段；
- 不得把模型回答伪装成工具结果；
- 摘要中的“已完成/已验证”必须能点回原始事件；
- 压缩事件只带 `sourceEventIdsPreview` 时，UI 标明“预览”，完整范围在检查点详情。

## 9. 可访问性

- 百分比有文本，不只靠颜色；
- 压缩事件可键盘展开；
- 失败/过期不只靠红色；
- 时间线按时间排序，屏幕阅读器可读；
- 图表提供表格替代。

## 10. 测试

| 测试 | 断言 |
| --- | --- |
| 上下文卡 | normal/warning/compaction/committed/failed/stale 文案 |
| 未知值 | 显示“未提供”，不显示 0 |
| 暂停/中断 | 状态与动作正确 |
| 轨迹 | 压缩事件顺序、刷新恢复、去重 |
| 统计 | 0 与未知区分 |
| 可访问性 | 键盘/文本替代 |
| 真机 | 真实任务压缩与恢复可见 |

## 11. 不做的 UI

- 不做独立“上下文管理”一级页面；
- 不做手动编辑摘要；
- 不做压缩开关的临时弹窗；
- 不在对话流里放大段摘要正文；
- 不把摘要当任务结论。

## 12. 依赖

- P4：预算、压缩状态、Usage；
- P5：暂停/中断/恢复状态；
- P6：本规格实现。
