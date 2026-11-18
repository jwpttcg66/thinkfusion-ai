# 实施计划索引

这组文档把 V3 的产品与架构设计拆成**可以交给 Codex 分阶段执行**的计划。
历史实现日志仍然只在 `git log` 里；这里只放**还没做完或正在做**的计划。

**设计基线：`product-v3`（快照 `2d05b12`）；代码基线：`cd30be3`（P1-001 审计时；此后仅文档变化）。**
基线变了就先改这里的提交号，再改各计划里的文件行号。

## 计划集

| 文档 | 阶段 | 回答什么 |
| --- | --- | --- |
| [TASK-BOOK.md](TASK-BOOK.md) | 全阶段 | P0–P6、UI 与跨阶段全部任务的任务书 |
| [P0-F-TO-J-DESIGN-REVISION.md](P0-F-TO-J-DESIGN-REVISION.md) | P0 修订 | 状态所有权、输入契约/16 个 Prompt、证据归属、任务书一致性、评审门禁 |
| [P0-A-DESIGN-CONSISTENCY-REVIEW.md](P0-A-DESIGN-CONSISTENCY-REVIEW.md) | P0 前置 | 全量设计一致性审查、11 处不一致、D1–D8 决策清单 |
| [P0-B-TO-E-DESIGN-RESOLUTION.md](P0-B-TO-E-DESIGN-RESOLUTION.md) | P0 前置 | B.1 类型、B.2 状态机、C 文档统一、D 评审清单、E 冻结与任务书 |
| [P1-001-MIGRATION-AUDIT.md](P1-001-MIGRATION-AUDIT.md) | P1 前置 | 当前代码架构、重复职责、状态/Runtime/Planner/Debate/Evidence/工程/Java 审计 |
| [P1-002-DOMAIN-RUNTIME-CONTRACT.md](P1-002-DOMAIN-RUNTIME-CONTRACT.md) | P1 前置 | 领域对象、所有权、生命周期、状态机、错误/重试/取消/并发/预算、持久化与事件 |
| [00-master-plan.md](00-master-plan.md) | 全局 | 阶段、门禁、开关、回滚、删除策略、与提案 P0–P12 的映射 |
| [01-p0-contracts.md](01-p0-contracts.md) | P0 | 审计矩阵、契约冻结、Feature Flag、事件与持久化 |
| [02-p1-collaboration-engine.md](02-p1-collaboration-engine.md) | P1 | 协作引擎、参与者管理、DAG、重规划、行为目录、辩论降级 |
| [03-p2-knowledge.md](03-p2-knowledge.md) | P2 | 知识索引、复用、时效、缺口驱动研究、知识地图 |
| [04-p3-engineering.md](04-p3-engineering.md) | P3 | 工程任务状态、Agentic Search、CLI 执行者、worktree、回滚 |
| [05-p4-evidence-quality.md](05-p4-evidence-quality.md) | P4 | 统一证据引用、验证计划、质量指标、测试矩阵 |
| [06-p5-channels.md](06-p5-channels.md) | P5 | 能力模型、路由降级、新增通道、发布判据 |
| [07-ui.md](07-ui.md) | 跨阶段 | 界面结构、事件映射、移除辩论入口、分阶段落地 |

## 状态板

| 阶段 | 状态 | 出口条件 | 负责人 |
| --- | --- | --- | --- |
| P0 契约与开关 | 🟡 方向确认；P0-J 待评审 | P0-J 通过后进入 P1 | — |
| P1.0 协作引擎骨架 | 未开始（设计完成） | Goal → DAG → Run → Observation → Deliver 可跑 | — |
| P1.1 重规划/辩论 | 未开始 | Replanner 有护栏，debate 按需 | — |
| P2 知识学习 | 未开始 | 第二次研究可复用并标时效 | — |
| P3 工程空间 | 未开始 | 一次真实改动全链路通过 | — |
| P4 证据与质量 | 未开始 | 跨空间引用 + 门槛可回归 | — |
| P5 模型与通道 | 未开始 | 新增通道不改主流程 | — |
| P6 发布与运维 | 未开始 | 干净机器安装/迁移/回滚/签名 | — |
| V3 发布 | 未开始 | 06 文档的发布判据 | — |

## 使用方式

1. 只从**当前阶段**取任务；前置门禁没过，不领后一阶段。
2. 每个任务开工前先读它的「依赖」与「回滚」；没有回滚点的任务不许开工。
3. 验收命令必须真实执行，不能以「代码看起来对」代替。
4. 实际代码与计划不一致时，先改计划再改代码，并在提交信息里写清原因。
