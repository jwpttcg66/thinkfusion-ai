# P1-001 迁移审计

状态：**正式审计（2026-11-18）**，待评审。
代码基线：`cd30be3`（main，含 product-v3 合并；代码与 `ddf48c0` 相同）。
范围：现有代码的架构、状态、Runtime、Planner、Debate、Evidence、Engineering、Java、
删除/保留/改造/新增清单、风险、P1 顺序与不可触碰边界。

> 分支提示：设计分支 `product-v3`（快照 `2d05b12`，含 P1-002/P0-A/P0-B）；代码基线 `cd30be3`。
> `main` 仅集成；本文以代码基线 `cd30be3` 为准。

---

## 1. 当前代码架构

### 1.1 入口与生命周期

| 模块 | 职责 | 状态持有 | 输入 | 输出 | 调用者 |
| --- | --- | --- | --- | --- | --- |
| `src/main/index.ts` | Electron 装配、IPC、窗口 | 无（装配） | IPC | 事件/窗口 | renderer |
| `conversation-runner.ts` | 对话入口、意图路由、研究/工程分支、预算与看门狗、辩论触发 | `AgentStore` + 内存 `running` | 用户问题、配置 | 事件、Conversation | `index.ts` |
| `master-agent.ts` | 第一手并发提问 + 规则综合 | 无 | `ResearchRequest` | `ResearchOutcome` | `ConversationRunner` |
| `collaboration/strategy.ts` | 并行/递进/smart 的 stage 计划 | 无 | 问题、成员 | `CollaborationPlan` | `CollaborationResearch` |
| `collaboration/runner.ts` | 按计划执行、逐任务记录 | 无 | `CollaborationPlan` | `CollaborationResult` | `ConversationRunner` |

### 1.2 执行链

| 模块 | 职责 | 状态持有 | 输入 | 输出 | 调用者 |
| --- | --- | --- | --- | --- | --- |
| `orchestrator.ts`（AgentOrchestrator） | 建任务、生成计划、审批、执行、修复 | `AgentStore` | prompt、权限 | `AgentTask` | `index.ts` / `ConversationRunner` |
| `agent-manager.ts` | `UtilityProcess` 生命周期、Runtime 消息 | 子进程句柄 | 计划/授权 | 执行结果 | `AgentOrchestrator` |
| `src/agent/*` | Runtime：工具、策略、审批、验证 | 子进程内存 | 计划、TaskGrant | `ExecutionReport` | `agent-manager` |
| `engineering/*` | 读盘、分析、计划评审、执行后评审 | 无 | 仓库、计划 | 文本/证据 | `ConversationRunner` / `AgentOrchestrator` |
| `code-index/*` | SQLite+FTS5 索引、检索、影响面 | `node:sqlite` | 仓库 | 查询结果 | `engineering` / `ConversationRunner` |
| `lsp/*` | TypeScript 语言服务 | tsserver 进程 | 文件位置 | 定义/引用/诊断 | `code-index` / 工具 |

### 1.3 辩论链

| 模块 | 职责 | 状态持有 | 调用者 |
| --- | --- | --- | --- |
| `debate/orchestrator.ts` | 辩论启动、分轮、主张/争议、证据、裁判、收敛 | `DebateStore` | `ConversationRunner` |
| `debate/lead.ts` | 主导模式与参与者选择（local/web/cloud/hybrid） | 无 | 编排器 |
| `debate/claims.ts` | 从 `DebateMessage` 抽 Claim/Dispute | 无 | 编排器 |
| `judge/*` / `debate/judges.ts` | 三维裁判、方向判断 | 无 | 编排器/验证 |
| `debate/argument-graph.ts` | 论证图 | 无 | 编排器 |
| `debate/prompts.ts` | 固定提示词 | — | **已删除** |

### 1.4 证据与存储

| 模块 | 职责 | 状态 |
| --- | --- | --- |
| `evidence-pack/store.ts` | Pack 存储、哈希、快照 | `userData` 文件 |
| `evidence-pack/repository-snapshot.ts` | 仓库快照 Pack | Pack |
| `evidence-pack/execution-producer.ts` | 执行断言 | Pack |
| `store.ts`（AgentStore） | 原子 JSON journal：任务/对话/轮次/计划/事件 | 单文件 |
| `debate/store.ts` | 每场辩论一个 JSON | 多文件 |
| `code-index/store.ts` | SQLite + FTS5：节点、边、记忆关联 | 单 DB |

---

## 2. V3 目标架构

```text
User Goal
   ↓
CollaborationEngine
   ├── Planner（含参与者数量与范围）
   ├── Scheduler（DAG、能力、并发、超时）
   ├── Runner（任务执行 / Observation）
   ├── Replanner（P1.1）
   ├── Verifier（P1.1 / P4）
   └── Deliver
   ↓
Participants: 网页渠道 / 本地模型 / 远端模型 / CLI
   ↓
Evidence / Knowledge / Engineering / Runtime
```

要求：

- 一份 `CollaborationState`；
- 一个引擎，三个空间只是任务类型与能力集合；
- Debate、Knowledge、Engineering 都不是独立 Engine；
- 不新建 Runtime / 审批 / Journal / TaskGrant / Verifier / Evidence 存储。

---

## 3. 模块映射表

| 当前模块 | V3 目标 | 处置 |
| --- | --- | --- |
| `conversation-runner.ts` | 入口；按 flag 路由到 engine | 保留 + 增量 |
| `master-agent.ts` | ParticipantManager + Deliver | 拆分 |
| `collaboration/strategy.ts` | Planner 的 DAG 输入 | 改造 |
| `collaboration/runner.ts` | Runner / Observation | 扩展 |
| `debate/orchestrator.ts` | DebateBehavior | 降级 + 拆职责 |
| `debate/lead.ts` | 辩论内部主导选择 | 保留（不上升为全局 Planner） |
| `debate/claims.ts` | 通用 Claim/Dispute 抽取 | 拆分 |
| `debate/judges.ts` / `judge/*` | 验证能力 | 保留 |
| `debate/argument-graph.ts` | 论证结构 | 保留 |
| `debate/prompts.ts` | — | 已删除 |
| `evidence-pack/*` | 统一证据层 | 保留 + 适配 |
| `orchestrator.ts` / `agent-manager.ts` / `agent/*` | 执行治理与 Runtime | 保留（不动） |
| `engineering/*` | 工程能力 | 保留 + 接入 |
| `code-index/*` / `lsp/*` | 事实提供者 | 保留 |
| `coding/team.ts` | 工程协作能力 | 保留 + 接入 |
| `execution/cli-answer-agent.ts` | 只读 Participant | 保留 |
| CLI 执行者（`agent.exec`） | Executor | 保留 |
| `store.ts` | `CollaborationState` 持久化 | 扩展 |
| `shared/conversation.ts` | 事件契约 | 扩展 |
| `renderer/*` | UI | 延后 |

---

## 4. 重复职责（P1-001 核心结论）

现有代码不是「多了一套 Runtime」，而是**四条编排回路并存**，各自回答一部分问题：

| 问题 | 现在由谁回答 | 冲突 |
| --- | --- | --- |
| 谁创建任务？ | `AgentOrchestrator.tasks.create`；`ConversationRunner` 建会话；`DebateOrchestrator` 建 DebateState；`collaboration` 建 Task | 四种「任务」语义 |
| 谁决定模型/参与者？ | `routeModels`（执行模式）；`planLead`（辩论主导）；`MasterAgent`（全部可用）；`CollaborationResearch`（计划） | 四处选人，规则不同 |
| 谁执行？ | `AgentOrchestrator.driveRound`；`DebateOrchestrator.ask`；`MasterAgent.ask`；`CollaborationResearch` | 四条执行路径 |
| 谁记录状态？ | `AgentStore`；`DebateStore`；`EvidencePackStore`；`CodeIndexStore`；`trace` | 五个状态源 |
| 谁决定结束？ | `ConversationRunner` 看门狗；`DebateOrchestrator` 收敛/轮数；`AgentOrchestrator` task_complete；`CollaborationResearch` stage 结束 | 四种停止条件 |
| 谁做验证？ | `agent/verification`；`judge`；`engineering/review`；`evidence-pack/claim-verification` | 四套验证口径 |
| 谁做重试？ | `CollaborationResearch`（一次）；`AgentOrchestrator.repairPlan`（≤2）；页面适配器 | 三套重试策略 |
| 谁做并发？ | `MasterAgent` Promise.all；`DebateOrchestrator.mapLimit`；`CollaborationResearch` Promise.all；`AgentOrchestrator.pageQueue` | 四套并发控制 |

**结论：V3 不是「新增一个引擎」，而是把上述四条的「决策」集中到
Planner/Scheduler/Replanner，把「执行」留给既有 Runtime，把「状态」收敛到
`CollaborationState`。**

---

## 5. 状态来源

| 状态 | 当前存放 | 生命周期 | 问题 |
| --- | --- | --- | --- |
| 对话 / 任务 / 轮次 / 计划 / 报告 / 事件 | `AgentStore` 单 JSON journal | 进程重启后仍在 | 全量写，辩论轮次放大成本 |
| 辩论 | `DebateStore` 每场一文件 | 独立 | 与会话状态分离，需双写引用 |
| 证据 | `EvidencePackStore` packs | 冻结 | 与辩论上下文历史耦合（`baseline` 命名残留） |
| 代码索引 | `node:sqlite` + FTS5 | 持久 | 工程/知识之外的事实库；含 code memory links |
| 协作计划/任务 | 内存（`CollaborationPlan` / `records`） | 一轮 | **无持久化** |
| 工程任务状态 | 无独立对象；散在会话/证据 | 一轮 | 没有 S1/S2 的正式状态 |

结论：`CollaborationState` 必须新引入，但**落盘复用 `AgentStore`**，不新建 Journal。

---

## 6. Runtime 来源

只有一个执行 Runtime：

- `agent-manager.ts` 用 `utilityProcess.fork` 启动 `src/agent/index.ts`；
- 计划审批、TaskGrant、工具白名单、sha256 复验都在这一条链；
- `AgentOrchestrator` 只是主进程侧的调度与审批门面。

**没有第二套 Runtime。** 风险不是「重复进程」，而是未来 engine 另写一套执行/审批。

不可触碰：`agent/*`、`agent-manager.ts`、`orchestrator.ts` 的审批与授权逻辑。

---

## 7. Planner / Participant 当前实现

结论：**当前不存在「按能力选参与者」的 Planner。**

| 现有机制 | 实际做什么 | 不能替代 Planner 的原因 |
| --- | --- | --- |
| `MasterAgent.research()` | 把问题发给 pool 里所有可用成员 | 没有「选几个 / 为什么」 |
| `planLead()` | 按主导模式（local/web/cloud/hybrid）选辩论成员 | 是辩论规则，不是任务能力匹配 |
| `routeModels()` | 按执行模式选模型/汇总者 | 是执行配置，不是任务理解 |
| `CollaborationResearch` | 按 stage 复制任务 | 没有能力过滤，也没有跳过理由 |

缺少的正是 V3 要的：

```text
Task → requiredCapabilities → availableParticipants → Planner → selectedParticipants(+reason)
```

以及 `modelScope`（local/remote/hybrid）与 `includeWeb` 的显式约束。

---

## 8. Debate 当前耦合

### 8.1 仍把 Debate 当主流程的地方

| 位置 | 表现 |
| --- | --- |
| `ConversationRunner` | `runDebate` 依赖；总结后按 `debateMode` 触发 |
| 会话配置/UI | `debateMode`、策略、辩论徽标（`ConversationView`） |
| `AgentOrchestrator` | `planDebate`（D-03）把辩论接进执行审批前 |
| 迁移计划 | `debate/orchestrator` 仍是独立大模块 |

### 8.2 应保留的通用能力

| 能力 | 现状 | 去向 |
| --- | --- | --- |
| Claim / Dispute 模型 | `debate/claims.ts`，绑定 `DebateMessage` | 拆成通用抽取 |
| 方向判断 | `judge/*`、`debate/judges.ts` | 验证能力 |
| 论证结构 | `argument-graph.ts` | 可选结构 |
| 证据包 | `evidence-pack` | 统一证据 |
| 多轮质疑/修订 | `revision.ts` | DebateBehavior 内部 |

结论：**Debate 不是要删，而是从「入口/主流程」降为「Behavior」**；
`DebateOrchestrator` 可以保留很强，但只能被 engine 调用。

---

## 9. Evidence / Memory 当前状态

- **Evidence**：`EvidencePackStore` 已能冻结内容、哈希、快照、执行断言；
  `claim-verification*` 能把 Runtime Claim 接到执行报告。
- **缺口**：`context.kind` 仍有 `baseline` 历史值；`mapping.ts` 仍以辩论证据为中心；
  无跨空间 `EvidenceRef` 适配。
- **Memory**：**没有通用 Memory 模块**。只有：
  - `knowledge/page-extract.ts`（网页正文抽取）；
  - `code-index` 的 code memory links（仅代码索引内）。
- 结论：P1 只做 `EvidenceRef` 最小契约；P4 做统一映射；Memory 归 P2 知识层，不在 P1 造。

---

## 10. Engineering 当前状态

已有：

- `engineering/project.ts`：读盘扫描（文件、结构、命名）；
- `engineering/analysis.ts`：符号、调用点、模块图、影响面（正则 + import）；
- `engineering/plan-review.ts`：计划能力门槛、评审辩题、`shouldDebatePlan`；
- `engineering/review.ts`：执行后评审；
- `orchestrator.ts` 的 `worktree` 依赖；`agent/*` 执行；`code-index`/`lsp` 事实。

缺口：

- 没有 `EngineeringTaskState`（S1/S2、commit、dirty、diff、测试报告）；
- 工程执行仍经 `ConversationRunner.runExecutionStage` + `AgentOrchestrator`；
- `planDebate` 仍把辩论接在计划评审前（Debate 耦合）；
- Java 没有独立语义层（见 §11）。

结论：工程空间是**能力集合 + 状态 + 交付协议**，不是新 Engine。

---

## 11. Java 能力当前状态

| 能力 | 现状 | 结论 |
| --- | --- | --- |
| 文件识别 | `code-index/indexer.ts` 支持 `.java`，`collectJava` 提取声明/import | 有轻量结构 |
| 全文/符号搜索 | `code-index`（SQLite+FTS5）、`fs.search` | 可用 |
| LSP | `lsp/providers.ts` 只有 TypeScript（tsserver） | **无 Java LSP** |
| 调用图 | `code-index` 有跨文件边（Java 解析为轻量） | 非编译器级 |
| 编译验证 | 无内置；可经 `test.run` / `shell.run` / Maven/Gradle | 按需 |
| 外部图 | CGC/Graphiti/Neo4j 可选（`code-index/config.ts`） | 非默认依赖 |

结论：与 V3 方向一致——**工具给事实，模型做理解**；不把 JDT/完整语义引擎作为 P1/P3 阻塞。

---

## 12. 删除项（满足条件后）

| 项 | 条件 |
| --- | --- |
| `debate/prompts.ts` | 已删除（完成） |
| `buildInitialPrompt`（`shared/protocol.ts`） | **当前仍存在，且是固定角色提示词**；P3 改为结构化计划契约后删除。这是最后一个违反 AGENTS §6 的实现 |
| `collaboration/strategy.ts` 的 stage 计划 | DAG Planner 接管后 |
| `debate/orchestrator` 的开场基线/轮次入口 | 已移除基线；入口在 DebateBehavior 接管后 |
| `round-evidence` 接线 | 已移除；P4 按新证据层重建 |
| `baseline` 命名/上下文 | P4 映射后，旧 Pack 只读 |

**不删**：Debate 引擎、judge、argument-graph、evidence-pack、Runtime、审批、Journal。

---

## 13. 保留项

- `AgentOrchestrator` + `agent-manager` + `agent/*`（执行治理与 Runtime）；
- `TaskGrant`、审批、stepApproval、工具白名单、sha256 复验；
- `EvidencePackStore`、`hash.ts`、`snapshot.ts`、`execution-producer`；
- `engineering/*`、`code-index/*`、`lsp/*`、`coding/team.ts`；
- `DebateOrchestrator`、`judge/*`、`argument-graph`（作为能力）；
- 网页 Adapter、`WebContentsView`、来源配置；
- `AgentStore` journal。

---

## 14. 改造项

| 项 | 改造 |
| --- | --- |
| `ConversationRunner` | 按 mode 路由；决策移出 |
| `MasterAgent` | 拆 ParticipantManager / Deliver |
| `collaboration/strategy` | stage → DAG |
| `collaboration/runner` | 计划执行 → Observation + State |
| `debate/claims` | 输入泛化，脱离 `DebateMessage` |
| `debate/orchestrator` | 包成 DebateBehavior；不接基线、不接主入口 |
| `evidence-pack/mapping` | Pack → EvidenceRef |
| `AgentStore` | 承载 `CollaborationState`（可选字段） |
| `shared/conversation` | 增加 collaboration 事件 |
| `shared/protocol` | 计划契约替换固定提示词（P3） |

---

## 15. 新增项

| 项 | 说明 |
| --- | --- |
| `collaboration/domain/*` | Goal / TaskEnvelope / TaskSpec / Observation / EvidenceRef / Claim / Dispute / State |
| `collaboration/mode.ts` | legacy / shadow / active，默认 legacy |
| `collaboration/planner/*` | 规则版 DAG + 参与者数量 + `modelScope` / `includeWeb` |
| `collaboration/scheduler/*` | 能力过滤、依赖、并发、超时、取消 |
| `collaboration/runner/*` | 执行 + Observation + 状态转移 |
| `collaboration/deliver/*` | 交付物组装 |
| `collaboration/adapt/replanner.ts` | P1.1 |
| `collaboration/reviewer.ts` | P1.1 关键阶段模型审核（数据 + schema） |
| 事件 | `goal.started` / `plan.created` / `task.started` / `observation.recorded` / `plan.revised` / `goal.stopped` / `deliverable.ready` |

---

## 16. 风险

| 风险 | 证据/信号 | 对策 |
| --- | --- | --- |
| 第五套编排 | 新 engine 自己建任务/选模型/结束 | 本文 §4 清单，代码评审逐条对照 |
| 提示词借尸还魂 | `TaskEnvelope.question` 出现角色/阶段话术 | 渲染层测试；`buildInitialPrompt` 删除 |
| 状态分裂 | engine 另存 task 列表 | 只允许 `CollaborationState` |
| 参与者静默减少 | 计划没有 reason/跳过原因 | 测试断言 |
| 证据两套 | 新 EvidenceRef 另建存储 | 只做适配层，复用 Pack |
| Debate 仍主导 | 入口/配置/事件仍以辩论为中心 | P1.1 移除入口，DebateBehavior |
| 网页被塞指令 | 后续轮 question 出现「请指出」 | 边界测试 |
| 旧路径回归 | legacy 行为变化 | flag + 对照测试 |
| 大爆炸重构 | 一次改 Runner+Debate+UI | 按 §17 小步 |

---

## 17. P1 实施顺序

### P1.0（先跑通，不做自动重规划）

1. **契约与状态**：domain 类型；`CollaborationState`；`mode` flag；落盘（复用 AgentStore）。
2. **Planner MVP**：规则 DAG；`modelScope` + `includeWeb`；参与者数量与理由。
3. **Scheduler**：校验范围；按名单执行；依赖/并发/超时/取消。
4. **Runner**：执行 → Observation → 状态转移；失败也是结果。
5. **Deliver**：按 acceptance 组装；未核验显式标记。
6. **Shadow plan-only**：只算计划，零调用；日志可读。
7. **接 `ConversationRunner` shadow 分支**；legacy 不变。

验收：简单问题 1–2 任务；高风险至少 2 个参与者；跳过有原因；停止原因可解释；
legacy 行为无回归。

### P1.1（之后）

1. Replanner + 护栏；
2. 关键阶段模型审核（数据 + schema，默认关闭）；
3. DebateBehavior 接入 + 入口移除；
4. 只读回放对照（不做双跑）。

---

## 18. 不允许修改的边界

- 不改 Runtime（`agent/*`、`agent-manager.ts`）；
- 不改审批 / TaskGrant / stepApproval；
- 不新建 Journal / 状态库 / 证据存储；
- 不改网页 Adapter 的「只收原话」边界；
- 不改 Pack 哈希与快照格式（只加适配）；
- P1 不改产品 UI（只日志与调试入口）；
- 不删 Debate / judge / argument-graph；
- 不自动 merge、不自动 push。
