# 规范与契约

`spec/` 只放仍有约束力的行为、接口和领域规则。实现状态见
[STATUS](../implementation/STATUS.md)；已完成任务书和旧研究见
[archive 索引](../archive/README.md)。

## 能力与通道

- [CAPABILITY_PLUGINS.md](CAPABILITY_PLUGINS.md)：本地/联网/保存能力插件契约。
- [WEB_ANSWER_STREAMING.md](WEB_ANSWER_STREAMING.md)：网页流式读取边界。

## 工程、记忆与上下文

- [GLOBAL_MEMORY.md](GLOBAL_MEMORY.md)：记忆数据模型、注入边界和治理不变量。
- [GOAL_CONTRACT_EVIDENCE_CONTRACTS.md](GOAL_CONTRACT_EVIDENCE_CONTRACTS.md)：目标契约、Criterion、Cycle、Evidence 关联和三种完成状态规范；仅 DESIGN。
- [GOAL_CONTRACT_UI.md](GOAL_CONTRACT_UI.md)：目标区、Criterion、Goal Fit、决策原因与目标变更确认的 UI 规格；仅 DESIGN。
- [LONG_TASK_CONTEXT_CONTRACTS.md](LONG_TASK_CONTEXT_CONTRACTS.md)：长任务共享类型、状态机、事件、错误降级和不变量；类型/事件只在此定义。
- [LONG_TASK_CONTEXT_UI.md](LONG_TASK_CONTEXT_UI.md)：上下文 UI 展示与可追溯性契约。
- [TASK_CONVERSATION_STREAM.md](TASK_CONVERSATION_STREAM.md)：工程对话流的事件源/投影分层、四层模型、差距清单、A→B→C→D1→D2 实施方案；区分会话聚合胶囊与独立文件变更块、交付产物卡片。
- 早期工具对照/能力盘点已移入 [archive/spec/reference](../archive/README.md)；代码架构见 [architecture index](../architecture/README.md)。
- 工程观测与交付硬约束见仓库 [AGENTS.md](../../AGENTS.md) §8，不复制第二份。

## 辩论

- [DEBATE_RUNBOOK.md](DEBATE_RUNBOOK.md)：当前运行、配置和测试手册。
- 旧辩论任务书/主导模式已归档；当前网页角色以 [ADR 0009](../adr/0009-web-roles.md) 为准。

## 检查点存储

存储布局、原子提交和恢复实现说明见
[CONTEXT_CHECKPOINT_STORAGE.md](../architecture/CONTEXT_CHECKPOINT_STORAGE.md)。
契约字段仍以 `LONG_TASK_CONTEXT_CONTRACTS.md` 为准，不在两处复制。

## 规范变更

契约改动必须与实现和回归测试同一任务更新。若规范与代码矛盾，先确认状态板、代码和测试事实，
再修订规范；不要只改索引或复制一份“新版本”文档。
