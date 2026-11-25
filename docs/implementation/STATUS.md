# ThinkFusion 单一状态板

状态：当前有效  
基线：`main` · `d152137` · 2026-11-25（含 U7 质量收敛合入）

> 本文件是**唯一阶段状态来源**。其他文档里的阶段表、完成度表只作为历史计划或
> 设计依据；与本文件冲突时，以本文件 + 代码/测试事实为准。
>
> 状态只表示“代码与验证是否到位”，不把设计文档、计划书或任务书当成已实现功能。

## 1. 状态口径

| 标记 | 含义 |
| --- | --- |
| DESIGN | 设计/契约冻结，未写运行时 |
| IMPLEMENTED | 代码已落地 |
| TESTED | 有自动化回归 |
| VERIFIED | 真机/真实任务验证通过 |
| PARTIAL | 核心可用，但有明确缺口 |
| NOT STARTED | 未开始 |
| HISTORICAL | 历史规格，不再约束当前实现 |

## 2. V3 计划门禁

| 项 | 状态 | 事实 |
| --- | --- | --- |
| P0-J 设计评审 | ✅ 通过 | P0-J 记录关闭的是**设计/契约评审门禁**，不等于 V3 全部实现完成 |
| P0-04 Feature Flag | ✅ 完成 | 代码与测试存在 |
| P0-06 回滚钻取 | ✅ 完成 | `P0-06-ROLLBACK-DRILL.md` 记录 |
| P1-001 代码事实审计 | ✅ 签收 | 迁移审计完成；不表示后续阶段全部完成 |

> 结论：P0 的“完成”指设计门禁与开关/回滚/审计完成，不是“P1–P6 全部完成”。

## 3. V3 能力状态

| 能力 | 状态 | 依据 | 缺口 |
| --- | --- | --- | --- |
| 多通道独立作答 / 网页通道 | VERIFIED | 现有实现与 P5 通道验收 | 部分站点需要登录/维护 |
| 协作引擎（Planner/Scheduler/Runner） | PARTIAL | `collaboration/`、`UNIFIED-TASK-RUNTIME` | 设置页/全量分组回归仍有缺口 |
| 辩论引擎（按需行为） | IMPLEMENTED / TESTED | `debate/`、runbook | 手动入口为历史/程序化用途，不是产品主流程 |
| 证据包与执行断言 | VERIFIED | Evidence Pack、Item Hash | 跨空间统一引用仍在 P4 范围 |
| 工程工作空间 | VERIFIED | 真实工程任务、评审、交付、暂停/继续、30 步 Runtime、检查点中断恢复 | 无 |
| 知识学习空间 | PARTIAL | KnowledgeStore、召回、研究 | 索引复用/产品化仍有缺口 |
| 证据与质量 P4 | VERIFIED | EvidenceRef、Verifier、场景测试、上下文检查点、30 步 Runtime、中断恢复 | 无 |
| 模型与通道 P5 | IMPLEMENTED / TESTED | 能力、路由、观测、矩阵 | 新增通道仍需适配 |
| 发布与运维 P6 | PARTIAL | 清单、迁移、备份、dmg/zip | 签名/公证未执行 |
| V3 正式发布 | NOT STARTED | 发布判据未满足 | 见 P6 |
| macOS 真机控制（Computer Use） | VERIFIED / TESTED | `implementation/V3-COMPUTER-USE-MACOS.md`，分支 `feat/v3-computer-use-macos` | 能力清单 109 真机全跑：`test:capabilities:live`（`tf-cap-mwvp2fb6`）暴露 109/109 且每项执行一次；含 13 个 `computer.*` TextEdit 真机。`test:computer-use` 18 项通过。锁屏时控件操作被挡 |
| 分层任务分解与长任务进度（TDL） | VERIFIED / TESTED | `architecture/V3-TASK-DECOMPOSITION-LAYER.md`、`spec/V3-TASK-DECOMPOSITION-TASK-BOOK.md`、`implementation/V3-TDL-PROGRESS.md`；分支 `feat/v3-task-decomposition` | `test:tdl` 全绿；真机 `test:tdl:live` → `evidence/V3-TDL-ENGINEERING-LIVE.json`（面板 0/1→1/1，work.* 种子+step 状态） |

## 3.5 全局一致性治理（G0–G6）

| 阶段 | 状态 | 依据 |
| --- | --- | --- |
| G0 审计 | ✅ 文档级完成 | `V3-GLOBAL-CONSISTENCY-AUDIT.md` |
| G1 全局架构 | ✅ 文档级完成 | `architecture/V3-GLOBAL-ARCHITECTURE.md` |
| G2 跨空间契约 | ✅ 文档级完成 | `LONG_TASK_CONTEXT_CONTRACTS.md` |
| G3 存储/归档 | ✅ 文档级完成 | `CONTEXT_CHECKPOINT_STORAGE.md` + ADR 0010（Proposed） |
| G4 V3/LT 协调 | ✅ 文档级完成 | `TASK-BOOK.md` 所有权表 |
| G5 测试/状态 | ✅ 文档级完成 | 本文件 + 测试计划登记说明 |
| G6 评审 | ✅ 文档级通过；ADR 0010 设计接受 | `V3-GLOBAL-CONSISTENCY-REVIEW.md` |

> G0–G5 只代表文档/契约修订完成，不代表运行时代码已实现。
> **LT-P0 可以开始契约/设计工作；LT-P3 检查点实现仍需 P0-03 按 ADR 复核。**

## 4. 长任务与上下文压缩（LT）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 架构/契约/存储/UI/任务书 | DESIGN | `docs/architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md` 等 |
| `src/main/context/` 运行时 | NOT STARTED | 当前仓库不存在该目录 |
| 上下文压缩 | NOT STARTED | 设计完成，未实施 |
| 暂停/恢复/中断 | NOT STARTED | 当前 `reconcileInterrupted()` 仍把在途任务标 failed |
| LT-P0–P6 | VERIFIED | 真实云端会话压缩/检查点；工程暂停继续；30 步 Runtime；工程检查点中断恢复；Engineering Provider 规划上下文 | Web/CLI 按契约保持原话 |
| 文档一致性修订（2026-11-24） | ✅ 已应用 | 基线、ContextOwner、归档/裁剪、检查点提交协议、单一状态板 |

> 长任务文档中的“已完成”只代表设计文档/任务书完成，不代表功能已落地。

## 4.5 主活动区与协作结果表达（V3）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 实施任务书（U0–U6） | HISTORICAL / 主体已合入 | `docs/spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md`；基线已过时，见 U7 |
| U0 现状与数据链路审计 | 完成 | `docs/implementation/V3-MAIN-ACTIVITY-U0-AUDIT.md` |
| U1 统一协作结果投影 | PARTIAL | 投影层 + UI 已接线；来源引用在 U7 收敛 |
| U2 Debate 争议驱动与展示 | PARTIAL | PlanDebate 结构化；跨场景裁决统一在 U7 |
| U3 Review 内容与闭环 | PARTIAL | disposition 闭环已有；评审语义补齐在 U7 |
| U4 General / Knowledge 主活动区 | PARTIAL | 结果面板已接入；去重与场景验收在 U7 |
| U5 Engineering 主活动区 | PARTIAL | 结果面板已接入；去重与闭环验收在 U7 |
| U6 集成 / 恢复 / 真机验收 | PARTIAL | Engineering 单路径冒烟有证据；三场景完整验收改由 U7 |
| **U7 质量收敛与最终验收** | PARTIAL | 已合入 `main@d152137`；Engineering 真机去重通过；General/Knowledge 真机待补。见 `V3-MAIN-ACTIVITY-U7-ACCEPTANCE.md` |
| 功能分支（U7） | 已合入 | `feat/v3-main-activity-u7-quality` → `main` |
| 实施记录 | — | `V3-MAIN-ACTIVITY-U2-U6-IMPLEMENTATION.md`、`V3-MAIN-ACTIVITY-U6-ACCEPTANCE.md` |

> U6 真机证据（Engineering 冒烟）：`taskId=0753851d-6dab-4e11-b4f2-83ead4bd8e69`，终态 completed。  
> **不得把 U0–U6 整体标为 VERIFIED**；以 U7 三场景验收为准。

## 4.6 目标驱动循环协作（GDC）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 架构说明书 | DESIGN | `architecture/V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md` |
| P0 架构审计 | 完成 | `V3-GDC-P0-ARCHITECTURE-AUDIT.md` |
| 实施任务书 | 实施中 | `spec/V3-GOAL-DRIVEN-CYCLE-TASK-BOOK.md` |
| GDC-P1～P7 | DONE / 已合 main | 见 `V3-GDC-ACCEPTANCE.md`；基线以最新 `main` 为准 |
| 功能分支 | 已合入 | 曾用 `feat/v3-goal-driven-cycle` |

> GDC **不**另建 Runtime。

## 4.7 辩论与审核按需触发 / 去重 / 预算（CB）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 专项任务书 | DONE | `spec/V3-COLLAB-BUDGET-CONTROL-TASK-BOOK.md` |
| CB-P0a `auto` 跳过 L0 五段 | DONE | `plan-review.ts` `shouldDebatePlan` + `assessCollaborationRisk` |
| CB-P0b 轮次按等级收紧 | DONE | `planReviewRounds` → 1/2/3 |
| CB-P0c 执行后模型审核门禁 | DONE | `shouldModelReviewExecution` |
| CB-P1 核心意见去重上限 | DONE | `selectKeyOpinions` / `dedupeOpinions` |
| CB-P2 UI 区分原始/展示/争议 | DONE | CollaborationResultPanel 文案 |
| 功能分支 | 已合入 main | `feat/v3-collab-budget-control` → `ededc97` |
| 自动化 | ✅ | `test:plan-review` / `test:plan-debate` / `test:collab-budget` |
| 真机 L0 | ✅ | `collab-budget-live.mjs`：跳过五段、rules 审核、意见展示 1；见 `V3-COLLAB-BUDGET-LIVE.json` |
| 专项结论 | DONE | 见 `V3-COLLAB-BUDGET-ACCEPTANCE.md` |

> 硬规则：不为「要不要辩论」先调一次模型；意见数 ≠ 争议数；展示去重不能替代执行克制。

## 4.8a 动态多模型协作与贡献对齐（DMOCA）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 架构说明书 | DONE | `architecture/V3-DYNAMIC-MULTI-MODEL-ORCHESTRATION.md` |
| 实施任务书 | DONE | `spec/V3-DMOCA-TASK-BOOK.md` |
| DMOCA-P0 审计 | DONE | `V3-DMOCA-P0-ARCHITECTURE-AUDIT.md` |
| DMOCA-P1 参与策略 | DONE | `shared/dmoca.ts` `decideParticipation` + 事件 `model.participation.selected` |
| DMOCA-P2 角色生命周期 | DONE | 角色写入决策；`transitionParticipationLife` |
| DMOCA-P3 贡献协议 | DONE | 事件投影 ModelRun / ContributionArtifact（流式≠final） |
| DMOCA-P4 对齐快照 | DONE | ContributionSnapshot / DecisionSnapshot 投影 |
| DMOCA-P5 辩论审核预算 | DONE | 复用 CB L0–L3 + `shouldStopCollaboration` |
| DMOCA-P6 UI | DONE | CollaborationResultPanel「模型协作」区 |
| DMOCA-P7 验收 | DONE | `test:dmoca`（7）+ `dmoca-live.mjs` → `evidence/V3-DMOCA-LIVE.json` |
| 验收说明 | DONE | `V3-DMOCA-ACCEPTANCE.md` |
| 功能分支 | 已合入 main | 随 `feat/v3-goal-tdl-eco` |

> DMOCA **不**另建 Runtime；选人扩展 `planLead`/风险门禁，贡献从 Journal 事件投影。

## 4.9 Goal / TDL / ECO 整合（V2.0）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 架构说明书 | DONE | `architecture/V3-GOAL-TDL-ECO-ARCHITECTURE.md` |
| 实施任务书 | DONE | `spec/V3-GOAL-TDL-ECO-TASK-BOOK.md` |
| P0 审计 | DONE | `V3-GOAL-TDL-ECO-P0-AUDIT.md` |
| P1 Goal+TDL level | DONE | WorkTask.level L0–L3；种子 L1 组 + L3 步骤 |
| P2 真实进度 | DONE | `progressRatioFromRows`；UI 百分比 |
| P3 ECO | DONE | `shared/eco.ts` + `eco.context.prepared` |
| P4 Cycle | REUSE GDC | 复用 cycle.snapshot / continueAfterReport |
| P5 DMOCA×ECO | DONE | 参与决策理由附带 ECO 充分度 |
| P6 长任务 | REUSE LT | 复用 `main/context/`；ECO 版本可挂检查点后续 |
| P7 UI | DONE | 任务树缩进 +「工程上下文」区 |
| P8 验收 | DONE | `test:eco`（4）+ `eco-live.mjs` → `evidence/V3-GOAL-TDL-ECO-LIVE.json` |
| 验收说明 | DONE | `V3-GOAL-TDL-ECO-ACCEPTANCE.md` |
| 功能分支 | 已合入 main | `feat/v3-goal-tdl-eco` → `615eeed` |

> ECO **不**另建代码理解引擎；充分度门禁约束正式架构/审核职责。

## 4.9a Goal/TDL/ECO 分阶段质量整改（gtec-phased）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 总计划 | DESIGNED | `docs/superpowers/plans/2026-11-25-gtec-phased-quality.md` |
| P0 设计/审计 | AUDITED | `gtec-phases/P0-DESIGN.md` |
| P1 Goal+TDL 加深 | TESTED | `gtec-phases/P1-DESIGN.md` + `test:gtec-p1` |
| P2 真实进度 | TESTED | `gtec-phases/P2-DESIGN.md` + `test:gtec-p2` |
| P3 ECO 实质化 | TESTED | `gtec-phases/P3-DESIGN.md` + `test:gtec-p3` |
| P4 Cycle↔TDL | TESTED | `gtec-phases/P4-DESIGN.md` + `test:gtec-p4` |
| P5 DMOCA×ECO | TESTED | `gtec-phases/P5-DESIGN.md` + `test:gtec-p5` |
| P6 LT×ECO 引用 | TESTED | `gtec-phases/P6-DESIGN.md` + `test:gtec-p6` |
| P7 UI 投影 | TESTED | `gtec-phases/P7-DESIGN.md` + `test:gtec-p7` |
| P8 端到端 | DEVICE | `gtec-phases/P8-DESIGN.md` + `evidence/V3-GTEC-PHASED-LIVE.json` |
| 验收说明 | DONE | `V3-GTEC-PHASED-ACCEPTANCE.md` |
| 功能分支 | 已合入 main | `feat/v3-gtec-phased` → `27f435d` |

> 首次薄层合入质量不足：本轨按阶段门禁重做；§4.9a 为正式质量验收口径。

## 4.8 分层任务分解（TDL）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 架构说明书 | DESIGN | `architecture/V3-TASK-DECOMPOSITION-LAYER.md` |
| 实施任务书 | DESIGN | `spec/V3-TASK-DECOMPOSITION-TASK-BOOK.md` |
| TDL-P0 审计 | 文档完成 | `implementation/V3-TDL-PROGRESS.md` |
| TDL-P1–P7 | VERIFIED / TESTED | 契约/投影/写入/策略/UI/重规划闭包；真机证据见 `evidence/V3-TDL-ENGINEERING-LIVE.json` |
| 功能分支 | 待合入 | `feat/v3-task-decomposition` |

> TDL **不**另建 Runtime；进度只投影真实子任务状态。Worktree 不自动清理（`AGENTS.md` §5.1）。

## 5. 文档分类

| 类别 | 文档 |
| --- | --- |
| 当前有效架构 | `PRODUCT.md`、`ARCHITECTURE.md`、`ROADMAP.md`、`architecture/COLLABORATION_ARCHITECTURE.md`、`architecture/ENGINEERING_WORKSPACE.md`、`architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md`、**`architecture/V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md`**、**`architecture/V3-TASK-DECOMPOSITION-LAYER.md`**、**`architecture/V3-DYNAMIC-MULTI-MODEL-ORCHESTRATION.md`** |
| 当前实施计划 | `implementation/README.md`、`implementation/TASK-BOOK.md`、`implementation/LONG-TASK-CONTEXT-TASK-BOOK.md`、LT 阶段任务书、**U7 质量收敛任务书**、**GDC 任务书**、**CB 协作预算任务书**、**TDL 任务书**、**DMOCA 任务书**、`implementation/V3-COMPUTER-USE-MACOS.md` |
| 已完成能力与证据 | `implementation/COMPLETION-AUDIT.md`、`implementation/E-ACCEPTANCE-REPORT.md`、`docs/spec/evidence/*`、`git log` |
| 历史规格 | `docs/spec/DEBATE_ENGINE_TASK_V1.0.md`、旧辩论入口/固定轮次说明、已被替代的 V3 阶段表 |
| 运维/发布 | `operations/RELEASE_CHECKLIST.md`、`operations/LONG-TASK-CONTEXT-ROLLOUT.md` |

## 6. 状态更新规则

1. 任何阶段状态变化只改本文件 + 对应任务书状态板。
2. 设计文档不写“已实施”，除非代码与测试存在。
3. 历史文档保留，但顶部标注 `HISTORICAL`，不再作为验收依据。
4. 真机验证必须写清设备、任务、证据；不能只写“已验证”。
5. 与代码冲突时，以代码与测试为准，并修正文档。

## 7. 已知文档冲突

| 冲突 | 处理 |
| --- | --- |
| `ROADMAP` 旧句“P0 门禁未过、未实施” | 已改为指向本状态板 |
| `PRODUCT` 旧句“代码尚未迁移” | 已改为“主体已迁移，见状态板” |
| `implementation/README` 旧状态板与 COMPLETION-AUDIT 不一致 | 旧表标记为历史，本文件为唯一状态 |
| `UNIFIED-TASK-RUNTIME` 声称重启恢复已完成 | 修正为：当前仅标记中断，长任务恢复在 LT-P5 |
| 长任务文档基线 `e31b6a3` / 旧主活动区基线 `cdc8308` | 本文件顶部已更新为 `8601fc2`（2026-11-24） |
| 主活动区 U0–U6 曾标 VERIFIED / 功能分支未推送 | 已改为 PARTIAL + U7 收尾；改动已在 `main` |
