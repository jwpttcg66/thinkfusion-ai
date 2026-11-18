# 迁移计划

状态：**方向确认（2026-11-18）；P0 技术门禁未全部通过；未实施。**
目标：把现有以辩论为主线的实现，迁移到
[协作架构 V1](COLLABORATION_ARCHITECTURE.md) 与
[工程工作空间 V1](ENGINEERING_WORKSPACE.md)，**不重写、不新建第二套基础设施**。

定位见 [PRODUCT.md](../PRODUCT.md)。

---

## 1. 原则

1. **先搬职责，再删代码。** 设计阶段不改生产代码；每个阶段都可以独立回滚。
2. **辩论不删除，降级。** 保留 `debate/`、`judge/`、`argument-graph` 作为按需能力。
3. **不新建第二套** Runtime、审批、Journal、TaskGrant、Verifier、证据格式。
4. **网页通道的边界不突破。** 不发 system、不发工具协议、不改用户原话。
6. **不使用任务提示词、不冻结流程基线。** `prompts.ts` 删除；辩论开场不再创建仓库基线；
   仓库快照改由工程任务持有（允许保留快照能力，但不叫流程基线）。
5. **每一步都有验收与回滚点。** 没有可观察判据的迁移不算完成。

---

## 2. 现状盘点

| 模块 | 现在是什么 | 目标职责 | 处置 |
| --- | --- | --- | --- |
| `debate/orchestrator.ts`（955 行） | 辩论主流程：开场、分轮、证据包、裁判 | 一种可选协作行为 | **降级 + 拆职责** |
| `debate/prompts.ts` | 固定辩论提示词与阶段次序 | —— | **已删除**（P0 同步，硬规则：不使用任务提示词） |
| `debate/strategies.ts` | 固定辩论策略 | 仅辩论行为内部使用 | 保留，但不再生成文本指令 |
| `debate/revision.ts` / `claims.ts` | 修订与主张 | 辩论行为内部 | 保留 |
| `judge/` | 三维裁判、方向判断 | 可选验证能力 | 保留 |
| `debate/argument-graph.ts` | 论证关系图 | 可选论证能力 | 保留 |
| `debate/eval.ts` / `metrics.ts` / `quality.ts` | 质量与回归 | 辩论质量与回归 | 保留 |
| `evidence-pack/` | 冻结证据包、哈希、attestation | 统一证据层 | **保留，解除辩论绑定** |
| `evidence-pack/baseline.ts` | 辩论开场冻结仓库基线 | 仓库快照（任务自持） | **改为 `repository-snapshot.ts`，辩论不再调用** |
| `master-agent.ts` | 第一手并发提问 + 规则综合 | 参与者管理器 | 保留，扩展 |
| `collaboration/strategy.ts` | 并行 / 递进 / smart 计划 | 调度器雏形 | 升级为任务图 |
| `collaboration/runner.ts` | 按计划执行、逐任务记录 | 执行与观察层 | 保留，扩展 |
| `conversation-runner.ts`（3227 行） | 对话入口与全链路 | 入口，逐步接入协作引擎 | 保留，增量改造 |
| `orchestrator.ts`（793 行） | 执行审批与治理 | 执行治理 | 保留 |
| `code-index/` | 索引与检索 | 工程事实 | 保留，轻量化 |
| `engineering/` | 读盘、分析、评审 | 工程空间能力 | 保留 |
| `cli-agents.ts` | Qoder / Claude 调用 | CLI Agent 参与者 | 保留，补能力描述 |
| `coding/team.ts` | 多 Agent 编码 | 工程协作 | 保留，接入调度 |
| UI 的辩论入口 | 用户可选辩论模式 | 内部行为 | 移除入口 |

---

## 3. 目标模块图

```
ConversationRunner / TaskEntry
        │
        ▼
CollaborationEngine  ──────────────┐
  ├─ Planner（任务图、停止条件）      │
  ├─ Scheduler（能力匹配、并发）      │
  ├─ Behaviors                      │
  │   ├─ independent / progressive  │
  │   ├─ cross-check / counter      │
  │   ├─ debate（按需，调 debate/）  │
  │   └─ engineering（读/改/测/评）   │
  ├─ Verifier（judge/、execution）   │
  └─ Synthesizer（交付物模板）        │
        │                            │
        ▼                            ▼
EvidenceService  ◄──────────  EngineeringTaskState
（evidence-pack + 统一引用）      （commit / snapshot / diff / tests）
```

---

## 4. Debate 的具体迁移

### 4.1 移出「开场自动基线」

**已完成（P0 同步）**：`DebateOrchestrator.start()` 不再创建仓库基线 Pack，
`attachRepositoryBaseline()` 改为 `attachRepositoryContext()`，只解析 commit / branch / dirty
作为任务上下文；`baseline.ts` 改名为 `repository-snapshot.ts`，`publishRepositorySnapshot()`
由工程任务按需调用。

目标：

- 仓库状态由**工程任务**持有，辩论只读；
- 辩论若需要代码证据，向工程任务或证据层**申请引用**，不自己冻结一份；
- 快照 Pack 只在工程任务需要时创建，不成为任何流程的前提。

### 4.2 移出「固定提示词次序」

- `prompts.ts` **已删除**；辩论与工程任务都不再接收 role / stage / format / challenge 文案；
- 工程任务不套用「独立分析 → 质疑 → 修订 → 裁判」；
- 通用 Agent 约束保留：任务上下文、工具说明、权限、输出契约、停止条件、证据要求——
  它们以机器可读契约存在，不写成话术。

### 4.3 移除产品入口

- 用户不再选择「辩论 / 评审 / 研究」模式；
- 辩论由引擎在检测到**成对且未定论的争议**时调用；
- 保留手动触发的调试入口，但不作为主流程。

### 4.4 保留的部分

- `judge/` 作为验证能力；
- `argument-graph.ts` 作为论证结构存储；
- `claims.ts` / `revision.ts` / `evidence.ts` 作为辩论行为内部实现；
- 质量与回归脚本继续跑。

---

## 5. Evidence 的具体迁移

| 现有 | 目标 | 动作 |
| --- | --- | --- |
| `EvidencePack` 条目 | 统一证据引用 | 保留结构；补可选 `scope`（goal / task） |
| `repository-snapshot.ts`（原 `baseline.ts`） | 工程任务状态 | 已迁出辩论，由工程任务按需调用 |
| `round-evidence.ts` | 辩论轮证据（依赖开场基线） | **已移除**，待 P4 按新证据层重建 |
| `execution-producer.ts` | 执行证据 | 保留，接入工程任务与验证 |
| `mapping.ts` | Pack → 辩论证据 | 保留，改为通用引用适配 |
| `hash.ts` | 内容哈希 | 不动，作为统一哈希实现 |

**不新建 EvidenceStore。** 在 `evidence-pack/` 上扩展 `EvidenceRef` 适配层；
两种形态共享同一份内容哈希与快照能力。

---

## 6. 分阶段迁移

### P0 产品与协作架构重构（设计冻结 + 硬规则同步）

- 交付：PRODUCT V3、协作架构 V1、工程空间 V1、本迁移计划、ROADMAP 重排。
- 硬规则同步（2026-11-18 已执行）：AGENTS 第 6 节；删除 `debate/prompts.ts`；
  `baseline.ts` 改为 `repository-snapshot.ts`，辩论开场不再创建基线；
  移除 `round-evidence` 接线；辩论与工程任务不再接收任务提示词。
- 剩余改动：类型草案与 feature flag；协作调度行为不变。
- 验收：文档评审通过；typecheck 与受影响测试全绿（275/275）；新旧定位的冲突点全部列出。
- 回滚：文档与规则回滚；代码回滚以本次提交为界，不涉及数据迁移。

### P1 多模型协作能力

- 用 `collaboration/strategy.ts` 升级出任务图调度器 MVP：独立、并行、递进、交叉验证。
- 计划可视化：参与者、分工、依赖、停止条件可读。
- 辩论保持可选，默认不启动；参与者由 Planner 决定（AGENTS 第 2 条）。
- 验收：同一组问题在旧路径与新调度器下质量不降；计划可解释；单点失败不影响同批。
- 回滚：feature flag 切回 `MasterAgent` 老路径。

### P2 知识学习空间

- 主题、结论、证据、知识卡落库与索引；复用带时效；缺口驱动研究。
- 验收：同主题第二次研究能复用旧结论并标时效；旧结论被推翻可追溯。
- 回滚：索引只读，关闭后回到单会话。

### P3 工程工作空间

- 工程任务状态（commit / snapshot / diff / tests）落地。
- Agentic Search、CLI Agent 参与、worktree 隔离、执行断言。
- 辩论在工程中只在方案评审或争议时按需触发。
- 验收：一次真实改动能走完理解 → 计划 → 审批 → 执行 → 验证 → 评审，且证据可复验。
- 回滚：工程链路保持旧命令入口，新链路可关闭。

### P4 证据与质量体系

- 统一 `EvidenceRef`、验证计划、未核验标记、质量门槛。
- 验收：跨空间引用同一套哈希与来源；「凭什么」可走通；质量门禁可回归。
- 回滚：适配层可关，旧 Pack 继续可读。

### P5 模型与通道扩展

- Web / Local / Cloud / Hybrid / CLI 统一能力描述；新增通道不改主流程。
- 验收：新增一个来源只加 Adapter 与能力描述；网页通道仍只收原话。
- 回滚：能力描述可降级为旧配置。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 「改名式重构」：只把 DebateOrchestrator 改名 | 架构没变，债务更深 | 以职责迁移与验收判据为准，不以重命名为交付 |
| 调度器过度设计 | 简单问题变慢 | 默认路径保持轻量；复杂任务才升级计划 |
| 网页通道被塞结构化上下文 | 取回答失败、回显污染 | 能力描述 + 只发原话；结构化只在汇总侧 |
| 证据层两套并存 | 哈希与快照不一致 | 复用 `hash.ts` 与 `evidence-pack`，只加适配层 |
| 迁移期间双路径分叉 | 行为不一致 | feature flag + 对照回归；一个阶段只切换一个面 |
| 知识层变成向量库 | 召回多、可信度低 | Claim 关系与时效优先，向量只做召回 |

---

## 8. 验收口径

1. **可回滚**：每个阶段都有开关或分支点，失败能切回旧路径。
2. **可观察**：计划、参与者、跳过原因、证据与未核验项都能在界面上看见。
3. **不降质**：P1 之后，原有多通道问答与辩论质量不下降；回归脚本继续跑。
4. **不重复**：没有第二个 Runtime、审批、Journal、TaskGrant、Verifier。
5. **守边界**：网页通道只收原话；写入必须审批；推送仍由用户执行。

---

## 9. 明确不做

- 不做一次性大重写；
- 不删除辩论、裁判与论证图；
- 不在迁移中顺手改安全模型；
- 不为了「统一」让所有模型走同一套协议；
- 不在 P0-J 通过前动生产代码。
