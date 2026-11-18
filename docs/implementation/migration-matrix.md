# P1-001 迁移审计矩阵

状态：**初稿（2026-11-18）**，待评审。
基线：`cd30be3`（main，含 product-v3 合并）；代码与 `ddf48c0` 相同。
用途：把现有模块的职责、调用、写盘与目标说清楚，避免 P1 实施时再造一套编排。

> 读法：`处置` 只回答「这个模块将来是保留、扩展、拆分、降级还是删除」；
> `删除条件` 没有填「已满足」之前，不允许删代码。

---

## 1. 入口与总流程

| 模块 | 当前职责 | 调用方 | 写盘/事件 | 目标职责 | 处置 | 删除条件 |
| --- | --- | --- | --- | --- | --- | --- |
| `conversation-runner.ts` | 对话入口、生命周期、意图路由、研究/工程分支、执行阶段、辩论触发 | `index.ts` IPC | `AgentStore` / `ConversationEvent` | 仍是入口；按 flag 路由到 engine，不自己实现调度 | **保留 + 增量** | engine 接管全部路径且 legacy 移除后 |
| `master-agent.ts` | 第一手并发提问 + 规则综合 | `ConversationRunner` | 通过 sink 发事件 | 拆成 ParticipantManager（提问/健康/失败）与 Deliver（综合） | **拆分** | Manager 与 Deliver 在 active 下跑通，legacy 删除后 |
| `index.ts` | 装配、IPC、窗口 | Electron | 配置 | 增加 mode 路由与 engine 装配 | **扩展** | 不删 |

**最小接线点**：`ConversationRunner.run()` 里按 `CollaborationMode` 分叉；`legacy` 保持现状，
`shadow` 只调 Planner，`active` 调 engine。**不改 `AgentOrchestrator`。**

---

## 2. 协作/调度

| 模块 | 当前职责 | 写盘/事件 | 目标职责 | 处置 | 删除条件 |
| --- | --- | --- | --- | --- | --- |
| `collaboration/strategy.ts` | 并行 / 递进 / smart，按 stage 生成任务 | 无 | Planner 的第一版输入：把 stage 换成 DAG | **改造** | DAG Planner 接管，且旧策略只留兼容 |
| `collaboration/runner.ts` | 按计划执行、记录每个子任务 | 无 | Runner/Observation 的雏形 | **扩展** | 新 Runner 接管任务状态后 |
| `debate/orchestrator.ts` | 辩论完整流程：分轮、主张、争议、修订、证据、裁判 | `DebateStore` | DebateBehavior：被 engine 按需调用 | **降级 + 拆职责** | 不删；内部实现稳定后再整理 |
| `debate/claims.ts` | 从 `DebateMessage` 切句、抽 Claim、检测争议 | 无 | 通用 Claim/Dispute 抽取 | **拆分** | 通用抽取器通过 P1 测试后 |
| `debate/evidence.ts` / `judges.ts` | 辩论证据与三维裁判 | 无 | 可选验证能力 | **保留** | 不删 |
| `debate/argument-graph.ts` | 论证关系图 | 无 | 可选论证结构 | **保留** | 不删 |
| `debate/prompts.ts` | 固定辩论提示词 | — | — | **已删除** | 已完成 |

---

## 3. 证据与状态

| 模块 | 当前职责 | 写盘 | 目标职责 | 处置 | 删除条件 |
| --- | --- | --- | --- | --- | --- |
| `evidence-pack/store.ts` | Pack 存储、哈希、快照 | `userData` | 统一证据层（保留） | **保留** | 不删 |
| `evidence-pack/repository-snapshot.ts` | 仓库快照 Pack | Pack | 工程任务状态（按需调用） | **保留** | 不删 |
| `evidence-pack/mapping.ts` | Pack → 辩论证据 | 无 | Pack → `EvidenceRef` 适配 | **扩展** | P4 映射完成后保留为兼容 |
| `evidence-pack/execution-producer.ts` | ExecutionReport → attestation | Pack | 执行证据生产者 | **保留** | 不删 |
| `evidence-pack/claim-verification*.ts` | Runtime Claim 验证计划与生产 | Pack | 工程/验证能力 | **保留** | 不删 |
| `evidence-pack/hash.ts` / `snapshot.ts` | 哈希与快照 | 无 | 统一哈希实现 | **保留** | 不删 |
| `store.ts`（AgentStore） | 原子 JSON journal：任务/对话/事件 | 全量 | `CollaborationState` 落盘复用 | **扩展** | 不删 |

**EvidenceRef 最小契约在 P0 冻结，P1 Observation 直接引用**，不另造临时证据格式。

---

## 4. 执行、工程与 CLI

| 模块 | 当前职责 | 目标职责 | 处置 | 删除条件 |
| --- | --- | --- | --- | --- |
| `orchestrator.ts`（AgentOrchestrator） | 计划审批、执行、TaskGrant、worktree 依赖 | 执行治理（不变） | **保留** | 不删 |
| `agent-manager.ts` | 任务/授权生命周期 | 执行治理（不变） | **保留** | 不删 |
| `agent/*` + `shared/protocol.ts` | Runtime、工具、协议 | 执行能力（不变） | **保留** | 不删 |
| `engineering/project.ts` / `analysis.ts` | 读盘、符号、调用、影响面 | 工程事实能力 | **保留 + 接入** | 不删 |
| `engineering/plan-review.ts` / `review.ts` | 计划评审、执行后评审 | 评审行为 | **保留** | 不删 |
| `code-index/*` | 索引、检索、影响面 | 事实提供者（按需） | **保留** | 不删 |
| `lsp/*` | 语言服务 | 事实提供者（可选） | **保留** | 不删 |
| `coding/team.ts` | 多 Agent 编码 | 工程协作能力 | **保留 + 接入** | 不删 |
| `cli-agents.ts` / `execution/cli-answer-agent.ts` | 只读回答源（临时目录、无 grant） | Participant（只读） | **保留** | 不删 |
| CLI 执行者（`agent.exec` 链） | 改代码（走 TaskGrant/worktree） | Executor | **保留** | 不删 |

**CLI 两种角色不能合并**：只读回答源与写执行者走不同链路。

---

## 5. 共享契约与 UI

| 模块 | 当前职责 | 目标职责 | 处置 |
| --- | --- | --- | --- |
| `shared/conversation.ts` | Conversation/事件契约 | 增加 collaboration 事件（不新建总线） | **扩展** |
| `shared/workspace.ts` | 知识/工程空间 | 与 Goal.workspace 对齐 | **保留** |
| `renderer/*` | 三栏 UI、辩论入口 | 后续 UI 计划 | **延后** |

---

## 6. 不许迁移的清单

以下能力**只复用，不重建**：

- Runtime 隔离（`UtilityProcess`）
- TaskGrant / 审批 / stepApproval
- AgentStore journal
- 网页 Adapter 与 WebContentsView
- 快照与哈希
- 工具白名单与权限模型

新引擎只能调用它们，不能复制。

---

## 7. 职责冲突（实施时必须拆开）

1. **`MasterAgent` 同时做参与者管理与综合** → Manager 与 Deliver 分开。
2. **`collaboration/strategy.ts` 用 stage 当任务模型** → 换 DAG，stage 只做执行批次。
3. **`debate/claims.ts` 的 Claim 依赖 `DebateMessage`** → 通用抽取器接受 `{text, agentId, messageId}`。
4. **`evidence-pack` 仍带 `baseline` 命名与上下文** → P4 映射为 `EvidenceRef`，旧 Pack 只读兼容。
5. **CLI 只读回答源 vs 写执行者** → 两条链路，不能共用 `SubAgent`。
6. **`ConversationRunner` 内仍有路由/决策逻辑** → 逐步移入 engine，runner 只做入口。

---

## 8. 建议的第一刀

不改 `ConversationRunner`、不改 `DebateOrchestrator`、不改 Runtime。只做：

1. `collaboration/domain/*`：Goal / TaskEnvelope / TaskSpec / Observation / EvidenceRef /
   Claim / Dispute / CollaborationState；
2. `collaboration/mode.ts`：legacy / shadow / active，默认 legacy；
3. `collaboration/planner/*`：规则版 DAG，先只支持「独立 / 并行 / 递进」；
4. `collaboration/scheduler/*`：按计划名单执行，不越界；
5. `collaboration/runner/*`：执行任务、写 Observation、落 `CollaborationState`；
6. `collaboration/deliver/*`：把 Observation 组装成交付物。

跑通后再接 `ConversationRunner` 的 shadow 分支；`active` 最后开。

---

## 9. 待确认

- **参与者规则**：当前 main 是「Planner 决定数量」（ADR 0008）；本次输入提到
  「第一手仍覆盖所有通道」。两条不一致，需要确认以哪条为准（见提交说明）。
- **P1-A…G 与现有 P1.0/P1.1 的映射**：审计建议保持 P1.0（不自动重规划）先跑通，
  再进 P1.1（Replan / Debate）。若坚持把 Replan 放进 P1 前半段，需要重排里程碑。
