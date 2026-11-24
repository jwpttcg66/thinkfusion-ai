# 长任务与上下文压缩 · 契约冻结

状态：设计冻结，未实施  
基线：`main` · `e336ae434978211138879688031a9d40c1a27cd7` · 2026-11-24  
上游设计：[LONG_TASK_AND_CONTEXT_COMPACTION.md](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md)  
任务书：[LONG-TASK-CONTEXT-TASK-BOOK.md](../implementation/LONG-TASK-CONTEXT-TASK-BOOK.md)  
存储设计：[CONTEXT_CHECKPOINT_STORAGE.md](../architecture/CONTEXT_CHECKPOINT_STORAGE.md)

> 本文定义类型、不变量、状态机、事件与 API。实现必须服从这些契约；
> 契约变更必须先改本文，再改代码与任务书。

## 1. 版本与兼容

| 项 | 规则 |
| --- | --- |
| 契约版本 | `context.contractVersion = 1` |
| 旧数据 | 所有新字段可选；旧 `agent-store.json` 无字段时按“无上下文”读取 |
| 旧报告 | 无 `ContextCheckpoint` 时回退到现有请求组装 |
| 事件 | 新事件只追加，不修改旧 payload 语义 |
| 删除 | 不删除原始事件；检查点可清理，但必须保留引用与审计事件 |
| Provider | 不支持的 Provider 标记 `unknown`，不静默换 Provider |

## 2. 核心原则

1. **用户原始问题逐字不变**。上下文只能通过 `context` / `system` 追加。
2. **Memory 只进 system**，不改 `question`；网页通道忽略 system，保持原话。
3. **Evidence 不是 Memory，摘要不是 Evidence**。
4. **摘要不是执行事实**。测试是否通过只能来自执行事件。
5. **未知不是 0**。Token、费用、窗口未知返回 `null`，UI 显示“未提供”。
6. **压缩不删原始历史**。只替换模型输入中的历史表示。
7. **每模型独立预算**。任务不共享一个窗口。
8. **开关关闭零行为变化**。

## 3. 类型

### 3.1 预算

```ts
export type BudgetConfidence = 'verified' | 'configured' | 'estimated' | 'unknown';

export interface ContextBudget {
  providerId: string;
  modelId: string;

  /** Provider 声明或配置的窗口；未知为 null。 */
  contextWindow: number | null;
  /** 为输出预留的 Token；未知为 null。 */
  maxOutputTokens: number | null;

  /** 本次请求估算输入；不能冒充 Provider 实际值。 */
  estimatedInputTokens: number;
  /** Provider 返回的真实输入；没有为 null。 */
  actualInputTokens: number | null;

  /** 0–1，默认 0.65。 */
  warningThreshold: number;
  /** 0–1，默认 0.85。 */
  compactionThreshold: number;

  /**
   * 预算来源：provider 实际 / 用户配置 / 本地估算 / 无依据保守值。
   * 保守值不能伪装成 Provider 窗口。
   */
  budgetSource: 'provider' | 'config' | 'estimated' | 'conservative';
  /** 用户或系统配置的保守输入上限；没有为 undefined。 */
  configuredInputLimit?: number;

  confidence: BudgetConfidence;
}

export interface BudgetDecision {
  budget: ContextBudget;
  /** 可用输入上限：window - outputReserve - safetyMargin；未知为 null。 */
  inputLimit: number | null;
  /** 有可用分母时才计算；未知窗口为 null，不显示 65/75/85%。 */
  usageRatio: number | null;
  level: 'normal' | 'warning' | 'compaction' | 'overflow' | 'unknown';
  reason: string;
}
```

### 3.2 上下文

```ts
export type ContextCompactionStatus =
  | 'not-needed'
  | 'preparing'
  | 'summarizing'
  | 'validating'
  | 'committed'
  | 'failed'
  | 'stale';

export interface ContextHistoryItem {
  eventId: string;
  kind: 'message' | 'tool' | 'model' | 'system' | 'evidence';
  role?: 'user' | 'assistant' | 'system';
  text: string;
  at: number;
  roundId?: string;
  stepId?: string;
  attemptId?: string;
  /** 工具调用必须与结果成对；未配对不压缩。 */
  toolCallId?: string;
  evidenceRefs?: string[];
  /** 原始内容的位置；裁剪后仍可回查。 */
  sourceRef?: string;
}

/**
 * 上下文所有权：Engineering 属于 AgentTask，General/Knowledge 属于
 * Conversation。不能为了复用接口伪造一个 AgentTask。
 */
export type ContextOwner =
  | {
      ownerType: 'agent-task';
      ownerId: string;
      taskId: string;
      runId: string;
    }
  | {
      ownerType: 'conversation';
      ownerId: string;
      conversationId: string;
      runId: string;
    };

export interface PreparedContext {
  contextId: string;
  owner: ContextOwner;
  /** 兼容镜像：agent-task 时有 taskId；conversation 时没有。 */
  taskId?: string;
  /** 兼容镜像：conversation 时有 conversationId；agent-task 时没有。 */
  conversationId?: string;
  runId: string;

  checkpointId?: string;
  includedEventIds: string[];
  retainedEventIds: string[];
  evidenceRefs: string[];
  memoryRequestId?: string;

  estimatedTokens: number;
  contextWindow: number | null;
  compactionStatus: ContextCompactionStatus;
}
```

### 3.3 检查点

```ts
export type CheckpointStatus = 'prepared' | 'committed' | 'failed';

export interface ContextCheckpoint {
  contractVersion: 1;
  checkpointId: string;
  owner: ContextOwner;
  taskId?: string;
  conversationId?: string;
  runId: string;
  contextId: string;

  sourceStartSeq: number;
  sourceEndSeq: number;
  /** 完整来源引用：用于校验、恢复、审计；不得截断。 */
  sourceEventIds: string[];
  /** 仅用于 UI/事件 payload 的预览；不能用于完整性校验。 */
  sourceEventIdsPreview?: string[];
  /** 原始事件归档段；Journal 裁剪前必须已存在。 */
  archiveRef?: string;

  summary: ContextSummary;
  summaryHash: string;

  retainedEventIds: string[];
  evidenceRefs: string[];

  modelId: string;
  inputTokensBefore: number | null;
  inputTokensAfter: number | null;

  /**
   * 文件状态。注意：status=prepared 不等于未提交；Journal 活动指针
   * （owner + runId + checkpointId）才是提交权威。
   */
  status: CheckpointStatus;
  createdAt: number;
  committedAt?: number;
  failureReason?: string;
}
```

### 3.4 摘要

```ts
export interface ContextSummary {
  goal: string;
  constraints: string[];
  completed: SummaryItem[];
  decisions: SummaryDecision[];
  evidence: SummaryEvidence[];
  openIssues: string[];
  currentStep: string | null;
  nextActions: string[];
  risks: string[];
  stopConditions: string[];
}

export interface SummaryItem {
  text: string;
  /** verified 只能来自执行事件；模型推测必须标 claim。 */
  certainty: 'verified' | 'claim';
  eventIds: string[];
}

export interface SummaryDecision {
  text: string;
  status: 'active' | 'superseded';
  /** 被后续决定取代时必须写清；不能保留两条矛盾决策。 */
  supersededBy?: string;
  eventIds: string[];
}

export interface SummaryEvidence {
  ref: string;
  kind: 'file' | 'commit' | 'test' | 'assertion' | 'pack';
  path?: string;
  hash?: string;
  eventIds: string[];
}
```

### 3.5 事件

```ts
export type ContextEventType =
  | 'context.budget.warning'
  | 'context.compaction.started'
  | 'context.compaction.summary.ready'
  | 'context.compaction.committed'
  | 'context.compaction.failed'
  | 'context.compaction.stale'
  | 'context.recovered';

export interface ContextEventPayload {
  contextId: string;
  ownerType?: 'agent-task' | 'conversation';
  ownerId?: string;
  checkpointId?: string;
  modelId?: string;
  providerId?: string;
  level?: 'normal' | 'warning' | 'compaction' | 'overflow';
  inputTokensBefore?: number | null;
  inputTokensAfter?: number | null;
  /** 事件 payload 只放展示用预览；完整来源在检查点文件。 */
  sourceEventIdsPreview?: string[];
  reason?: string;
}
```

事件进入现有 `AgentEvent`/`TaskEventEnvelope`，不新建事件总线。

### 3.6 Manager 接口

```ts
export interface PrepareContextInput {
  owner: ContextOwner;
  /** 兼容镜像：agent-task 时由 owner 带出；conversation 时不存在。 */
  taskId?: string;
  conversationId?: string;
  runId: string;
  roundId?: string;
  stepId?: string;
  attemptId?: string;
  question: string;
  context: string[];
  system: string[];
  history: ContextHistoryItem[];
  evidenceRefs: string[];
  providerId: string;
  modelId: string;
}

export interface FinalizeContextInput {
  contextId: string;
  owner: ContextOwner;
  runId: string;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  providerId: string;
  modelId: string;
}

export interface ContextManager {
  prepare(input: PrepareContextInput): Promise<{
    context: PreparedContext;
    question: string;
    contextLines: string[];
    systemLines: string[];
  }>;
  finalize(input: FinalizeContextInput): Promise<void>;
  recover(input: { owner: ContextOwner; runId: string }): Promise<PreparedContext | null>;
}
```

`prepare` 不执行工具、不审批、不改变任务状态。`finalize` 只校准与记录。

## 4. 任务状态契约

### 4.1 新增状态

```ts
export type TaskStatus =
  | 'created'
  | 'planning'
  | 'awaiting_clarification'
  | 'plan_ready'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'report_pending'
  | 'awaiting_next_round'
  | 'paused'
  | 'interrupted'
  | 'budget_exhausted'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

### 4.2 转换表

| 当前 | 允许到 |
| --- | --- |
| created | planning, cancelled |
| planning | awaiting_clarification, plan_ready, paused, interrupted, budget_exhausted, blocked, failed, cancelled |
| awaiting_clarification | planning, paused, interrupted, cancelled |
| plan_ready | awaiting_approval, paused, interrupted, blocked, cancelled |
| awaiting_approval | executing, blocked, paused, interrupted, cancelled |
| executing | verifying, paused, interrupted, budget_exhausted, blocked, failed, cancelled |
| verifying | report_pending, paused, interrupted, failed, cancelled |
| report_pending | awaiting_next_round, completed, paused, blocked, failed, cancelled |
| awaiting_next_round | planning, paused, interrupted, cancelled |
| paused | 原状态（恢复）, cancelled, failed |
| interrupted | 原状态（恢复）, cancelled, failed |
| budget_exhausted | 原状态（追加预算后恢复）, cancelled, failed |
| blocked | 原状态（解除阻塞后恢复）, cancelled, failed |

约束：

- `interrupted` 不是 `failed`；
- `blocked` 只表示外部条件，不表示执行失败；
- `paused` 不替代 `awaiting_approval` / `awaiting_clarification`；
- 恢复时必须回到暂停/中断前的状态，不直接跳到 completed。

### 4.3 身份

`AgentTask` 增加：

```ts
runId: string;
contextId?: string;
checkpointId?: string;
```

- `taskId` 不变；
- `runId` 恢复复用，用户明确重跑才换；
- `contextId` 每次上下文版本变化；
- `checkpointId` 最近一次已提交检查点。

## 4.4 上下文所有权

| ownerType | ownerId | 谁拥有 | 指针存在 |
| --- | --- | --- | --- |
| `agent-task` | taskId | TaskManager / AgentOrchestrator | `AgentTask.contextId/checkpointId` |
| `conversation` | conversationId | ConversationRunner | `Conversation.contextId/checkpointId`（P0-05 冻结） |

规则：

1. `owner` 是权威；`taskId/conversationId` 只是兼容镜像。
2. General/Knowledge 不伪造 `AgentTask`。
3. 恢复只加载 `owner + runId` 对应的检查点。
4. 同一 owner 多个 runId 时，活动指针必须写明 `runId + checkpointId`。
5. 检查点文件按 `ownerType/ownerId` 隔离，不能互相覆盖。
6. Conversation 当前代码没有独立 `runId`；P0-05 必须冻结它如何生成/复用，
   在此之前不得假设它已存在。

### 4.5 Conversation 运行身份

| 字段 | 语义 |
| --- | --- |
| `conversationId` | 整个会话的稳定身份 |
| `runId` | 一次连续执行过程；不永久等于 conversationId |
| `contextId` | 当前使用的上下文版本 |
| `checkpointId` | 最近提交的上下文检查点 |
| `activeRunId` | 与 checkpointId 组成 Journal 活动指针 |

规则：

1. 新用户请求启动新 runId；
2. 同一次请求的模型/工具/评审共享 runId；
3. 暂停恢复原 runId；
4. 明确重新开始时才生成新 runId；
5. 新 run 可继承已提交检查点，但记录来源 checkpointId；
6. 删除会话时指针/归档一致清理。

### 4.6 活动指针权威

**Journal 中 owner 的活动指针是唯一提交/恢复权威。**

- `contextId`
- `checkpointId`
- `activeRunId`

检查点文件中的 `active` 只能作为可重建缓存；不得参与提交或恢复决策。
G3 必须删除或明确标注该缓存。

## 5. 不变量

### 5.1 请求

1. `question` 与用户原话逐字一致。
2. `system` 只来自系统/工具/Memory 注入，不混入用户问题。
3. Web 通道不接收强制 system。
4. CLI 不伪造 system turn。
5. `requestId`、`contextId`、`taskId`、`runId` 可关联。
6. `systemHash` 按实际消息组装结果计算。
7. Provider 不支持上下文能力时，标记 `degraded` 或 `unknown`，不换 Provider。

### 5.2 压缩

1. 原始事件不删除。
2. 未配对工具调用不压缩。
3. 摘要只覆盖 `sourceStartSeq..sourceEndSeq`。
4. 摘要生成后新增事件不进入本次摘要。
5. `sourceEventIds` 是完整引用；UI/事件 payload 可以只带前 20 个预览。
6. 被压缩引用的事件若会被 Journal 裁剪，必须先写入归档段并记录 `archiveRef`。
7. 检查点校验使用完整 `sourceEventIds`，不得使用预览截断。
5. 摘要提交成功前不使用。
6. 摘要失败/过期保留旧上下文。
7. 摘要 `evidence` 必须能在 Evidence Store 或执行报告里找到。
8. 摘要中的“已完成/验证通过”必须有事件依据，否则标 `claim`。

### 5.3 恢复

1. 恢复以执行事实为准，不以摘要为准。
2. 已完成写操作不自动重做。
3. 未知副作用步骤标 `needs_reconciliation`。
4. 恢复不改变 `taskId`；`runId` 默认复用。
5. 同一任务同时只允许一个恢复流程。
6. 恢复事件必须可追溯。

### 5.4 UI

1. 未知 Token/费用显示“未提供”。
2. 没有执行证据不显示“已验证”。
3. 压缩中、失败、stale 必须可区分。
4. 不把摘要当任务进度。
5. 不隐藏真实步骤。

## 6. 事件目录

| 事件 | phase | 关键 payload | 用途 |
| --- | --- | --- | --- |
| `context.budget.warning` | understanding/planning | budget, usageRatio, level | 预警 |
| `context.compaction.started` | planning/execution | contextId, source range | 开始压缩 |
| `context.compaction.summary.ready` | planning/execution | checkpointId, modelId, tokens | 摘要完成 |
| `context.compaction.committed` | planning/execution | checkpointId, before/after | 提交成功 |
| `context.compaction.failed` | planning/execution | reason | 压缩失败 |
| `context.compaction.stale` | planning/execution | checkpointId, reason | 摘要过期 |
| `context.recovered` | execution | checkpointId, taskId | 恢复完成 |

映射到 `task-events.ts` 的 `phaseOfEvent` 时，按事件发生的真实阶段填，不统一塞进 `execution`。

## 7. 错误与降级

| 情况 | 行为 | UI |
| --- | --- | --- |
| 窗口未知 | `confidence=unknown`，保守预算 | “窗口未提供” |
| 估算失败 | 只记录，不阻塞 | 无额外提示 |
| 摘要模型失败 | 保留旧上下文，可继续裁剪 | “摘要失败，保留旧上下文” |
| 摘要校验失败 | 不提交 | “摘要未通过校验” |
| 摘要 stale | 不提交，重新生成或回退 | “摘要已过期” |
| 检查点写失败 | 回退未压缩 | “压缩未提交” |
| 恢复失败 | 停在 interrupted，要求人工 | “恢复需要人工确认” |
| Provider 溢出 | 一次受控压缩重试 | “上下文溢出，已重试一次” |
| 压缩后仍溢出 | 停止当前请求，记录原因 | “上下文仍超限” |
| 工具配对不完整 | 不压缩该段 | 轨迹显示“未配对” |

## 8. 测试义务

每个契约变更必须补：

- 类型/序列化兼容测试；
- 用户原话不变测试；
- Memory 只进 system 测试；
- Web/CLI 边界测试；
- 摘要证据校验测试；
- 检查点崩溃恢复测试；
- 状态转换合法/非法测试；
- 未知值不为 0 测试。

## 9. 未决问题

1. `ContextSummary` 是否允许 Markdown 正文，还是只允许结构化字段？
2. 摘要模型是否可与任务模型不同；费用如何归属？
3. Web/CLI 是否参与摘要生成；如果不参与，摘要模型如何选？
4. `runId` 当前由谁生成；恢复是否复用。
5. 检查点保留数量与磁盘配额。
6. 旧 `UNIFIED-TASK-RUNTIME.md` 状态板如何修正。

这些在 `LT-P0-02` / `LT-P0-03` / `LT-P0-04` 中定稿。
