# P0-A V3 全量设计一致性审查

状态：**方向确认；P0 技术门禁未全部通过（P0-J）**。D1/D4/D5/D6/D8 已采纳。
设计分支：`product-v3`；设计快照：`7d27c6e`（P0-B）。
代码基线：`cd30be3`（P1-001 审计时；此后仅文档变化）。`main` 只做集成。
范围：AGENTS、PRODUCT、ROADMAP、协作架构、工程空间、迁移计划、ADR-0008、
P1-001、P0 契约、P1 计划、P1-002 契约。

---

## 1. 结论摘要

方向一致，但设计包还不能称为「完整冻结」。本次确认 **11 处不一致或未决项**，
其中 4 处会直接影响实施：

1. **分支分叉**：P1-002 只在 `main`，不在 `product-v3`；设计包没有单一基线。
2. **参与者规则残留**：三处文档仍写「所有通道」，与 ADR-0008 冲突。
3. **状态对象重叠**：`TaskGraphState` / `CollaborationState` / `Plan` 职责未定。
4. **Planner 责任边界未定**：规则与模型各做什么，没有成文。

建议：先按本文 D1–D8 确认决策，再进入 P1-003 / P1-004；**P1-001 评审通过前不开工实现**。

---

## 2. 基线与会话事实

| ref | 提交 | 说明 |
| --- | --- | --- |
| `product-v3` / `origin/product-v3` | `7d27c6e` | 设计分支；含 P1-001、P1-002、P0-A、P0-B |
| `main` / `origin/main` | `d7cd030` | 只做集成；不含 P0-A/P0-B |
| `cd30be3` | 代码基线 | P1-001 审计时的代码；之后只有文档变化 |

含义：

- 设计以 `product-v3` 为准；`main` 不承载进行中的设计；
- P1-002 已并入 product-v3，不再是「只在 main」；
- 设计快照 `7d27c6e` 是 P0-B 时点；后续提交不自动改变本审计快照，重新审计时更新。

## 3. 不一致清单

| ID | 位置 | 现状 | 冲突 | 级别 | 处置 |
| --- | --- | --- | --- | --- | --- |
| C1 | `MIGRATION_PLAN.md:143` | 「第一手仍覆盖所有已启用通道」 | ADR-0008 / AGENTS 第 2 条 | 高 | 已修正 |
| C2 | `02-p1-collaboration-engine.md:94` | 「所有通道独立作答 + 综合」 | 同上 | 高 | 已修正 |
| C3 | `COLLABORATION_ARCHITECTURE.md:91` | Independent 停止条件「所有可用通道返回或超时」 | 把「行为」与「选人」混为一谈 | 高 | 已修正 |
| C4 | 00/01/README | 代码基线写 `45ccb11` | 审计写 `cd30be3`；设计在 `d7cd030` | 中 | 已统一口径 |
| C5 | 01 / README | P1-001 标「初稿完成」 | 审计写「待评审」 | 中 | 已统一为「已提交，待评审」 |
| C6 | 01 §2.5/2.6 | `TaskGraphState` 与 `CollaborationState` 字段重叠 | P1-002 又定义了 `Plan` + `State` | 高 | 已采纳 D4：删除 TaskGraphState |
| C7 | 02 / P1-002 | 规则 Planner 与模型职责未成文 | 实施时容易让模型控制 Runtime | 高 | 已采纳 D5：P1-002 §10.1 |
| C8 | 产品/架构 | 三空间共享引擎只有原则，没有契约 | 可能又造 Knowledge/Engineering Engine | 中 | 已采纳 D6：P1-002 §12.1 |
| C9 | COLLAB §4 / P1-002 §11 | Debate 门槛两处措辞不同 | 实现时可能出现两套判定 | 中 | 统一为 Conflict→Dispute |
| C10 | 01 / P1-002 | `Plan` 是否不可变、历史如何保留未定 | 重规划会覆盖还是追加 | 高 | 已采纳 D4：不可变 + planHistory |
| C11 | 分支治理 | `product-v3` 与 `main` 分叉 | 读者会漏掉 P1-002 | 高 | 已采纳 D1：设计只在 product-v3 |

---

## 4. 决策清单

### D1 设计只留在 product-v3（已采纳）

- 决定：`product-v3` 是唯一设计分支；`main` 只做集成，不承载进行中的设计。
- 理由：用户 2026-11-18 裁决；P1-002 与 P0-A 已并入 product-v3。
- 动作：设计文档与后续 P0-B 只在 product-v3 提交；main 等 P0-J 后再合并。
- 状态：**已采纳**。

### D2 参与者规则统一（已决，已修正）

- 决定：Planner 决定数量；ADR-0008 为准；删除所有「全通道」残留。
- 动作：C1/C2/C3 已改。
- 状态：**已执行**。

### D3 Independent ≠ 全通道（已决，已修正）

- 决定：Independent 只表示「参与者之间不共享观点」；选人是 Planner 的职责。
- 动作：协作行为表的停止条件改为「本行为的参与者返回或超时」。
- 状态：**已执行**。

### D4 状态所有权（建议）

- 决定：
  - `Plan` **不可变**；重规划产生新 `version`，旧版本进 `planHistory`；
  - `TaskSpec` 的定义（envelope/依赖/能力）不可变，运行状态在 `CollaborationState.taskStates[]`；
  - **删除 `TaskGraphState`**：DAG 由 `Plan.tasks` + `dependsOn` 派生，不单独存；
  - 只有 Runner 写状态；Planner/Scheduler 返回新对象；
  - 取消、失败、重试的转换只由 Runner 执行（重试策略见契约）。
- 理由：现在三个对象都在描述「任务 + 状态」，必然出现两份事实。
- 影响：01 删除 2.5；P1-002 增加 `planHistory`；P1 计划的 state 章节同步。
- 状态：**已采纳**（P0-B 已落地）。

### D5 Planner 的模型/规则/系统边界（建议）

| 责任 | 承担者 |
| --- | --- |
| 理解目标、判断复杂度、产生候选任务 | 模型（P1.1 起；P1.0 用规则） |
| 校验 DAG、依赖、预算、范围、能力 | 系统（规则） |
| 选择参与者与理由 | Planner，在系统约束内 |
| 执行、权限、审批 | 现有 `AgentOrchestrator` |
| 记录 Observation/状态 | Runner |
| 是否继续 / 是否 Debate | Replanner / Conflict 状态 |

护栏：

- 模型只能产出 `Plan` 候选，必须通过 schema 与规则校验；
- 模型不能直接调用 Runtime、不能改权限、不能决定停止；
- 规则可以否决模型计划；否决理由要可见；
- P1.0 先纯规则，P1.1 再引入模型审核（数据 + schema）。
- 状态：**已采纳**（P1-002 §10.1）。

### D6 三空间共享引擎（建议）

- 决定：Knowledge / Engineering / General 只是 `Task.context` + 能力 + 交付协议；
  禁止 `KnowledgeEngine` / `EngineeringEngine` / `ResearchEngine`。
- 边界：Memory 归 P2；EngineeringContext 归 P3；P1 不实现空间专属引擎。
- 状态：**已采纳**（P1-002 §12.1）。

### D7 基线与状态口径（已决，已修正）

- 口径：设计分支 `product-v3`；设计快照 `2d05b12`；代码基线 `cd30be3`。
- P1-001 状态统一为「已提交，待评审」。
- 状态：**已执行**。

### D8 P1-001 评审门禁（建议）

- 决定：P1-001 评审通过前，不开工 P1-004（引擎 MVP）。
- 评审内容：18 项审计 + 本文 D1–D6 决策。
- 状态：**已采纳**。

---

## 5. 状态对象建议（D4 细节）

```text
Plan（不可变，版本化）
  ├── version
  ├── policy
  ├── tasks（定义）
  ├── participants / skipped
  └── assignments

CollaborationState（唯一运行时事实）
  ├── goal
  ├── activePlan
  ├── planHistory[]
  ├── taskStates[]（status + attempts）
  ├── observations[]
  ├── evidence[]
  ├── claims / conflicts / disputes
  ├── budget
  ├── stop
  └── deliverable

TaskGraph = 从 activePlan.tasks + dependsOn 派生（不单独持久化）
```

删除 `TaskGraphState`，避免与 `CollaborationState` 重叠。

---

## 6. 三空间契约（D6 细节）

| 空间 | Task.context | 能力 | 交付 | 专属存储 |
| --- | --- | --- | --- | --- |
| General | `GeneralContext` | reasoning / web-research | answer | 无 |
| Knowledge | `KnowledgeContext` | knowledge / web-research | research / knowledge_map | MemoryStore（P2） |
| Engineering | `EngineeringContext` | code-search / read / java / test / review | engineering_change / test_report | 证据 + 工程状态（P3） |

规则：空间不增加 Engine；只增加上下文、能力与交付模板。

---

## 7. 本次已修改的文档

| 文档 | 修改 |
| --- | --- |
| `MIGRATION_PLAN.md` | 删除「第一手仍覆盖所有通道」 |
| `02-p1-collaboration-engine.md` | 简单问题改为「参与者由 Planner 选定」 |
| `COLLABORATION_ARCHITECTURE.md` | Independent 停止条件改为「本行为参与者」 |
| `00` / `01` / `README` | 统一设计基线/代码基线口径 |
| `P1-001` | 状态与基线提示更新 |
| `01` | `TaskGraphState` 标注「待 D4 决策」 |

---

## 8. 设计收敛出口（P0-J）

- [x] D1 设计只在 product-v3（已采纳）
- [x] D4 状态所有权确认，删除 `TaskGraphState`
- [x] D5 Planner 边界确认
- [x] D6 三空间契约确认
- [ ] D8 P1-001 评审通过（未完成）
- [ ] 全部文档无「全通道」残留
- [ ] 文档基线/代码基线口径一致
- [ ] 评审记录进 ADR 或本文附录

---

## 9. 建议顺序

```text
P0-A（已完成） → P0-B 契约收敛（已完成）
              → P1-003 代码映射
              → P1-001 评审
              → P1-004 引擎 MVP
```

不要跳过 P0-B 直接写代码；也不要让 P1-001 的「已提交」被当成「已评审」。
