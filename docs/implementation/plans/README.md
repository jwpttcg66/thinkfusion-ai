# 实施计划

计划描述待做的工作，不是当前实现事实。状态只由
[`../STATUS.md`](../STATUS.md) 维护。

## 当前计划

- [V4-IMPLEMENTATION-PLAN.md](V4-IMPLEMENTATION-PLAN.md)：**V4.0.0 正式功能实施计划（当前主线）**，
  基线 `main@bd5a883`，P0 架构事实统一 → P1 Engineering Runtime 与长任务（按 M1/M2/M3 里程碑交付）→
  P2 质量治理 → P3 Goal–Evidence 闭环 → P4 三场景 → P5 Native/External → P6 工作台与验收。
  不含实现状态，状态见 [`../STATUS.md`](../STATUS.md)；阶段编号与 V3 计划**不是同一套**。
- [../../audits/V4-P0-CODE-FACT-AUDIT.md](../../audits/V4-P0-CODE-FACT-AUDIT.md)：
  P0 全量代码事实审计（模块调用链、符合性矩阵、对象关系、死代码清单），P1 任务书的事实底稿。
- [active/V4-P1-TASK-BOOK.md](active/V4-P1-TASK-BOOK.md)：P1 按 M1（Goal/Task/Execution 统一）→
  M2（Checkpoint 与恢复）→ M3（Decision/Verification/持续循环，判定点）拆分的任务书；`DESIGN / NOT STARTED`。
- [V3-PRODUCTION-CLOSURE-PLAN.md](V3-PRODUCTION-CLOSURE-PLAN.md)：V3 全局生产闭环总计划（P0–P5），
  定义方向、架构、阶段边界与验收口径；其 P0（版本一致性与长任务中断恢复）已合入 `main`。
  已被 V4 计划接续，保留用于追溯 V3 期间的阶段划分。
- [active/P0-VERSION-RECOVERY-TASK-BOOK.md](active/P0-VERSION-RECOVERY-TASK-BOOK.md)：
  总计划 P0（版本一致性与长任务中断恢复）详细任务书，基于 `main@af7b312` 的只读审计；`DESIGN / NOT STARTED`。
- [active/P1-REMEDIATION-PLAN.md](active/P1-REMEDIATION-PLAN.md)：远程审计整改项。
  P0/P1 两批已闭合，文中保留落地结论与仍未闭合的边界（P2 不在本计划内）。

## 已完成计划

已关闭的阶段任务书、审计任务书和一次性研发计划移入
[`../../archive/README.md`](../../archive/README.md)。归档中的“待实现”只代表其记录时点，
不能推断现在仍未实现。
