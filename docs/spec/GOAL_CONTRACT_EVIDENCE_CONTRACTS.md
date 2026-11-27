# 目标契约与证据闭环规范

**状态：** `DESIGN`；规范定义，不表示当前代码已实现。实现状态见 [STATUS.md](../implementation/STATUS.md)。  
**设计说明：** [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](../architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md)  
**实施任务：** [V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md)  
**基线：** `main@9026e0e`

本文只定义字段、状态、事件与不变量。设计理由和流程图不在这里重复；现有 `AgentStore`/Journal 仍是事实权威，不新建平行存储。

## 1. GoalSource

```ts
export type GoalSource =
  | 'USER_EXPLICIT'
  | 'USER_CONFIRMED'
  | 'MODEL_INFERRED'
  | 'PROJECT_EVIDENCE'
  | 'SYSTEM_CONSTRAINT'
  | 'UNRESOLVED';
```

规则：

- 只有 `USER_EXPLICIT` 和 `USER_CONFIRMED` 可视为用户要求；
- `MODEL_INFERRED` 不能直接升级为用户要求；
- 模型推断与用户原话冲突时，保留两者并记录冲突，不静默覆盖；
- 每条目标信息必须有 `source`、`confidence`、`confirmedByUser`、`conflictsWith`、`evidenceRefs`、`updatedAt`。

## 2. GoalDimension

六维目标结构：

```ts
export type GoalDimensionKind =
  | 'USER_INTENT'
  | 'DESIRED_OUTCOME'
  | 'GOAL_VALUE'
  | 'SUCCESS_CRITERIA'
  | 'IMPLICIT_CONSTRAINT'
  | 'FEASIBILITY';

export interface GoalDimension {
  kind: GoalDimensionKind;
  text: string;
  source: GoalSource;
  confidence: number;          // 0..1
  confirmedByUser: boolean;
  conflictsWith: string[];
  evidenceRefs: string[];
  updatedAt: number;
}
```

原始用户请求保持独立字段 `originalRequest`，六维是对它的理解结果，不替换原文。

## 3. Criterion

```ts
export type CriterionStatus =
  | 'PENDING'
  | 'MET'
  | 'PARTIAL'
  | 'UNMET'
  | 'UNVERIFIED'
  | 'WAIVED';

export interface GoalCriterion {
  criterionId: string;
  goalId: string;
  goalVersion: number;
  description: string;
  source: GoalSource;
  priority: 'MUST' | 'SHOULD' | 'NICE';
  verificationMethod: string;
  acceptanceThreshold: string;
  status: CriterionStatus;
  evidenceRefs: string[];
  /** 该 Criterion 接受的证据类型；缺省不限制，但 MODEL_CLAIM 不能单独使 MET 成立。 */
  acceptedEvidenceTypes?: GoalEvidenceType[];
  waiver?: { authorizedBy: string; reason: string; at: number };
  updatedAt: number;
}
```

不变量：

- 禁止从任务 summary 自动生成 `MUST` Criterion；
- `WAIVED` 必须有用户授权与原因；
- `MET` 必须绑定与 `verificationMethod` 匹配的证据；
- `UNVERIFIED` 不能显示为已满足；
- 目标版本变化后，旧版本 Criterion 必须保留引用，不得原地覆盖。

## 4. GoalContract 状态

```ts
export type GoalContractStatus =
  | 'DRAFT'
  | 'UNDERSTANDING'
  | 'CLARIFYING'
  | 'READY_FOR_CONFIRMATION'
  | 'CONFIRMED'
  | 'ACTIVE'
  | 'AT_RISK'
  | 'CHANGE_PROPOSED'
  | 'BLOCKED'
  | 'ACHIEVED'
  | 'ACHIEVED_WITH_RISKS'
  | 'PARTIAL_ACHIEVEMENT'
  | 'ABANDONED';
```

合法转换：

```text
DRAFT → UNDERSTANDING
UNDERSTANDING → CLARIFYING | READY_FOR_CONFIRMATION | ACTIVE
CLARIFYING → UNDERSTANDING
READY_FOR_CONFIRMATION → CONFIRMED | UNDERSTANDING
CONFIRMED → ACTIVE
ACTIVE → AT_RISK | CHANGE_PROPOSED | BLOCKED | ACHIEVED | ACHIEVED_WITH_RISKS | PARTIAL_ACHIEVEMENT
AT_RISK → ACTIVE | CHANGE_PROPOSED | BLOCKED
CHANGE_PROPOSED → ACTIVE（用户确认后） | ACTIVE（用户拒绝，沿用旧版本）
BLOCKED → ACTIVE | ABANDONED
```

分级确认策略：简单任务可在充分理解后进入 `ACTIVE`；重大目标、约束冲突、不可逆影响必须经过 `READY_FOR_CONFIRMATION` 与 `CONFIRMED`。

## 5. Goal Fit

```ts
export interface GoalFitAssessment {
  goalId: string;
  goalVersion: number;
  cycleId: string;
  criteria: Array<{ criterionId: string; status: CriterionStatus }>;
  met: number;
  partial: number;
  unmet: number;
  unverified: number;
  waived: number;
  blockingRisks: string[];
  evidenceCompleteness: number;  // 0..1
  fit: 'MET' | 'WITH_RISKS' | 'PARTIAL' | 'GAP' | 'UNKNOWN';
  assessedAt: number;
}
```

判定：

- 所有 `MUST` 为 `MET`、无阻塞风险 → `MET`；
- 有授权豁免或已记录风险但不影响核心目标 → `WITH_RISKS`；
- 存在 `PARTIAL` / `UNVERIFIED` 且未阻塞 → `PARTIAL`；
- 存在未处理 `UNMET` 或阻塞风险 → `GAP`；
- 没有 Criterion 或证据不足 → `UNKNOWN`。

不得用整体 `verified/fullyVerified/needsFix` 代替逐条评估；它们只能作为证据输入。

## 6. Cycle

```ts
export type CycleStage =
  | 'GOAL_REASONING'
  | 'ANALYSIS'
  | 'DESIGN'
  | 'DESIGN_DEBATE'
  | 'PLANNING'
  | 'IMPLEMENTATION'
  | 'REVIEW'
  | 'REVIEW_DEBATE'
  | 'CONCLUSION'
  | 'GOAL_FIT'
  | 'NEXT_DECISION';

export interface CycleSnapshot {
  cycleId: string;
  workId: string;
  cycleNumber: number;
  goalId: string;
  goalVersion: number;
  currentStage: CycleStage;
  stageHistory: Array<{
    stage: CycleStage;
    status: 'STARTED' | 'COMPLETED' | 'SKIPPED';
    reason?: string;
    artifactRefs?: string[];
    at: number;
  }>;
  decision?: CycleDecision;
  decisionEvidenceRefs: string[];
  artifactRefs: string[];
  budget?: unknown;
  status: 'ACTIVE' | 'WAITING' | 'BLOCKED' | 'COMPLETED' | 'ABORTED';
  createdAt: number;
  updatedAt: number;
}
```

- `cycleNumber` 只统计完整 Cycle；Round Number 不得替代。
- `SKIPPED` 必须有 `reason`。
- 投影不能替代真实 `STARTED/COMPLETED` 事件。

### 6.1 阶段/决策事件 payload

```ts
export interface CycleStageEvent {
  type: 'cycle.stage.started' | 'cycle.stage.completed' | 'cycle.stage.skipped';
  taskId: string;
  workId: string;
  cycleId: string;
  stage: CycleStage;
  reason?: string;
  artifactRefs?: string[];
  at: number;
}

export interface CycleDecisionEvent {
  type: 'cycle.decision.created';
  taskId: string;
  workId: string;
  cycleId: string;
  decision: CycleDecision;
  at: number;
}
```

旧 `cycle.snapshot` 与新阶段事件并存时：新阶段事件是阶段事实，`cycle.snapshot` 只作旧任务/兼容投影；`cycle.snapshot.decision` 是兼容镜像。

## 7. CycleDecision

```ts
export type CycleDecisionType =
  | 'CONTINUE'
  | 'REPAIR'
  | 'REPLAN'
  | 'REDESIGN'
  | 'REANALYZE'
  | 'CLARIFY_GOAL'
  | 'CHANGE_PROPOSED'
  | 'WAIT_USER'
  | 'BLOCKED'
  | 'COMPLETE'
  | 'ABORT';

export interface CycleDecision {
  decisionId: string;
  cycleId: string;
  decisionType: CycleDecisionType;
  reason: string;
  evidenceRefs: string[];
  goalVersion: number;
  taskRevision: number;
  ecoContextVersion?: string;
  contributionSnapshotVersion?: string;
  createdAt: number;
}
```

正式决策必须绑定版本；版本不匹配不得静默复用。`COMPLETE` 只能在 Goal Fit `MET` 或经用户明确授权的 `WITH_RISKS` 下产生。

## 8. Evidence

证据类型与范围：

```ts
export type EvidenceType =
  | 'MODEL_CLAIM'
  | 'TOOL_RESULT'
  | 'FILE_READBACK'
  | 'BUILD_RESULT'
  | 'TEST_RESULT'
  | 'RUNTIME_RESULT'
  | 'INTEGRATION_RESULT'
  | 'USER_ACCEPTANCE';

export interface GoalEvidenceLink {
  evidenceId: string;
  workId: string;
  cycleId: string;
  workTaskId?: string;
  criterionId?: string;
  goalVersion: number;
  evidenceType: EvidenceType;
  source: string;
  contentHash?: string;
  verificationStatus: 'PENDING' | 'PASSED' | 'FAILED' | 'UNKNOWN';
  linkedAt: number;
}
```

适用范围：

- `FILE_READBACK` 只证明写入内容可读；文本改动可作验证，代码回读不证明编译或运行。
- `BUILD_RESULT` / `TEST_RESULT` / `RUNTIME_RESULT` 必须来自真实执行记录。
- `MODEL_CLAIM` 不能单独支撑 `MET`。
- `USER_ACCEPTANCE` 保留接受时的未验证缺口，不抹除事实。

### 8.1 现有 EvidenceRef/ExecutionReport 映射

| 现有来源 | 新类型 | 规则 |
| --- | --- | --- |
| `EvidenceRef.kind=file` + 写后同路径回读 | `FILE_READBACK` | 文本改动可作该类验证；代码回读不替代编译/运行 |
| `StepResult.tool=test.run` | `TEST_RESULT` | 使用真实 exitCode/stdout，不按模型声明 |
| `StepResult.tool=shell.run`/构建命令 | `BUILD_RESULT` 或 `RUNTIME_RESULT` | 按命令语义与实际退出码归类；无法归类时 `TOOL_RESULT` |
| `StepResult.tool=fs.*` 写/改 | `TOOL_RESULT` | 只证明工具结果；目标满足仍看 Criterion |
| `EvidenceRef.kind=command` | `TEST_RESULT`/`BUILD_RESULT`/`RUNTIME_RESULT` | 需要命令与退出码上下文，不能只凭 URL/文本 |
| `EvidenceRef.kind=url` | `TOOL_RESULT` | 只能证明抓取/来源，不等于目标证据 |
| 模型回答中的完成声明 | `MODEL_CLAIM` | 永远不能单独支撑 `MET` |
| 用户明确接受未验证交付 | `USER_ACCEPTANCE` | 保留缺口，不把未验证改成已验证 |

`EvidenceRef` 本身不足以判定新类型；归一化必须同时读取 `StepResult` 和报告上下文。

## 9. 三种完成状态

```ts
export type DeliveryState = {
  execution: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  verification: 'UNVERIFIED' | 'PARTIAL' | 'PASSED' | 'FAILED';
  goal: 'UNKNOWN' | 'GAP' | 'PARTIAL' | 'WITH_RISKS' | 'MET';
};
```

- `execution.COMPLETED` 不能推导 `verification.PASSED`。
- `verification.PASSED` 不能推导 `goal.MET`。
- 完全权限允许未验证收尾，但 `verification` 必须保持 `UNVERIFIED`，摘要必须写明缺口。

## 10. 事件语义

事件名必须先核对 `contracts.ts`，优先复用已有语义。以下为需要评估的业务语义，不表示当前已存在：

| 语义 | 用途 |
| --- | --- |
| `goal.assessment.created/updated` | 目标理解结果 |
| `goal.confirmation.requested` / `goal.confirmed` | 分级确认 |
| `goal.criterion.updated` | Criterion 状态变化 |
| `goal.change.proposed/confirmed` | 目标变更与确认 |
| `cycle.created` | 完整 Cycle |
| `cycle.stage.started/completed/skipped` | 阶段真实发生 |
| `cycle.decision.created` | 下一步决策 |
| `goal.fit`（扩展字段） | 目标符合度评估；不新增 `goal.fit.assessed` |
| `evidence.linked` | 证据关联 Criterion |

事件 payload 只存引用和摘要；完整正文存现有 Journal/Evidence 记录。

## 10.5 与现有 GDC 模型/事件的兼容

### 状态映射

现有 `GoalStatusGdc` 是读模型；新 `GoalContractStatus` 是契约状态。旧视图由契约派生，不是第二事实源。

| 现有 | 新 |
| --- | --- |
| `draft` | `DRAFT` |
| `clarifying` | `CLARIFYING` |
| `confirmed` | `CONFIRMED` |
| `active` | `ACTIVE` |
| `at_risk` | `AT_RISK` |
| `change_proposed` | `CHANGE_PROPOSED` |
| `blocked` | `BLOCKED` |
| `achieved` | `ACHIEVED` |
| `abandoned` | `ABANDONED` |
| — | `UNDERSTANDING`、`READY_FOR_CONFIRMATION`、`ACHIEVED_WITH_RISKS`、`PARTIAL_ACHIEVEMENT`（新状态，旧视图需升级） |

### Fit 映射

| 现有 `GoalFitStatus` | 新 `GoalContractFit` |
| --- | --- |
| `met` | `MET` |
| `gap` | `GAP` |
| `unknown` | `UNKNOWN` |
| `pending` | 有 Criterion 时 `PARTIAL`，否则 `UNKNOWN` |
| — | `WITH_RISKS`（旧视图不能表达，P5 UI 必须升级显示） |

`EngineeringGoalView` 继续作为 UI 读模型，但必须从 `GoalContract` 派生；禁止反向修改契约。

### 事件兼容

- **不新增 `goal.fit.assessed`**；扩展现有 `goal.fit` 的可选字段：`goalVersion`、`criteria[]`、计数、`blockingRisks`。旧字段 `fit/notes` 保留。
- 新 `cycle.stage.started/completed/skipped` 是真实阶段事件；旧 `cycle.snapshot` 保留为旧任务/兼容投影，新事件存在时以新事件为准。
- `cycle.decision.created` 是决策事实；`cycle.snapshot.decision` 是兼容镜像，不覆盖新决策。
- `goal.*` 事件只存引用/摘要；完整契约正文仍由现有 Journal/Conversation 记录恢复。

## 11. 不变量

1. 用户原话不被隐藏提示词替换。
2. 模型推断不标记为用户确认。
3. 任务摘要不自动生成强制成功标准。
4. 执行完成不等于验证通过，验证通过不等于目标达成。
5. 阶段投影不等于阶段真实发生。
6. L2 独立 ID 不等于物理并行。
7. 辩论参与人数不等于决策质量。
8. 版本不匹配的结论不静默复用。
9. 压缩不删除目标版本、决策和证据引用。
10. 恢复前必须做目标/任务/ECO/贡献/证据一致性检查。
11. 无进展时停止自动循环，不用轮数上限掩盖重复失败。
12. 不新建第二套 Journal、EvidenceStore、Approval、Verifier 或 Runtime。
