# GCE-P2：Criterion ↔ Evidence 详细设计

**状态：** `DESIGN`；纯函数层已实现，生产接线未完成。  
**基线：** `main@9026e0e`  
**总设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**契约：** [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)  
**任务：** [GCE-P2](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md#5-gce-p2criterion--evidence-闭环)

## 1. 目标

让每条成功标准能回答：**有没有证据、证据类型是否匹配、是否真正满足**。同时严格区分：

```text
执行完成（Execution Completed）
≠ 验证通过（Verification Passed）
≠ 目标达成（Goal Achieved）
```

## 2. 数据流

```text
ExecutionReport / verification
  → EvidenceNormalizer
  → GoalEvidenceLink[]
  → CriterionEvidenceEvaluator
  → GoalCriterion.status
  → GoalFitAssessment
  → 交付结论 / 决策输入
```

不新建 EvidenceStore；证据正文仍在现有 ExecutionReport/EvidencePack/Journal，`GoalEvidenceLink` 只保存引用。

## 3. 证据归一化

输入：

- `StepResult`（工具、参数、结果、状态、耗时）；
- `ExecutionVerification`（checks、changedPaths、verified/fullyVerified/reasons）；
- 可选 `ReviewVerdict`、`UserAcceptance`、ECO 证据。

输出 `GoalEvidenceLink`：

| 场景 | type | 规则 |
| --- | --- | --- |
| 模型文本声称完成 | `MODEL_CLAIM` | 只能证明声明，不能单独支撑 MET |
| 工具执行返回 | `TOOL_RESULT` | 按工具结果判断，不把 exit 0 自动当目标达成 |
| 写文件后回读 | `FILE_READBACK` | 文本改动可作验证；代码回读不等于编译/运行 |
| 编译/构建 | `BUILD_RESULT` | 需真实退出码/输出 |
| 测试 | `TEST_RESULT` | 需真实退出码/输出 |
| 实际运行 | `RUNTIME_RESULT` | 需真实运行场景与断言 |
| 集成 | `INTEGRATION_RESULT` | 组件组合验证 |
| 用户接受 | `USER_ACCEPTANCE` | 保留接受时未验证缺口 |

规则：

- 证据必须带 `goalVersion`、`criterionId`（可后关联，但最终必须有）；
- `verificationStatus` 只来自真实结果，不能由模型自报；
- 代码改动的 `FILE_READBACK` 不能替代构建/测试；
- 一个证据可关联多条 Criterion，但每条关系独立判定。

## 4. Criterion 判定

纯函数（已实现于 `shared/goal-evidence.ts`）：

```text
WAIVED → WAIVED（保留授权，不被证据覆盖）
适用 PASSED 证据 → MET
适用 FAILED 证据 → UNMET
仅 MODEL_CLAIM / PENDING / UNKNOWN / 不适用类型 → UNVERIFIED
无证据 → PENDING
```

`acceptedEvidenceTypes` 可限定某条标准接受的证据；缺省不限制类型，但 `MODEL_CLAIM` 永远不能使 `MET` 成立。

## 5. Goal Fit 汇总

`assessGoalContractFit()` 逐条汇总：

| 条件 | fit |
| --- | --- |
| 无 Criterion | `UNKNOWN` |
| 阻塞风险或 MUST `UNMET` | `GAP` |
| MUST `PARTIAL/UNVERIFIED` | `PARTIAL` |
| 有豁免/非核心缺口 | `WITH_RISKS` |
| 所有标准 MET | `MET` |

必须同时返回计数、证据完整度、阻塞项。不能使用整体 `verified/fullyVerified` 代替。

## 6. 三种完成状态

`DeliveryState`：

```text
execution: PENDING | COMPLETED | FAILED | CANCELLED
verification: UNVERIFIED | PARTIAL | PASSED | FAILED
goal: UNKNOWN | GAP | PARTIAL | WITH_RISKS | MET
```

约束：

- `execution.COMPLETED` 不能推导 `verification.PASSED`；
- `verification.PASSED` 不能推导 `goal.MET`；
- 完全权限允许未验证收尾，但 `verification` 保持 `UNVERIFIED`，摘要写明缺口；
- 用户接受未验证时记录 `USER_ACCEPTANCE` 与缺口，不改写历史证据。

## 7. WorkTask 映射

`WorkTask` 增加可选 `criterionIds[]`（已实现类型字段）：

- 一条 Criterion 可由多个任务共同承接；
- 一个任务可服务多条 Criterion；
- 旧任务没有映射：`criterionCoverage` 视为未覆盖，不假装；
- MUST 未覆盖 → `coverageGaps.blocking`，P4 分解门禁阻断；
- SHOULD/NICE 未覆盖 → advisory，不阻断但可见。

## 8. 与现有验证逻辑的边界

`verification.ts` 继续负责“本轮执行是否可验证”；

`goal-evidence.ts` 只负责“Criterion 是否被证据满足”。

例如文本改动：

```text
fs.writeFile(note.txt) → fs.readFile(note.txt) PASSED
verification: PASSED（文本回读）
Criterion: 文本内容正确 → MET
```

代码改动：

```text
fs.writeFile(src/x.ts) → fs.readFile(src/x.ts) PASSED
verification: 不能仅凭回读算 PASSED
Criterion: 单元测试通过 → 仍需 TEST_RESULT
```

## 9. 持久化与事件

- `GoalEvidenceLink` 可作为事件 payload/报告派生物，不重复存证据正文；
- Criterion 更新写 `goal.criterion.updated`（或复用现有语义）；
- 交付结论写 `goal.fit.assessed`；
- 事件必须带 `goalVersion/criterionId/evidenceId`（或可解析引用）。

## 10. 失败与降级

| 情况 | 行为 |
| --- | --- |
| 证据缺失 | Criterion `UNVERIFIED`，Goal Fit 不 `MET` |
| 证据类型不适用 | 不把该证据算入 MET |
| 证据版本不匹配 | 标 stale，要求重新验证 |
| 报告与评审冲突 | 保留双方，Goal Fit `GAP/PARTIAL`，不静默选一方 |
| 证据写入失败 | 不影响执行，但不能据此宣称目标达成 |

## 11. 验收

- `MODEL_CLAIM` 单独不能 MET；
- 文本回读可 MET 文本标准，代码回读不能 MET 代码标准；
- MUST 无任务承接阻断；
- `execution.COMPLETED + verification.UNVERIFIED` 不产生 `goal.MET`；
- 旧报告无 Goal Criterion 时显示 `UNKNOWN`，不补造；
- 真机文本/代码各一次验证。

## 12. 未决

- Criterion 与 Evidence 的关联是在执行报告生成时建立，还是在 UI/决策前补关联；
- 一个证据对应多标准时的置信度传播；
- 旧任务 evidence 迁移策略（P0 核对后定）。
