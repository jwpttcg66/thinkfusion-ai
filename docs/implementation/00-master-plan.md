# 实施总计划 V1.1

状态：**实施基线**（2026-11-18）。
设计基线：`product-v3`（设计分支）；代码基线：`cd30be3`（P1-001 审计时；此后仅文档变化）。
依据：[PRODUCT V3](../PRODUCT.md)、[协作架构 V1](../architecture/COLLABORATION_ARCHITECTURE.md)、
[工程空间 V1](../architecture/ENGINEERING_WORKSPACE.md)、[迁移计划](../architecture/MIGRATION_PLAN.md)、
[路线](../ROADMAP.md)，以及 2026-11-18 的计划审核意见。

范围：从当前代码（仍以 `MasterAgent` + `collaboration/` 雏形为主）迁移到 V3 发布。

---

## 1. 唯一阶段表

本计划**只使用仓库已冻结的 P0–P5**，不再另起 P6–P12。提案里的细分阶段一律映射为里程碑。

| 阶段 | 主题 | 出口判据（摘要） | 状态 |
| --- | --- | --- | --- |
| **P0** | 契约与开关 | 契约冻结、迁移矩阵、flag 默认 legacy、无行为变化 | 进行中 |
| **P1** | 统一协作引擎 | P1.0：任务图 + 观测 + 交付可跑；P1.1：重规划与辩论适配；shadow 达标后切 active | 未开始 |
| **P2** | 知识学习空间 | 第二次研究复用旧结论并标时效 | 未开始 |
| **P3** | 工程工作空间 | 一次真实改动全链路通过、可复验、可回退 | 未开始 |
| **P4** | 证据与质量 | 跨空间同一套证据引用；门槛可回归 | 未开始 |
| **P5** | 模型与通道 | 新增通道只加 Adapter 与能力描述 | 未开始 |

> P4 在 P2/P3 之后，但 **EvidenceRef 契约在 P0 就冻结**，P2/P3 直接引用，不各造一套。

---

## 2. 与提案 P0–P12 的映射

| 提案阶段 | 本计划位置 | 说明 |
| --- | --- | --- |
| P0 契约 / Flag | **P0** M0.1–M0.5 | 审计、契约、flag、事件、回滚演练 |
| P1 CollaborationEngine | **P1.0** M1.0–M1.5 | Goal / State / Planner / Scheduler / Runner / Deliver；含参与者数量决策与 plan-only shadow |
| P2 AgentCapabilities | **P1** M1.6 + **P5** M5.1 | 能力模型在 P1 先够用，P5 再扩展 |
| P3 DAG / Replan | **P1.0** M1.2–M1.4（DAG）/ **P1.1** M1.6（Replan） | 真做出来先不自动重规划 |
| P4 Debate 降级 | **P1.1** M1.9 | Adapter + 触发规则；入口移除可随 UI 后置 |
| P5 Evidence 统一 | **P4** M4.1–M4.3（契约在 P0） | 映射与验证在 P4，契约不后移 |
| P6 Knowledge | **P2** | — |
| P7 Engineering | **P3** M3.1–M3.6 | — |
| P8 CLI Agents | **P3** M3.6（执行者）+ **P5** M5.2（通道） | 只读参与者与写执行者分开 |
| P9 Verification | **P4** M4.2 | — |
| P10 UI | **P3/P4 之后** | P1 只写事件日志，不做产品 UI 改版 |
| P11 Quality | **P4** M4.4 | — |

---

## 3. 四条纪律（违反即停）

1. **先搬职责，再删代码。** 旧路径（legacy）在 active 验证通过前必须保持可用。
2. **不新建第二套** Runtime、审批、Journal、TaskGrant、Verifier、Evidence 存储。
3. **不把动态协作做成新的固定 Pipeline。** 如果每个任务都必须走同一组阶段，
   那只是把辩论换了个名字。
4. **单一运行时状态。** Goal / Task / Assignment / Observation / Evidence / Budget /
   StopReason / Deliverable 只存在一份 `CollaborationState` 里；Planner、Scheduler、
   Runner、Replanner 只能通过状态转移读写，不各自维护私有状态。

补充：`AGENTS.md` 第 6 节是硬约束——不使用任务提示词，不冻结流程基线。
任务上下文只能以「数据 + 机器契约」的形式出现。

---

## 4. Feature Flag

```ts
type CollaborationMode = 'legacy' | 'shadow' | 'active';
```

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `legacy` | 完全走现有 `MasterAgent` 路径 | 默认值，回滚目标 |
| `shadow` | 旧路径照常执行；新 Planner 只计算计划，不调用模型、不执行任务 | 计划质量与结构对比 |
| `active` | 新引擎执行；旧路径作为回退开关保留 | 正式路径 |

规则：

- 默认 `legacy`；切换只能由用户在设置页或调试开关发起。
- flag 存在 main 进程既有 settings store（`userData/*.json`），不新建配置系统。
- flag 变更必须写一条事件（`collaboration.mode.changed`），并记录旧值/新值/操作者。
- `shadow` **禁止**调用付费模型；需要模型才能算的计划，只记录「无法 shadow」。
- 每次启动打印当前模式与配置来源（日志），便于排查。

### 4.1 Shadow：只做 plan-only

| 阶段 | 行为 | 目的 |
| --- | --- | --- |
| P1.0 | 旧路径执行；新 Planner 只算计划，零模型调用、零任务执行 | 比较计划结构、任务数、参与者选择 |

**不做双跑。** 2026-11-18 裁决：暂不引入第二份真实调用成本。需要对照真实结果时，
先用录制回放（fixture）验证；回放也不做，就只看 plan-only。

### 4.2 参与者数量由任务决定

2026-11-18 裁决：`AGENTS.md` 第 2 条已修改。Planner 可以判断「这个问题只需要几个 Agent」，
但先受调用范围约束：

- 本地只调本地模型，远端只调远端模型；只有混合可同时使用两者；
- 网页是渠道不是模型；是否参与由任务决定，不因混合自动加入；
- 简单事实/单点核对可以 1 个；
- 有争议、高风险、用户要求多视角时至少 2 个；
- 选择理由与被跳过的通道必须可见；
- 不得以省成本为唯一理由静默少问。

### 4.3 关键阶段的模型审核

允许在三个节点引入模型：计划生成后、重规划决策前、辩论触发前。

- 输入是结构化数据（计划 / 观察 / 争议）+ 输出 schema，不含角色、阶段、话术；
- 只允许能接收 system 的 local/cloud；网页通道只收原话，不参与审核；
- 默认关闭、有预算上限、输出不合法回退规则；
- 审核记录必须可追溯，不覆盖原计划而不留痕。

---

## 5. 门禁、回滚与删除

### 5.1 每个里程碑的出口

1. `npm run typecheck` 通过；
2. 本阶段的测试脚本通过（见各计划）；
3. 至少一个真实场景跑通（不是 mock）；
4. diff 自查：无无关改动、无调试代码；
5. 提交信息写清「原来错在哪」。

### 5.2 回滚

- 每阶段都必须能在不 revert 代码的情况下关闭：flag / 配置 / 开关。
- 新增持久化数据必须能被旧版本安全忽略（未知字段不崩溃）。
- 回滚演练写进 P0 出口，不等到出事再做。

### 5.3 旧代码删除条件

一个模块只有在同时满足时才删：

1. 对应职责已在新路径运行 ≥ 1 个真实场景；
2. 相关测试全部迁移并通过；
3. flag=`active` 连续 ≥ 2 个真实任务或 7 天；
4. 没有回滚需求；
5. 删除清单在 PR/提交里逐项列出。

不做「先删了再说」。删除顺序见各计划的迁移矩阵。

---

## 6. 风险台账

| 风险 | 触发信号 | 对策 |
| --- | --- | --- |
| 新引擎变成固定 Pipeline | 所有任务都走同一组阶段 | P1 验收必须包含「简单问题只走 1–2 步」 |
| Shadow 没有意义 | 只比计划条数 | shadow 指标见 02 文档第 8 节 |
| 网页通道被塞指令 | 后续轮 question 出现「请指出」 | Adapter 层测试 + 代码审查 |
| 证据两套并存 | 出现第二个哈希/存储 | P0 契约 + P4 映射表 |
| 参与者被静默减少 | 状态条少了通道 | 第一手全覆盖测试 |
| 删除过早 | 旧路径不可用 | 删除条件 5.3 |
| 计划与代码漂移 | 文件/行号对不上 | 基线变更先改计划 |

---

## 7. 文档索引

- 全任务书：[TASK-BOOK.md](TASK-BOOK.md)
- 契约与开关：[01-p0-contracts.md](01-p0-contracts.md)
- 协作引擎：[02-p1-collaboration-engine.md](02-p1-collaboration-engine.md)
- 知识学习：[03-p2-knowledge.md](03-p2-knowledge.md)
- 工程空间：[04-p3-engineering.md](04-p3-engineering.md)
- 证据与质量：[05-p4-evidence-quality.md](05-p4-evidence-quality.md)
- 模型与通道：[06-p5-channels.md](06-p5-channels.md)
- UI：[07-ui.md](07-ui.md)
