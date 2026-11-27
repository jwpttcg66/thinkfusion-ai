# 架构文档

本目录只保留仍适用于当前 V3 的领域设计和实现架构；旧 V1 领域设计已归档。它不是运行状态板。当前代码是否已实现某项设计，只看 [`../implementation/STATUS.md`](../implementation/STATUS.md)。V1 领域设计快照见 [`../archive/architecture/v3-domain-v1/`](../archive/README.md)。

## 当前架构专题

| 文档 | 唯一职责 |
| --- | --- |
| [LONG_TASK_AND_CONTEXT_COMPACTION.md](LONG_TASK_AND_CONTEXT_COMPACTION.md) | Context Manager 的职责、请求前数据流和降级边界 |
| [CONTEXT_CHECKPOINT_STORAGE.md](CONTEXT_CHECKPOINT_STORAGE.md) | 已接受的检查点/归档存储决策 |

## V3 目标架构专题

| 文档 | 唯一职责 |
| --- | --- |
| [V3-DYNAMIC-MULTI-MODEL-ORCHESTRATION.md](V3-DYNAMIC-MULTI-MODEL-ORCHESTRATION.md) | DMOCA 目标模型与贡献投影 |
| [V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md](V3-GOAL-DRIVEN-ITERATIVE-ENGINEERING.md) | Goal/Cycle 工程协作方向 |
| [V3-GOAL-TDL-ECO-ARCHITECTURE.md](V3-GOAL-TDL-ECO-ARCHITECTURE.md) | Goal、TDL、ECO 的组合方向 |
| [V3-TASK-DECOMPOSITION-LAYER.md](V3-TASK-DECOMPOSITION-LAYER.md) | Work/WorkTask 分解和进度投影 |
| [V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md](V3-GOAL-CONTRACT-EVIDENCE-CYCLE.md) | V2.0 核心闭环：Goal Contract、Criterion、Evidence、Cycle Decision；设计目标，不声明实现 |
| [GCE-P1-GOAL-CONTRACT-DESIGN.md](GCE-P1-GOAL-CONTRACT-DESIGN.md) | GoalReasoner、六维、确认、版本与持久化接线 |
| [GCE-P2-CRITERION-EVIDENCE-DESIGN.md](GCE-P2-CRITERION-EVIDENCE-DESIGN.md) | 证据归一化、Criterion 判定、三态分层、WorkTask 映射 |
| [GCE-P3-CYCLE-DECISION-DESIGN.md](GCE-P3-CYCLE-DECISION-DESIGN.md) | Work/Cycle/Round、真实阶段、决策算法、无进展检测 |
| [GCE-P4-COLLABORATION-DESIGN.md](GCE-P4-COLLABORATION-DESIGN.md) | TDL 映射、ECO 资格、DMOCA 阶段角色与贡献版本 |
| [GCE-P5-UI-RECOVERY-DESIGN.md](GCE-P5-UI-RECOVERY-DESIGN.md) | 连续文档 UI 接线、目标变更、恢复一致性 |

## 长任务上下文

- 类型、状态机、事件 payload 的规范唯一放在
  [`../spec/LONG_TASK_CONTEXT_CONTRACTS.md`](../spec/LONG_TASK_CONTEXT_CONTRACTS.md)；
  UI 约束唯一放在 [`../spec/LONG_TASK_CONTEXT_UI.md`](../spec/LONG_TASK_CONTEXT_UI.md)。

## 阅读规则

- 同一类型/事件/状态转换不在架构文档复制定义；请链接到 `spec/`。
- 每份设计文档的实现状态不在文档内维护；请链接到 `STATUS.md`。
- 目标设计与现实代码不一致时，标明设计意图，不用“已实现/未实施”替代事实状态。
