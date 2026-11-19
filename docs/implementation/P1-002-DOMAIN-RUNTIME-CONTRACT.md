# P1-002 领域与运行时契约

状态：**P0-F..J 设计修订版（2026-11-18）**；产品方向已确认；P0 门禁未过；P0-J 待评审。
设计分支：`product-v3`；评审快照：`2d05b12`（当前 HEAD 见 git log；历史 P0-B 为 `7d27c6e`）；代码基线：`cd30be3`；`main` 只做集成。
前置：[P1-001 迁移审计](P1-001-MIGRATION-AUDIT.md)。
目标：把 V3 的对象、所有权、生命周期、状态转移、错误/重试/取消/并发/预算、
持久化与事件一次冻结，供 P1-003 映射和 P1-004 实现使用。

> 本文只定义契约，不写实现，不改代码。**所有接口均为目标契约，代码尚未实现（P1 落地）。**
>
> **D4 已采纳**：`Plan` 不可变、版本化；`planHistory` 保留旧版本；`TaskGraphState` 删除，
> DAG 由 `Plan.tasks` + `dependsOn` 派生。

---

## 1. 概念边界

### 1.1 运行时状态 ≠ 领域存储

V3 只允许一个**运行时事实来源**：

```text
CollaborationState（运行时事实）
```

领域存储仍可并列存在，它们是**数据仓库**，不是第二个运行时：

```text
AgentStore          对话 / 任务 / 轮次 / 计划 / 事件（journal）
DebateStore         每场辩论
EvidencePackStore   冻结证据包 / 哈希 / 快照
CodeIndex           SQLite + FTS5（代码事实）
Trace               轨迹
MemoryStore         知识记忆（P2，暂不建）
```

规则：

- `CollaborationState` 是**运行时聚合根**：存 Goal、Plan、TaskRuntimeState、Assignment、
  Observation、EvidenceRef、Claim/Conflict/Dispute、Budget、Stop、Deliverable，
  工程任务另有可选 `EngineeringTaskState`。
- 对**大块正文**（证据内容、代码、辩论发言）只存引用 id，不复制正文；
- 领域存储是数据仓库，不反过来驱动调度；
- 不允许出现第二个「当前任务列表」。

### 1.2 一个任务模型，三种上下文

```text
Task（通用）
 ├── GeneralContext
 ├── KnowledgeContext
 └── EngineeringContext
```

- `Task` 只放所有任务共有的字段；
- 工程字段（commit、dirty、diff、测试）放 `EngineeringContext`，不塞进 `Task`；
- 空间不是 Engine，只是上下文 + 能力 + 交付协议。

### 1.3 四条旧回路的新归属

| 旧回路 | 新归属 | 不做什么 |
| --- | --- | --- |
| `ConversationRunner` | 入口 + 生命周期 | 不再决定任务拆分/结束 |
| `AgentOrchestrator` | 执行治理（Runtime） | 不再决定参与者 |
| `DebateOrchestrator` | DebateService/Behavior | 不再是任务入口 |
| `CollaborationResearch` | Planner/Scheduler 的雏形 | 不再按 stage 复制任务 |

---

## 2. 对象目录

| 对象 | 创建者 | 修改者 | 持久化 | 消费方 |
| --- | --- | --- | --- | --- |
| `Goal` | Runner/入口 | 不可变 | `AgentStore`（会话） | Planner / Deliver |
| `Policy` | Planner | 不可变（重规划可出新版） | State | Scheduler / UI |
| `TaskSpec` | Planner | 不可变 | Plan | Scheduler / Runner |
| `TaskRuntimeState` | Runner | Runner（纯转移） | State | Scheduler / UI |
| `TaskGraph` | Planner | 不修改 | **派生，不持久化** | Scheduler |
| `TaskEnvelope` | Planner | 不可变 | State | Runner / Adapter |
| `Participant` | ParticipantManager | 健康状态刷新 | 配置 + 内存 | Planner / Scheduler |
| `Capability` | 代码常量 | 不可变 | 代码 | Planner |
| `Plan` | Planner | Replanner（新版本，不修改旧版） | State | Scheduler / UI |
| `Assignment` | Scheduler | 不可变 | State | Runner / UI |
| `Observation` | Runner | 不可变 | State | Replanner / Deliver |
| `EvidenceRef` | Runner / Tool | 不可变 | State + Pack | Verifier / Deliver |
| `Claim` | Extractor | 不可变 | State | Conflict Detector / Deliver |
| `Conflict` | Detector | 状态（matters） | State | Dispute 判定 |
| `Dispute` | Detector | 状态（resolved） | State | Debate / Deliver |
| `CollaborationState` | Runner | Runner（纯转移） | `AgentStore` | 全部 |
| `Execution` | AgentOrchestrator | 状态 | 领域存储 | Runner / Verifier |
| `Verdict`（别名 `Verification`） | Verifier | 不可变 | State | Deliver |
| `EngineeringTaskState` | 工程任务 | 任务自身 | State（可选） | Deliver / Review |
| `Deliverable` | Deliver | 不可变 | State + 会话 | UI |

---

## 3. 类型契约

### 3.1 Goal / Policy

```ts
export interface Goal {
  goalId: string;
  workspace: 'knowledge' | 'engineering' | 'general';
  /** 用户原话，逐字保留；系统不得改写。 */
  statement: string;
  constraints: string[];
  /** 什么算完成；必须可检查。 */
  acceptance: string[];
  createdAt: number;
}

export type ModelScope = 'local' | 'remote' | 'hybrid';

export interface Policy {
  /** 模型范围：先守范围，再选人。 */
  modelScope: ModelScope;
  /** 网页是渠道，不是模型；与范围正交。 */
  includeWeb: boolean;
  /** 高风险时的参与者下限；默认 1，高风险为 2。 */
  minParticipants: number;
  /** 知识/通用可为 true；工程必须 false。 */
  allowWebQuestioner: boolean;
  /** 调用/时间预算。 */
  budget: Budget;
}
```

### 3.2 Capability / Participant

```ts
export type CapabilityId =
  | 'reasoning' | 'knowledge' | 'web-research'
  | 'code-search' | 'code-read' | 'symbols' | 'impact'
  | 'java' | 'test-run' | 'shell-read'
  | 'review' | 'verification';

/** 参与者的能力声明；权威定义，P5 只引用。 */
export interface AgentCapabilities {
  kind: 'web' | 'local' | 'cloud' | 'cli';
  canSystemPrompt: boolean;
  canUseTools: boolean;
  canStream: boolean;
  canSeeOtherAgents: boolean;
  maxConcurrency: number;
  costClass: 'low' | 'medium' | 'high';
  requiresLogin?: boolean;
}

export interface Capability {
  id: CapabilityId;
  /** 事实来源：模型 / 工具 / LSP / CLI；便于解释为什么选它。 */
  source: 'model' | 'tool' | 'lsp' | 'cli' | 'runtime';
}

export interface Participant {
  participantId: string;
  kind: 'web' | 'local' | 'cloud' | 'cli';
  label: string;
  capabilities: CapabilityId[];
  /** 网页为 false；本地/云端为 true。 */
  canSystemPrompt: boolean;
  canUseTools: boolean;
  canStream: boolean;
  canSeeOtherAgents: boolean;
  maxConcurrency: number;
  costClass: 'low' | 'medium' | 'high';
  available: boolean;
  unavailableReason?: string;
}
```

### 3.3 TaskEnvelope / TaskSpec / TaskRuntimeState / Attempt

```ts
export interface TaskEnvelope {
  /** 用户原话或系统转述；网页只允许这一项。 */
  question: string;
  scope?: { paths?: string[]; symbols?: string[]; sources?: string[] };
  acceptance: string[];
  /** 输出契约：字段与类型，不是话术。 */
  outputSchema?: Record<string, unknown>;
  evidenceRequired: boolean;
}

/** 计划内的任务定义：不可变。运行状态不在这里。 */
export interface TaskSpec {
  taskId: string;
  goalId: string;
  kind: 'analyze' | 'research' | 'verify' | 'review' | 'execute' | 'synthesize';
  envelope: TaskEnvelope;
  dependsOn: string[];
  requiredCapabilities: CapabilityId[];
  timeoutMs?: number;
  degradable?: boolean;
  context?: GeneralContext | KnowledgeContext | EngineeringContext;
}

export type TaskStatus =
  | 'pending' | 'assigned' | 'running' | 'retrying'
  | 'done' | 'failed' | 'blocked' | 'skipped' | 'cancelled';

/** 一次执行尝试；只追加，不修改历史。 */
export interface Attempt {
  attemptId: string;
  taskId: string;
  participantId: string;
  /** 1 起；只读任务最多 2 次。 */
  number: number;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  error?: { code: ErrorCode; message: string };
}

/** 运行状态与定义分离；每个 taskId 只有一条。 */
export interface TaskRuntimeState {
  taskId: string;
  status: TaskStatus;
  attempts: Attempt[];
  currentAttemptId?: string;
  /** 跳过/阻塞/取消的原因；失败原因在 Attempt.error。 */
  reason?: string;
}

/** 由 Plan.tasks + dependsOn 派生，不单独持久化。 */
export interface TaskGraph {
  goalId: string;
  tasks: TaskSpec[];
  maxDepth: number;
  createdAt: number;
}
```

### 3.4 Context

```ts
export interface GeneralContext { kind: 'general'; }

export interface KnowledgeContext {
  kind: 'knowledge';
  topicId?: string;
  reuseCardIds?: string[];
}

export interface EngineeringContext {
  kind: 'engineering';
  workspace: string;
  branch?: string;
  worktree?: string;
  baseCommit?: string;
  currentCommit?: string;
  dirty?: boolean;
  dirtyFiles?: string[];
  changedFiles?: string[];
  tests?: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; exitCode?: number }>;
  build?: { command: string; status: 'passed' | 'failed' | 'skipped' };
  review?: { verdict: 'approved' | 'changes_requested' | 'unknown'; notes: string[] };
}
```

### 3.5 Plan / ParticipantChoice / Assignment

```ts
/**
 * 不可变。重规划不修改旧 Plan，而是生成新 version，并写 supersedes。
 * Plan 只含规划结果：任务定义 + 参与者选择 + 停止条件。
 * 派发结果（Assignment）属于运行时，不在 Plan 里。
 */
export interface Plan {
  planId: string;
  goalId: string;
  version: number;
  /** 新版本指回上一版 planId；首版为空。 */
  supersedes?: string;
  policy: Policy;
  tasks: TaskSpec[];
  /** 规划阶段的参与者选择与理由；跳过也要记录。 */
  participants: Array<{ participantId: string; reason: string }>;
  skipped: Array<{ participantId: string; reason: string }>;
  stopWhen: string[];
  reason: string;
  createdAt: number;
}

/** 派发结果：任务 → 参与者的一次配对；由 Scheduler 创建。 */
export interface Assignment {
  assignmentId: string;
  taskId: string;
  participantId: string;
  reason: string;
  contextRefs: string[];
  assignedAt: number;
}
```

### 3.6 Observation / EvidenceRef

```ts
/**
 * 只对应一次 Attempt；skipped/blocked 不产生 Observation，
 * 原因写在 TaskRuntimeState.reason。
 */
export interface Observation {
  observationId: string;
  taskId: string;
  attemptId: string;
  participantId: string;
  status: 'done' | 'failed' | 'cancelled';
  text?: string;
  toolCalls?: Array<{ tool: string; args: unknown; resultHash?: string }>;
  evidenceRefs: string[];
  error?: { code: ErrorCode; message: string };
  startedAt: number;
  endedAt: number;
}

export type EvidenceKind = 'web' | 'code' | 'execution' | 'knowledge' | 'tool';

export interface EvidenceRef {
  evidenceId: string;
  kind: EvidenceKind;
  scope: { goalId: string; taskId?: string };
  source: { uri?: string; commit?: string; snapshot?: string; capturedAt: number };
  locator?: { path: string; startLine?: number; endLine?: number };
  hash: string;
  trust: 'verified' | 'unverified' | 'degraded';
  summary: string;
  legacy?: { packId: string; itemId: string };
}
```

### 3.7 Claim / Conflict / Dispute

```ts
export interface Claim {
  claimId: string;
  goalId: string;
  taskId?: string;
  text: string;
  kind: 'fact' | 'inference' | 'assumption' | 'recommendation' | 'prediction';
  source: { participantId?: string; observationId?: string; evidenceId?: string };
  scope?: 'code' | 'runtime' | 'world';
  createdAt: number;
}

/** 检测到的矛盾：此时还不一定需要辩论。 */
export interface Conflict {
  conflictId: string;
  goalId: string;
  claimA: string;
  claimB: string;
  type: 'factual' | 'logical' | 'scope' | 'definitional' | 'evidence_conflict';
  /** 是否影响交付；由规则/Planner 判定，最终可人工覆盖。 */
  matters: boolean;
  status: 'detected' | 'dismissed' | 'confirmed';
  detectedBy: 'rule' | 'planner' | 'reviewer';
  evidenceRefs: string[];
  createdAt: number;
}

/**
 * 影响交付且未解决的冲突，才允许进入 Debate。
 * 不继承 Conflict：两者状态集合不兼容，且生命周期独立；用 conflictId 关联。
 */
export interface Dispute {
  disputeId: string;
  conflictId: string;
  goalId: string;
  status: 'open' | 'resolved' | 'unresolved';
  openedAt: number;
  resolvedAt?: number;
  resolution?: { relation: 'supports' | 'contradicts' | 'context' | 'unverified'; evidenceRefs: string[] };
}
```

### 3.8 CollaborationState

```ts
export interface CollaborationState {
  /** 状态版本；用于迁移与恢复。 */
  version: 1;
  goal: Goal;
  /** 当前生效的计划；不可变。 */
  activePlan: Plan;
  /** 历史计划，按 version 升序；只追加，不修改。 */
  planHistory: Plan[];
  /** 运行状态；与 activePlan.tasks 按 taskId 对应。 */
  taskStates: TaskRuntimeState[];
  /** 派发结果；属于运行时。 */
  assignments: Assignment[];
  observations: Observation[];
  evidence: EvidenceRef[];
  claims: Claim[];
  conflicts: Conflict[];
  disputes: Dispute[];
  budget: Budget;
  replans: Array<{ at: number; reason: string; added: string[]; removed: string[] }>;
  stop?: { reason: StopReason; at: number };
  deliverable?: Deliverable;
  /** 仅工程任务；定义见 ENGINEERING_CONTRACT §1，不新建 EngineeringStore。 */
  engineering?: EngineeringTaskState;
  updatedAt: number;
}

export interface Budget {
  maxCalls: number;
  maxMs: number;
  usedCalls: number;
  startedAt: number;
}

export type StopReason =
  | 'acceptance_satisfied' | 'no_new_information'
  | 'budget_exhausted' | 'blocked' | 'user_cancelled' | 'failed';
```

### 3.9 Execution / Verdict / Deliverable

```ts
/** 执行治理的引用，不复制 Runtime 的内部状态。 */
export interface ExecutionRef {
  executionId: string;
  taskId: string;
  grantId?: string;
  planId?: string;
  status: 'pending' | 'approved' | 'running' | 'done' | 'failed' | 'rejected';
  reportHash?: string;
}

export interface Verdict {
  claimId: string;
  relation: 'supports' | 'contradicts' | 'context' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
  evidenceRefs: string[];
}

/** 旧名；V3 文档统一用 Verdict。 */
export type Verification = Verdict;

export interface Deliverable {
  deliverableId: string;
  goalId: string;
  kind: 'answer' | 'research' | 'knowledge_map' | 'engineering_change' | 'test_report';
  content: string;
  claims: Claim[];
  verifications: Verdict[];
  openQuestions: string[];
  stopReason: StopReason;
  evidenceCoverage: number;
  createdAt: number;
}
```

### 3.10 ModelInput（通道边界）

```ts
/** 网页通道唯一允许的输入：问题 + 数据，不含指令。 */
export interface QuestionInput {
  kind: 'question';
  question: string;
  transcript?: Array<{ source: string; text: string }>;
}

/** 仅知识/通用：网页提问者输入，单条问题 + 数据，无 system/格式。 */
export interface QuestionerInput {
  kind: 'questioner';
  question: string;
  transcript: Array<{ source: string; text: string }>;
}

/** 本地/云端可接收的契约：数据 + 输出 schema，不含角色/阶段话术。 */
export interface ContractInput {
  kind: 'contract';
  question: string;
  schema: Record<string, unknown>;
  data?: Record<string, unknown>;
  constraints?: { tools?: string[]; permission?: string; timeoutMs?: number };
}
```

- 网页只收 `QuestionInput`；知识/通用可额外收 `QuestionerInput`（单条追问 + 数据），
  工程模式必须拒绝网页 `questioner`（见下表）；
- 任何「请指出 / 你的职责 / 第一步 / 按格式」都非法；
- 本地/云端可收 `ContractInput`；schema 是契约，不是话术；
- **执行计划必须由 `ContractInput` 产生**；没有 local/cloud 规划者时任务 `blocked`，
  不得把规划提示词塞进网页；
- 网页 `questioner` 只生成追问，不规划执行、不调用工具、不审批、不决定停止。

| 空间 | 网页角色 | 输入 |
| --- | --- | --- |
| 知识学习 / 通用 | answerer / questioner | `QuestionInput` / `QuestionerInput` |
| 工程 | 仅 answerer | `QuestionInput` |
| 执行规划（所有空间） | 不允许 | 仅 local/cloud `ContractInput` |
- 现存 27 个输入构造点的处置见
  [P0-F..J 修订 §2.2](P0-F-TO-J-DESIGN-REVISION.md)。


---

## 4. 所有权矩阵

| 动作 | 唯一负责人 | 禁止 |
| --- | --- | --- |
| 生成 Goal | 入口 | Planner 改写用户原话 |
| 选范围/选参与者/拆任务/生成 TaskSpec | Planner | Scheduler 自行增删 |
| 生成 Plan 新版本 | Planner（首版）/ Replanner（P1.1） | 原地修改旧 Plan |
| 创建 Assignment | Scheduler | Runner 改派 |
| 创建 Attempt / 写 TaskRuntimeState | Runner | Planner 直接改状态 |
| 校验范围与能力、排期 | Scheduler | Runner 改计划 |
| 执行任务、写 Observation | Runner | Planner 直接执行 |
| 写 Plan / taskStates / observations | Runner（状态）/ Planner（Plan） | 模块各存一份 |
| 状态转移 | Runner（纯函数） | 模块各存一份状态 |
| 冲突检测 | Conflict Detector | Debate 自己造冲突 |
| 验证 | Verifier | Deliver 给证据加分 |
| 交付 | Deliver | Runner 直接面向用户 |
| 领域数据写入 | 对应 Store | 引擎复制内容 |

---

## 5. 生命周期

### 5.1 Goal / Plan

```text
Goal: created ──► planning ──► running ──► stopping ──► stopped ──► delivered
Plan: draft ──► validated ──► active ──► superseded（新版本产生时） ──► closed
```

Plan 不可变：重规划产生新的 `version`，旧版本进 `planHistory`，不原地改。

### 5.2 Task / Attempt

```text
Task:
pending ──► assigned ──► running ──┬─► done
                                   ├─► retrying ──► running（只读重试，新 Attempt）
                                   ├─► failed（写操作失败 / 重试耗尽）
                                   ├─► blocked
                                   └─► skipped
任意非终态 ──► cancelled（用户取消）

Attempt:
running ──► done | failed | cancelled
```

规则：

- `Plan` 里的 `TaskSpec` 不可变；运行状态只在 `TaskRuntimeState`。
- 每次执行创建新的 `Attempt`；旧 `Attempt` 与 `Observation` 不修改。
- 只读任务最多 2 次 Attempt：第 1 次失败 → `retrying` → 第 2 次；仍失败 → `failed`。
- 写/执行任务只有 1 次 Attempt；失败直接 `failed`，重跑必须新 Plan + 审批。
- `done` 必须满足 `acceptance`，且有 `Observation`。
- `skipped` / `blocked` 不产生 `Observation`，原因写 `TaskRuntimeState.reason`。
- `failed` 是终态；不允许 `failed → running`。

### 5.3 Conflict / Dispute

```text
Conflict: detected ──► confirmed ──► (matters) ──► Dispute.open
                    └► dismissed

Dispute: open ──► resolved
              └► unresolved（交付时保留）
```

### 5.4 Observation / Deliverable

- `Observation` 只对应一次 `Attempt`，创建后不可变；
- `skipped` / `blocked` 没有 Observation，只有状态与原因；
- `Deliverable` 只能在 `stop` 之后创建，且必须带 `stopReason`。

---

## 6. 状态转移规则（不变量）

1. 只有 Runner 写 `CollaborationState`；Planner/Scheduler 返回新对象，不原地改。
2. 任务参与者必须在 `Policy` 范围内；越界直接拒绝，不改道。
3. 高风险任务 `minParticipants >= 2`；降到 1 必须拒绝。
4. 每个 `TaskSpec` 必须有非空 `acceptance`。
5. `done` 任务必须至少有一个 Observation 或明确的「无外部结果」说明。
6. 证据引用必须有 `source` 与 `hash`；没有就标 `unverified`。
7. `Deliverable.stopReason` 必须来自 `StopReason`，不能自造字符串。
8. 任何跳过/失败必须出现在 State 与 UI。
9. 一次只允许一个 `activePlan`；修订产生新 Plan 进 `planHistory`，旧版不可改。
10. 预算只能减少，不能中途上调（用户显式加预算除外）。
11. `Plan` 与 `TaskSpec` 不可变；新计划产生新 `version`，旧版进 `planHistory`。
12. `taskStates` 每个 `taskId` 只有一条；`attempts` 只追加。
13. `Observation.attemptId` 必须指向已存在的 `Attempt`。
14. 只读重试最多 2 次 Attempt；写操作不自动重试。
15. 取消已开始的 Attempt 必须产生 `cancelled` Observation；未开始则只记录状态原因。

---

## 7. 持久化

- `CollaborationState` 作为 `Conversation` 的可选字段存 `AgentStore` journal；
- 版本 `version: 1`；旧记录没有该字段时按「无协作状态」读取；
- 未知字段忽略，不崩溃；
- 恢复：
  - `running` 任务 → `failed`（`interrupted`），由 P1.1 Replanner 决定是否重跑；
  - 不静默重放写操作；
  - `stop` 已写但未交付 → 可重新 Deliver。
- 领域存储按 id 引用；删除会话不级联删除证据（由 GC 策略处理）。

---

## 8. 错误、重试、取消、并发、预算

### 8.1 错误码

```ts
export type ErrorCode =
  | 'PLAN_INVALID' | 'SCOPE_VIOLATION' | 'CAPABILITY_MISSING'
  | 'PARTICIPANT_UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED'
  | 'BUDGET_EXHAUSTED' | 'STORE_FAILURE' | 'VERIFICATION_FAILED' | 'INTERNAL';
```

映射：

| 错误 | Task | Stop |
| --- | --- | --- |
| `SCOPE_VIOLATION` | 拒绝计划 | `failed`（P0 阶段） |
| `CAPABILITY_MISSING` | `skipped` | 继续，记录缺口 |
| `PARTICIPANT_UNAVAILABLE` | `failed`/`skipped`（按配置） | 继续 |
| `TIMEOUT` | `failed` | 继续或 `budget_exhausted` |
| `CANCELLED` | `cancelled` | `user_cancelled` |
| `BUDGET_EXHAUSTED` | 不再派发 | `budget_exhausted` |

### 8.2 重试

- 只读任务：最多 2 次 Attempt；第 1 次失败进 `retrying`，第 2 次失败进 `failed`；
- 每次重试创建新 `Attempt`，不改旧 Attempt / Observation；
- 写/执行任务：只有 1 次 Attempt，**不自动重试**；重跑必须重新计划与审批；
- `failed` 是终态，不允许 `failed → running`；
- Planner 本身：P1 无模型调用；P1.1 模型审核失败回退规则，不重试模型。

### 8.3 取消

- 用户取消 → 停止派发 → 通知在途任务 → 非终态任务标 `cancelled`；
- 已开始的 Attempt：标 `cancelled`，并产生 `Observation(status='cancelled')`；
- 未开始的任务：只写 `TaskRuntimeState.reason`，不产生 Observation；
- 网页触发停止生成；CLI kill；Runtime 走既有取消；
- 已产生的 Observation 保留，不删。

### 8.4 并发

- 每个 participant 有 `maxConcurrency`；
- 网页通道同一页面串行；
- 全局并发上限 = min(预算, 各通道上限)；
- 同一 `taskId` 不允许并发重复执行。

### 8.5 预算

- 单位：调用数 + 时间；P1 不上成本估算；
- 派发前扣减；耗尽即停止派发；
- 网页调用计 1 次；CLI/模型按实际调用计；
- 预算耗尽必须作为 StopReason 写入 State 与交付物。

---

## 9. 事件契约

| 事件 | 载荷 | 发出者 |
| --- | --- | --- |
| `collaboration.mode.changed` | from / to / source | 设置 |
| `goal.started` | goalId / workspace / statement | Runner |
| `plan.created` | planId / taskIds / participants / reason | Planner |
| `plan.revised` | added / removed / reason（P1.1） | Replanner |
| `task.assigned` | taskId / participantId / reason | Scheduler |
| `task.started` | taskId / participantId | Runner |
| `observation.recorded` | taskId / status / evidenceRefs | Runner |
| `conflict.detected` | conflictId / matters | Detector |
| `dispute.opened` | conflictId | Detector |
| `verification.recorded` | claimId / relation | Verifier |
| `goal.stopped` | reason / at | Runner |
| `deliverable.ready` | kind / evidenceCoverage | Deliver |

事件落在 `ConversationEvent` 体系内，不新建总线。

---

## 10. 参与者选择契约

```text
Task.requiredCapabilities
        │
        ▼
filter Policy.modelScope / includeWeb
        │
        ▼
filter role（知识/通用允许网页 questioner；工程拒绝）
        │
        ▼
filter available + capability match
        │
        ▼
risk floor（高风险 ≥ 2）
        │
        ▼
选人 + reason + skipped reason
```

规则：

- 先范围，后能力，最后数量；
- `local` 只选本地模型，`remote` 只选远端模型；越界拒绝；
- 网页由 `includeWeb` 决定；知识/通用可担任 `questioner`，工程只能 `answerer`；
  网页不参与需要工具/看他人输出的任务；
- 选择理由写进 `Plan.participants[].reason`；跳过写 `Plan.skipped[]`；
- 高风险判定（初始规则）：涉及写操作、用户要求多视角、存在未决争议。

示例：

| 问题 | 范围 | 参与者 |
| --- | --- | --- |
| Java 虚拟线程为什么省资源 | remote | 1 个远端模型 |
| Redis 连接数过高，分析项目 | hybrid + web=false | 代码搜索/读取 + 1–2 个模型 + 测试能力 |
| 方案争议需要复核 | hybrid + web=true | 2 个模型 + 网页证据（按需） |

### 10.1 Planner 的模型 / 规则 / 系统边界

| 责任 | 承担者 |
| --- | --- |
| 理解目标、判断复杂度、产生候选任务 | 模型（P1.1 起）；P1.0 用规则 |
| 校验 DAG、依赖、预算、范围、能力 | 系统（规则） |
| 选择参与者与理由 | Planner，在系统约束内 |
| 执行、权限、审批 | 现有 `AgentOrchestrator` |
| 记录 Observation / 状态 | Runner |
| 是否继续 / 是否 Debate | Replanner / Conflict 状态 |

护栏：

- 模型只能产出 `Plan` 候选，必须通过 schema 与规则校验；
- 模型不能直接调用 Runtime、不能改权限、不能决定停止；
- 规则可以否决模型计划，否决理由必须可见；
- P1.0 纯规则；P1.1 才引入模型审核（数据 + schema）。


---

## 11. 冲突、辩论与验证

- Conflict 可由规则、Planner（P1.1）、Reviewer 产生；
- 只有 `matters=true` 且 `open` 的 Dispute 才允许 Debate；
- DebateService 输入：goalId、question、claims、disputes、participants；
- DebateService 输出：Observation + Verdict + EvidenceRef；
- Debate 不创建基线、不接收任务提示词、不成为入口；
- Verifier 独立于提出者；无法验证标 `unverified`，不删除 Claim。

---

## 12. 工程上下文

- `EngineeringContext` 挂在 `Task.context`，不塞进 `Task` 公共字段；
- `start/end` 由工程任务自己持有；
- 快照是证据，不是流程基线；
- 写操作必须经审批；CLI 执行者走 `agent.exec` 链，不复用只读回答源。

### 12.1 三空间契约

| 空间 | Task.context | 能力 | 交付 | 专属存储 |
| --- | --- | --- | --- | --- |
| General | `GeneralContext` | reasoning / web-research | answer | 无 |
| Knowledge | `KnowledgeContext` | knowledge / web-research | research / knowledge_map | MemoryStore（P2） |
| Engineering | `EngineeringContext` | code-search / read / java / test / review | engineering_change / test_report | 证据 + 工程状态（P3） |

空间不增加 Engine：只增加上下文、能力与交付模板。禁止 `KnowledgeEngine` /
`EngineeringEngine` / `ResearchEngine`。


---

## 13. 非目标（本阶段不做）

- 不做 MemoryStore / 向量库 / Neo4j（P2）；
- 不做 Java LSP / JDT（按需再评估）；
- 不做 UI 改版（P3/P4 后）；
- 不删除 `buildInitialPrompt`（P3 结构化计划契约后）；
- 不做 shadow 双跑；
- 不新建 Runtime / 审批 / Journal / 证据存储。

---

## 14. P1-003 映射的输入

P1-003 必须逐文件回答：

1. 该文件创建/修改哪些对象？
2. 该文件属于哪条旧回路？
3. 新归属是 Planner / Scheduler / Runner / Verifier / Deliver / Store？
4. 它写哪个存储？读哪个存储？
5. 它的删除条件是什么？
6. 哪些测试需要迁移？

---

## 15. 评审清单

- [ ] 运行时状态与领域存储边界清晰，没有第二个任务列表
- [ ] Task 与 EngineeringContext 分离
- [ ] Policy（范围 + 网页开关）先于选人
- [ ] Conflict 与 Dispute 区分，Debate 有明确门槛
- [ ] 状态机与不变量可测试
- [ ] 错误码、重试、取消、并发、预算可落地
- [ ] 持久化复用 AgentStore，恢复语义明确
- [ ] 事件不新建总线
- [ ] 非目标写清楚，尤其是 Memory/JDT/UI/buildInitialPrompt
