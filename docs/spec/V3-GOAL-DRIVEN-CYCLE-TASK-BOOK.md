# ThinkFusion V3 Goal-Driven Cycle（GDC）实施任务书

版本：V1.0 · 基线：`main@d152137` · 分支：`feat/v3-goal-driven-cycle`  
架构：[`V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md`](../architecture/V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md)  
审计：[`V3-GDC-P0-ARCHITECTURE-AUDIT.md`](../implementation/V3-GDC-P0-ARCHITECTURE-AUDIT.md)

> **约束：** 薄协调 + 投影；不另建 Runtime；不套任务提示词；不冻结流程基线。

## 阶段

| ID | 内容 | 验收 |
| --- | --- | --- |
| GDC-P0 | 审计四类清单 | 本文 + 审计文档合入分支 |
| GDC-P1 | EngineeringGoalView 投影、变更分类、符合度 | `test:gdc-goal` |
| GDC-P2 | WorkCycleView + CycleCoordinator 派生 | `test:gdc-cycle` |
| GDC-P3 | Artifact / Decision 投影与 supersedes | 同 cycle 测试覆盖 |
| GDC-P4 | Engineering 事件序列可重建 cycle；General 不强制八阶段 | 投影测试 |
| GDC-P5 | 从 Journal 事件可恢复 cycle/stage；暴露预算摘要 | 投影测试 |
| GDC-P6 | 结果面板目标区/循环区/下一步 | UI 接线 + typecheck |
| GDC-P7 | 自动化全绿；Engineering 真机或可重放证据 | STATUS 更新 |

## 非目标

第二套 Orchestrator / Journal / Approval / Verifier；提示词导演；Computer Use。
