# 实施计划索引

这组文档把 V3 的产品与架构设计拆成**可以交给 Codex 分阶段执行**的计划。
历史实现日志仍然只在 `git log` 里；这里只放**还没做完或正在做**的计划。

**文档基线：`main@e336ae4`（2026-11-24）。** 旧设计快照 `product-v3@2d05b12`
与代码审计基线 `cd30be3` 只作为历史记录，不再作为实施依据。

**唯一阶段状态：[STATUS.md](STATUS.md)。** 本页的阶段表只表示计划划分，
不再作为验收依据；与 `STATUS.md` 冲突时以状态板 + 代码/测试为准。

## 计划集

| 文档 | 阶段 | 回答什么 |
| --- | --- | --- |
| [STATUS.md](STATUS.md) | 全阶段 | **唯一状态板**：代码/测试事实、文档分类、已知冲突 |
| [TASK-BOOK.md](TASK-BOOK.md) | 全阶段 | P0–P6、UI 与跨阶段全部任务的任务书（历史计划） |
| [LONG-TASK-CONTEXT-TASK-BOOK.md](LONG-TASK-CONTEXT-TASK-BOOK.md) | LT-P0–P6 | 长任务执行与上下文压缩的正式实施任务书；设计基线 `e336ae4` |
| [P0-06-ROLLBACK-DRILL.md](P0-06-ROLLBACK-DRILL.md) | P0 | 模式 Flag 的升级/降级/损坏钻取 |
| [P1-00A-CODE-MAPPING.md](P1-00A-CODE-MAPPING.md) | P1 | 逐文件职责映射与第一刀顺序 |
| [V3-FORMAL-FEATURES-PLAN.md](V3-FORMAL-FEATURES-PLAN.md) | 全阶段 | 正式功能实施计划（不含发布） |
| [V3-FORMAL-FEATURES-DESIGN.md](V3-FORMAL-FEATURES-DESIGN.md) | 全阶段 | A-03..E 的完整设计包 |
| [D-LEGACY-EXIT-AUDIT.md](D-LEGACY-EXIT-AUDIT.md) | D | 旧模块调用链与删除证据 |
| [RCA-2026-11-20-ROUTING.md](RCA-2026-11-20-ROUTING.md) | 排查 | 工程“制作示例工程”被当成问答的 RCA |
| [E-ACCEPTANCE-REPORT.md](E-ACCEPTANCE-REPORT.md) | E | 正式功能验收报告与已知限制 |
| [COMPLETION-AUDIT.md](COMPLETION-AUDIT.md) | 全阶段 | V3 完成度审计（历史快照；当前状态见 STATUS.md） |
| [../operations/RELEASE_CHECKLIST.md](../operations/RELEASE_CHECKLIST.md) | P6 | 发布前检查清单 |
| [P0-J-REVIEW-RECORD.md](P0-J-REVIEW-RECORD.md) | P0 评审 | 独立文档/代码评审结论、修复项与残余门禁 |
| [P0-F-TO-J-DESIGN-REVISION.md](P0-F-TO-J-DESIGN-REVISION.md) | P0 修订 | 状态所有权、输入契约/27 个输入构造点、证据归属、任务书一致性、评审门禁 |
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

## 状态板（历史计划）

V3 的 P0–P6 阶段表保留为历史计划；当前真实状态只维护在
[STATUS.md](STATUS.md)。旧表曾出现“P0 完成”与“P3/P4 未开始”互相矛盾，
不再作为验收依据。

## 新增设计轨道：长任务与上下文压缩

这组设计不属于现有 P0–P6 的阶段编号，使用独立的 `LT-P0–LT-P6` 编号：

- 文档集入口：[LONG-TASK-CONTEXT-README.md](LONG-TASK-CONTEXT-README.md)
- 架构决议：[../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md](../architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md)
- 契约：[../spec/LONG_TASK_CONTEXT_CONTRACTS.md](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)
- 存储：[../architecture/CONTEXT_CHECKPOINT_STORAGE.md](../architecture/CONTEXT_CHECKPOINT_STORAGE.md) · [ADR 0010](../adr/0010-context-checkpoint-storage.md)
- UI：[../spec/LONG_TASK_CONTEXT_UI.md](../spec/LONG_TASK_CONTEXT_UI.md)
- 正式任务书：[LONG-TASK-CONTEXT-TASK-BOOK.md](LONG-TASK-CONTEXT-TASK-BOOK.md)
- 阶段任务书：[LT-P0](LT-P0-CONTRACTS.md) · [LT-P1](LT-P1-CONTEXT-MANAGER.md) · [LT-P2](LT-P2-TOOL-PRUNING.md) · [LT-P3](LT-P3-COMPACTION-CHECKPOINTS.md) · [LT-P4](LT-P4-PROVIDER-WIRING.md) · [LT-P5](LT-P5-PAUSE-RESUME.md) · [LT-P6](LT-P6-UI-E2E.md)
- 测试计划：[LONG-TASK-CONTEXT-TEST-PLAN.md](LONG-TASK-CONTEXT-TEST-PLAN.md)
- 灰度/回滚：[../operations/LONG-TASK-CONTEXT-ROLLOUT.md](../operations/LONG-TASK-CONTEXT-ROLLOUT.md)
- 产出模板：[审计](LONG-TASK-CONTEXT-AUDIT.md) · [验收](LONG-TASK-CONTEXT-ACCEPTANCE.md)

当前状态：**设计完成，未实施**。P0 契约冻结通过前不进入实现。

所有权：V3 既有模块（`task-manager.ts`、`orchestrator.ts`、`store.ts`、
`task-events.ts`、`task-view.ts`）由 V3 计划拥有；LT 只做扩展，不重写同一职责。

## 使用方式

1. 只从**当前阶段**取任务；前置门禁没过，不领后一阶段。
2. 每个任务开工前先读它的「依赖」与「回滚」；没有回滚点的任务不许开工。
3. 验收命令必须真实执行，不能以「代码看起来对」代替。
4. 实际代码与计划不一致时，先改计划再改代码，并在提交信息里写清原因。
