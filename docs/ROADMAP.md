# 产品路线

产品总目标与总体架构约束以
[PRODUCT_ARCHITECTURE_BASELINE_V4.md](PRODUCT_ARCHITECTURE_BASELINE_V4.md)（V4.0.0）为基准；
当前实现的取舍说明见 [PRODUCT.md](PRODUCT.md)。当前代码能力、验收事实与缺口只维护在
[implementation/STATUS.md](implementation/STATUS.md)。本页只定义优先顺序，不复制状态表或完成度数字。

## 优先级原则

1. 先保证一次真实任务的端到端正确性、事件可追溯和交付物完整。
2. 对已实现能力优先补运行边界、失败处理和真实场景验收，不先扩建平行架构。
3. 新能力复用现有 Collaboration、TaskManager、AgentStore、Evidence、Memory 和 Runtime 边界。
4. 没有运行时代码/验收证据的方向标记为设计，不以文档任务书代替完成。

## 近期工作方向

- 收敛 General / Knowledge / Engineering 的结果投影、来源引用和实际交付呈现。
- 补齐知识索引的跨会话复用与时效产品体验。
- 长任务上下文能力继续保持可配置；扩大真实恢复验证后，再评估默认开启策略。
- 完成发布签名、公证、迁移与回滚等发布门禁。

具体未完成项、优先级和证据链接统一见 [STATUS.md](implementation/STATUS.md)。
目标契约证据闭环（GCE）的设计与批次见 [架构说明](architecture/V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md) 与 [任务书](implementation/V3-GOAL-CONTRACT-EVIDENCE-TASK-BOOK.md)；当前为 DESIGN/NOT STARTED。

V3 全局生产闭环（P0–P5）的方向、阶段边界与验收口径见
[总计划](implementation/plans/V3-PRODUCTION-CLOSURE-PLAN.md)；当前从
[P0 详细任务书](implementation/plans/active/P0-VERSION-RECOVERY-TASK-BOOK.md) 起步。

## 后续候选方向

以下是候选，不代表已承诺排期或已实现：

- 可复用的 Workflow Definition / Plugin 执行定义；
- Java 结构化 AST、类型绑定和调用图；
- 更多 Provider 与工具能力。

新增候选必须先确认与现有系统边界兼容，不新建第二套协作调度、任务状态、Journal、审批或验证系统。
