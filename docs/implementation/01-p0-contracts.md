# P0 契约与开关

目标：**冻结接口、给出迁移矩阵、装好开关**，不改变任何用户可见行为。

前置：设计基线 `main@d7cd030`；代码基线 `cd30be3`（先更新 00 文档的基线）。
出口：本文件 §7 的清单全绿。

---

## 1. M0.1 实施审计（Task 001）

**产出**：[P1-001-MIGRATION-AUDIT.md](P1-001-MIGRATION-AUDIT.md)（正式审计）。
详细对象契约见 [P1-002-DOMAIN-RUNTIME-CONTRACT.md](P1-002-DOMAIN-RUNTIME-CONTRACT.md)；本文只保留 P0 冻结要点。

**为什么先做**：现有 `MasterAgent`、`ConversationRunner`、`collaboration/`、`debate/`、
`engineering/`、`orchestrator.ts` 各自承担了一部分编排职责。不先把职责写清楚，
新引擎一定会变成第四套编排。

矩阵必须逐文件、逐导出，不允许「模块级」概括：

| 列 | 内容 | 示例 |
| --- | --- | --- |
| 文件 | 相对路径 | `desktop-agent-macos/src/main/master-agent.ts` |
| 导出 | 类 / 函数 / 类型 | `MasterAgent.research()` |
| 调用方 | 谁在调用 | `conversation-runner.ts:...` |
| 写盘 | 是否写 journal / 文件 | 否 |
| 事件 | 发什么事件 | `message.added` |
| 测试 | 覆盖脚本 | `check-runner.mjs` |
| 目标 | 保留 / 扩展 / 降级 / 拆分 / 删除 | 扩展 |
| 删除条件 | 什么情况下可以删 | 见 00 文档 5.3 |

**审计要求**：

- 必须覆盖：`master-agent.ts`、`conversation-runner.ts`、`collaboration/*`、
  `debate/*`、`judge/*`、`evidence-pack/*`、`engineering/*`、`code-index/*`、
  `execution/cli-answer-agent.ts`、`orchestrator.ts`、`agent/*`、`store.ts`。
- 必须单列「**不许迁移**」：网页 Adapter、Runtime 审批、TaskGrant、Journal。
- 必须单列「**职责冲突**」：至少包括
  - `MasterAgent` 同时负责参与者管理与综合；
  - `collaboration/strategy.ts` 用 stage 而非 DAG；
  - `debate/claims.ts` 的 Claim 依赖 `DebateMessage`；
  - `cli-answer-agent` 只读但被计划当成工程执行者。
- 审计结论必须回答：**新引擎的最小接线点在哪**（建议 `ConversationRunner` 的 run 入口）。

验收：矩阵文件存在，上述文件全部有行；评审时能按行指出「这行将来删还是留」。

---

## 2. M0.2 契约冻结（Task 002）

**产出**：`desktop-agent-macos/src/main/collaboration/domain/*.ts`（只加类型与纯函数，不改行为）。

契约以 [协作架构 V1](../architecture/COLLABORATION_ARCHITECTURE.md) 第 9 节为基础，
这里只补审核后新增的部分，并明确「不做什么」。

### 2.1 Goal

```ts
export interface Goal {
  goalId: string;
  workspace: 'knowledge' | 'engineering' | 'general';
  /** 用户原话，逐字保留；系统不得改写。 */
  statement: string;
  constraints: string[];
  acceptance: string[];
  createdAt: number;
}
```

### 2.2 TaskEnvelope（新增，解决「提示词藏进 question」）

```ts
export interface TaskEnvelope {
  /** 用户原话或系统转述；网页通道只允许这一项。 */
  question: string;
  /** 机器可读的范围与验收，不发给人设/阶段话术。 */
  scope?: { paths?: string[]; symbols?: string[]; sources?: string[] };
  acceptance: string[];
  /** 输出契约：字段与类型，不是自然语言要求。 */
  outputSchema?: Record<string, unknown>;
  /** 证据要求：没有证据时必须标 unverified。 */
  evidenceRequired: boolean;
}

export interface TaskSpec {
  taskId: string;
  goalId: string;
  kind: 'analyze' | 'research' | 'verify' | 'review' | 'execute' | 'synthesize';
  envelope: TaskEnvelope;
  dependsOn: string[];
  requiredCapabilities: Partial<AgentCapabilities>;
  timeoutMs?: number;
  /** 失败是否允许降级；默认 false。 */
  degradable?: boolean;
}
```

规则：

- `envelope.question` 不得包含角色、阶段、格式、挑战话术；渲染层也不得追加。
- 网页 Adapter 只接收 `question`；`scope/acceptance/outputSchema` 由系统在汇总侧使用。
- local / CLI 可以把 `outputSchema` 作为契约传入，但不得写成人设。

### 2.3 Claim / Dispute（新增，解决「辩论外没有主张模型」）

```ts
export interface Claim {
  claimId: string;
  goalId: string;
  taskId?: string;
  text: string;
  kind: 'fact' | 'inference' | 'assumption' | 'recommendation' | 'prediction';
  /** 出处：消息 / 证据 / 代码位置。 */
  source: { agentId?: string; messageId?: string; evidenceId?: string };
  scope?: 'code' | 'runtime' | 'world';
  createdAt: number;
}

export interface Dispute {
  disputeId: string;
  goalId: string;
  claimA: string;
  claimB: string;
  type: 'factual' | 'logical' | 'scope' | 'definitional' | 'evidence_conflict';
  /** 是否影响交付：由 Planner 依据 acceptance 判定，不是模型自称。 */
  matters: boolean;
  createdAt: number;
}
```

现有 `debate/claims.ts` 的抽取逻辑可以复用，但输入必须从 `DebateMessage[]` 泛化为
`{ text, agentId, messageId }[]`；这一步在 P1 M1.2 做，P0 只定类型。

### 2.4 Observation / Assignment / EvidenceRef

沿用协作架构第 9 节，补两个字段：

```ts
export interface Observation {
  // ...同架构文档
  stopReason?: StopReason;
}

export interface EvidenceRef {
  // ...同架构文档
  /** 旧 Pack 条目迁移时保留来源 id，便于回溯。 */
  legacy?: { packId: string; itemId: string };
}
```

### 2.5 TaskGraphState（待 D4 决策，可能删除）

> P0-A 审查建议：由 `Plan` + `CollaborationState` 取代，不单独持久化。
> 确认前保留此节，仅作对照。

```ts
export interface TaskGraphState {
  goalId: string;
  planVersion: number;
  tasks: Array<TaskSpec & { status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' }>;
  assignments: Assignment[];
  observations: Observation[];
  evidence: EvidenceRef[];
  replans: Array<{ at: number; reason: string; added: string[]; removed: string[] }>;
  stop?: { reason: StopReason; at: number };
}
```

### 2.6 CollaborationState（单一运行时状态）

**新增，解决「Planner / Scheduler / Runner / Replanner 各维护一份状态」的问题。**

```ts
export interface CollaborationState {
  goal: Goal;
  /** 先定范围再选人：local / remote / hybrid；网页是否参与单独标记。 */
  policy: { modelScope: 'local' | 'remote' | 'hybrid'; includeWeb: boolean };
  planVersion: number;
  tasks: Array<TaskSpec & {
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'blocked';
  }>;
  assignments: Assignment[];
  observations: Observation[];
  evidence: EvidenceRef[];
  budget: { maxCalls: number; maxMs: number; usedCalls: number; startedAt: number };
  replans: Array<{ at: number; reason: string; added: string[]; removed: string[] }>;
  stop?: { reason: StopReason; at: number };
  deliverable?: Deliverable;
}
```

规则：

- 这是唯一事实源；`planner / scheduler / runner / replanner / deliver` 只能通过
  纯函数「旧状态 → 新状态」修改，不得各存一份 task 列表。
- 落盘时作为对话/任务记录的可选字段；P1.0 接入 `AgentStore`，P0 只冻结类型。
- `budget` 在 P1.0 至少记调用数与耗时；成本估算可以后加。
- `stopReason` 与 `deliverable` 在停止后写入，界面与报告都读这里。

### 2.7 StopReason / Verdict / Deliverable

```ts
export type StopReason =
  | 'acceptance_satisfied'
  | 'no_new_information'
  | 'budget_exhausted'
  | 'blocked'
  | 'user_cancelled';

export interface Verdict {
  claimId: string;
  relation: 'supports' | 'contradicts' | 'context' | 'unverified';
  confidence: 'low' | 'medium' | 'high';
  limitations: string[];
  evidenceRefs: string[];
}

export interface Deliverable {
  goalId: string;
  kind: 'answer' | 'research' | 'knowledge_map' | 'engineering_change' | 'test_report';
  content: string;
  claims: Claim[];
  verdicts: Verdict[];
  openQuestions: string[];
  stopReason: StopReason;
}
```

### 2.7 事件契约（新增）

事件必须落在现有 `ConversationEvent` 体系内，**不新建事件总线**：

| 事件 | 关键字段 | 谁发 |
| --- | --- | --- |
| `collaboration.mode.changed` | from / to / source | 设置页 |
| `goal.started` | goalId / workspace / statement | Runner |
| `plan.created` | goalId / tasks / strategy / reason | Planner |
| `plan.revised` | added / removed / reason | Replanner |
| `task.started` | taskId / agentId / reason | Scheduler |
| `observation.recorded` | taskId / status / evidenceRefs | Runner |
| `goal.stopped` | reason / at | Runner |
| `deliverable.ready` | kind / evidence coverage | Deliver |

验收：`npm run typecheck` 通过；`test:collaboration-domain`（新增）覆盖序列化与纯函数。

---

## 3. M0.3 Feature Flag（Task 003）

**产出**：`src/main/collaboration/mode.ts` + 设置页只读显示（调试开关可后置）。

```ts
export type CollaborationMode = 'legacy' | 'shadow' | 'active';
export function readCollaborationMode(): CollaborationMode;
export function writeCollaborationMode(mode: CollaborationMode, source: string): void;
```

要求：

- 默认 `legacy`；非法值回落 `legacy` 并记日志。
- 存储复用现有 settings store（`userData` 下 JSON），不新增配置文件。
- 读取只发生在 main 进程；renderer 通过既有 IPC 读取。
- 切换写 `collaboration.mode.changed` 事件；`shadow` 下不产生模型调用。
- 单测：默认值、非法值、持久化、事件。

验收：`node --test scripts/check-collaboration-mode.mjs`；手工确认设置页显示当前模式。

---

## 4. M0.4 状态与恢复契约（实现放 P1.0）

P0 只冻结「存哪、恢复到什么状态」，不写落盘代码。决策：

- **复用 `AgentStore` 的原子 JSON journal**（`store.ts`），不新建数据库、不新建 Journal。
- `TaskGraphState` 作为对话/任务记录的可选字段落盘；旧记录没有该字段时按无任务图读取。
- 事件与状态同文件，保证 `seq` 单调；恢复时以最后一条已提交状态为准。
- 崩溃恢复语义：`running` 的任务在重启后标记为 `failed`（reason=`interrupted`），
  由 Replanner 决定是否重跑；**不静默重放写操作**。

P0 验收：契约与恢复语义评审通过；实现与测试放 P1.0（M1.0）。

---

## 5. M0.5 回滚演练

- 写入一条 active 配置 → 重启 → 确认真实走新路径（此时可能还没有，允许直接回落）。
- 关闭 flag → 重启 → 确认走旧路径、旧数据可读。
- 删除新增字段的模拟数据 → 确认旧代码不崩溃。
- 记录演练步骤与结果到 PR 描述。

---

## 6. 任务清单

| ID | 任务 | 文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P0-01 | 迁移审计（已提交，待评审） | [P1-001-MIGRATION-AUDIT.md](P1-001-MIGRATION-AUDIT.md) | 无 | 18 项审计 + P0-A 决策清单 |
| P0-02 | 领域契约 | `src/main/collaboration/domain/*` | 01 | typecheck + 序列化单测 |
| P0-03 | 事件类型 | `src/shared/conversation.ts`（增量） | 02 | 事件枚举与载荷测试 |
| P0-04 | Flag | `src/main/collaboration/mode.ts` | 02 | 单测 + 手工开关 |
| P0-05 | 状态契约 | `collaboration/domain/state.ts` | 02 | 类型 + 序列化单测 |
| P0-06 | 回滚演练 | 无代码 | 04 | 演练记录 |

---

## 7. P0 出口清单

- [ ] 基线口径一致：设计 `main@d7cd030`、代码 `cd30be3`
- [ ] 迁移矩阵覆盖 §1 列出的全部文件，含「不许迁移」与「职责冲突」
- [ ] `Goal / TaskEnvelope / TaskSpec / Claim / Dispute / TaskGraphState / CollaborationState / EvidenceRef / StopReason / Verdict / Deliverable` 类型冻结
- [ ] 事件枚举与载荷冻结，且不新增事件总线
- [ ] flag 默认 legacy、可持久化、可回滚
- [ ] 状态契约（CollaborationState）冻结，落盘位置与恢复语义写明（实现放 P1.0）
- [ ] `npm run typecheck` 通过
- [ ] 新增测试通过；现有测试无回归
- [ ] diff 只含类型、文档、开关、无行为变化
- [ ] 回滚演练记录在 PR 描述里
