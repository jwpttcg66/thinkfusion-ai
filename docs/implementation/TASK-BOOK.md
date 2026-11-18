# ThinkFusion V3 全任务设计书

状态：**设计稿（2026-11-18）**，设计分支 `product-v3`。
代码基线：`cd30be3`。设计快照：本文提交前为 `8489df5`。
用途：把 P0–P5、UI、发布与跨阶段工作拆成可执行任务；每个任务都有目标、依赖、
文件、验收、回滚与风险。**本文不写实现代码。**

> 契约唯一权威：[P1-002 领域与运行时契约](P1-002-DOMAIN-RUNTIME-CONTRACT.md)。
> P2–P5 领域设计：[KNOWLEDGE_SPACE](../architecture/KNOWLEDGE_SPACE.md)、
> [ENGINEERING_CONTRACT](../architecture/ENGINEERING_CONTRACT.md)、
> [EVIDENCE_QUALITY](../architecture/EVIDENCE_QUALITY.md)、
> [CAPABILITY_MODEL](../architecture/CAPABILITY_MODEL.md)。
> 本文只做任务设计；出现接口冲突时，以 P1-002 为准。

---

## 0. 状态与读法

| 标记 | 含义 |
| --- | --- |
| ✅ | 设计完成（不代表代码已实现） |
| ⏳ | 待实现 |
| 🔒 | 门禁，不通过不进入下一阶段 |

任务编号与已有文档对齐：P0-xx、P1-xx、P2-xx、P3-xx、P4-xx、P5-xx、UI-xx、X-xx。

**P2–P5 领域设计已完成**（知识空间、工程契约、证据与质量、能力路由）；
下表中的任务状态仍表示「实现待做」，不代表代码已存在。

并行与集成：P2 与 P3 可在 P1.1 后并行开发，但按 AGENTS 第 5 条**串行集成**；
UI 可以晚于 P5，也可以从 P1-10 之后增量做，但不阻塞引擎。

---

## 1. 依赖图

```text
P0 契约/开关/审计
   │
   ├─► P0-01 审计评审 ──┐
   └─► P0-02..06 契约 ──┤
                        ▼
                    P0-E 冻结 🔒
                        │
                        ▼
P1.0 引擎骨架（State/Planner/Scheduler/Runner/Deliver/Shadow）
                        │
                        ▼
P1.1 Replan / Debate / 模型审核
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
      P2 知识         P3 工程         P4 证据/质量
        │               │               │
        └───────────────┼───────────────┘
                        ▼
                    P5 通道/模型
                        │
                        ▼
                    UI 改造
                        │
                        ▼
                    V3 发布
```

---

## 2. 阶段门禁

| 门禁 | 条件 |
| --- | --- |
| P0-E | P1-001 评审通过；P0-02..06 类型/状态机评审通过；无重复契约；基线一致 |
| P1.0 | 简单问题 1–2 任务；高风险 ≥2 参与者；跳过有原因；legacy 无回归 |
| P1.1 | Replanner 有护栏；Debate 按需；模型审核可关闭/回退 |
| P2 | 第二次研究复用旧结论并标时效 |
| P3 | 一次真实改动全链路通过，可复验、可回退 |
| P4 | 跨空间 EvidenceRef 统一；40 场景受控集通过 |
| P5 | 新增通道只加 Adapter + 能力声明 |
| V3 | 产品/协作/工程/知识/安全判据全部满足 |

---

## 3. 任务总表

| ID | 任务 | 阶段 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| P0-01 | 迁移审计与评审 | P0 | — | 🟡 待评审 |
| P0-02 | Domain 类型冻结 | P0 | P0-01 | ✅ |
| P0-03 | 事件契约 | P0 | P0-02 | ✅ |
| P0-04 | Feature Flag | P0 | P0-02 | ⏳ |
| P0-05 | 持久化/恢复契约 | P0 | P0-02 | ✅ |
| P0-06 | 回滚演练设计 | P0 | P0-04 | ⏳ |
| P1-00 | CollaborationState 存储与转移 | P1.0 | P0-02 | ⏳ |
| P1-01 | ParticipantManager | P1.0 | P0-02 | ⏳ |
| P1-02 | Planner MVP | P1.0 | P1-01 | ⏳ |
| P1-03 | Scheduler | P1.0 | P1-02 | ⏳ |
| P1-04 | Runner / Attempt / Observation | P1.0 | P1-03 | ⏳ |
| P1-05 | Deliver | P1.0 | P1-04 | ⏳ |
| P1-06 | 网页边界 | P1.0 | P1-04 | ⏳ |
| P1-07 | 行为：Independent/Parallel/Progressive/CrossCheck | P1.0 | P1-04 | ⏳ |
| P1-08 | Shadow plan-only | P1.0 | P1-02..04 | ⏳ |
| P1-09 | ConversationRunner 路由（legacy/shadow） | P1.0 | P1-08 | ⏳ |
| P1-10 | 日志与调试可观察 | P1.0 | P1-04 | ⏳ |
| P1-11 | Replanner | P1.1 | P1.0 | ⏳ |
| P1-12 | DebateBehavior 适配 | P1.1 | P1-11 | ⏳ |
| P1-13 | 关键阶段模型审核 | P1.1 | P1-11 | ⏳ |
| P1-14 | Active 门禁与回滚 | P1.1 | P1-08..13 | ⏳ |
| P1-15 | 测试迁移与回归 | P1.0/1.1 | 各任务 | ⏳ |
| P2-01 | 知识卡/主题存储 | P2 | P1.0 | ⏳ |
| P2-02 | 索引与召回 | P2 | P2-01 | ⏳ |
| P2-03 | 时效与复用 | P2 | P2-02 | ⏳ |
| P2-04 | 缺口驱动研究 | P2 | P2-03 | ⏳ |
| P2-05 | 知识地图 | P2 | P2-03 | ⏳ |
| P2-06 | 知识场景验收 | P2 | P2-01..05 | ⏳ |
| P3-01 | EngineeringContext / 任务状态 | P3 | P1.0 | ⏳ |
| P3-02 | Agentic Search 工具 | P3 | P3-01 | ⏳ |
| P3-03 | 计划/审批/worktree | P3 | P3-01 | ⏳ |
| P3-04 | 执行与 attestation | P3 | P3-03 | ⏳ |
| P3-05 | 独立评审 | P3 | P3-04 | ⏳ |
| P3-06 | CLI Executor | P3 | P3-03 | ⏳ |
| P3-07 | 快照/回退 | P3 | P3-04 | ⏳ |
| P3-08 | Java 轻量能力 | P3 | P3-02 | ⏳ |
| P3-09 | 工程闭环验收 | P3 | P3-01..08 | ⏳ |
| P4-01 | Pack → EvidenceRef 映射 | P4 | P1-02 | ⏳ |
| P4-02 | 验证计划 | P4 | P4-01 | ⏳ |
| P4-03 | 质量指标 | P4 | P4-02 | ⏳ |
| P4-04 | 测试夹具 | P4 | P4-01 | ⏳ |
| P4-05 | 40 场景矩阵 | P4 | P4-04 | ⏳ |
| P4-06 | CI 门禁 | P4 | P4-05 | ⏳ |
| P4-07 | 回放与篡改检测 | P4 | P4-01 | ⏳ |
| P5-01 | 能力注册表 | P5 | P1.0 | ⏳ |
| P5-02 | 路由与降级 | P5 | P5-01 | ⏳ |
| P5-03 | 新通道模板 | P5 | P5-02 | ⏳ |
| P5-04 | 费用/延迟观测 | P5 | P5-02 | ⏳ |
| P5-05 | 发布矩阵 | P5 | P5-01..04 | ⏳ |
| UI-01 | 计划/任务视图 | UI | P1-10 | ⏳ |
| UI-02 | 参与者/跳过原因 | UI | P1-01 | ⏳ |
| UI-03 | 停止原因 | UI | P1-05 | ⏳ |
| UI-04 | 证据展开 | UI | P4-01 | ⏳ |
| UI-05 | 工程任务视图 | UI | P3-03 | ⏳ |
| UI-06 | 移除辩论入口 | UI | P1-12 | ⏳ |
| UI-07 | 知识卡/地图 | UI | P2-05 | ⏳ |
| X-01 | 文档/索引同步 | 跨阶段 | 各阶段 | ⏳ |
| X-02 | 测试基线工具 | 跨阶段 | P1-00 | ⏳ |
| X-03 | 旧路径删除 | 跨阶段 | P1-14 | ⏳ |
| X-04 | V3 发布清单 | 跨阶段 | P5-05 | ⏳ |

---

## 4. P0 任务详设

### P0-01 迁移审计与评审

- 目标：确认现有代码的回路、状态、Runtime、Planner、Debate 与工程能力。
- 产物：`P1-001-MIGRATION-AUDIT.md`；评审记录。
- 验收：18 节齐全；关键结论有 `文件:行`；评审人签字（不能自评）。
- 回滚：纯文档。
- 风险：把「已提交」当成「已通过」。

### P0-02 Domain 类型冻结

- 目标：`Goal / Policy / TaskEnvelope / TaskSpec / TaskRuntimeState / Attempt / Plan /
  Assignment / Observation / EvidenceRef / Claim / Conflict / Dispute / CollaborationState`。
- 文件：`src/main/collaboration/domain/*`（只类型 + 纯函数）。
- 验收：typecheck；序列化往返；旧记录缺字段可读；无行为变化。
- 回滚：删除新增文件。
- 风险：类型里再次塞入运行状态（必须拆 TaskSpec / TaskRuntimeState）。

### P0-03 事件契约

- 目标：`goal.started / plan.created / task.assigned / task.started /
  observation.recorded / conflict.detected / dispute.opened / verification.recorded /
  goal.stopped / deliverable.ready / collaboration.mode.changed`。
- 文件：`shared/conversation.ts`（增量）。
- 验收：事件枚举、载荷测试；不新建事件总线。
- 回滚：删除新增事件。

### P0-04 Feature Flag

- 目标：`legacy | shadow | active`，默认 legacy。
- 文件：`src/main/collaboration/mode.ts` + settings store。
- 验收：默认值、非法值、持久化、切换事件；shadow 零模型调用。
- 回滚：删 flag，行为回 legacy。

### P0-05 持久化 / 恢复契约

- 目标：`CollaborationState` 作为 `Conversation` 可选字段；`running → failed(interrupted)`；
  不重放写操作。
- 文件：`store.ts` 增量。
- 验收：旧记录可读；中断恢复；事件 seq 单调。
- 回滚：旧代码忽略新字段。

### P0-06 回滚演练设计

- 目标：flag 关闭、旧数据读取、未知字段忽略、双版本并存。
- 验收：演练步骤与结果记录；出问题可回 legacy。
- 风险：只设计不演练，等于没有。

---

## 5. P1 任务详设

### P1-00 CollaborationState 存储与转移

- 目标：单一状态；纯函数转移；落盘复用 `AgentStore`。
- 文件：`collaboration/domain/state.ts`、`collaboration/state-store.ts`。
- 步骤：定义事件 → 转移函数 → 写盘 → 恢复。
- 验收：状态机测试（pending/assigned/running/retrying/done/failed/skipped/blocked/cancelled）。
- 回滚：flag legacy；状态字段不读。
- 风险：Planner/Runner 各存一份。

### P1-01 ParticipantManager

- 目标：按名单问人；可用性/健康/失败记录；不再默认全通道。
- 文件：`collaboration/participants/manager.ts`（从 `master-agent.ts` 抽）。
- 验收：1 个参与者可跑；跳过有原因；单通道失败不影响同批。
- 回滚：legacy 走 `MasterAgent`。

### P1-02 Planner MVP

- 目标：规则版 DAG；`Policy`（modelScope/includeWeb）；参与者数量与理由；
  简单问题 1–2 任务。
- 文件：`collaboration/planner/planner.ts`。
- 验收：越界计划拒绝；高风险 ≥2；计划含 stopWhen；无固定阶段链。
- 回滚：shadow 只算计划。
- 风险：规则退化成固定 Pipeline。

### P1-03 Scheduler

- 目标：校验范围 → 能力过滤 → 依赖/并发/超时/取消。
- 文件：`collaboration/scheduler/scheduler.ts`。
- 验收：依赖顺序、网页串行、单任务不并发、取消停止派发。
- 回滚：legacy。

### P1-04 Runner / Attempt / Observation

- 目标：执行任务；每次尝试一个 `Attempt`；Observation 对应 Attempt；失败也是结果。
- 文件：`collaboration/runner/*`。
- 验收：状态机测试；只读重试 ≤2；写操作不重试；取消产生 cancelled Observation。
- 回滚：legacy。
- 风险：failed → running 被偷偷加回来。

### P1-05 Deliver

- 目标：按 acceptance 组装；未核验显式标记；带 stopReason 与缺口。
- 文件：`collaboration/deliver/*`。
- 验收：交付字段完整；无证据结论标断言。
- 回滚：legacy 综合。

### P1-06 网页边界

- 目标：第一手只收原话；后续只附数据块，不含指令。
- 文件：`adapters/*` 增量。
- 验收：无「请指出」「说明是否修改」等词；跳过有原因。
- 回滚：网页通道暂停。

### P1-07 行为 MVP

- 目标：Independent / Parallel / Progressive / CrossCheck；行为只决定协作方式，不决定选人。
- 文件：`collaboration/behaviors/*`。
- 验收：无争议不 Debate；简单问题不 CrossCheck；行为停止条件可读。
- 回滚：只留 Independent。

### P1-08 Shadow plan-only

- 目标：旧路径回答；Planner 只算计划；零模型调用、零任务执行。
- 文件：`engine.ts` 分支。
- 验收：计划文件生成；用户结果不变；无模型调用。
- 回滚：flag legacy。

### P1-09 ConversationRunner 路由

- 目标：按 mode 分叉；legacy 原样；shadow 只调 Planner。
- 文件：`conversation-runner.ts` 增量。
- 验收：三模式切换；legacy 回归；取消/预算不变。
- 回滚：删分支。
- 风险：把决策又写回 runner。

### P1-10 日志与调试可观察

- 目标：计划、参与者、跳过、停止原因写入日志/调试文件；不做 UI 改版。
- 文件：`engine.ts`、`out-test/collaboration/*`。
- 验收：能从日志回答「谁在做什么、为什么停」。
- 回滚：删日志。

### P1-11 Replanner（P1.1）

- 目标：按 acceptance 缺口、未决 Dispute、无新增信息决定继续/停；最多 2 次。
- 文件：`collaboration/adapt/replanner.ts`。
- 验收：缺口驱动；无新增即停；护栏；新旧 Plan 版本。
- 回滚：关闭 replan，回到单 Plan。

### P1-12 DebateBehavior（P1.1）

- 目标：仅 `matters && open` 的 Dispute 调 Debate；输出 Verdict/Evidence；不建基线、不收提示词。
- 文件：`collaboration/behaviors/debate.ts`。
- 验收：无争议不触发；无 repository 基线；输出映射。
- 回滚：关闭 Debate。

### P1-13 模型审核（P1.1）

- 目标：计划后/重规划前/辩论前，模型审核；输入数据 + schema；默认关闭。
- 文件：`collaboration/reviewer.ts`。
- 验收：不合法输出回退规则；预算上限；审核记录可追溯。
- 回滚：关闭 reviewer。

### P1-14 Active 门禁

- 目标：shadow 达标后切 active；保留回滚。
- 验收：20 个真实问题计划覆盖 ≥90%；简单问题 ≤2 任务；回滚演练。
- 风险：未达标就切。

### P1-15 测试迁移与回归

- 目标：现有测试迁移；新增调度/状态/边界测试；legacy 全绿。
- 验收：typecheck；受影响测试全绿；无 flaky。

---

## 6. P2 知识学习任务

### P2-01 知识卡/主题存储

- 目标：一卡一结论；主题/别名；原子写；`status`。
- 文件：`src/main/knowledge/store.ts`。
- 验收：原子写、加载、旧数据兼容。
- 风险：把长报告塞进一张卡。

### P2-02 索引与召回

- 目标：主题/Claim/证据召回；不做向量库；结果带 asOf/status。
- 文件：`knowledge/index.ts`。
- 验收：召回可解释；跨主题不串。
- 风险：只按相似度排序。

### P2-03 时效与复用

- 目标：fresh/stale/refuted；版本/时间；旧卡不被静默覆盖。
- 文件：`knowledge/freshness.ts`。
- 验收：三态可追溯；复用标时效。
- 回滚：关闭复用，只读历史。

### P2-04 缺口驱动研究

- 目标：复用 Replanner；缺口变任务；无新增即停。
- 验收：输出已确认/争议/未回答。
- 风险：无限补研究。

### P2-05 知识地图

- 目标：三块 + 出处；每一条能点到证据。
- 验收：无「来源：无」。
- 回滚：只出列表。

### P2-06 知识场景验收

- 目标：首次研究、二次复用、过期、被推翻、多主题、无来源。
- 验收：6 个场景通过。

---

## 7. P3 工程空间任务

### P3-01 EngineeringContext / 任务状态

- 目标：S1/S2、commit、dirty、diff、tests、build、review；挂 `Task.context`。
- 文件：`engineering/task-state.ts`。
- 验收：缺失快照不能 done；不叫基线。
- 回滚：旧任务无 context。

### P3-02 Agentic Search

- 目标：search/find/tree/read/symbol/LSP/git 按需；不预建全图。
- 文件：`engineering/*`、`code-index/*` 增量。
- 验收：结论带 `路径:行号`；降级说明。
- 风险：启动即全仓扫描。

### P3-03 计划/审批/worktree

- 目标：计划含影响面/测试/回退；审批复用 AgentOrchestrator；worktree 隔离。
- 验收：只读不写；写必审批；并发不共享目录。
- 回滚：旧执行入口。

### P3-04 执行与 attestation

- 目标：`test.run` → `ExecutionReport` → attestation → EvidenceRef。
- 验收：篡改被发现；未跑标未验证。
- 回滚：只读模式。

### P3-05 独立评审

- 目标：评审者不参与实现；意见回计划。
- 验收：阻断项可见；评审记录。
- 风险：评审者与实现者同一模型。

### P3-06 CLI Executor

- 目标：走 `agent.exec` + TaskGrant + worktree；不复用只读回答源。
- 验收：权限/失败/超时记录。
- 回滚：禁用 CLI Executor。

### P3-07 快照/回退

- 目标：S1/S2、diff、回滚；失败可回 S1。
- 验收：回退后重跑受影响测试。
- 风险：永久删除当回退。

### P3-08 Java 轻量能力

- 目标：文本搜索 + 轻量结构 + 可选 LSP/JDT；不做完整语义引擎。
- 验收：Java 8/11/17/21 源码阅读；降级说明。
- 风险：把 JDT 引入核心。

### P3-09 工程闭环验收

- 目标：理解 → 计划 → 审批 → 执行 → 验证 → 评审 全链路。
- 验收：一次真实小仓库改动；可复验、可回退。

---

## 8. P4 证据与质量任务

### P4-01 Pack → EvidenceRef 映射

- 目标：8 类 Pack → 5 类 EvidenceRef；哈希统一；旧 Pack 可读。
- 验收：映射测试；无第二套存储。
- 回滚：旧映射只读。

### P4-02 验证计划

- 目标：Claim → 代码/执行/来源/交叉；四态 Verdict。
- 验收：unverified 保留；judge 复用。
- 风险：把「再问一个模型」当验证。

### P4-03 质量指标

- 目标：Completion / Evidence / Verification / Honesty / Efficiency / Replan / Engineering。
- 验收：公式、采样、阈值；门禁可回归。
- 风险：指标只算不拦。

### P4-04 测试夹具

- 目标：5 个仓库 fixture（Java/TS/Node/Maven/Gradle）；网页文本 fixture；假 CLI。
- 验收：可复制、不污染仓库。
- 风险：live 测试依赖登录。

### P4-05 40 场景矩阵

- 目标：10 General + 10 Knowledge + 20 Engineering。
- 验收：受控集全过；live 跳过有原因。
- 风险：场景变成脚本堆。

### P4-06 CI 门禁

- 目标：unit/integration 每次；live 发布前；性能预算。
- 验收：失败阻断合并。
- 回滚：门禁可临时跳过（记录原因）。

### P4-07 回放与篡改检测

- 目标：同 commit/证据/哈希复验一致；篡改字段被定位。
- 验收：回放测试；篡改测试。

---

## 9. P5 模型与通道任务

### P5-01 能力注册表

- 目标：`CapabilityId`、Participant、能力声明；网页/本地/远端/CLI。
- 验收：能力声明与调度一致。
- 风险：能力声明与实现不符。

### P5-02 路由与降级

- 目标：先范围后能力；四级降级；不越界。
- 验收：local 不降 remote；跳过有原因。
- 回滚：固定名单。

### P5-03 新通道模板

- 目标：新增只加 Adapter + 能力声明 + 配置。
- 验收：mock 通道跑通；主流程零改动。
- 风险：在 Adapter 里夹带提示词。

### P5-04 费用/延迟观测

- 目标：按通道记录；网页无 token 单独说明。
- 验收：可读、可汇总。
- 风险：把网页延迟当模型延迟。

### P5-05 发布矩阵

- 目标：Web/Local/Cloud/CLI 组合的发布验证矩阵。
- 验收：受控组合通过；降级路径覆盖。

---

## 10. UI 任务

### UI-01 计划/任务视图

- 目标：计划摘要、任务状态、依赖、停止原因。
- 验收：能解释一个问答与一个多任务研究为什么停。

### UI-02 参与者/跳过原因

- 目标：显示选中与被跳过；高风险单点提示。
- 验收：不出现无理由减员。

### UI-03 停止原因

- 目标：acceptance/no-info/budget/cancel 可读。
- 验收：与 State 一致。

### UI-04 证据展开

- 目标：结论 → 证据 → 来源/版本/哈希。
- 验收：四态清晰；无证据标断言。

### UI-05 工程任务视图

- 目标：文件、路径:行号、计划、审批、diff、测试、回退。
- 验收：全链路可见。

### UI-06 移除辩论入口

- 目标：删除模式/策略入口；旧数据可读。
- 验收：无入口；旧会话不崩。

### UI-07 知识卡/地图

- 目标：卡片、时效、三块地图。
- 验收：每块可点通。

---

## 11. 跨阶段任务

### X-01 文档/索引同步

- 每任务完成更新 `docs/implementation/README` 与 CHANGELOG；契约只改 P1-002。

### X-02 测试基线工具

- 统一 `build:test`、日志、fixture 路径；避免旧 out-test 误判。

### X-03 旧路径删除

- 条件：active 连续 2 个真实任务/7 天；测试迁移；无回滚需求；删除清单逐项列。
- 顺序：MasterAgent → collaboration/strategy 旧 stage → debate 入口 → buildInitialPrompt（P3）。

### X-04 V3 发布清单

- 产品：无需选择协作模式；三空间可用；Debate 非入口。
- 协作：DAG、重规划、并行/递进、失败记录、停止原因。
- 证据：五类 EvidenceRef；可追溯。
- 工程：一次真实闭环。
- 知识：二次复用 + 时效。
- 安全：审批、Runtime、worktree、白名单、哈希、不自动 push。

---

## 12. 任务模板（Definition of Done）

每个任务提交前必须回答：

1. 输入/输出是什么？对应哪个契约对象？
2. 写哪个存储？是否出现第二份状态？
3. 错误、取消、重试、预算怎么处理？
4. 哪些测试新增/迁移？typecheck 是否通过？
5. 开关/回滚是什么？
6. 是否引入提示词、基线、第二套 Runtime？
7. 文档/索引是否同步？

---

## 13. 风险总表

| 风险 | 任务 | 对策 |
| --- | --- | --- |
| 第二套状态 | P1-00 | 单一 CollaborationState + 纯转移 |
| 固定 Pipeline | P1-02/P1-07 | 简单问题 1–2 任务；行为按需 |
| 网页被塞指令 | P1-06 | 数据块 + 边界测试 |
| 写操作重试 | P1-04 | Attempt 模型；写失败终态 |
| 证据两套 | P4-01 | 只加映射，不建存储 |
| Planner 越权 | P1-02/P1-13 | 规则校验；模型只出候选 |
| 旧路径删早 | X-03 | 删除条件 |
| UI 先改后废 | UI-01..07 | P1 只日志，UI 后置 |
