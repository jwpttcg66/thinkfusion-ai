# GCE-P1：Goal Contract 详细设计

**状态：** `DESIGN`；P1 纯函数层已部分实现，接线/确认/持久化未完成。  
**基线：** `main@9026e0e`  
**总设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**契约：** [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)  
**任务：** [GCE-P1](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md#4-gce-p1goal-contract)

## 1. 目标

把“用户原话 + 任务摘要”升级为可追溯的结构化目标契约，同时保持：

- 原始请求逐字保留；
- 模型推断不冒充用户确认；
- 成功标准不来自任务摘要；
- 简单任务不为流程付确认成本，复杂/重大/高风险任务必须确认。

## 2. 组件

```text
GoalReasoner（模型/规则）
  → GoalContractDraft
  → GoalContractValidator（纯函数）
  → GoalConfirmationPolicy（纯函数）
  → GoalContractStore（事件 + 现有 AgentStore/Conversation）
  → GoalContractView（UI）
```

不新增 Runtime、Journal 或第二套任务存储。

| 组件 | 输入 | 输出 | 约束 |
| --- | --- | --- | --- |
| GoalReasoner | 原始请求、工程事实、已有契约 | 六维草案 + 来源 + 置信度 | 不得改写原始请求；无法判断标 `UNRESOLVED` |
| Validator | 契约草案 | `ok/reasons` | 不静默修正；冲突保留双方 |
| ConfirmationPolicy | 风险、目标变更、复杂度 | 自动 `ACTIVE` / 要求确认 | 分级确认，不是所有任务弹窗 |
| GoalContractStore | 契约版本、事件 | 可恢复快照 | 复用 AgentStore/Conversation，不新建库 |
| GoalContractView | 契约 + 任务 | 目标区/确认入口 | 来源可见，未知不隐藏 |

## 3. GoalReasoner

### 3.1 输入

- `originalRequest`：用户原话，逐字；
- 可选 `conversationGoal`：已有 ConversationGoal；
- 可选 `projectFacts`：ECO 已确认事实、约束；
- 可选 `previousContract`：上一版本，用于复核；
- `now`：确定性测试注入。

### 3.2 输出

必须满足 `GoalContract` 六维结构；每个维度包含 `source`、`confidence`、`confirmedByUser`、`conflictsWith`、`evidenceRefs`。

规则：

- 只有用户明确表达或确认的内容可标 `USER_EXPLICIT` / `USER_CONFIRMED`；
- 模型补充的合理目标标 `MODEL_INFERRED`，置信度不得抬到 1；
- 工程事实只进 `PROJECT_EVIDENCE`；
- 能力/安全限制进 `SYSTEM_CONSTRAINT`；
- 缺失维度保留 `UNRESOLVED`，不能编造；
- 模型输出必须通过 schema；失败时不生成“假目标”，转 `CLARIFYING` 或保留旧契约。

### 3.3 不改变的边界

- 用户原话不包装成提示词；GoalReasoner 的模型调用只传“数据 + 机器可读 schema”，不写角色/流程话术；
- 不把 Memory 当本轮目标事实；
- 不把任务摘要当目标或成功标准。

## 4. 成功标准抽取

`SUCCESS_CRITERIA` 维度不能只存一段文本；由独立 `GoalCriterion[]` 表达：

```text
用户原话/已确认目标
  → 提取标准候选
  → 标来源与优先级（MUST/SHOULD/NICE）
  → 缺验证方式则标 PENDING/UNVERIFIED
  → 用户确认（复杂/重大时）
```

禁止路径：

```text
没有标准 → 用 summary 生成“可核对标准” → 显示目标符合度
```

没有标准时：`criteria = []`、`openQuestions += '成功标准尚未明确'`、Goal Fit `UNKNOWN`。

## 5. 确认策略

| 情况 | 行为 |
| --- | --- |
| 简单、低风险、标准明确 | 充分理解后直接 `ACTIVE`，记录自动确认原因 |
| 多标准、跨模块、不可逆修改 | `READY_FOR_CONFIRMATION`，等待用户 |
| 目标删减/替换标准 | `CHANGE_PROPOSED`，必须确认 |
| 用户拒绝变更 | 回到 `ACTIVE`，旧版本与旧标准继续有效 |
| 信息不足 | `CLARIFYING`，提出具体问题，不生成假标准 |

确认不是新 Runtime；沿用现有对话/任务交互和事件记录。

## 6. 版本与变更

- 初始契约 `goalVersion=1`；
- 删除/替换标准 = `change`，用户确认后 `+1`；
- 只补充标准 = `clarify`，版本不变；
- 无标准变化 = `optimize`，版本不变；
- 旧版本 Criterion 保留，按版本可查；
- 目标变更影响未完成任务，已完成且不受影响成果可继承；
- 版本变更不得通过修改任务摘要完成。

## 7. 持久化

复用现有存储边界：

- `GoalContract.goalId` 复用现有 `goalId`（工程默认 `goal:${taskId}`；Conversation 用 `conversationId`）；`AgentTask` 继续使用已有 `goalId/goalVersion`，不新增平行的 `goalContractId`；
- `Conversation` 如尚无版本字段，增加可选 `goalVersion`，或在事件中保存契约版本；不复制契约正文；
- 契约正文/版本通过 `goal.assessment.*`、`goal.confirmed`、`goal.criterion.updated`、`goal.change.*` 事件保存；
- 不新建 `goal.sqlite` 或第二套 Journal；
- 旧任务无契约字段时按 `DRAFT/UNKNOWN` 读取，不迁移、不伪造；
- 事件 payload 只存引用和摘要，正文由事件/快照恢复；
- 旧 `EngineeringGoalView`/`GoalStatusGdc` 是派生读模型，映射见契约 §10.5，不得反向成为第二事实源。

具体字段/事件名先按契约文档核对 `contracts.ts`，能复用则复用，不能复用才新增。

## 8. 与 Orchestrator 的接线点

```text
ConversationRunner（工程分流）
  → GoalContractResolver.ensureForTask(task, request)
  → Orchestrator 在 plan/执行前读取当前 ACTIVE 契约
  → 目标变更使旧计划失效：进入 CHANGEPROPOSED/重规划
```

P1 只要求“创建/读取/确认/变更”可用；目标变更的完整重规划由 P3/P4 消费。

## 9. 失败与降级

| 失败 | 行为 |
| --- | --- |
| GoalReasoner 超时/JSON 非法 | 保留旧契约；无旧契约则 `CLARIFYING` 或 `UNDERSTANDING`，不生成假目标 |
| 契约校验失败 | 不进入 ACTIVE；返回 reasons |
| 事件写入失败 | 不阻塞任务；契约指针不前进，保持旧版本 |
| 用户拒绝变更 | 旧契约继续有效，记录拒绝 |
| 版本不一致 | 下游任务标 `needs_replan`，不静默覆盖 |

## 10. 验收

- 六维缺失不编造；推断/确认分离；
- summary 不进入 Criterion；
- 分级确认路径可测试；
- 拒绝变更后旧版本仍有效；
- 旧任务可读，不强制迁移；
- 真机：简单任务不弹确认；复杂目标可见确认。

## 11. 未决

- GoalReasoner 用哪个模型/是否需要本地规则兜底；
- 契约正文最佳存储位置（事件快照 vs 独立记录）需在 P0 契约核对后定；
- UI 确认入口放在目标区还是任务提交前，需按 P5 交互定稿。
