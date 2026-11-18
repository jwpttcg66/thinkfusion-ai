# P0-F → P0-J 设计修订

状态：**设计修订完成；P0-J 评审未完成**（2026-11-18）。
设计分支：`product-v3`；设计快照：`89b447c`。
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

```ts
/** 网页通道唯一允许的输入：问题 + 数据，不含任何指令。 */
export interface QuestionInput {
  kind: 'question';
  question: string;
  /** 跨通道材料，作为数据附带；必须标注来源。 */
  transcript?: Array<{ source: string; text: string }>;
}

/** 本地/云端可接收的契约输入：数据 + 输出 schema，不含角色/阶段话术。 */
export interface ContractInput {
  kind: 'contract';
  question: string;
  /** 机器可读输出契约。 */
  schema: Record<string, unknown>;
  /** 结构化数据（计划、报告、观察），不是自然语言要求。 */
  data?: Record<string, unknown>;
  /** 仅限系统级约束：权限、工具、超时；不得写人设/阶段。 */
  constraints?: { tools?: string[]; permission?: string; timeoutMs?: number };
}
```

规则：

1. 网页通道只接受 `QuestionInput`；不得附加「请指出」「你的职责是」「第一步…」等指令。
2. 本地/云端可接受 `ContractInput`；schema 是契约，不是话术。
3. **执行计划必须由 `ContractInput` 产生**；网页通道不能承担规划角色。
   若没有可用的本地/云端规划者，执行任务 `blocked`，不得把计划提示词塞进网页。
4. 跨通道材料只作为 `transcript` 数据；不允许把「质疑/修订/汇总」话术塞进 `question`。
5. 不在代码里维护「任务提示词」；所有输入由 Adapter 组装，并受 `check-prompt-policy` 扫描。

### 2.2 现存构造器清单与处置

| 文件 | 构造器 | 现状 | 处置 | 阶段 |
| --- | --- | --- | --- | --- |
| `shared/protocol.ts` | `buildInitialPrompt` | 规划角色 + 12 条规则 | 替换为 `ContractInput`；网页不能规划 | P1 |
| `shared/protocol.ts` | `buildReportPrompt` | 执行报告 + 指令 | 替换为 `ContractInput` | P1 |
| `shared/protocol.ts` | `buildPlanRepairPrompt` | 修复指令 | 替换为 `ContractInput` | P1 |
| `shared/protocol.ts` | `buildClarificationAnswerPrompt` | 澄清指令 | 替换为 `ContractInput` | P1 |
| `synthesis/lead-prompt.ts` | `buildLeadPrompt` | 网页消息含四步指令 | 改为数据块（问题+回答），去掉指令 | P1 |
| `synthesis/lead-stage.ts` | `leadSummarySystem` | system 角色/阶段 | 仅 local/cloud；改为 schema | P1 |
| `synthesis/lead-stage.ts` | `buildLeadSummaryQuestion` | 网页消息含汇总要求 | 改为数据块 | P1 |
| `synthesis/lead-stage.ts` | `inlineLeadInstructions` | 把要求拼进问题 | 删除；需要契约时走 ContractInput | P1 |
| `synthesis/lead-stage.ts` | `buildVerdictQuestion` | 结论指令 | 改为数据块或 ContractInput | P1 |
| `research/engineering-round.ts` | `buildEngineeringAnswerQuestion` | 工程回答指令 | 改为数据块 | P1 |
| `research/engineering-round.ts` | `engineeringAnswerSystem` | 工程角色指令 | 仅 local/cloud；改 schema | P1 |
| `research/engineering-round.ts` | `engineeringToolSystem` | 工具指令 | 仅 local/cloud；工具契约 | P1 |
| `research/engineering-round.ts` | `buildToolFollowupQuestion` | 工具追问指令 | 数据块 | P1 |
| `research/follow-up.ts` | `buildFollowUpQuestion` | 「请直接回答这几点」 | 数据块（问题+缺口） | P1 |
| `research/follow-up.ts` | `buildFollowUpSummaryQuestion` | 汇总指令 | 数据块/ContractInput | P1 |
| `research/follow-up.ts` | `followUpNote` | 备注文本 | 数据 | P1 |

**结论：`buildInitialPrompt` 不再推迟到 P3，必须在 P1 与规划链一起替换。**
否则 P1 一边禁用提示词，一边继续用旧执行链，规则无法自洽。

### 2.3 后果（必须明说）

- 网页通道从「可规划/可主导汇总」降为「回答者」；
- 结构化计划、汇总、修复、澄清只在 local/cloud 上执行；
- 没有 local/cloud 时，执行类任务 `blocked`，而不是退回网页提示词；
- 纯网页问答仍可用：问题 + 数据，无指令。

### 2.4 测试

- `check-prompt-policy` 扩展：扫描全部 16 个构造器与网页消息，禁止角色/阶段/挑战/汇总指令；
- 新增 `check-web-input`：网页输入只含 `QuestionInput` 字段；
- 新增 `check-contract-input`：schema 合法、无话术；
- 回归：网页问答、追问、纯网页总结仍可运行（允许无结构）。

---

## 3. P0-H：证据与工程上下文

### 3.1 EvidencePackContext 归属

```ts
export interface EvidencePackContext {
  kind: 'snapshot' | 'baseline' | 'round';
  /** 归属类型：目标 / 任务 / 辩论。 */
  ownerType: 'goal' | 'task' | 'debate';
  ownerId: string;
  roundIndex?: number;
  baselinePackId?: string;
}
```

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
| 设计快照 | `89b447c`（product-v3） |
| 历史快照 | `7d27c6e`（P0-B）、`8489df5`（B.1/B.2） |
| 代码基线 | `cd30be3` |
| `main` | 仅集成 |

统一表述：**「V3 产品与核心架构方向已确认；P0 技术审查与实施门禁仍有未完成项。」**
不再笼统写「设计冻结」。

### 4.2 分支/快照修正

- P1-001：删除「后续设计基线 main@d7cd030」「product-v3 只到 P1-001」；
- P0-A：D7 统一为 product-v3；旧 `tasks[]` 描述改为 `taskStates[]`；
- P0-B-TO-E：状态改为「方向确认，P0 门禁未过」；P1-T 编号映射 TASK-BOOK；
- TASK-BOOK：快照写 `89b447c`；新增 P1-00A。

### 4.3 新增 P1-00A：代码职责映射

在 P1-00 之前增加：

| ID | 任务 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P1-00A | 现有代码职责映射与迁移矩阵 | P0-01 | 逐文件矩阵；禁止新建重复模块 |

矩阵列：文件、导出、调用方、写盘、事件、测试、新归属、删除条件。

### 4.4 P1 编号

- 只保留 TASK-BOOK 的 `P1-xx` 编号；
- P0-B-TO-E 的 `P1-T0..T7` 改为映射表（T0→P1-00，T1→P1-02，…），不再作为第二套任务书。

---

## 5. P0-J：正式评审门禁

P0-J 通过前不开工 P1-004。评审内容：

- [ ] 本修订 F/G/H/I 的决策逐条确认
- [ ] P1-001 审计逐项核对（18 节）
- [ ] 无重复 TS 契约（通用对象只在 P1-002）
- [ ] 16 个输入构造器全部有处置，网页无指令
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
