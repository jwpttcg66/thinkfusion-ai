# GCE-P4：TDL、ECO、DMOCA 接入设计

**状态：** `DESIGN`，未实现。  
**基线：** `main@9026e0e`  
**总设计：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**契约：** [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)  
**任务：** [GCE-P4](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md#7-gce-p4tdl-与动态协作接入)

## 1. 目标

让“目标标准 → 任务 → 上下文 → 模型贡献 → 证据”共享同一套版本；不新建任务树、上下文引擎或选模系统。

## 2. TDL 映射

### 2.1 任务字段

`WorkTask` 已有时：`workId`、`parentTaskId`、`level`、`dependencies`、`acceptanceCriteria`、`cycleId`、`goalId`、`goalVersion`、`revision`。

新增（可选，兼容旧任务）：

```ts
criterionIds?: string[];
```

规则：

- 只承接 `GoalCriterion` 的逻辑 ID，不复制 Criterion 正文；
- 任务删除/重规划时 Criterion 映射随之失效；
- `acceptanceCriteria` 仍保留任务级验收文本，但不替代 Goal Criterion；
- 旧任务无 `criterionIds` → 覆盖检查视为未覆盖，不自动绑定。

### 2.2 分解质量门禁

```text
Plan / WorkTask 草案
  → 结构校验（ID、依赖、层级）
  → Criterion 覆盖检查
  → 可验收检查
  → 重复/循环检查
  → ECO 请求检查
  → 通过 / NEEDS_ANALYSIS / CLARIFY_GOAL
```

阻断条件：

- MUST Criterion 没有任务承接；
- 任务无验收方式；
- 循环依赖；
- 无目标价值的重复任务；
- 关键依赖缺失。

提示条件：

- SHOULD/NICE 未覆盖；
- 任务粒度过大/过小；
- 可并行但暂串行。

### 2.3 子任务循环

L2 保留 `cycleId` 独立身份，但：

- 不新建 Agent Runtime；
- 不把独立 ID 宣称为物理并行；
- 共享主执行链时，子任务保留自己的目标映射、阶段记录、执行证据、审核与集成状态；
- 规划/执行顺序仍由现有调度决定。

## 3. ECO 正式参与资格

### 3.1 上下文包

正式参与者至少需要：

1. Goal Contract + Version；
2. 当前 Cycle/Stage/任务；
3. 相关工程结构（包、符号、依赖、调用）；
4. 已确认事实与约束；
5. 历史设计与决策；
6. 未解决问题；
7. 相关证据与变更；
8. 目标 Criterion。

### 3.2 充分度等级

| 等级 | 可用于 | 限制 |
| --- | --- | --- |
| `SUFFICIENT` | 正式设计/评审裁决 | 可进入决策 |
| `PARTIAL` | 初步意见、风险提示 | 不得成为正式架构裁决者 |
| `INSUFFICIENT` | 只能提问/请求补上下文 | 输出标“有限上下文” |

规则：

- 每个正式参与者记录 `ecoContextVersion`；
- 上下文中 `MODEL_INFERRED` 与 `PROJECT_EVIDENCE` 必须标源；
- ECO 过期 → `needs_context_refresh`，不沿用旧结论；
- 旁听模型输出不得冒充正式设计结论。

## 4. DMOCA 阶段化选模

### 4.1 阶段角色

| 阶段 | 建议角色 |
| --- | --- |
| GOAL_REASONING | Lead + 必要领域分析者 |
| ANALYSIS | Analyst / Challenger |
| DESIGN | Architect / Challenger |
| DESIGN_DEBATE | 真实分歧参与者 |
| PLANNING | Lead / Implementer |
| IMPLEMENTATION | Implementer / 工具执行者 |
| REVIEW | Reviewer / Challenger |
| REVIEW_DEBATE | 争议双方 + 裁决者 |
| CONCLUSION | Integrator |

角色是职责，不是固定模型身份。一个模型可跨阶段换角色。

### 4.2 选模输入

```text
阶段
任务复杂度
目标风险
ECO 充分度
已有贡献覆盖
真实分歧
成本预算
可用性/健康
```

### 4.3 辩论触发

- 有真实方案冲突；
- 审核意见与实现者结论不一致；
- 不同模型对事实判断冲突；
- 高风险/不可逆；
- 目标符合度争议。

无真实分歧必须记录 skipped 原因，不生成伪造辩论。

## 5. 贡献与决策版本

每次正式决策绑定：

```text
goalId + goalVersion
cycleId
workTaskId + revision
ecoContextVersion
contributionSnapshotVersion
evidenceRefs[]
decisionId
```

未完整返回/超时/失败的模型记录 `unresolved`，不写成一致意见。

采纳/拒绝理由必须可追溯；同一贡献不能在不同版本间静默复用。

## 6. 与现有模块的接线

| 模块 | 接入 |
| --- | --- |
| `task-decomposition.ts` | 增加 criterionIds、覆盖检查、版本绑定 |
| `subtask-cycle.ts` | 保留独立 cycleId；记录阶段/证据/审核/集成 |
| `eco.ts` / `eco-explore.ts` | 作为正式参与资格与版本来源 |
| `dmoca.ts` | 按阶段/风险/贡献缺口选人；绑定版本 |
| `orchestrator.ts` | 将 TDL/ECO/DMOCA 结果送入 Cycle 决策 |
| `version-consistency.ts` | 校验 Goal/Criterion/ECO/贡献/证据版本 |

## 7. 失败与降级

| 情况 | 行为 |
| --- | --- |
| ECO 不足 | 只给有限意见；不能正式裁决 |
| 模型超时/失败 | unresolved；不伪造一致 |
| Criterion 未覆盖 | MUST 阻断；SHOULD/NICE 提示 |
| 贡献版本不匹配 | 重新获取或标 stale |
| 任务树冲突 | 回到 REPLAN，不直接执行 |
| 串行执行 | 如实说明，不宣称并行 |

## 8. 验收

- MUST 无承接阻断；
- 旧任务无映射不被假装覆盖；
- ECO 不足的模型不能成为正式裁决者；
- 贡献/决策绑定版本可追溯；
- 无分歧不伪造辩论；
- 真机：一次设计阶段按需辩论、一次任务覆盖门禁。

## 9. 未决

- Criterion 覆盖由 Planner 输出还是系统自动映射；
- ECO 充分度的量化阈值；
- 子任务循环保留多少独立阶段记录而不增加 UI 噪音。
