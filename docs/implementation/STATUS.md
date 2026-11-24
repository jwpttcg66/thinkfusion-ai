# ThinkFusion 单一状态板

状态：当前有效  
基线：`main` · `cdc8308689e65b92017701a7646410c94fa1beb2` · 2026-11-24

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
| 实施任务书 | DESIGN | `docs/spec/V3-MAIN-ACTIVITY-COLLABORATION-RESULT-TASK-BOOK.md` |
| U0 现状与数据链路审计 | DESIGN | `docs/implementation/V3-MAIN-ACTIVITY-U0-AUDIT.md` |
| U1 统一协作结果投影 | IMPLEMENTED / TESTED | `shared/collaboration-result.ts` + `test:collaboration-result` |
| U2 Debate 争议驱动与展示 | IMPLEMENTED / TESTED | `PlanDebate.result` + 投影不伪造无争议 |
| U3 Review 内容与闭环 | IMPLEMENTED / TESTED | `review.disposition` + 修复轮自动采纳 + IPC/UI；投影挂修正/验证；验证失败不关闭 |
| U4 General / Knowledge 主活动区 | IMPLEMENTED / TESTED | `CollaborationResultPanel` 置顶（自动化）；真机见 U6 报告中的结果面板 |
| U5 Engineering 主活动区 | IMPLEMENTED / TESTED | 结果面板 + 对话页去掉重复最终交付；真机见 U6 |
| U6 集成 / 恢复 / 真机验收 | VERIFIED | 自动化全绿；云端 OpenCode Go 真机 `completed`（问题原样、不开网页）；见 `V3-MAIN-ACTIVITY-U6-ACCEPTANCE.md` |
| 功能分支 | 进行中 | `feat/v3-main-activity-collab-result`（未推送） |
| 实施记录 | — | `V3-MAIN-ACTIVITY-U2-U6-IMPLEMENTATION.md`、`V3-MAIN-ACTIVITY-U6-ACCEPTANCE.md` |

> U6 真机证据：`taskId=0753851d-6dab-4e11-b4f2-83ead4bd8e69`，终态 completed；报告 `/tmp/tf-v3-u6-report.json`。

## 5. 文档分类

| 类别 | 文档 |
| --- | --- |
| 当前有效架构 | `PRODUCT.md`、`ARCHITECTURE.md`、`ROADMAP.md`、`architecture/COLLABORATION_ARCHITECTURE.md`、`architecture/ENGINEERING_WORKSPACE.md`、`architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md` |
| 当前实施计划 | `implementation/README.md`、`implementation/TASK-BOOK.md`、`implementation/LONG-TASK-CONTEXT-TASK-BOOK.md`、LT 阶段任务书 |
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
| 长任务文档基线 `e31b6a3` | 已统一为当时审计基线；当前仓库基线以本文件顶部 `cdc8308` 为准（2026-11-24） |
| STATUS 曾写 `e336ae4` | 已与 `origin/main@cdc8308` 对齐 |
