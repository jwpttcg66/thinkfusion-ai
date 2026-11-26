# P0-B → P0-E 设计解决方案

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：**V3 方向已确认；P0 技术门禁未全部通过（P0-J）**。B.1/B.2/C 已完成；D 未单独评审。
设计分支：`product-v3`；上一设计快照：`7d27c6e`（P0-B）；本文提交后以新 HEAD 为准。
代码基线：`cd30be3`。`main` 只做集成。

---

## 0. 子任务状态

| 子任务 | 内容 | 状态 |
| --- | --- | --- |
| P0-B.1 | 领域类型：TaskSpec / TaskRuntimeState / Attempt / Plan / Assignment / Dispute | **完成** |
| P0-B.2 | 状态机：重试、取消、恢复、失败、阻塞、重规划 | **完成** |
| P0-C | 统一所有架构文档，P1-002 为唯一契约源 | **完成** |
| P0-D | P1-001 代码审计评审 | ✅ 已签收（2026-11-19） |
| P0-E | 完整设计 + Codex P1 任务书 | 🟡 方向确认；P0-J 门禁未过 |

---

## 1. P0-B.1 领域类型（已写入文档）

### 1.1 三层拆分

```ts
// 计划内定义：不可变
TaskSpec { taskId, goalId, kind, envelope, dependsOn, requiredCapabilities, ... }

// 运行状态：每个 task 一条
TaskRuntimeState { taskId, status, attempts: Attempt[], currentAttemptId?, reason? }

// 一次执行
Attempt { attemptId, taskId, participantId, number, status, startedAt, endedAt?, error? }
```

- `Plan.tasks: TaskSpec[]`，不再包含 status/attempts；
- `CollaborationState.taskStates: TaskRuntimeState[]`，不再保存任务定义副本；
- `TaskGraph` 只从 `Plan.tasks + dependsOn` 派生，不持久化。

### 1.2 Plan 与 Assignment

- `Plan` 不可变，含 `tasks`、`participants`、`skipped`、`stopWhen`、`policy`、`supersedes`；
- `Assignment` **不属于 Plan**，是 Scheduler 的派发结果，放在 `CollaborationState.assignments`；
- 解决「Plan 创建时 Assignment 还没有」的所有权矛盾。

### 1.3 Dispute 独立

```ts
Dispute { disputeId, conflictId, goalId, status, openedAt, resolvedAt?, resolution? }
```

- 不继承 `Conflict`（状态集合不兼容，TypeScript 也不允许）；
- 用 `conflictId` 关联，生命周期独立；
- Debate 只接受 `Dispute`。

### 1.4 唯一契约源

- **P1-002 是 TypeScript 契约的唯一权威**；
- `COLLABORATION_ARCHITECTURE.md`、`02-p1`、`01-p0` 只描述职责与流程，引用 P1-002，不重复接口；
- 本提交已删除 `COLLABORATION_ARCHITECTURE` 的 `CollaborationPlan` / `Observation` / `Verdict` 旧接口，
  以及 `02-p1` 的旧 `CollaborationState` 示例。

---

## 2. P0-B.2 状态机（已写入文档）

### 2.1 Task

```text
pending ──► assigned ──► running ──┬─► done
                                   ├─► retrying ──► running（只读重试，新 Attempt）
                                   ├─► failed（写失败 / 重试耗尽）
                                   ├─► blocked
                                   └─► skipped
任意非终态 ──► cancelled
```

- `failed` 是终态，**没有 failed → running**；
- 只读重试：最多 2 次 Attempt；第 1 次失败进 `retrying`，第 2 次失败进 `failed`；
- 写/执行：1 次 Attempt，失败直接 `failed`；重跑必须新 Plan + 审批；
- `skipped` / `blocked` 不产生 Observation，原因写 `TaskRuntimeState.reason`；
- `done` 必须满足 acceptance，且有 Observation。

### 2.2 Attempt

```text
running ──► done | failed | cancelled
```

- 每次尝试新建 Attempt；旧 Attempt / Observation 不修改；
- `Observation.attemptId` 必须指向已存在 Attempt；
- 取消已开始的 Attempt：Attempt=cancelled，并产生 `Observation(status='cancelled')`；
- 未开始的任务取消：只写状态原因。

### 2.3 恢复

- 重启后 `running` / `retrying` → `failed(interrupted)`；
- 不重放写操作；
- 只读任务可由 P1.1 Replanner 决定是否新 Plan。

### 2.4 重规划

- 新 Plan 版本；旧 Plan 进 `planHistory`；
- 旧 TaskSpec 不修改；新 Plan 可以复用相同 taskId（语义未变）或新建；
- 已 `done` 的任务不因新 Plan 重跑，除非新 Plan 明确新增验证任务。

---

## 3. P0-C 文档统一（已写入文档）

| 文档 | 修改 |
| --- | --- |
| `COLLABORATION_ARCHITECTURE.md` | 删除旧 TS 接口，改为「对象速查 + P1-002 链接」 |
| `02-p1-collaboration-engine.md` | 删除旧 `CollaborationState` 示例，引用 P1-002 |
| `01-p0-contracts.md` | 删除 `TaskGraphState`；`CollaborationState` 只留不变量 |
| `P0-A` | 基线改为 product-v3 + 设计快照；D1 与正文一致 |
| `P1-002` | 唯一权威；基线、类型、状态机更新 |

规则：以后新增字段只改 P1-002；其他文档出现 TS 接口视为重复，应在评审中删除。

---

## 4. P0-D P1-001 评审（待执行）

### 4.1 评审清单

- [ ] 18 节是否齐全，结论是否都有 `文件:行` 证据
- [ ] 「四条编排回路」是否逐条确认
- [ ] 「五个状态源」是否逐条确认
- [ ] 「无按能力选人的 Planner」是否确认
- [ ] 「Debate 仍从主流程进入」是否确认
- [ ] 「buildInitialPrompt 是最后一个提示词违规点」是否确认
- [ ] Java 现状（无 Java LSP/JDT）是否确认
- [ ] 删除/保留/改造/新增清单是否有遗漏
- [ ] P1 顺序与 P0-A 决策是否一致
- [ ] 风险与不可触碰边界是否可执行

### 4.2 评审记录

| 项 | 值 |
| --- | --- |
| 评审人 | 待填（不能由作者自评通过） |
| 评审日期 | 待填 |
| 结论 | 待填（通过 / 有条件通过 / 退回） |
| 条件 | 待填 |

> 当前状态：**未单独评审**。用户确认「全部设计完成」只表示方向接受，
> 不等于 P1-001 评审通过；P0-J 前必须补做。

---

## 5. P0-E 设计完成与任务书（P0-J 前）

### 5.1 冻结条件

- [ ] P0-A D1/D4/D5/D6 已采纳（已完成）
- [ ] P1-002 类型与状态机独立评审通过（未完成）
- [ ] 文档无重复 TS 契约（P0-C 完成）
- [ ] 基线口径一致：设计 product-v3、代码 cd30be3
- [ ] P1-001 独立审计评审通过（未完成）
- [ ] 无「全通道」规则残留
- [ ] 风险清单与不可触碰边界确认

### 5.2 Codex P1 任务书（唯一编号以 TASK-BOOK 为准）

任务书只包含可执行任务，不再讨论产品方向：

| 任务 | 内容 | 验收 |
| --- | --- | --- |
| P1-00A | 现有代码职责映射 | 逐文件迁移矩阵 |
| P1-00 | domain 类型 + CollaborationState + mode flag | typecheck + 序列化测试 |
| P1-02 | 规则版 Planner | 简单问题 1–2 任务；越界拒绝 |
| P1-03 | Scheduler | 调度测试 |
| P1-04 | Runner（Attempt/Observation/状态转移） | 状态机测试 |
| P1-05 | Deliver | 交付含 stopReason 与缺口 |
| P1-08 | shadow plan-only 接线 | 日志可读；legacy 不变 |
| P1-15 | 测试迁移与回归 | 现有测试全绿 |
| P1-14 | 评审与切 active 门禁 | 回滚演练 |

### 5.3 冻结后仍不做

- Memory（P2）、JDT、UI 改版、`buildInitialPrompt` 删除（P3）、shadow 双跑。

---

## 6. 剩余风险

| 风险 | 对策 |
| --- | --- |
| 新字段又写回旧文档 | P0-C 规则 + 评审检查重复 TS |
| 状态机实现时走样 | P1-04 用状态机测试逐条覆盖 |
| Planner 越权控制 Runtime | P1-002 §10.1 + 代码评审 |
| P1-001 未评审就开工 | P0-E 门禁 |
| 设计快照过期 | 每次评审更新快照 SHA，不自动继承 |
