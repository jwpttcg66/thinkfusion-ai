# ThinkFusion 单一状态板

状态：当前有效  
基线：`main` · `e336ae434978211138879688031a9d40c1a27cd7` · 2026-11-24

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
| 工程工作空间 | VERIFIED | 真实工程任务、评审、交付 | 长任务恢复未实现 |
| 知识学习空间 | PARTIAL | KnowledgeStore、召回、研究 | 索引复用/产品化仍有缺口 |
| 证据与质量 P4 | IMPLEMENTED / TESTED | EvidenceRef、Verifier、场景测试 | 长任务上下文证据尚未接 |
| 模型与通道 P5 | IMPLEMENTED / TESTED | 能力、路由、观测、矩阵 | 新增通道仍需适配 |
| 发布与运维 P6 | PARTIAL | 清单、迁移、备份、dmg/zip | 签名/公证未执行 |
| V3 正式发布 | NOT STARTED | 发布判据未满足 | 见 P6 |

## 4. 长任务与上下文压缩（LT）

| 项 | 状态 | 依据 |
| --- | --- | --- |
| 架构/契约/存储/UI/任务书 | DESIGN | `docs/architecture/LONG_TASK_AND_CONTEXT_COMPACTION.md` 等 |
| `src/main/context/` 运行时 | NOT STARTED | 当前仓库不存在该目录 |
| 上下文压缩 | NOT STARTED | 设计完成，未实施 |
| 暂停/恢复/中断 | NOT STARTED | 当前 `reconcileInterrupted()` 仍把在途任务标 failed |
| LT-P0–P6 | NOT STARTED | 35 项任务，见任务书 |
| 文档一致性修订（2026-11-24） | ✅ 已应用 | 基线、ContextOwner、归档/裁剪、检查点提交协议、单一状态板 |

> 长任务文档中的“已完成”只代表设计文档/任务书完成，不代表功能已落地。

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
| 长任务文档基线 `e31b6a3` | 已统一为 `e336ae4`（2026-11-24） |
