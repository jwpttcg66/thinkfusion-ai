# P0 契约与开关

目标：**冻结接口、给出迁移矩阵、装好开关**，不改变任何用户可见行为。

前置：设计基线 `product-v3`；代码基线 `cd30be3`（先更新 00 文档的基线）。
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

**唯一权威：[P1-002 领域与运行时契约](P1-002-DOMAIN-RUNTIME-CONTRACT.md)。**
本节只列冻结对象与不变量，**不重复 TypeScript 接口**。

| 对象 | 冻结要点 |
| --- | --- |
| `Goal` / `Policy` | 用户原话；modelScope + includeWeb；预算 |
| `TaskEnvelope` / `TaskSpec` | 任务定义不可变；问题 + 验收 + schema |
| `TaskRuntimeState` / `Attempt` | 运行状态与尝试分离；Attempt 只追加 |
| `Plan` | 不可变、版本化、`supersedes`；`planHistory` |
| `Assignment` | Scheduler 派发结果，属于运行时 |
| `Observation` | 只对应一次 Attempt |
| `EvidenceRef` | 引用 Pack，不复制正文 |
| `Claim` / `Conflict` / `Dispute` | 主张 / 矛盾 / 未决争议分离 |
| `CollaborationState` | 唯一运行时聚合根 |
| `Verdict`（别名 `Verification`）/ `Deliverable` | 验证四态；交付必须带 stopReason |

不变量：

- 只有 Runner 写 `CollaborationState`；Planner/Scheduler 返回新对象；
- 任务参与者必须在 `Policy` 范围内；越界拒绝；
- 高风险任务至少 2 个参与者；
- 任务定义不可变；重规划产生新 Plan；
- 交付必须有 `stopReason`；未核验项必须显式标记。

> P0-02 的验收不是「01 里有接口」，而是「P1-002 通过评审，且 P1 实现只引用 P1-002」。

### 2.1 P0 任务与契约对照

| P0 任务 | 权威章节 | 说明 |
| --- | --- | --- |
| P0-02 Domain | P1-002 §3.1–3.10 | 类型 + ModelInput |
| P0-03 事件 | P1-002 §9 | 事件名与载荷 |
| P0-04 Flag | 本文 §3 | `legacy/shadow/active` |
| P0-05 持久化 | P1-002 §7 | AgentStore / 恢复语义 |
| P0-06 回滚 | 本文 §5 | 演练设计，不是代码 |

> 01 不再定义接口；出现重复 TS 接口时，以 P1-002 为准并删除 01 中的副本。


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
- `CollaborationState` 作为对话/任务记录的可选字段落盘；旧记录没有该字段时按无协作状态读取。
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

- [ ] 基线口径一致：设计 `product-v3`、代码 `cd30be3`
- [ ] 迁移矩阵覆盖 §1 列出的全部文件，含「不许迁移」与「职责冲突」
- [ ] `Goal / Policy / TaskEnvelope / TaskSpec / TaskRuntimeState / Attempt / Plan / Assignment / Observation / EvidenceRef / Claim / Conflict / Dispute / CollaborationState / Verdict / StopReason / Deliverable` 类型冻结
- [ ] 事件枚举与载荷冻结，且不新增事件总线
- [ ] flag 默认 legacy、可持久化、可回滚
- [ ] 状态契约（CollaborationState）冻结，落盘位置与恢复语义写明（实现放 P1.0）
- [ ] `npm run typecheck` 通过
- [ ] 新增测试通过；现有测试无回归
- [ ] diff 只含类型、文档、开关、无行为变化
- [ ] 回滚演练记录在 PR 描述里
