# GCE-P5：UI 与长任务恢复详细设计

**状态：** `PARTIAL`：目标/Criterion/真实阶段/决策已接入；目标变更 UI、恢复版本一致性与真机长任务未完成。
**基线：** `main@9026e0e`  
**总设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**UI 规格：** [GOAL_CONTRACT_UI.md](../spec/GOAL_CONTRACT_UI.md)  
**恢复契约：** [LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)  
**任务：** [GCE-P5](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md#8-gce-p5ui-与长任务验收)

## 1. 目标

在不破坏最新连续文档式对话流的前提下，把 Goal Contract、Criterion、Goal Fit、Cycle 决策和恢复状态接到真实 UI；恢复后不复用过期目标/结论。

## 2. UI 数据源

| 区域 | 数据源 | 约束 |
| --- | --- | --- |
| 目标区 | GoalContract + event refs | 原始请求只读；来源标签可见 |
| Criterion | GoalCriterion + EvidenceLink | MET 必须可展开证据 |
| Goal Fit | GoalFitAssessment | 不显示 `task.completed` 当目标达成 |
| 目标物 | 全部轮次 ExecutionReport/artifact 并集 | 有路径列出；无记录明确写“没有记录到交付文件” |
| 决策 | CycleDecision | 原因/证据/版本可见 |
| 阶段 | cycle.stage.* 真实事件 | 投影不冒充真实阶段 |
| 执行/工具 | 现有 AgentEvent | 保留 step/call 标识 |
| 恢复 | 检查点 + 版本一致性结果 | stale/needs_replan 明确 |

UI 不直接读 checkpoint 文件；由主进程投影为事件/视图。

## 3. 组件接线

保留现有四页：

```text
对话：连续文档主活动区
输出：原始事件/工具/改动
轨迹：阶段/调用/决策
统计：模型/工具/耗时/费用
```

建议新增/扩展的纯投影：

```text
projectGoalContractView()
projectCriterionRows()
projectGoalFitView()
projectCycleDecisionView()
```

这些函数只从事件/契约投影，不写状态；现有 `projectGoalDrivenWorkbench` 可扩展，不新建平行工作台。

不新增：

- 第五个页面；
- 独立定位轨；
- 可以自动折叠真实事件的大卡片；
- 用模型摘要替代执行事实的进度节点。

## 4. 目标变更交互

入口：目标区“修改目标/成功标准”。

状态机：

```text
ACTIVE
 → 用户打开变更
 → CHANGE_PROPOSED（展示 diff、影响任务）
 → 用户确认 → 新 goalVersion，受影响任务 replan
 → 用户拒绝 → ACTIVE，旧版本不变
```

必须显示：

- 新增/删除/修改的 Criterion；
- 删除标准属于重大变更；
- 受影响任务与可继承成果；
- 目标版本变化。

不得通过任务摘要或隐藏 IPC 修改目标。

## 5. 未验证收尾

- 完全权限：允许结束，但 UI 显示 `未验证`/`部分达成` 与缺口。
- 非完全权限：显示继续修复/重新判定/接受未验证。
- “接受未验证”不是“目标达成”；Goal Fit 保持 `GAP/PARTIAL/UNVERIFIED`。

## 6. 长任务恢复范围

检查点除现有任务运行状态外，至少恢复：

```text
GoalContract + goalVersion
CycleSnapshot + currentStage + decision
TDL revision + criterionIds
Plan version
ECO context version
Contribution snapshot version
Evidence links
未解决 Review issues
预算/阻塞原因
可继承交付物
```

## 7. 恢复一致性

| 检查 | 结果 | UI |
| --- | --- | --- |
| Goal 不变、任务/证据兼容 | 继续原阶段 | 显示恢复来源 |
| Goal 变化 | 重规划受影响任务 | `needs_replan` |
| ECO 过期 | 重新读取上下文 | `needs_context_refresh` |
| 贡献版本不匹配 | 重新获取 | 显示 stale |
| Evidence 失效 | 重新验证 | Criterion 回到 UNVERIFIED |
| 外部副作用无法确认 | 停止自动执行 | `WAIT_USER/BLOCKED` |

恢复失败不得静默降级为成功；显示 stale/需要人工。

## 8. 事件与投影

- `cycle.stage.*` 用于阶段；
- `goal.*` 用于契约/确认/变更；
- `goal.criterion.updated` 用于标准；
- `goal.fit`（扩展字段）用于汇总；
- `cycle.decision.created` 用于下一步；
- `context.recovered`/版本事件用于恢复。

旧 `cycle.snapshot` 可继续显示，但不得覆盖真实阶段或决策。

## 9. 可访问性

- 状态同时用文字/图标，不只颜色；
- 每个 Criterion 有可读标签；
- 目标变更确认可键盘操作；
- 长文档流可展开/收起，但默认不隐藏事实。

## 10. 验收

- 目标区、Criterion、Goal Fit、决策可见且可追溯；
- 目标变更确认/拒绝都可操作；
- 没有发生阶段显示未发生；
- 恢复后版本一致性与 stale 可见；
- 连续文档流保持，无独立定位轨/大卡片回退；
- 真机：General/Knowledge/Engineering 各一次，工程含真实文件修改、测试、评审、交付。

## 11. 未决

- 目标区在任务头的具体位置；
- Criterion 多版本切换的交互；
- 恢复提示是否进入主活动区或轨迹页；
- 四页签在窄窗口的折叠方式。
