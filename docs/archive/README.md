# 历史文档归档

这里保存已完成、已取代或仅对历史背景有用的实施材料。归档是为了保留决策和证据，
**不是**继续约束当前实现。

## 分类

- `implementation/legacy-v3/`：早期 P0–P6 任务书、旧完成度审计和早期运行时记录。
- `architecture/`：2026-11-24 的长任务/检查点详细设计快照、旧 V3 全局架构/迁移计划和 V1 领域设计；当前 `docs/ARCHITECTURE.md`、`docs/architecture/README.md` 与 `spec/` 契约为现行入口。
- `implementation/audits/`：已完成的设计评审、迁移审计与回滚演练。
- `implementation/long-task-context/`：已实现的 LT 分阶段旧任务书；当前结果见
  [`../implementation/acceptance/long-task-context/ACCEPTANCE.md`](../implementation/acceptance/long-task-context/ACCEPTANCE.md)。
- `implementation/{gdc,dmoca,goal-tdl-eco,main-activity,...}/`：阶段进度和早期实现记录；
  当前状态见 [`../implementation/STATUS.md`](../implementation/STATUS.md)。
- `spec/task-books/`：已完成或已由代码/新任务取代的实施任务书。
- `spec/global-memory/`：全局记忆 M2/M3 阶段任务与历史状态快照；当前运行状态由
  `implementation/STATUS.md` 和代码/测试确定。
- `spec/reference/`：按指定日期/外部版本形成的工具对照、代码智能研究和过程可见性记录。
- `operations/`：早期长任务多阶段灰度提案；当前实际配置见 `docs/operations/LONG-TASK-CONTEXT-ROLLOUT.md`。
- `work-plans/`：一次性研发计划，不是产品规范。

## 如何使用历史材料

- 检查标题下的 `HISTORICAL` 标记，先确认其基线与适用日期。
- 路径、类型或状态与当前代码不一致时，以当前代码、测试和状态板为准。
- 不把历史验收截图、旧基线数字或旧任务中的“待实现”复制到当前 README。
- 需要恢复旧决策时，优先引用对应 ADR；不要重新抄写整份历史设计。
