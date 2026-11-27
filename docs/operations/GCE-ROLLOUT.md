# GCE 迁移、灰度与回滚

**状态：** `DESIGN`，未执行生产灰度。  
**基线：** `main@9026e0e`  
**设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](../architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**测试：** [GCE-TEST-PLAN.md](../implementation/GCE-TEST-PLAN.md)

本文定义上线策略和兼容边界，不代表功能已存在。当前状态以 [STATUS.md](../implementation/STATUS.md) 为准。

## 1. 兼容原则

- 旧任务、旧事件、旧会话继续可读；缺少 Goal Contract 时按“未建立目标契约”读取，不伪造六维内容。
- 新增字段全部可选；旧 `task.completed`、`report.ready`、`goal.fit` 事件仍可投影。
- 不新建第二套 Journal/Evidence/TaskManager/Runtime；扩展现有契约和投影。
- 旧任务首次进入新链路时生成 `DRAFT` 契约，成功标准为空，Goal Fit `UNKNOWN`。
- 旧 Goal Version 缺省视为 `1`；不自动升级，不把旧摘要当 Criterion。

## 2. 迁移阶段

| 阶段 | 行为 | 退出条件 |
| --- | --- | --- |
| M0 只读影子 | 根据旧任务派生 Goal Contract 视图，只记录差异；不参与决策、不改任务 | 差异报告覆盖主要任务形态；无写入副作用 |
| M1 目标展示 | 展示 Goal Contract/Criterion，决策仍走旧 `complete/repair` | 现有任务不退化；UI 连续文档流保持 |
| M2 Criterion 证据 | 逐条 Goal Fit 参与展示和交付结论，但不阻断执行 | 文本/代码验证分类正确；无 Criterion 时明确 `UNKNOWN` |
| M3 Cycle 决策 | 新决策出口接入 Orchestrator，旧四出口作为兼容映射 | 修复/重规划/重设计/澄清/等待均有回归与真机样本 |
| M4 默认评估 | 新任务默认启用；旧任务按需迁移 | 回滚演练、备份恢复、版本一致性通过 |

每阶段独立开关/分支，不允许一次性替换全部生产行为。

## 3. 兼容映射

旧 `decideNextEngineeringAction()` 四出口与新决策的临时映射：

| 旧 | 新兼容解释 |
| --- | --- |
| `complete` | `COMPLETE`，但必须通过 Goal Fit；无 Criterion 时不得直接 `MET` |
| `repair` | `REPAIR`；若证据显示设计/分析不成立，升级为 `REDESIGN`/`REANALYZE` |
| `fail_budget` | `BLOCKED` 或 `WAIT_USER` |
| `fail_delivery` | `BLOCKED` 或 `REPLAN`，按缺口判断 |

旧 `goal.fit` 事件保持可读；新事件不得复用旧字段承载冲突语义。

## 4. 回滚

- 关闭 GCE 决策开关，回到旧 `complete/repair` 分支；Goal Contract 和 Criterion 只读保留。
- 不删除已写入的 Goal/Criterion/Evidence；只停止新决策消费。
- 若版本链不匹配，任务进入 `WAIT_USER/BLOCKED`，不静默降级为成功。
- 回滚后旧对话流、工程执行、Memory、LT 行为必须保持可用。
- 回滚演练需在默认 userData 的备份副本之外进行？遵循 `AGENTS.md` §10.2：真机只用默认目录；任何数据备份/恢复操作必须明确、可回滚并记录。

## 5. 版本一致性

恢复或继续前检查：

| 检查 | 不一致处理 |
| --- | --- |
| Goal Version | 重规划受影响任务；旧成果可继承 |
| Task Revision | 失效任务树，要求重规划 |
| Criterion 版本 | 旧 Criterion 不参与新目标判定 |
| ECO Context Version | `needs_context_refresh`，重新读取工程 |
| Contribution Snapshot | 重新获取相关模型贡献 |
| Evidence 有效性 | 重新验证；不能复用失效证据 |
| 外部副作用 | 无法确认则停止自动执行，要求人工核对 |

## 6. 观测

新增/扩展事件必须可重放，且与现有 AgentStore 一致。至少观测：

- Goal Contract 创建/确认/变更/拒绝；
- Criterion 状态变化与证据链接；
- Cycle 阶段开始/完成/跳过；
- 决策类型、原因、证据引用；
- 无进展停止原因；
- 恢复版本检查结果；
- Goal Fit 汇总（计数与阻塞项）。

指标：标准覆盖率、证据完整度、无进展停止率、重设计/重分析比例、因版本不一致中断数、未验证交付数。不得把模型自报完成计入“目标达成”。

## 7. 发布门禁

- `typecheck`、GCE 专项测试、既有工程/对话/Memory/LT 回归全绿。
- 真实应用走通：目标确认、文本/代码验证分类、Goal Fit、目标变更、恢复、最终交付文件。
- 备份/恢复包含新数据；回滚开关演练通过。
- 未完成项仍按 `STATUS` 标记，不能用发布说明掩盖。
