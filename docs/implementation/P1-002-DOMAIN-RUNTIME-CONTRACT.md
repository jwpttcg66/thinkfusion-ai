# P1-002 领域与运行时契约

状态：**设计冻结候选（2026-11-18）**，待评审。
代码基线：`main@29062c3`（P1-001 审计已合并）。
前置：[P1-001 迁移审计](P1-001-MIGRATION-AUDIT.md)。
目标：把 V3 的对象、所有权、生命周期、状态转移、错误/重试/取消/并发/预算、
持久化与事件一次冻结，供 P1-003 映射和 P1-004 实现使用。

> 本文只定义契约，不写实现，不改代码。

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

- `CollaborationState` 只存**引用 id**，不复制领域内容；
- 领域存储不反过来驱动调度；
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
| `Task` | Planner | Runner（状态） | State | Scheduler / Runner |
| `TaskGraph` | Planner | Replanner（P1.1） | State | Scheduler |
| `TaskEnvelope` | Planner | 不可变 | State | Runner / Adapter |
| `Participant` | ParticipantManager | 健康状态刷新 | 配置 + 内存 | Planner / Scheduler |
| `Capability` | 代码常量 | 不可变 | 代码 | Planner |
| `Plan` | Planner | Replanner（P1.1） | State | Scheduler / UI |
| `Assignment` | Scheduler | 不可变 | State | Runner / UI |
| `Observation` | Runner | 不可变 | State | Replanner / Deliver |
| `EvidenceRef` | Runner / Tool | 不可变 | State + Pack | Verifier / Deliver |
| `Claim` | Extractor | 不可变 | State | Conflict Detector / Deliver |
| `Conflict` | Detector | 状态（matters） | State | Dispute 判定 |
| `Dispute` | Detector | 状态（resolved） | State | Debate / Deliver |
| `CollaborationState` | Runner | Runner（纯转移） | `AgentStore` | 全部 |
| `Execution` | AgentOrchestrator | 状态 | 领域存储 | Runner / Verifier |
| `Verification` | Verifier | 不可变 | State | Deliver |
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

export interface Policy {
  /** 模型范围：先守范围，再选人。 */
  modelScope: 'local' | 'remote' | 'hybrid';
  /** 网页是渠道，不是模型；与范围正交。 */
  includeWeb: boolean;
  /** 高风险时的参与者下限；默认 1，高风险为 2。 */
  minParticipants: number;
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

### 3.3 Task / TaskEnvelope / TaskGraph

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

export interface Task {
  taskId: string;
  goalId: string;
  kind: 'analyze' | 'research' | 'verify' | 'review' | 'execute' | 'synthesize';
  envelope: TaskEnvelope;
  dependsOn: string[];
  requiredCapabilities: CapabilityId[];
  timeoutMs?: number;
  degradable?: boolean;
  context?: GeneralContext | KnowledgeContext | EngineeringContext;
  status: TaskStatus;
  attempts: number;
}

export type TaskStatus =
  | 'pending' | 'assigned' | 'running'
  | 'done' | 'failed' | 'skipped' | 'blocked' | 'cancelled';

export interface TaskGraph {
  goalId: string;
  tasks: Task[];
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

### 3.5 Plan / Assignment

```ts
export interface Plan {
  planId: string;
  goalId: string;
  version: number;
  policy: Policy;
  tasks: Task[];
  /** 参与者选择结果与理由；跳过也要记录。 */
  participants: Array<{ participantId: string; reason: string }>;
  skipped: Array<{ participantId: string; reason: string }>;
  assignments: Assignment[];
  stopWhen: string[];
  reason: string;
  createdAt: number;
}

export interface Assignment {
  assignmentId: string;
  taskId: string;
  participantId: string;
  reason: string;
  contextRefs: string[];
}
```

### 3.6 Observation / EvidenceRef

```ts
export interface Observation {
  observationId: string;
  taskId: string;
  participantId: string;
  status: 'done' | 'failed' | 'skipped';
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

/** 影响交付且未解决的冲突，才允许进入 Debate。id 沿用 conflictId。 */
export interface Dispute extends Conflict {
  status: 'open' | 'resolved' | 'unresolved';
  resolution?: { relation: 'supports' | 'contradicts' | 'context' | 'unverified'; evidenceRefs: string[] };
}
```

### 3.8 CollaborationState

```ts
export interface CollaborationState {
  /** 状态版本；用于迁移与恢复。 */
  version: 1;
  goal: Goal;
  plan: Plan;
  tasks: Task[];
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

### 3.9 Execution / Verification / Deliverable

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

export interface Verification {
  claimId: string;
  relation: 'supports' | 'contradicts' | 'context' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
  evidenceRefs: string[];
}

export interface Deliverable {
  deliverableId: string;
  goalId: string;
  kind: 'answer' | 'research' | 'knowledge_map' | 'engineering_change' | 'test_report';
  content: string;
  claims: Claim[];
  verifications: Verification[];
  openQuestions: string[];
  stopReason: StopReason;
  evidenceCoverage: number;
  createdAt: number;
}
```

---

## 4. 所有权矩阵

| 动作 | 唯一负责人 | 禁止 |
| --- | --- | --- |
| 生成 Goal | 入口 | Planner 改写用户原话 |
| 选范围/选参与者/拆任务 | Planner | Scheduler 自行增删 |
| 校验范围与能力、排期 | Scheduler | Runner 改计划 |
| 执行任务、写 Observation | Runner | Planner 直接执行 |
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
Plan: draft ──► validated ──► active ──► revised(P1.1) ──► closed
```

### 5.2 Task

```text
pending ──► assigned ──► running ──┬─► done
                                   ├─► failed
                                   ├─► skipped
                                   └─► blocked
pending/assigned/running ──► cancelled（用户取消）
```

规则：

- `done` 必须有 Observation 且满足 `acceptance`；
- `skipped` 必须有原因（能力不匹配 / 通道不可用 / 被取消）；
- `failed` 不自动重跑写操作；
- 状态只前进，不回退（重规划生成新 Task）。

### 5.3 Conflict / Dispute

```text
Conflict: detected ──► confirmed ──► (matters) ──► Dispute.open
                    └► dismissed

Dispute: open ──► resolved
              └► unresolved（交付时保留）
```

### 5.4 Observation / Deliverable

- `Observation` 创建后不可变；
- `Deliverable` 只能在 `stop` 之后创建，且必须带 `stopReason`。

---

## 6. 状态转移规则（不变量）

1. 只有 Runner 写 `CollaborationState`；Planner/Scheduler 返回新对象，不原地改。
2. 任务参与者必须在 `Policy` 范围内；越界直接拒绝，不改道。
3. 高风险任务 `minParticipants >= 2`；降到 1 必须拒绝。
4. 每个 `Task` 必须有非空 `acceptance`。
5. `done` 任务必须至少有一个 Observation 或明确的「无外部结果」说明。
6. 证据引用必须有 `source` 与 `hash`；没有就标 `unverified`。
7. `Deliverable.stopReason` 必须来自 `StopReason`，不能自造字符串。
8. 任何跳过/失败必须出现在 State 与 UI。
9. 一次只允许一个 `Plan` 处于 `active`；修订产生新版本。
10. 预算只能减少，不能中途上调（用户显式加预算除外）。

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

- 只读任务：最多 1 次；
- 写/执行任务：**不自动重试**，必须重新计划与审批；
- Planner 自身：P1 无模型调用；P1.1 模型审核失败回退规则，不重试模型。

### 8.3 取消

- 用户取消 → 停止派发 → 通知在途任务 → 标记 `cancelled`；
- 网页：触发停止生成；CLI：kill；Runtime：走既有取消；
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
- 网页由 `includeWeb` 决定；网页不参与需要工具/看他人输出的任务；
- 选择理由写进 `Plan.participants[].reason`；跳过写 `Plan.skipped[]`；
- 高风险判定（初始规则）：涉及写操作、用户要求多视角、存在未决争议。

示例：

| 问题 | 范围 | 参与者 |
| --- | --- | --- |
| Java 虚拟线程为什么省资源 | remote | 1 个远端模型 |
| Redis 连接数过高，分析项目 | hybrid + web=false | 代码搜索/读取 + 1–2 个模型 + 测试能力 |
| 方案争议需要复核 | hybrid + web=true | 2 个模型 + 网页证据（按需） |

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
