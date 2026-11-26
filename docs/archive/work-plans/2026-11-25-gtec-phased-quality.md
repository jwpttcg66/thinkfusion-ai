# Goal/TDL/ECO V2.0 分阶段质量整改计划

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


**分支：** `feat/v3-gtec-phased`  
**工作区：** `/Users/yalla/data/localLab/thinkfusion-ai-gtec-phased`  
**基线：** `main@e47fd59`（已含首次薄层合入）  
**原则：** 每阶段 = 设计书 → 失败测试 → 最小实现 → 本阶段测试绿 → 提交；禁止一次塞完 P0–P8。

## 质量问题（为何重做）

1. 缺少分阶段设计书，契约与边界未先锁定。  
2. 测试过薄（ECO 4 条、缺 Goal 版本/依赖环/Cycle↔TDL 绑定等）。  
3. ECO 资源多为计划占位，未形成可追溯 ContextRequest 闭环。  
4. Goal 无独立持久契约；Cycle 与 WorkTask.cycleId 未真正交叉。  
5. 完成状态未区分 DESIGNED / IMPLEMENTED / TESTED / DEVICE。

## 阶段门禁

| 阶段 | 设计书 | 单测入口 | 提交粒度 |
| --- | --- | --- | --- |
| P0 | `docs/implementation/gtec-phases/P0-DESIGN.md` | 审计清单可追溯即可 | docs |
| P1 | `.../P1-DESIGN.md` | `test:gtec-p1` | Goal+TDL level 契约 |
| P2 | `.../P2-DESIGN.md` | `test:gtec-p2` | 真实进度 |
| P3 | `.../P3-DESIGN.md` | `test:gtec-p3` | ECO 包/请求/充分度 |
| P4 | `.../P4-DESIGN.md` | `test:gtec-p4` | Cycle↔WorkTask |
| P5 | `.../P5-DESIGN.md` | `test:gtec-p5` | DMOCA×ECO 门禁 |
| P6 | `.../P6-DESIGN.md` | `test:gtec-p6` | 检查点挂 ECO 版本 |
| P7 | `.../P7-DESIGN.md` | `test:gtec-p7`（契约/DOM 投影） | UI |
| P8 | `.../P8-DESIGN.md` | 分场景 live + 证据 | e2e |

每阶段 STATUS 只在该阶段测试绿后更新为 TESTED；真机仅 P8（及必要冒烟）标 DEVICE。

## 不做什么

- 不另建 Runtime / Journal / Verifier  
- 不把 LT ContextManager 改造成 ECO  
- 不擅自 push / 发布  
