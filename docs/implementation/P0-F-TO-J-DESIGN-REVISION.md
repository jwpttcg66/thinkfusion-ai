# P0-F → P0-J 设计修订

状态：**设计修订完成；P0-J 评审未完成**（2026-11-18）。
设计分支：`product-v3`；评审快照：`2d05b12`（当前 HEAD 见 git log）。
代码基线：`cd30be3`（此后无源代码变更）。

依据：2026-11-18 复审意见。本文只做设计修订，不改生产代码。

---

## 0. 结论

- V3 产品方向与核心决策：**保留**。
- 设计文档中的契约矛盾：**本次修订解决**。
- 实际代码：**仍是旧架构**；未实现统一协作引擎。
- P0 技术门禁：**未全部通过**；P0-J 评审前不开工 P1。

---

## 1. P0-F：Runtime 与领域数据模型

### 1.1 决策：CollaborationState 是聚合根

采用**聚合状态模型**，不再写「只存引用 id」：

```text
CollaborationState（运行时聚合根，落 AgentStore）
├── goal
├── activePlan / planHistory
├── taskStates（TaskRuntimeState）
├── assignments
├── observations
├── evidence（EvidenceRef，引用 Pack 内容，不复制正文）
├── claims / conflicts / disputes
├── budget / stop / deliverable
└── engineering?（EngineeringTaskState，仅工程任务）
```

领域存储仍并列存在，但只是数据仓库：

| 存储 | 角色 | 与 State 的关系 |
| --- | --- | --- |
| `AgentStore` | 会话/任务/轮次/事件 journal | 持久化 State |
| `DebateStore` | 辩论记录 | 引用 debateId |
| `EvidencePackStore` | 冻结证据内容 | State 只存 `EvidenceRef`，不复制正文 |
| `CodeIndex` | 代码事实 | 工具查询，不进 State |
| `Trace` | 观测 | 不是运行时事实来源 |
| `KnowledgeStore`（P2） | 知识卡 | 引用 cardId |

「不复制领域内容」只针对**大块正文**（证据正文、代码、辩论发言）：
State 存对象与引用，不存这些正文。

### 1.2 TaskGraph 不持久化

- `TaskGraph` 是 `Plan.tasks + dependsOn` 的派生视图；
- 唯一持久化：`Plan.tasks`（定义）+ `CollaborationState.taskStates`（状态）；
- 对象目录删除 `TaskGraph` 的「持久化 State」行；
- 对象目录的 `Task` 行删除，改为 `TaskSpec` / `TaskRuntimeState`。

### 1.3 生命周期与所有权

| 对象 | 创建 | 修改 | 持久化 |
| --- | --- | --- | --- |
| Goal | 入口 | 不可变 | State |
| TaskSpec | Planner | 不可变 | Plan |
| TaskRuntimeState | Runner | Runner（纯转移） | State |
| Attempt | Runner | 只追加 | State |
| Plan | Planner | 新版本（Replanner） | State |
| Assignment | Scheduler | 不可变 | State |
| Observation | Runner | 不可变 | State |
| EvidenceRef | Runner/Tool | 不可变 | State + Pack |
| Claim/Conflict/Dispute | 抽取/检测 | 状态字段 | State |
| EngineeringTaskState | 工程任务 | 任务自身 | State（可选） |
| Deliverable | Deliver | 不可变 | State + 会话 |

---

## 2. P0-G：输入契约与通道边界

### 2.1 决策：两层输入

`QuestionInput` / `ContractInput` 的权威定义见 [P1-002 §3.10](P1-002-DOMAIN-RUNTIME-CONTRACT.md)；
本节只列规则，不重复接口。

规则：

1. 网页通道只接受 `QuestionInput`；知识/通用可额外接受 `QuestionerInput`（单条追问 + 数据）。
   不得附加「请指出」「你的职责是」「第一步…」等指令。工程模式网页只能是回答者。
2. 本地/云端可接受 `ContractInput`；schema 是契约，不是话术。
3. **执行计划必须由 `ContractInput` 产生**；网页通道不能承担规划角色。
   若没有可用的本地/云端规划者，执行任务 `blocked`，不得把计划提示词塞进网页。
4. 跨通道材料只作为 `transcript` 数据；不允许把「质疑/修订/汇总」话术塞进 `question`。
5. 不在代码里维护「任务提示词」；所有输入由 Adapter 组装，并受 `check-prompt-policy` 扫描。

### 2.2 现存构造器清单与处置

代码中与模型输入相关的构造点共 **27 个**：21 个函数 + 6 个 `SYSTEM` 常量。
附件拼接（`composeQuestionWithAttachments`）只拼数据，不产生指令，单列在末尾。

| # | 文件 | 构造器 | 现状 | 处置 | 阶段 |
| --- | --- | --- | --- | --- | --- |
| 1 | `shared/protocol.ts` | `buildInitialPrompt` | 规划角色 + 12 条规则 | 替换为 `ContractInput`；网页不能规划 | P1 |
| 2 | `shared/protocol.ts` | `buildReportPrompt` | 执行报告 + 指令 | `ContractInput` | P1 |
| 3 | `shared/protocol.ts` | `buildPlanRepairPrompt` | 修复指令 | `ContractInput` | P1 |
| 4 | `shared/protocol.ts` | `buildClarificationAnswerPrompt` | 澄清指令 | `ContractInput` | P1 |
| 5 | `synthesis/lead-prompt.ts` | `buildLeadPrompt` | 网页消息含四步指令 | 改为数据块（问题+回答） | P1 |
| 6 | `synthesis/lead-prompt.ts` | `LEAD_SYSTEM` | system 角色/流程 | 仅 local/cloud；改 schema | P1 |
| 7 | `synthesis/lead-stage.ts` | `LEAD_SUMMARY_SYSTEM` | system 汇总要求 | 仅 local/cloud；改 schema | P1 |
| 8 | `synthesis/lead-stage.ts` | `buildLeadSummaryQuestion` | 网页消息含汇总要求 | 改为数据块 | P1 |
| 9 | `synthesis/lead-stage.ts` | `inlineLeadInstructions` | 把要求拼进问题 | 删除；需要契约走 `ContractInput` | P1 |
| 10 | `synthesis/lead-stage.ts` | `LEAD_VERDICT_SYSTEM` | system 结论要求 | 仅 local/cloud；改 schema | P1 |
| 11 | `synthesis/lead-stage.ts` | `buildVerdictQuestion` | 网页消息含结论指令 | 改为数据块 | P1 |
| 12 | `synthesis/lead-selector.ts` | `PICK_SYSTEM` | system 选择主导 | 仅 local/cloud；改 schema | P1 |
| 13 | `synthesis/lead-selector.ts` | `buildPickPrompt` | 网页消息「请选择、指出错误」 | 改为数据块 | P1 |
| 14 | `synthesis/local-summary.ts` | `SUMMARY_SYSTEM` | system 汇总 | 仅 local/cloud；改 schema | P1 |
| 15 | `synthesis/local-summary.ts` | `buildSummaryQuestion` | 汇总问题 | 数据块 / schema | P1 |
| 16 | `research/routing-classifier.ts` | `ROUTING_SYSTEM` | system 路由 | 仅 local/cloud；规则优先 | P1 |
| 17 | `research/routing-classifier.ts` | `buildRoutingQuestion` | 路由问题 | 数据 / schema | P1 |
| 18 | `research/engineering-round.ts` | `buildEngineeringAnswerQuestion` | **数据块**（问题+材料，无指令） | 保留 | P1 |
| 19 | `research/engineering-round.ts` | `engineeringAnswerSystem` | system 工程角色 | 仅 local/cloud；改 schema | P1 |
| 20 | `research/engineering-round.ts` | `engineeringToolSystem` | 工具契约 | 仅 local/cloud；保留为契约 | P1 |
| 21 | `research/engineering-round.ts` | `buildToolFollowupQuestion` | 仅 local/cloud 的工具追问 | `ContractInput`；不是网页 | P1 |
| 22 | `research/engineering-orchestration.ts` | `buildWebOrchestrationQuestion` | **数据块**（委托第 18 项） | 保留 | P1 |
| 23 | `research/follow-up.ts` | `buildFollowUpQuestion` | 网页「请直接回答这几点」 | 改为数据块（问题+缺口） | P1 |
| 24 | `research/follow-up.ts` | `buildFollowUpSummaryQuestion` | 汇总指令 | 数据块 / schema | P1 |
| 25 | `research/follow-up.ts` | `followUpNote` | 备注文本 | 数据 | P1 |
| 26 | `engineering/plan-review.ts` | `planReviewQuestion` | 计划评审指令 | 仅 local/cloud；`ContractInput` | P1 |
| 27 | `shared/attachments.ts` | `composeQuestionWithAttachments` | 只拼数据（原话+附件） | 保留 | P1 |

**结论：`buildInitialPrompt` 不再推迟到 P3**结论：`buildInitialPrompt` 不再推迟到 P3，必须在 P1 与规划链一起替换。**
否则 P1 一边禁用提示词，一边继续用旧执行链，规则无法自洽。

### 2.3 后果（必须明说）

- 网页通道在**知识/通用**可担任提问者（只生成追问），但仍是回答者为主；
- 工程模式下网页只能是回答者，不得提问/规划；
- 结构化执行计划、修复、澄清只在 local/cloud 上执行；
- 没有 local/cloud 时，执行类任务 `blocked`，而不是退回网页提示词；
- 纯网页问答仍可用：问题 + 数据，无指令。

### 2.4 测试

- `check-prompt-policy` 扩展：扫描全部 27 个构造点与网页消息，禁止角色/阶段/挑战/汇总指令；
- 新增 `check-web-input`：网页输入只含 `QuestionInput` 字段；
- 新增 `check-contract-input`：schema 合法、无话术；
- 回归：网页问答、追问、纯网页总结仍可运行（允许无结构）。

---

## 3. P0-H：证据与工程上下文

### 3.1 EvidencePackContext 归属

`EvidencePackContext` 的权威定义见 [EVIDENCE_QUALITY §1.1](../architecture/EVIDENCE_QUALITY.md)；
本节只列归属规则。

- 新数据必须写 `ownerType/ownerId`；
- `repository-snapshot.ts` 写 `{ kind:'snapshot', ownerType:'task', ownerId }`；
- 旧数据没有 `ownerType` 时，按 `ownerType='debate'`、`ownerId=debateId` 读取；
- 不再把工程任务 id 填进 `debateId`。

### 3.2 EvidenceRef 单一定义

- 权威仍是 P1-002 §3.6；`COLLABORATION_ARCHITECTURE` 删除重复的 `EvidenceRef` 定义；
- P2–P5 只允许定义**扩展类型**（如 KnowledgeCard、EngineeringTaskState），通用对象必须引用 P1-002；
- 扩展类型必须注明「引用 P1-002 的 X」，不得改字段名。

### 3.3 EngineeringTaskState 与 State 的关系

- `CollaborationState.engineering?: EngineeringTaskState`（仅工程任务）；
- 快照、测试、diff、review 存在这里；
- 不新建 EngineeringStore；证据仍走 `EvidenceRef`；
- P3 文档补这一条，避免「State 还是领域存储」的二次歧义。

---

## 4. P0-I：文档与任务书一致性

### 4.1 状态口径

| 概念 | 状态 |
| --- | --- |
| V3 产品方向与核心决策 | 已由用户确认 |
| P0 技术审查门禁 | **未全部通过**（P0-J） |
| 评审快照 | `2d05b12`（product-v3；当前 HEAD 见 git log） |
| 历史快照 | `7d27c6e`（P0-B）、`8489df5`（B.1/B.2） |
| 代码基线 | `cd30be3` |
| `main` | 仅集成 |

统一表述：**「V3 产品与核心架构方向已确认；P0 技术审查与实施门禁仍有未完成项。」**
不再笼统写「设计冻结」。

### 4.2 分支/快照修正

- P1-001：删除「后续设计基线 main@d7cd030」「product-v3 只到 P1-001」；
- P0-A：D7 统一为 product-v3；旧 `tasks[]` 描述改为 `taskStates[]`；
- P0-B-TO-E：状态改为「方向确认，P0 门禁未过」；旧 P1-T 编号已删除，统一 TASK-BOOK；
- TASK-BOOK：快照写 `2d05b12`；新增 P1-00A。

### 4.3 新增 P1-00A：代码职责映射

在 P1-00 之前增加：

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P1-00A | 现有代码职责映射与迁移矩阵 | P0-01 | 逐文件矩阵；禁止新建重复模块 |

矩阵列：文件、导出、调用方、写盘、事件、测试、新归属、删除条件。

### 4.4 P1 编号

- 只保留 TASK-BOOK 的 `P1-xx` 编号；
- P0-B-TO-E 的旧 `P1-T0..T7` 已删除，统一为 TASK-BOOK 的 `P1-xx` 编号。

---

## 5. P0-J：正式评审门禁

P0-J 通过前不开工 P1-004。评审内容：

- [ ] 本修订 F/G/H/I 的决策逐条确认
- [ ] P1-001 审计逐项核对（18 节）
- [ ] 无重复 TS 契约（通用对象只在 P1-002）
- [ ] 27 个输入构造点全部有处置，网页无指令
- [ ] EvidencePackContext 新归属设计确认
- [ ] 任务书无两套编号
- [ ] 基线/快照/状态一致
- [ ] 风险与边界确认

评审记录：

| 项 | 值 |
| --- | --- |
| 评审人 | 待填（不能作者自评） |
| 日期 | 待填 |
| 结论 | 待填 |

---

## 6. 修订后仍不做

- 不改生产代码；
- 不实现 Planner/Scheduler；
- 不删旧模块；
- 不合并 main；
- 不把 P0-J 标为已通过。
