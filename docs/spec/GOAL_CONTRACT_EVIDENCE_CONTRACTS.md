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
| `goal.fit.assessed` | 目标符合度评估 |
| `evidence.linked` | 证据关联 Criterion |

事件 payload 只存引用和摘要；完整正文存现有 Journal/Evidence 记录。

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
