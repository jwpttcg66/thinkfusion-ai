# ThinkFusion 长任务与上下文压缩 · 正式实施任务书

状态：设计完成，未实施  
设计基线：`main` · `e336ae434978211138879688031a9d40c1a27cd7` · 2026-11-24  
架构决议：[LONG_TASK_AND_CONTEXT_COMPACTION.md](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md)  
文档集：[LONG-TASK-CONTEXT-README.md](LONG-TASK-CONTEXT-README.md)  
唯一状态板：[STATUS.md](STATUS.md)  
契约：[LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)  
存储：[CONTEXT_CHECKPOINT_STORAGE.md](../architecture/CONTEXT_CHECKPOINT_STORAGE.md)  
UI：[LONG_TASK_CONTEXT_UI.md](../spec/LONG_TASK_CONTEXT_UI.md)  
测试：[LONG-TASK-CONTEXT-TEST-PLAN.md](LONG-TASK-CONTEXT-TEST-PLAN.md)  
灰度：[LONG-TASK-CONTEXT-ROLLOUT.md](../operations/LONG-TASK-CONTEXT-ROLLOUT.md)

> 进入条件：G0–G6 全局一致性门禁通过（见
> [V3-GLOBAL-CONSISTENCY-TASK-BOOK.md](V3-GLOBAL-CONSISTENCY-TASK-BOOK.md)）。
> 本任务书只设计施工顺序、接口、验收与回滚，不代表任何任务已实施。
> 每个任务开工前必须重新核对远程 `main`；代码变化时先改本文，再改代码。

## 0. 范围与原则

### 0.1 范围

本任务书覆盖两条能力：

1. **长任务持续执行**：持续推进、动态调整、并发、暂停/恢复、中断处理、可观察进度。
2. **上下文生命周期管理**：预算、裁剪、摘要、检查点、恢复、成本与证据保留。

### 0.2 非目标

- 不新建第三套 Agent Runtime。
- 不重写 `TaskManager`、`AgentOrchestrator`、Collaboration Engine。
- 不把压缩摘要写入长期 Memory。
- 不用摘要替代 Evidence、测试报告或执行事实。
- 不改变 Web 通道“原话输入”的边界。
- 不把 Provider 未知上下文窗口伪造成固定值。

### 0.3 必须遵守的约束

- Task State、Execution State、Session History、Context State 四种状态独立。
- 压缩只替换模型输入中的历史表示；原始事件由 Journal 或归档段保留可追溯，
  被引用事件未归档前不得裁剪。
- 先裁剪工具结果，再做模型摘要。
- 摘要必须引用 `sourceEventIds` 与 `EvidenceRef`。
- 未知 Token、未知窗口、未知费用显示“未提供”，不写 0。
- 每个任务独立 PR；依赖未合并前不领后续任务。
- 未通过真实测试与 typecheck 的任务不得标记完成。

## 0.4 文档治理与 V3/LT 边界

- **唯一状态板**：`docs/implementation/STATUS.md`；
- V3 既有模块（`task-manager.ts`、`orchestrator.ts`、`store.ts`、
  `task-events.ts`、`task-view.ts`）由 V3 计划拥有；LT 只做扩展，
  不重写同一职责；
- 同一文件被两条轨道同时修改时，先在该文件对应任务书中写清接口与顺序；
- LT 的 P0–P6 使用 `LT-P0`–`LT-P6`，不与 V3 的 P0–P6 混用；
- 所有 LT 文档基线统一为 `main@e336ae4`；旧基线只作历史；
- 测试计划中的 `test:context-*` 是未来脚本，P0 必须登记到
  `verify`/`test:all` 后才能作为门禁。

共享文件所有权：

| 文件 | V3 所有权 | LT 只做 |
| --- | --- | --- |
| `task-manager.ts` | 任务生命周期/状态机 | P5 增加暂停/中断/预算/阻塞状态 |
| `orchestrator.ts` | 工程执行治理 | P4 上下文接线；P5 暂停/恢复钩子 |
| `store.ts` | Journal/事件/配额 | P0-03/P3 检查点指针与归档协议 |
| `task-events.ts` | 统一事件信封 | P3-05 追加 `context.*` 事件 |
| `task-view.ts` | 任务展示投影 | P6 增加上下文/压缩字段 |
| `execution-pool.ts` | 多模型执行名单 | P4-01 prepare/finalize 钩子 |

两条轨道不得各自重写同一职责；冲突时以 V3 现有模块所有权为准。

## 1. 任务编号与依赖

任务编号：`LT-P<阶段>-<两位序号>`，例如 `LT-P1-03`。

```text
P0 契约冻结
 ├─ LT-P0-01 现状审计
 ├─ LT-P0-02 类型契约
 ├─ LT-P0-03 存储 ADR
 ├─ LT-P0-04 状态机/文档冲突决策
 ├─ LT-P0-05 上下文所有权与跨空间身份
 ├─ LT-P0-06 Journal 事件保留/归档
 ├─ LT-P0-07 跨文档状态与测试门禁
 └─ LT-P0-08 LT 灰度/回滚演练设计
        ↓
P1 Context Manager 基础
 ├─ LT-P1-01 模块骨架
 ├─ LT-P1-02 ContextBuilder
 ├─ LT-P1-03 TokenEstimator
 ├─ LT-P1-04 BudgetManager
 └─ LT-P1-05 Provider 能力适配
        ↓
P2 工具结果裁剪
 ├─ LT-P2-01 ToolHistoryAdapter
 ├─ LT-P2-02 Pruner
 └─ LT-P2-03 接线与观测
        ↓
P3 摘要与检查点
 ├─ LT-P3-01 摘要 Schema / Validator
 ├─ LT-P3-02 Summarizer
 ├─ LT-P3-03 Checkpoint Store / Commit
 ├─ LT-P3-04 Recovery / Stale
 └─ LT-P3-05 Context Events / Trace
        ↓
P4 Provider 请求接线
 ├─ LT-P4-01 ExecutionPool Hook
 ├─ LT-P4-02 各入口策略
 ├─ LT-P4-03 Usage 校准
 └─ LT-P4-04 边界回归
        ↓
P5 暂停 / 恢复 / 中断
 ├─ LT-P5-01 TaskStatus 扩展
 ├─ LT-P5-02 Pause/Resume API
 ├─ LT-P5-03 Checkpoint Resume
 ├─ LT-P5-04 副作用核对
 └─ LT-P5-05 并发/取消保护
        ↓
P6 UI 与全链路验收
 ├─ LT-P6-01 主页面上下文状态
 ├─ LT-P6-02 轨迹压缩详情
 ├─ LT-P6-03 统计指标
 ├─ LT-P6-04 长任务故障注入 E2E
 └─ LT-P6-05 验收报告
```

## 2. 状态板

| 任务 | 状态 | 依赖 | 出口 |
| --- | --- | --- | --- |
| LT-P0-01 | 未开始 | — | 审计记录 |
| LT-P0-02 | 类型层完成 / TESTED | P0-01 | 契约类型 |
| LT-P0-03 | 未开始 | P0-01 | 存储 ADR |
| LT-P0-04 | 未开始 | P0-01 | 状态决策 |
| LT-P0-05 | 类型层完成 / TESTED | P0-02 / P0-04 | 所有权契约 |
| LT-P0-06 | 未开始 | P0-03 / P0-05 | 归档策略 |
| LT-P0-07 | 未开始 | P0-01 | 状态/基线统一 |
| LT-P0-08 | 未开始 | P0-03 / P0-07 | 回滚演练设计 |
| LT-P1-01 | 未开始 | P0-02 | 模块骨架 |
| LT-P1-02 | 未开始 | P1-01 | Builder |
| LT-P1-03 | 未开始 | P1-01 | Estimator |
| LT-P1-04 | 未开始 | P1-03 | Budget |
| LT-P1-05 | 未开始 | P0-02 | Provider 适配 |
| LT-P2-01 | 未开始 | P1-02 | 工具历史 |
| LT-P2-02 | 未开始 | P2-01 | Pruner |
| LT-P2-03 | 未开始 | P2-02 / P1-04 | 接线 |
| LT-P3-01 | 未开始 | P0-02 | 摘要契约 |
| LT-P3-02 | 未开始 | P3-01 / P1-04 | Summarizer |
| LT-P3-03 | 未开始 | P0-03 / P3-01 | Checkpoint |
| LT-P3-04 | 未开始 | P3-03 | Recovery |
| LT-P3-05 | 未开始 | P3-03 | 事件/Trace |
| LT-P4-01 | 未开始 | P1-02 / P2-03 / P3-04 | Pool Hook |
| LT-P4-02 | 未开始 | P4-01 | 入口策略 |
| LT-P4-03 | 未开始 | P1-03 / P4-01 | Usage 校准 |
| LT-P4-04 | 未开始 | P4-02 / P4-03 | 边界回归 |
| LT-P5-01 | 未开始 | P0-04 | 状态扩展 |
| LT-P5-02 | 未开始 | P5-01 | 暂停/恢复 |
| LT-P5-03 | 未开始 | P3-04 / P5-02 | 恢复计划 |
| LT-P5-04 | 未开始 | P5-03 | 副作用核对 |
| LT-P5-05 | 未开始 | P5-02 / P5-04 | 并发保护 |
| LT-P6-01 | 未开始 | P4-04 / P5-02 | 主页面 |
| LT-P6-02 | 未开始 | P3-05 / P4-04 | 轨迹页 |
| LT-P6-03 | 未开始 | P4-03 | 统计页 |
| LT-P6-04 | 未开始 | P4-04 / P5-05 | E2E |
| LT-P6-05 | 未开始 | P6-01..04 | 验收报告 |

## 3. 跨阶段契约

### 3.1 新增类型

建议落在 `desktop-agent-macos/src/shared/context.ts`（类型与纯函数）与
`desktop-agent-macos/src/main/context/`（实现）。

```ts
export type ContextCompactionStatus =
  | 'not-needed'
  | 'preparing'
  | 'summarizing'
  | 'validating'
  | 'committed'
  | 'failed'
  | 'stale';

export interface ContextBudget {
  providerId: string;
  modelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  estimatedInputTokens: number;
  actualInputTokens: number | null;
  warningThreshold: number;
  compactionThreshold: number;
  budgetSource: 'provider' | 'config' | 'estimated' | 'conservative';
  configuredInputLimit?: number;
  confidence: 'verified' | 'configured' | 'estimated' | 'unknown';
}

export type ContextOwner =
  | { ownerType: 'agent-task'; ownerId: string; taskId: string; runId: string }
  | { ownerType: 'conversation'; ownerId: string; conversationId: string; runId: string };

export interface PreparedContext {
  contextId: string;
  owner: ContextOwner;
  taskId?: string;
  conversationId?: string;
  runId: string;
  checkpointId?: string;
  includedEventIds: string[];
  evidenceRefs: string[];
  memoryRequestId?: string;
  estimatedTokens: number;
  contextWindow: number | null;
  compactionStatus: ContextCompactionStatus;
}

export interface ContextCheckpoint {
  checkpointId: string;
  owner: ContextOwner;
  taskId?: string;
  conversationId?: string;
  runId: string;
  contextId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  sourceEventIds: string[];
  sourceEventIdsPreview?: string[];
  archiveRef?: string;
  summary: string;
  summaryHash: string;
  retainedEventIds: string[];
  evidenceRefs: string[];
  modelId: string;
  inputTokensBefore: number | null;
  inputTokensAfter: number | null;
  status: 'prepared' | 'committed' | 'failed';
  createdAt: number;
}

export type ContextEventType =
  | 'context.budget.warning'
  | 'context.compaction.started'
  | 'context.compaction.summary.ready'
  | 'context.compaction.committed'
  | 'context.compaction.failed'
  | 'context.compaction.stale'
  | 'context.recovered';
```

### 3.2 `ContextManager` 接口

```ts
export interface ContextManager {
  prepare(input: PrepareContextInput): Promise<PreparedContext>;
  finalize(input: FinalizeContextInput): Promise<void>;
  recover(taskId: string, runId: string): Promise<PreparedContext | null>;
}
```

`prepare` 只组装与压缩，不执行工具、不审批、不改变任务状态。
`finalize` 接收真实 Usage，校准估算并记录指标。
`recover` 只读检查点与事件，不自动重跑工具。

### 3.3 身份扩展

`AgentTask` 增加：

```ts
runId: string;          // 一次连续运行；恢复复用，明确重跑才换
contextId?: string;     // 当前使用的上下文版本
checkpointId?: string;  // 最近一次已提交检查点
activeRunId?: string;   // 与 checkpointId 一起构成活动指针
```

`TaskEventEnvelope` 已有 `runId/roundId/stepId/attemptId`；不新建第二套事件。

### 3.4 状态扩展

`TaskStatus` 增加：

```ts
| 'paused'
| 'interrupted'
| 'budget_exhausted'
| 'blocked'
```

- `awaiting_approval` / `awaiting_clarification` 保留；
- `interrupted` 不是 `failed`；
- `blocked` 只表示外部条件阻塞，不是执行失败；
- 所有状态新增必须同步状态机、UI 标签、`codingStateFor`、测试。

### 3.5 存储决策

`LT-P0-03` 必须在以下两案中定一个 ADR：

| 方案 | 做法 | 优点 | 风险 |
| --- | --- | --- | --- |
| A | `agent-store.json` 增加 `contextCheckpoints` 数组 | 与任务同一原子写 | 摘要大，频繁写会拖慢 Journal |
| B | `context/owners/<ownerType>/<ownerId>.json`，Journal 只存指针 | Journal 轻；摘要可独立清理；支持 AgentTask/Conversation | 两份文件需要恢复顺序与一致性协议 |

推荐 **B**，但必须在 ADR 中写清：

1. 检查点文件先写 `prepared`（临时文件 → fsync → rename → 父目录 fsync）；
2. **同一次 Journal persist** 更新 `contextId/checkpointId/activeRunId` + committed 事件；
3. Journal 指针是提交权威；prepared 文件不等于活动检查点；
4. 同一 owner 串行写，多 runId 活动指针互不覆盖；
5. 被压缩引用的原始事件先归档，再允许 Journal 裁剪；
6. 崩溃恢复以 Journal 指针 + checkpoint 文件 + 归档双向核对；
7. 过期/未提交检查点清理策略；
8. 旧 `agent-store.json` 无字段时按“无检查点”兼容；
9. 大摘要不进入事件日志，事件只带 `checkpointId` 与来源预览。

## 4. P0 · 审计与契约冻结

### LT-P0-01 现状审计与基线冻结

- 目标：把本文引用的文件、函数、状态、事件、存储限制核到当前 `main`。
- 依赖：无。
- 接触文件：只读；产出 `docs/implementation/LONG-TASK-CONTEXT-AUDIT.md`。
- 实现要点：
  1. 核对 `TaskStatus`、`ALLOWED`、`reconcileInterrupted()`；
  2. 核对 `TaskEventEnvelope`、`AgentStore` 配额与 `KEEP_FOREVER`；
  3. 核对 `ModelRequest/ModelUsage/ModelMetadata.contextTokens`；
  4. 核对 `ExecutionPool.ask/askStream`、`ProviderBackedSubAgent`；
  5. 核对 Memory 注入点与“记忆不是证据”约束；
  6. 记录 `UNIFIED-TASK-RUNTIME.md` 与实际恢复行为的冲突。
- 验收：
  - 审计文档列出每个接口的真实文件与函数；
  - 明确哪些能力已有、哪些只是计划；
  - 明确基线提交与日期。
- 测试：无代码；文档审阅。
- 回滚：删除审计文档。
- 不做：改代码、改状态。

### LT-P0-02 契约冻结

- 目标：落 `src/shared/context.ts` 类型与纯函数签名，不接运行时。
- 依赖：P0-01。
- 接触文件：`src/shared/context.ts`、`src/shared/contracts.ts`、`src/shared/task-events.ts`。
- 实现要点：
  1. 落 3.1–3.4 的类型；
  2. `AgentTask` 增加 `runId/contextId/checkpointId`（可选兼容旧数据）；
  3. `TaskStatus` 暂不加入新状态，先定义 `LongTaskStatus` 供 P5 使用；
  4. 所有新字段可选，保证旧 Journal 可读；
  5. 只写类型与常量，不写压缩逻辑。
- 验收：
  - typecheck 三套通过；
  - 旧任务/旧事件不需要迁移即可读取；
  - 新类型有单元测试或类型测试。
- 测试：`npm run typecheck`；新增 `test:context-contracts`。
- 回滚：删除新类型与字段；旧数据不受影响。
- 不做：Provider 接线、存储写入。

### LT-P0-03 检查点存储 ADR

- 目标：决定 3.5 的方案 A/B，写清恢复顺序。
- 依赖：P0-01。
- 接触文件：`docs/adr/`（下一个编号）、`src/main/store.ts`（只读设计）。
- 实现要点：
  1. 评估 Journal 大小、写频率、原子写；
  2. 定义 `context/owners/<ownerType>/<ownerId>.json` 与 Journal 指针；
  3. 定义 prepared 文件 → Journal 指针的提交与崩溃恢复协议；
  4. 定义清理与配额；
  5. 定义旧数据兼容。
- 验收：
  - ADR 有明确选择与反例；
  - 有流程图或步骤说明；
  - P3 任务可按 ADR 实施，无需二次决策。
- 测试：文档评审。
- 回滚：ADR 标记 superseded。
- 不做：实现存储。

### LT-P0-04 状态机与文档冲突决策

- 目标：定义 `paused/interrupted/budget_exhausted/blocked` 的转换与 UI 文案；
  修正 `UNIFIED-TASK-RUNTIME.md` 中“重启恢复已完成”的错误状态。
- 依赖：P0-01。
- 接触文件：`src/main/task-manager.ts`（只读设计）、`src/shared/task-lifecycle.ts`、`docs/implementation/UNIFIED-TASK-RUNTIME.md`。
- 实现要点：
  1. 给出完整转换表；
  2. `reconcileInterrupted` 改为 `interrupted`，不自动重跑；
  3. 明确 `blocked` 与 `failed` 的边界；
  4. 明确 `budget_exhausted` 的恢复动作；
  5. 更新文档状态板。
- 验收：
  - 转换表覆盖所有合法/非法转换；
  - 旧任务无新状态时按原状态读取；
  - 文档不再声称重启恢复已完成。
- 测试：文档 + 转换表评审；P5 实现时补状态机测试。
- 回滚：恢复文档与转换表。
- 不做：代码改动。

**P0 出口**：契约、存储 ADR、状态决策、审计记录全部冻结；未写运行时。

### LT-P0-05 上下文所有权与跨空间身份

- 目标：冻结 `ContextOwner`，让 AgentTask 与 Conversation 都能拥有上下文，
  不伪造 AgentTask。
- 依赖：P0-02、P0-04。
- 接触文件：`src/shared/context.ts`、`contracts.ts`、`conversation.ts`、
  `task-events.ts`、存储设计。
- 实现要点：
  1. `ownerType: 'agent-task' | 'conversation'`；
  2. `ownerId` 权威，`taskId/conversationId` 只是镜像；
  3. 检查点按 `ownerType/ownerId` 隔离；
  4. 活动指针 `{runId, checkpointId}`；
  5. 恢复只加载 `owner + runId`；
  6. `Conversation` 增加 contextId/checkpointId/activeRunId（P0 只定义）。
- 验收：
  - General/Knowledge 不伪造 AgentTask；
  - 同一 owner 多 runId 不互相覆盖；
  - 跨空间恢复测试通过。
- 测试：`test:context-contracts`；跨空间恢复单测。
- 回滚：删除 owner 字段，回到 taskId-only（不推荐）。
- 不做：实现 ContextManager。

### LT-P0-06 Journal 事件保留、归档与检查点引用

- 目标：解决“原始事件永久保留”与现有 800/5000 事件配额的冲突。
- 依赖：P0-03、P0-05。
- 接触文件：`src/main/store.ts`（只读设计）、`context/archive/*`、契约。
- 实现要点：
  1. Context Manager 不主动删事件；
  2. 被压缩引用的来源先写归档段 `context/archive/...`；
  3. 检查点保存完整 `sourceEventIds`，事件 payload 只带预览；
  4. Journal 裁剪前检查引用；未归档不得裁剪；
  5. 归档段按检查点引用清理。
- 验收：
  - 检查点引用的来源可追溯；
  - 裁剪不会让摘要失去原始范围；
  - 归档失败不提交检查点。
- 测试：归档/裁剪/stale 单测。
- 回滚：停止归档，保留旧事件配额。
- 不做：改变现有事件配额数值。

### LT-P0-07 跨文档状态、基线、旧规格与测试门禁

- 目标：让所有文档只有一个状态来源，旧规格有明确标记。
- 依赖：P0-01。
- 接触文件：`docs/implementation/STATUS.md`、`docs/README.md`、
  `docs/ROADMAP.md`、`docs/PRODUCT.md`、`implementation/README.md`、
  `00-master-plan.md`、`UNIFIED-TASK-RUNTIME.md`、测试脚本注册。
- 实现要点：
  1. `STATUS.md` 为唯一状态板；
  2. 所有 LT 文档基线统一到 `e336ae4`；
  3. V3 P0-J/P0-04/P0-06/P1-001 口径分开；
  4. 历史规格标 `HISTORICAL`；
  5. 明确 `test:context-*` 是未来脚本；
  6. P0 至少注册 `test:context-contracts` 到 `package.json` 与 `verify`/`test:all`；
     其它 `test:context-*` 在对应阶段登记，未登记前不能当门禁。
- 验收：
  - 不再出现互相矛盾的状态表；
  - 文档基线一致；
  - 测试计划命令与 `package.json` 的落地关系写清。
- 测试：文档评审；`npm run verify` 不被文档改动影响。
- 回滚：恢复旧文档（不推荐）。
- 不做：实现运行时。

### LT-P0-08 LT 灰度/回滚演练设计

- 目标：为 LT 轨道单独设计开关、灰度、备份恢复与回滚演练，
  不与 V3 P0-06 混用编号。
- 依赖：P0-03、P0-07。
- 接触文件：`docs/operations/LONG-TASK-CONTEXT-ROLLOUT.md`、ADR 0010。
- 实现要点：
  1. `contextManagerMode: off/shadow/active`；
  2. `resumeMode: off/shadow/active`；
  3. 检查点文件备份/恢复与临时目录校验；
  4. 关闭开关后的旧路径；
  5. 演练步骤与证据。
- 验收：
  - 每个开关可回退；
  - 备份恢复不破坏任务；
  - 回滚演练步骤可执行。
- 测试：桌面演练；P6 真机复验。
- 回滚：关闭开关。
- 不做：实际发布。

## 5. P1 · Context Manager 基础

### LT-P1-01 模块骨架与 Manager

- 目标：建立 `src/main/context/` 目录与 `ContextManager` 空实现。
- 依赖：P0-02。
- 接触文件：`src/main/context/manager.ts`、`types.ts`、`index.ts`。
- 实现要点：
  1. `prepare` 先返回未压缩上下文（原样透传）；
  2. `finalize` 先只记录 Usage；
  3. `recover` 先返回 null；
  4. 不改变现有请求路径。
- 验收：
  - 现有测试全绿；
  - 开关关闭时行为完全不变。
- 测试：`test:context-manager`；现有 `npm run verify`。
- 回滚：删除模块与导出。
- 不做：压缩、Provider 接线。

### LT-P1-02 ContextBuilder

- 目标：按固定顺序组装上下文，保证用户原话不被改写。
- 依赖：P1-01。
- 接触文件：`src/main/context/builder.ts`、`src/main/memory/context.ts`、`src/main/memory/inject.ts`。
- 实现要点：
  1. 顺序：目标 → 系统/工具契约 → 任务状态 → 摘要 → 未压缩历史 → 当前步骤 → Evidence → Memory → 当前问题；
  2. Memory 只进 system，不进 question；
  3. Evidence 与 Memory 分开标记；
  4. 生成 `contextId` 与 `includedEventIds`；
  5. 同样输入必须生成同样上下文（稳定排序）。
- 验收：
  - 用户原始问题逐字不变；
  - 同一输入重复构建结果一致；
  - Web/CLI 不被迫接收 system。
- 测试：Builder 单测；`test:prompt-policy`。
- 回滚：关闭开关，回退到现有请求组装。
- 不做：压缩、摘要。

### LT-P1-03 TokenEstimator

- 目标：提供可解释的 Token 估算与校准。
- 依赖：P1-01。
- 接触文件：`src/main/context/estimator.ts`、`src/main/providers/*`（只读）。
- 实现要点：
  1. 文本估算按模型家族策略；
  2. 返回 `estimated` 与 `confidence`；
  3. 记录真实 Usage 与估算误差；
  4. 无 usage 时保留 null；
  5. 不把估算写成 Provider 实际值。
- 验收：
  - 已知样本误差在可接受范围；
  - Web/CLI 未知值显示未知；
  - 估算器无网络与副作用。
- 测试：固定样本单测；误差回归。
- 回滚：关闭估算，使用保守阈值。
- 不做：预算决策。

### LT-P1-04 BudgetManager

- 目标：按模型独立计算窗口、输出预留、安全余量、触发阈值。
- 依赖：P1-03。
- 接触文件：`src/main/context/budget.ts`。
- 实现要点：
  1. 窗口未知时返回 `confidence:'unknown'` 与保守值；
  2. 65/75/85 阈值可配置；
  3. 输出预留与安全余量独立；
  4. 不把 128K/200K 写死。
- 验收：
  - 不同模型得到不同预算；
  - 未知窗口不崩溃、不伪造；
  - 阈值边界测试。
- 测试：预算单测；未知窗口回归。
- 回滚：关闭压缩触发，仅记录预算。
- 不做：摘要。

### LT-P1-05 Provider 上下文能力适配

- 目标：统一读取 Provider 的窗口、输出限制、usage 能力。
- 依赖：P0-02。
- 接触文件：`src/main/context/adapters/provider-context.ts`、`src/main/providers/types.ts`、`ollama.ts`、`openai-compatible.ts`。
- 实现要点：
  1. `contextTokens=null` 保留 null；
  2. Ollama 用实际模型信息；
  3. OpenAI 兼容按配置/元数据；
  4. Web/CLI 标记 unknown；
  5. 不改变 Provider 选择。
- 验收：
  - 各 Provider 返回统一结构；
  - 未知能力不导致降级换 Provider；
  - 现有 Provider 测试全绿。
- 测试：Provider 适配单测；现有 `test:providers`。
- 回滚：适配层关闭，返回 unknown。
- 不做：请求接线。

**P1 出口**：上下文可重复构建；预算可解释；Provider 能力可查询；未改变模型请求。

## 6. P2 · 工具结果裁剪

### LT-P2-01 ToolHistoryAdapter

- 目标：把工具调用与结果配对，供裁剪器使用。
- 依赖：P1-02。
- 接触文件：`src/main/context/adapters/tool-history.ts`、`src/shared/task-events.ts`（只读）。
- 实现要点：
  1. 按 `stepId/attemptId` 配对 started/completed/failed；
  2. 未完成调用不裁剪；
  3. 保留原始事件 ID 与 EvidenceRef；
  4. 输出稳定的工具历史条目。
- 验收：
  - 调用/结果不拆散；
  - 失败/未完成不被丢弃；
  - 同一 stepId 重试可区分 attempt。
- 测试：配对单测；失败/重试回归。
- 回滚：关闭裁剪。
- 不做：摘要。

### LT-P2-02 确定性 Pruner

- 目标：不调用模型，裁剪大输出、重复内容、已归档证据。
- 依赖：P2-01。
- 接触文件：`src/main/context/compaction/pruner.ts`。
- 实现要点：
  1. 大终端输出保留命令、退出码、统计、证据指针；
  2. 重复文件内容去重；
  3. 已被 Evidence Pack 保存的内容只留引用；
  4. 原始结果位置保留；
  5. 不做语义猜测。
- 验收：
  - 裁剪后可定位原始输出；
  - 不丢执行结果与错误；
  - 裁剪结果稳定可复现。
- 测试：Pruner 单测；大输出/重复内容回归。
- 回滚：关闭 pruner，保留原历史。
- 不做：模型摘要。

### LT-P2-03 裁剪接线与观测

- 目标：在 ContextBuilder 中启用 pruner，并记录裁剪前后 Token。
- 依赖：P2-02、P1-04。
- 接触文件：`src/main/context/builder.ts`、`manager.ts`、`src/main/trace/*`（只读）。
- 实现要点：
  1. 预算超阈值时先裁剪；
  2. 记录 `prunedTokens`、被裁剪条目；
  3. 不够时交给 P3 摘要；
  4. 开关可回退。
- 验收：
  - 裁剪后请求可正常发送；
  - 统计显示裁剪前后；
  - 原始历史仍可查。
- 测试：Builder 集成测试；UI 统计占位。
- 回滚：关闭 pruner。
- 不做：摘要提交。

**P2 出口**：大工具输出可裁剪；原始结果可查；裁剪不改变执行事实。

## 7. P3 · 摘要与检查点

### LT-P3-01 摘要 Schema 与 Validator

- 目标：定义结构化摘要与完整性校验。
- 依赖：P0-02。
- 接触文件：`src/main/context/compaction/summary.ts`、`validator.ts`。
- 实现要点：
  1. 字段：goal/constraints/completed/decisions/evidence/openIssues/currentStep/nextActions/risks/stopConditions；
  2. 区分“已验证事实”与“模型观点”；
  3. 校验 `sourceEventIds`、`EvidenceRef`；
  4. 摘要 hash；
  5. 拒绝声称测试通过但无证据的摘要。
- 验收：
  - 缺证据的完成声明被拒绝；
  - 摘要可解析、可哈希；
  - 旧摘要版本可兼容。
- 测试：Validator 单测；伪造证据回归。
- 回滚：停用摘要，保留裁剪。
- 不做：调用模型。

### LT-P3-02 Summarizer

- 目标：生成后台摘要，支持超时/取消，不提前删除旧上下文。
- 依赖：P3-01、P1-04。
- 接触文件：`src/main/context/compaction/summarizer.ts`、Provider 适配。
- 实现要点：
  1. 只总结指定事件范围；
  2. 超时/取消不提交；
  3. 记录模型、费用、耗时；
  4. 不把摘要当执行事实；
  5. Web/CLI 是否参与由配置决定。
- 验收：
  - 摘要失败保留旧上下文；
  - 取消不产生 committed 检查点；
  - 费用与模型可追溯。
- 测试：失败/超时/取消回归。
- 回滚：关闭摘要。
- 不做：提交检查点。

### LT-P3-03 Checkpoint Store 与 Commit

- 目标：按 P0-03 ADR 落检查点存储与原子提交状态机。
- 依赖：P0-03、P3-01。
- 接触文件：`src/main/context/checkpoint/store.ts`、`commit.ts`、`src/main/store.ts`（按 ADR）。
- 实现要点：
  1. prepared 文件 → Journal 指针 + committed 事件；
  2. Journal 指针是提交权威；
  3. 崩溃恢复双向核对（指针/文件/hash/归档）；
  4. 清理过期/未提交检查点；
  5. 事件只引用 checkpointId。
- 验收：
  - 中途崩溃恢复旧检查点；
  - 未提交摘要不被使用；
  - 旧 Journal 可读。
- 测试：断电/半提交模拟；存储兼容回归。
- 回滚：删除检查点文件与索引，恢复旧上下文。
- 不做：UI。

### LT-P3-04 Recovery 与 Stale

- 目标：校验摘要范围、证据与版本，检测 stale。
- 依赖：P3-03。
- 接触文件：`src/main/context/compaction/recovery.ts`。
- 实现要点：
  1. 摘要依赖事件是否仍在；
  2. 证据是否仍有效；
  3. 摘要生成后是否有新事件；
  4. stale 时重新生成或回退；
  5. 不自动用摘要覆盖新事实。
- 验收：
  - 摘要过期不使用；
  - 新事件保留；
  - 恢复后上下文完整。
- 测试：stale/事件变化回归。
- 回滚：回退到未压缩上下文。
- 不做：任务恢复（P5）。

### LT-P3-05 Context Events 与 Trace

- 目标：把压缩过程写入现有事件/Trace，不新造日志。
- 依赖：P3-03。
- 接触文件：`src/shared/task-events.ts`、`src/main/trace/*`、`src/shared/observability.ts`。
- 实现要点：
  1. `context.budget.warning` 等事件；
  2. 事件只带 checkpointId 与计数；
  3. 大摘要不入事件；
  4. 可在轨迹页按任务/轮次查询。
- 验收：
  - 事件顺序正确、可恢复；
  - 刷新后仍在；
  - 不重复显示。
- 测试：事件投影回归。
- 回滚：关闭事件，仅日志。
- 不做：UI 详情。

**P3 出口**：摘要可生成/校验/提交/回退；原始历史与证据不丢；崩溃安全。

## 8. P4 · Provider 请求接线

### LT-P4-01 ExecutionPool / Provider Hook

- 目标：所有可压缩请求经过 `ContextManager.prepare/finalize`。
- 依赖：P1-02、P2-03、P3-04。
- 接触文件：`src/main/execution/execution-pool.ts`、`provider-sub-agent.ts`、`src/main/context/manager.ts`。
- 实现要点：
  1. `ask/askStream` 前 prepare，后 finalize；
  2. 生成 `contextId` 并写入 Trace；
  3. 开关关闭时零行为变化；
  4. CLI/Web 边界保持不变。
- 验收：
  - 现有请求输出不变（开关关闭）；
  - 开关开启后上下文含摘要/裁剪；
  - requestId/usage/trace 贯通。
- 测试：Pool 集成；现有 `test:execution`、`test:providers`。
- 回滚：关闭开关。
- 不做：入口策略差异。

### LT-P4-02 入口策略

- 目标：Master、Collaboration、Engineering、Debate 各自定义上下文策略。
- 依赖：P4-01。
- 接触文件：`master-agent.ts`、`collaboration/runner/runner.ts`、`orchestrator.ts`、`judge/*`。
- 实现要点：
  1. Reviewer 只给目标/证据/Diff/待审问题；
  2. Implementer 给执行状态与工具结果；
  3. Debate 给观点与证据，不给全部内部思考；
  4. Web 原话不变。
- 验收：
  - 各入口上下文不同且可解释；
  - Reviewer 不泄露无关内部讨论；
  - 原有边界测试通过。
- 测试：按入口的上下文快照测试。
- 回滚：退回统一简单策略。
- 不做：UI。

### LT-P4-03 Usage 校准与成本

- 目标：用真实 usage 校准估算，记录压缩成本。
- 依赖：P1-03、P4-01。
- 接触文件：`src/main/context/estimator.ts`、`src/main/trace/*`、`src/shared/task-view.ts`。
- 实现要点：
  1. 每次请求后记录估算 vs 实际；
  2. 无 usage 保留 null；
  3. 摘要模型费用单独归集；
  4. 不把未知写 0。
- 验收：
  - 统计页能区分未知与 0；
  - 误差可累计；
  - 成本按任务/模型可查。
- 测试：usage null/有值两种回归。
- 回滚：停止校准，仅显示实际。
- 不做：UI 图表。

### LT-P4-04 边界回归

- 目标：锁定用户原话、Memory、Web/CLI、systemHash 边界。
- 依赖：P4-02、P4-03。
- 接触文件：`scripts/check-prompt-policy.mjs`、`check-providers.mjs`、`check-memory-*`。
- 实现要点：
  1. 用户问题逐字不变；
  2. Memory 只进 system；
  3. CLI 不伪造 system；
  4. Web 不注入；
  5. systemHash 按实际消息计算。
- 验收：全部回归通过。
- 测试：新增边界矩阵。
- 回滚：关闭 Context Manager。
- 不做：长任务恢复。

**P4 出口**：统一上下文接线可用、可关闭、可观测；边界未被破坏。

## 9. P5 · 暂停、恢复、中断

### LT-P5-01 TaskStatus 扩展

- 目标：落 `paused/interrupted/budget_exhausted/blocked` 与转换表。
- 依赖：P0-04。
- 接触文件：`src/shared/contracts.ts`、`src/main/task-manager.ts`、`src/shared/task-lifecycle.ts`、`src/shared/coding-workflow.ts`。
- 实现要点：
  1. 合法转换；
  2. UI 标签；
  3. `reconcileInterrupted` 改为 `interrupted`；
  4. 旧任务兼容；
  5. 测试状态机。
- 验收：
  - 非法转换仍被拒；
  - 重启后任务显示“已中断”而非失败；
  - 旧任务状态不受影响。
- 测试：`check-state-machine` 扩展；持久化回归。
- 回滚：迁移回旧状态，清理新字段。
- 不做：恢复执行。

### LT-P5-02 Pause / Resume / Stop / Cancel API

- 目标：提供用户可操作的暂停、继续、停止当前模型、取消。
- 依赖：P5-01。
- 接触文件：`src/main/orchestrator.ts`、`task-manager.ts`、`src/preload/index.ts`、`src/renderer/src/App.tsx`。
- 实现要点：
  1. 暂停不再调度新步骤；
  2. 停止只取消 requestId；
  3. 取消任务终态；
  4. 恢复入口；
  5. 网页 give-up 如实显示。
- 验收：
  - 各操作语义不同且可观察；
  - 暂停后无新步骤；
  - 停止不误杀任务。
- 测试：状态机 + IPC 测试；真机操作。
- 回滚：隐藏入口，保留旧取消。
- 不做：自动恢复。

### LT-P5-03 Checkpoint Resume

- 目标：从最近检查点恢复，不重做已完成步骤。
- 依赖：P3-04、P5-02。
- 接触文件：`src/main/orchestrator.ts`、`src/main/task-manager.ts`、`src/main/context/recovery.ts`。
- 实现要点：
  1. 加载 Task/Run/Checkpoint；
  2. 已完成步骤可复用；
  3. 不确定步骤标记 `needs_reconciliation`；
  4. 不自动重跑副作用；
  5. 生成恢复事件。
- 验收：
  - 重启不重复写文件；
  - 未知步骤显式标记；
  - 恢复后可继续。
- 测试：fake tool + 崩溃恢复。
- 回滚：恢复入口关闭，回到手动重提。
- 不做：副作用核对细节（P5-04）。

### LT-P5-04 副作用核对

- 目标：核对文件、Git、测试、shell 的实际副作用。
- 依赖：P5-03。
- 接触文件：`src/main/evidence-pack/*`、`src/main/engineering/snapshot.ts`、`src/main/task-worktree.ts`。
- 实现要点：
  1. 文件写入看 hash/内容/存在性；
  2. Git 看分支/提交/status；
  3. 测试看已执行结果与证据；
  4. 不可重复命令标记危险；
  5. 核对结果进事件。
- 验收：
  - 已完成写操作不重做；
  - 半完成步骤可识别；
  - 外部副作用有记录。
- 测试：故障注入；真实仓库小任务。
- 回滚：停止自动恢复，需人工确认。
- 不做：自动修复所有不一致。

### LT-P5-05 并发与取消保护

- 目标：多任务、多模型、压缩与恢复互不干扰。
- 依赖：P5-02、P5-04。
- 接触文件：`src/main/orchestrator.ts`、`context/manager.ts`、`context/checkpoint/*`。
- 实现要点：
  1. 按 taskId/contextId 隔离；
  2. 摘要竞争检测；
  3. 取消压缩不提交；
  4. 同一任务只允许一个恢复；
  5. 锁与幂等。
- 验收：
  - 并发任务不串上下文；
  - 取消不留下半检查点；
  - 重复恢复不重复执行。
- 测试：并发/取消回归。
- 回滚：串行化压缩与恢复。
- 不做：分布式多进程。

**P5 出口**：暂停/恢复/中断可用；不重复副作用；并发安全。

## 10. P6 · UI 与全链路验收

### LT-P6-01 主页面上下文状态

- 目标：在任务页显示上下文使用、检查点、压缩状态。
- 依赖：P4-04、P5-02。
- 接触文件：`src/renderer/src/components/engineering/TaskProgressCard.tsx`、`TaskConversation.tsx`、`style.css`。
- 实现要点：
  1. 百分比、估算、压缩后估算；
  2. 最近检查点；
  3. 后台摘要状态；
  4. 未知显示“未提供”；
  5. 不掩盖真实步骤。
- 验收：
  - 压缩中/失败/已完成可区分；
  - 不写假 Token；
  - 真机可读。
- 测试：UI 投影测试；真机截图。
- 回滚：隐藏卡片。
- 不做：压缩操作。

### LT-P6-02 轨迹压缩详情

- 目标：轨迹页显示压缩事件与检查点详情。
- 依赖：P3-05、P4-04。
- 接触文件：`TaskTrajectory.tsx`、`EventInspector.tsx`、观察性投影。
- 实现要点：
  1. warning/started/ready/committed/failed/stale；
  2. 点击看范围、摘要、证据、保留历史、费用；
  3. 事件可跳转任务/轮次。
- 验收：
  - 压缩过程可追溯；
  - 刷新后仍在；
  - 不重复。
- 测试：投影回归；真机。
- 回滚：隐藏压缩事件。
- 不做：统计图表。

### LT-P6-03 统计指标

- 目标：统计页显示上下文与压缩指标。
- 依赖：P4-03。
- 接触文件：`TaskStats.tsx`、`shared/task-view.ts`。
- 实现要点：
  1. 输入/输出 Token；
  2. 压缩前/后、次数、摘要费用、溢出恢复、估算误差；
  3. 未知“未提供”；
  4. 可按任务/模型。
- 验收：
  - 数字来源可追溯；
  - 未知不为 0；
  - 现有统计不回归。
- 测试：投影测试；真机。
- 回滚：隐藏新指标。
- 不做：历史数据回填。

### LT-P6-04 长任务故障注入 E2E

- 目标：验证 30 步长任务、压缩、失败、崩溃恢复。
- 依赖：P4-04、P5-05。
- 接触文件：`scripts/` 新 E2E；测试夹具。
- 实现要点：
  1. 30 步真实工程任务；
  2. 触发 65/75/85%；
  3. 摘要失败；
  4. 应用中断；
  5. 验证已完成步骤不重复、未完成可继续、证据完整。
- 验收：
  - 全部通过；
  - 有日志与检查点证据；
  - 失败可复现。
- 测试：E2E 脚本 + 真机。
- 回滚：测试标记 skip，不阻塞发布。
- 不做：性能压测。

### LT-P6-05 验收报告与状态板

- 目标：汇总实现、验证、已知限制，更新文档状态。
- 依赖：P6-01..04。
- 接触文件：`docs/implementation/LONG-TASK-CONTEXT-ACCEPTANCE.md`、`README`、任务书状态板。
- 实现要点：
  1. 每个任务 IMPLEMENTED/VERIFIED/TESTED；
  2. 真机证据；
  3. 已知限制；
  4. 回滚演练；
  5. 修正 `UNIFIED-TASK-RUNTIME` 状态。
- 验收：文档与代码一致。
- 测试：文档评审。
- 回滚：无。
- 不做：发布。

**P6 出口**：真实长任务可运行、压缩、恢复、交付；状态板真实。

## 11. 测试矩阵

| 组 | 关键测试 | 阶段 |
| --- | --- | --- |
| Context Builder | 原话不变、顺序稳定、Memory/Evidence 分离 | P1 |
| Budget | 不同窗口、未知窗口、输出预留、阈值 | P1 |
| Estimator | 误差、null usage、校准 | P1/P4 |
| Pruner | 调用/结果配对、原始结果可查、重复去重 | P2 |
| Summary | Schema、证据引用、伪造完成拒绝 | P3 |
| Checkpoint | 原子提交、半提交恢复、stale、清理 | P3 |
| Pool | 开关关闭零变化、requestId/usage/trace | P4 |
| Entry Policy | Reviewer 隔离、Web/CLI 边界 | P4 |
| Status | paused/interrupted/blocked 转换 | P5 |
| Resume | 不重复写、未知步骤标记、并发恢复 | P5 |
| UI | 上下文卡、轨迹、统计、未知值 | P6 |
| E2E | 30 步、65/75/85%、摘要失败、崩溃 | P6 |

## 12. 里程碑与合并顺序

| 里程碑 | 内容 | 合并条件 |
| --- | --- | --- |
| M0 | P0 完成 | 契约/ADR/状态决策合并；typecheck |
| M1 | P1 完成 | Builder/Estimator/Budget/Provider 适配；测试 |
| M2 | P2 完成 | Pruner + 接线；原始结果可查 |
| M3 | P3 完成 | 摘要/检查点/恢复；崩溃测试 |
| M4 | P4 完成 | 各入口接线；边界回归 |
| M5 | P5 完成 | 暂停/恢复/中断；真机 |
| M6 | P6 完成 | UI + E2E + 验收报告 |

合并纪律：

1. 一任务一 PR；PR 标题带 `LT-Px-yy`。
2. 先合 P0，再合 P1；P2/P3 可在 P1 后并行，但 P4 必须等两者。
3. P5 必须等 P3/P4；P6 最后。
4. 每个 PR 必须更新任务书状态板。
5. 未验证不得标记完成。

## 13. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Journal 膨胀 | 启动/写入变慢 | P0-03 选择独立检查点文件；配额 |
| 摘要幻觉 | 错误事实进入上下文 | Schema/Validator/Evidence 引用 |
| Token 估算偏差 | 过早/过晚压缩 | 真实 usage 校准；保守阈值 |
| 窗口未知 | 预算错误 | confidence=unknown；保守值 |
| 恢复重复副作用 | 文件/命令重复执行 | P5-04 核对；默认不自动重跑 |
| 状态迁移 | UI/测试断裂 | P0-04 转换表；兼容旧值 |
| 压缩成本 | 费用增加 | 只在高阈值；费用单独统计 |
| 并发压缩 | 版本冲突 | contextId/checkpoint 版本隔离 |
| 摘要覆盖新事实 | 上下文错误 | stale 检测；只替换旧范围 |

回滚总原则：

- 所有能力带开关；关闭后行为回到当前实现。
- 检查点文件可删除，Journal 索引可忽略。
- 新状态可回退为旧状态，但不得丢失任务身份。
- 摘要失败不删除旧上下文。

## 14. 完成定义（Definition of Done）

每个任务必须同时满足：

1. 代码/文档实现；
2. 新增或更新测试；
3. `npm run typecheck` 通过；
4. 相关测试通过；
5. 开关关闭时无回归；
6. 回滚方式可执行；
7. 任务书状态板更新；
8. P5/P6 任务有真机证据。

## 15. 下一步

1. 先执行 `LT-P0-01`，核对远程 `main` 与本文引用是否仍一致。
2. 冻结 `LT-P0-02` 类型与 `LT-P0-03` 存储 ADR。
3. 在 P0 评审通过前，不开始 Context Manager 实现。
4. 不修改远程代码、不推送；用户明确授权后再进入实施。
