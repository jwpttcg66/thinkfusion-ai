# 目标契约驱动的证据闭环架构（Goal Contract & Evidence-driven Cycle）

**版本：** V2.0  
**设计性质：** V3 核心架构调整方案；当前仅为 `DESIGN`，不代表已实现  
**审计基线：** `main@9026e0e492cd0e8563cb4d5e6e50d5b37c371df6`（2026-11-27 03:00 UTC）  
**范围：** Goal Reasoning、Cycle Engine、TDL、ECO、DMOCA、Evidence、Verification、工程工作台  
**核心原则：** 用户目标为最终依据，证据为事实依据，循环决策为推进机制。

> 权威关系：业务契约见 [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](../spec/GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)；
> 实施批次见 [V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md](../implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md)；
> 决策记录见 [ADR 0011](../adr/0011-goal-contract-evidence-cycle.md)；当前实现状态只看 [STATUS.md](../implementation/STATUS.md)。
> 当前代码事实由 [ARCHITECTURE.md](../ARCHITECTURE.md) 维护，本文不复制 as-built 结构图。

## 一、设计结论

不推倒现有 V3 架构，不增加第二套 Agent Runtime。现有 Goal、TDL、GDC、ECO、DMOCA、Orchestrator、Journal、Verifier 继续保留，但重新明确权责。

核心调整：**从“任务执行驱动”转向“目标契约驱动”。**

| 旧流程 | 新流程 |
| --- | --- |
| 用户输入 → 模型分析 → 生成计划 → 执行 → 审核 → 修复或完成 | 用户目标 → 目标理解 → 目标契约 → 目标分解 → 动态协作 → 循环执行 → 证据验证 → 目标符合度评估 → 下一步决策 → 继续或验收 |
| 判断任务是否执行完 | 判断用户目标是否实现 |
| 审核结果容易成为最终结论 | 同时考虑技术质量、目标符合度与验证证据 |
| 修复轮容易重复执行 | 区分实现错误、设计错误、分析错误、目标不清 |

## 二、总体架构

### 2.1 分层

| 层 | 名称 | 核心职责 | 现有落点 |
| --- | --- | --- | --- |
| L0 | Goal Contract | 理解、确认、维护用户目标 | ConversationGoal、GDC |
| L1 | Goal Decomposition | 将目标拆成可交付、可验收任务 | TDL |
| L2 | Cycle Engine | 管理分析、设计、执行、审核和下一轮决策 | GDC、Orchestrator |
| L3 | Collaboration | 选模、分配职责、处理分歧 | DMOCA、Debate |
| L4 | Execution & Evidence | 工具执行、验证、产物和证据 | Agent Runtime、Journal、Verifier |

横向能力：ECO 提供真实且版本匹配的工程上下文；Long Task 负责长任务上下文、压缩、检查点与恢复；Memory 提供跨会话稳定信息，不替代本轮工程事实。

```text
用户请求 → Goal Contract → Goal Decomposition → Cycle Engine
                                      ↓              ↑
                                  Collaboration ──────┘
                                      ↓
                          Execution & Evidence
                                      ↓
                          Goal Fit Evaluation
                                      ↓
                          Next Decision ───┐
                                      ↓     │
                         目标达成 / 等待 / 阻塞 / 终止
```

Cycle Engine 是业务决策层，不是新 Runtime；真正执行仍由现有 Orchestrator 与执行基础设施完成。

### 2.2 权责边界

- Goal Contract 决定“最终要达到什么”。
- TDL 决定“需要完成哪些工作”。
- Cycle Engine 决定“当前处于什么阶段、下一步做什么”。
- DMOCA 决定“哪些模型参与、承担什么职责、贡献如何对齐”。
- Execution & Evidence 决定“实际发生了什么、有什么证据”。
- 模型可提出目标解释、设计和结论，但不能自行修改已确认目标，也不能自行认定工作已通过审核。

## 三、L0：Goal Contract

### 3.1 用户原话不等于完整目标

`projectEngineeringGoal()` 当前会把同一段原始文本同时赋给 `intent` 和 `desiredOutcome`；缺少成功标准时，还会用任务摘要生成“可核对标准”。这会让系统误以为已经理解用户目标。用户原话只是目标理解的输入，必须形成结构化目标契约。

### 3.2 六维目标理解

| 维度 | 问题 | 示例 |
| --- | --- | --- |
| 用户意图 | 用户为什么提出这个要求？ | 希望 AI 更准确理解项目 |
| 最终目标 | 最终希望得到什么？ | 能识别结构、调用关系和业务逻辑 |
| 目标价值 | 解决后带来什么价值？ | 提升工程分析和修改准确性 |
| 成功标准 | 如何判断目标实现？ | 能定位关键符号、调用关系和测试 |
| 隐含约束 | 有哪些未明确说出的限制？ | 本地运行、兼容现有架构 |
| 可行性 | 当前条件能否实现？ | 依赖语言解析能力和工程索引 |

每个维度必须有：内容、来源、置信程度、是否用户确认、是否冲突、关联证据、最后更新时间。字段与状态见契约文档。

### 3.3 目标信息来源

| 来源 | 含义 |
| --- | --- |
| `USER_EXPLICIT` | 用户明确表达 |
| `USER_CONFIRMED` | 用户确认过的目标或约束 |
| `MODEL_INFERRED` | 模型推断 |
| `PROJECT_EVIDENCE` | 工程中发现的事实 |
| `SYSTEM_CONSTRAINT` | 系统能力与许可边界 |
| `UNRESOLVED` | 尚未确定 |

模型推断不能直接升级为用户要求。用户明确要求 Java 21 是 `USER_EXPLICIT`；模型主张兼容 Java 8/11 是 `MODEL_INFERRED`。

### 3.4 契约状态

```text
DRAFT → UNDERSTANDING → READY_FOR_CONFIRMATION → CONFIRMED → ACTIVE
              ↓信息不足        ↑
          CLARIFYING ─用户回答─┘
ACTIVE ─目标风险→ AT_RISK
ACTIVE ─变更提议→ CHANGE_PROPOSED
ACTIVE ─无法推进→ BLOCKED
ACTIVE → ACHIEVED / ABANDONED
```

- 简单任务可在充分理解后直接进入 `ACTIVE`，不强制弹确认。
- 重大目标、约束冲突、不可逆影响必须要求确认。
- 目标变更不能通过修改任务摘要偷偷完成。
- 澄清、优化、变更是不同操作；拒绝变更后原目标仍有效。

### 3.5 成功标准独立于任务摘要

禁止“无成功标准 → 用任务 summary 填充 → 显示目标符合度”。正确链路：用户目标 → 提取标准 → 确认来源与含义 → 建立可验收 Criterion → 执行收集证据 → 逐条判定。Criterion 字段和状态见契约文档。

### 3.6 Goal Fit 不是布尔值

新 Goal Fit 由逐条 Criterion 汇总，显示：已满足、部分满足、未满足、未验证、已授权豁免、阻塞项、证据完整度、目标版本。默认达成条件是所有强制标准满足且无重大未处理风险；允许风险交付时标记 `ACHIEVED_WITH_RISKS` 或等价非完全达成状态，不能伪装为完全达成。

## 四、L1：Goal Decomposition

继续使用 TDL，不建第二套任务树。层级：`Goal Contract → L0 Work → L1 Task Group → L2 Subtask → L3 Execution Step`。

每个任务必须回答：服务哪条 Criterion、为何需要、交付物、如何验收、依赖、所需工程上下文、失败影响面。

任务增加逻辑映射：`goalId`、`goalVersion`、`criterionIds[]`、`acceptanceCriteria[]`、`evidenceRefs[]`、`cycleId`。一条 Criterion 可由多个任务承接，一个任务可服务多条 Criterion。

分解质量门禁必须检查：强制标准覆盖、关键依赖遗漏、不可验收任务、重复任务、循环依赖、无任务承接的 Criterion、无目标价值的任务。分解不完整时进入 `NEEDS_ANALYSIS` 或 `CLARIFY_GOAL`，不能假装计划完整。

L2 独立 `cycleId` 只代表身份、阶段记录、决策、调度语义上的独立；不等于物理并行。现阶段不要求每个 L2 新建 Runtime，也不把串行执行宣称为并行。

## 五、L2：Cycle Engine

### 5.1 Cycle 与 Round 分离

| 概念 | 含义 |
| --- | --- |
| Work | 用户交付的一项完整工作 |
| Goal | Work 要实现的最终目标 |
| Cycle | 围绕目标的一次完整决策与推进循环 |
| Round | 某阶段的一次模型调用或执行尝试 |
| WorkTask | 分解出的具体工作 |
| Evidence | 实际发生和验证的事实 |

一次修复调用不一定是新的完整 Cycle；小缺陷可局部修复。若设计无法满足成功标准，必须回到 DESIGN 或 ANALYSIS，而不是机械修复。

### 5.2 阶段

```text
GOAL_REASONING → ANALYSIS → DESIGN → DESIGN_DEBATE(按需) → PLANNING
→ IMPLEMENTATION → REVIEW → REVIEW_DEBATE(按需) → CONCLUSION
→ GOAL_FIT → NEXT_DECISION
```

| 阶段 | 产物 | 必须回答 |
| --- | --- | --- |
| GOAL_REASONING | Goal Assessment | 是否仍理解用户真实目标？ |
| ANALYSIS | Analysis Artifact | 当前事实、问题和未知项是什么？ |
| DESIGN | Design Artifact | 有哪些可行方案，选择依据是什么？ |
| DESIGN_DEBATE | Debate Artifact | 方案是否存在真实分歧？ |
| PLANNING | Plan Artifact | 如何分解任务、依赖和验收？ |
| IMPLEMENTATION | Execution Artifact | 实际做了什么，产生什么变化？ |
| REVIEW | Review Artifact | 实现是否正确，是否有缺陷？ |
| REVIEW_DEBATE | Review Debate Artifact | 重要评审争议是否解决？ |
| CONCLUSION | Cycle Conclusion | 本轮真正得出了什么结论？ |
| GOAL_FIT | Goal Fit Assessment | 本轮成果对最终目标有何贡献？ |
| NEXT_DECISION | Cycle Decision | 下一步采取什么行动？ |

允许跳过阶段，但必须有真实决策记录；不能从投影推断“已经执行”。发现设计不可行必须回 DESIGN，需求根本歧义必须回 GOAL_REASONING 或 CLARIFY_GOAL。

### 5.3 每轮目标推理

每个完整 Cycle 开始时复核：目标是否变化、当前理解是否正确、是否出现新约束、成功标准是否仍适用、技术路线是否可行、本轮工作是否服务最终目标。无变化可引用已有契约并记录复核；发现冲突则产生目标风险或变更提议。不要求每轮都重新询问用户。

### 5.4 设计阶段不被计划替代

设计阶段必须形成独立产物：问题分析、候选方案、比较、技术选型、关键取舍、风险与兼容性分析、选择理由。计划只是把已确定方案变成步骤；不能把执行计划当设计文档，也不能把模型写“设计完成”当真实完成。

## 六、Cycle Decision Engine

当前 `decideNextEngineeringAction()` 只有 `complete/repair/fail_budget/fail_delivery`，不能表达重分析、重设计、重规划、澄清或等待用户。

决策类型：`CONTINUE`、`REPAIR`、`REPLAN`、`REDESIGN`、`REANALYZE`、`CLARIFY_GOAL`、`CHANGE_PROPOSED`、`WAIT_USER`、`BLOCKED`、`COMPLETE`、`ABORT`。

优先级：用户取消与权限/安全 → 目标有效性 → 不可恢复阻塞 → 证据充分性 → 未解决重大评审 → 技术方案成立性 → 修复/重规划需要 → 是否达到最终目标。`task.completed` 不能直接覆盖上述判断。

| 事实 | 决策 |
| --- | --- |
| 实现正确、验证通过、标准全满足 | COMPLETE |
| 明确实现缺陷，设计成立 | REPAIR |
| 设计无法满足标准 | REDESIGN |
| 分析依据不足或关键事实错误 | REANALYZE |
| 任务拆分/依赖不合理 | REPLAN |
| 目标重大歧义 | CLARIFY_GOAL |
| 需修改目标才能继续 | CHANGE_PROPOSED |
| 缺用户授权或必须选择 | WAIT_USER |
| 依赖环境不可用 | BLOCKED |
| 预算耗尽但未达标 | BLOCKED / WAIT_USER |
| 用户取消 | ABORT |

无进展检测必须识别：重复问题、相同证据指纹、相同失败步骤、同一方案反复否决、多轮无新增有效证据、Criterion 长期不变、修复声明与审核反复冲突。停止自动循环后判断重设计、用户介入或终止，不能只依赖轮数上限。

## 七、L3：动态多模型协作

继续使用 DMOCA，不增加独立模型调度系统。参与由阶段、复杂度、目标风险、ECO 充分度、现有贡献、真实分歧、成本预算决定。角色：`Lead`、`Analyst`、`Architect`、`Challenger`、`Implementer`、`Reviewer`、`Integrator`；角色是职责，不是固定模型身份。

正式参与者必须经过 ECO 上下文充分度检查，最低上下文包含：目标及版本、当前阶段与任务、相关工程结构、已确认事实、历史决策、未解决问题、相关证据与变更。上下文不足只能作为有限意见，不能获得正式架构裁决资格。

辩论触发条件：重要设计存在不同方案、关键技术决策冲突、审核与实现结论不一致、事实判断重大分歧、高风险不可逆改动、目标符合度争议。无真实分歧直接跳过并记录原因。

正式决策绑定：Goal Version、Cycle ID、ECO Context Version、参与模型、原始贡献、贡献完整性、采纳/拒绝理由、决策版本。超时/失败记录 `unresolved`，不伪造一致意见。

## 八、Evidence 与 Verification

三种完成状态必须分开：

| 状态 | 含义 |
| --- | --- |
| Execution Completed | 工具和步骤执行结束 |
| Verification Passed | 对相应改动的验证通过 |
| Goal Achieved | 用户目标成功标准全部达到 |

最新 `9026e0e` 已区分非代码文件回读与代码验证：文本文件写入后回读同一路径可作为该类改动的验证证据；代码文件回读不等于编译或运行成功。

证据类型：`MODEL_CLAIM`、`TOOL_RESULT`、`FILE_READBACK`、`BUILD_RESULT`、`TEST_RESULT`、`RUNTIME_RESULT`、`INTEGRATION_RESULT`、`USER_ACCEPTANCE`。不同证据有不同适用范围；模型自报完成不能替代验证；一个真机样本不能外推所有环境。

证据关联：`workId`、`cycleId`、`workTaskId`、`criterionId`、`goalVersion`、`evidenceType`、`source`、`timestamp`、`contentHash`、`verificationStatus`。具体字段按现有 Evidence/Journal 契约扩展。

目标验收：`Execution Completed + Verification Evidence + Independent Review + Goal Criteria Evaluation + No Blocking Risk = Goal Acceptance`。完全权限下允许按策略结束未验证交付，但必须如实保留缺口，不把任务结束等同目标达成。

## 九、长任务与恢复

复用 ContextManager、Journal、Checkpoint；恢复对象从任务运行状态扩展为目标决策状态。检查点至少恢复：Goal Contract 及版本、Cycle 与阶段、TDL 任务树 revision、Plan 版本、ECO Context 版本、DMOCA 贡献快照、Evidence、未解决 Review Issue、决策与预算、可继承交付物。

恢复前版本一致性策略：目标/任务/证据兼容则继续原阶段；目标变化则重规划受影响任务；ECO 过期则重新读取上下文；贡献版本不匹配则重新获取；Evidence 失效则重新验证；外部副作用无法确认则停止自动执行要求核对。压缩不能删除重要决策、目标版本和证据引用。

## 十、主活动区 UI

遵循最新连续文档式对话流，不恢复独立定位轨，不重新把内容做成大卡片。主活动区按真实事件顺序呈现：用户目标 → 目标理解与确认 → 本轮分析 → 设计方案 → 模型协作与真实争议 → 计划 → 执行进度 → 审核 → 验证证据 → 本轮结论 → 目标符合度 → 下一步决策。

内容采用连续正文式：阶段作文档标题；模型贡献显示身份与完整输出；工具显示调用、结果与耗时；审核问题显示处理状态；证据显示来源与验证结果；Criterion 逐条状态；决策显示原因与依据。

目标区显示：最终目标、Goal Version、成功标准、已满足/未满足、风险与未确认假设；目标变更需正式确认入口，不再只依赖 IPC。工程工作台四个页签保持不变：对话、输出、轨迹、统计。

## 十一、事件与数据

继续以 Journal / AgentEvent 为事实来源；GDC 只做投影，不能把投影当事实。

建议补充事件语义（需先核对现有 contracts，优先复用）：`goal.assessment.created/updated`、`goal.confirmation.requested`、`goal.confirmed`、`goal.criterion.updated`、`goal.change.proposed/confirmed`、`cycle.created`、`cycle.stage.started/completed/skipped`、`cycle.decision.created`、`goal.fit.assessed`、`evidence.linked`。

Cycle Snapshot：`cycleId`、`workId`、`cycleNumber`、`goalId`、`goalVersion`、`currentStage`、`stageHistory`、`decision`、`decisionReason`、`decisionEvidenceRefs`、`artifactRefs`、`budget`、`status`、`createdAt`、`updatedAt`。Cycle Number 只代表完整 Cycle，不能用 Round Number 替代。

正式决策绑定 Goal Version、Task Revision、ECO Context Version、Contribution Snapshot Version、Evidence References；版本不匹配不静默复用。

## 十二、三个产品场景

| 场景 | 目标处理 | 主要循环 | 最终评价 |
| --- | --- | --- | --- |
| General | 理解问题与预期答案 | 分析、调查、必要时辩论、结论 | 答案是否解决问题 |
| Knowledge | 理解学习/研究目标 | 调查、资料验证、分析、辩论、综合 | 知识结论是否可靠 |
| Engineering | 理解工程交付目标 | 完整工程 Cycle | 工程目标是否达成 |

Engineering 默认完整循环；General/Knowledge 不强制 Implementation。三者共用 Goal Reasoning 与协作能力，允许按需多模型与辩论。

## 十三、与现有代码的关系

| 现有模块 | 新职责 | 调整方向 |
| --- | --- | --- |
| `conversation.ts` / ConversationGoal | 目标基础数据 | 扩展目标契约表达 |
| `goal-driven-cycle.ts` | 目标/周期投影与纯函数 | 升级为目标标准与决策模型 |
| `task-decomposition.ts` | 目标任务分解 | 增加 Criterion 映射与覆盖检查 |
| `subtask-cycle.ts` | L2 循环投影 | 补齐真实阶段与独立决策语义 |
| `orchestrator.ts` | 生产编排 | 接入 Cycle Decision |
| `version-consistency.ts` | 版本一致性 | 纳入标准、决策与证据 |
| `eco.ts` / `eco-explore.ts` | 工程上下文 | 保障正式参与者上下文充分 |
| `dmoca.ts` | 动态协作 | 按阶段与贡献缺口选模 |
| `verification.ts` | 执行验证 | 保留按改动类型选验证方法 |
| AgentStore / Journal | 状态与事实 | 保持事件权威，不建平行存储 |
| `TaskConversation.tsx` | 过程呈现 | 继续最新连续文档式流 |
| `EngineeringWorkbenchBar.tsx` | 工作台入口 | 增加目标与决策操作入口 |

## 十四、实施顺序

| 批次 | 内容 | 交付 |
| --- | --- | --- |
| P0 | 核对生产链路与数据模型；找真实事件与投影；确认 `task.completed/report.ready/goal.fit` 语义；核对 `9026e0e` 验证与收尾；更新状态快照 | 现状图、事件映射、缺口清单 |
| P1 | Goal Contract 六维结构、来源区分、Criterion、目标确认与变更入口；删除 summary 冒充标准 | 可用目标契约与确认流程 |
| P2 | Criterion→WorkTask、Evidence→Criterion、逐条 Goal Fit、三种完成状态、按改动类型验证 | 可追溯目标验收体系 |
| P3 | Work/Cycle/Round 分离、真实阶段语义、完整决策出口、无进展检测、目标评估接入结论 | 真正选择下一步的 Cycle Engine |
| P4 | L2 绑定 Criterion、覆盖检查、ECO 充分度资格、DMOCA 按阶段选模、按需辩论、版本可追溯 | 一致的协作链 |
| P5 | UI 展示目标/Criterion/决策、目标变更确认、恢复与版本一致性、三场景回归、真实工程长任务验收 | 生产闭环与可操作工作台 |

## 十五、生产验收标准

必须全部有真实证据，不能只凭文档或类型定义认定完成：

- Goal Contract：六维提取、来源不伪造、成功标准不由 summary 伪造、重大变更有确认、版本一致。
- Goal Decomposition：强制 Criterion 有任务承接、任务可验收、依赖有效、结果回到标准。
- Cycle Engine：Cycle/Round 分离、真实阶段可重放、区分修复/重规划/重分析/重设计、处理澄清与等待、识别重复失败、恢复不复用过期结论。
- Collaboration：动态选真实生效、正式参与者上下文充分度检查、贡献绑定版本、无争议不伪造辩论。
- Evidence：标准有证据、类型匹配验收方法、自报不算证据、文本回读不替代编译运行、任务完成不推导目标达成。
- UI：目标/阶段/输出/工具/审核/证据/结论可追溯、目标变更可操作、连续文档式流、进度来自真实事件。

## 十六、不可妥协的工程约束

1. 不新增第二套 Agent Runtime。
2. 不新增第二套 Journal、EvidenceStore、Approval、Verifier 或权限系统。
3. 不以提示词包装代替真实 Goal Reasoning。
4. 不把模型推断写成用户确认。
5. 不把任务摘要写成成功标准。
6. 不把执行完成写成目标达成。
7. 不把模型自报完成写成证据。
8. 不把阶段投影写成阶段真实发生。
9. 不把 L2 独立 ID 写成物理并行。
10. 不把辩论人数写成决策质量。
11. 不静默降低用户目标。
12. 不因局部失败推倒已验证成果。
13. 不重复建设最新对话流已完成的功能。
14. 不重新增加独立定位轨。
15. 不改变用户原始请求，不通过隐藏提示词替换用户意图。

工程实施必须使用独立 worktree/分支，未经授权不得推送 `main`，不执行发布、签名、公证或正式分发。

## 十七、最终设计决议

ThinkFusion V3 的核心不是更多轮对话或更多阶段卡片，而是建立：

> 一个以用户目标为最高业务依据、任务分解组织工作、循环引擎管理决策、动态模型协作提供能力、真实证据验证成果的工程协作系统。

最终评价标准只有一个：**用户真正希望实现的目标，是否在明确约束和可靠证据下得到实现。**

## 十八、已确定的三项架构选择

1. **目标确认策略：** 分级确认。简单任务在充分理解后自动进入 `ACTIVE`；复杂工程、重大变更、高风险任务要求用户确认。
2. **Goal Reasoning 运行方式：** 按需推理。每个完整 Cycle 复核目标，但不每次重新调用所有模型；只有目标冲突、信息缺口或重大风险才升级分析。
3. **目标达成策略：** 严格区分 `ACHIEVED`、`ACHIEVED_WITH_RISKS`、`PARTIAL_ACHIEVEMENT`、`UNVERIFIED`，不再用一个 `completed` 承载全部含义。

建议先打通 Goal Contract、Criterion、Evidence 三者，再建设完整 Cycle Decision Engine；否则阶段与出口再多，系统仍不知道是否实现用户真正想要的目标。
