# P1-00A 代码职责映射与迁移矩阵

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：**完成（2026-11-19）**。
基线：`main@8d937a4` + P0-04/P1-00 代码。
用途：在新建 Planner/Scheduler 前，逐文件确认旧职责与新归属；**先映射，后建模块**。

## 1. 读法

| 列 | 含义 |
| --- | --- |
| 新归属 | Planner / Scheduler / Runner / Verifier / Deliver / Store / 保留 Runtime |
| 写盘 | 是否写 journal / pack / 文件 |
| 删除条件 | 什么时候可以删；未满足前只允许并存 |
| 测试 | 现有或需迁移的脚本 |

## 2. 入口与总流程

| 文件 | 当前职责 | 新归属 | 写盘 | 删除条件 | 测试 |
| --- | --- | --- | --- | --- | --- |
| `conversation-runner.ts` | 入口、路由、研究/工程分支、看门狗、辩论触发 | 入口 + 生命周期；决策移入 engine | `AgentStore` | engine 接管全部路径且 legacy 删除 | `check-runner` 等 |
| `master-agent.ts` | 第一手并发 + 规则综合 | ParticipantManager + Deliver | 无 | Manager/Deliver 在 active 跑通 | `check-conversation` |
| `collaboration/strategy.ts` | 并行/递进/smart stage | Planner 输入 | 无 | DAG Planner 接管 | `check-collaboration` |
| `collaboration/runner.ts` | 按计划执行、逐任务记录 | Runner/Observation | 无 | 新 Runner 接管状态 | `check-collaboration` |
| `index.ts` | 装配/IPC | 装配 + mode 路由 | 配置 | 不删 | 手工 |

## 3. 辩论

| 文件 | 当前职责 | 新归属 | 删除条件 |
| --- | --- | --- | --- |
| `debate/orchestrator.ts` | 完整辩论流程 | DebateBehavior | 不删；入口移除后整理 |
| `debate/claims.ts` | 从 DebateMessage 抽 Claim/Dispute | 通用抽取器（P1 后续） | 通用抽取通过测试 |
| `debate/evidence.ts` / `judges.ts` | 辩论证据/裁判 | Verifier | 不删 |
| `debate/argument-graph.ts` | 论证图 | 可选结构 | 不删 |
| `debate/prompts.ts` | 固定提示词 | — | 已删除 |

## 4. 证据与状态

| 文件 | 当前职责 | 新归属 | 写盘 | 删除条件 |
| --- | --- | --- | --- | --- |
| `evidence-pack/store.ts` | Pack 存储/哈希 | Store | pack | 不删 |
| `repository-snapshot.ts` | 仓库快照 | 工程任务按需 | pack | 不删 |
| `mapping.ts` | Pack → 辩论证据 | EvidenceRef 适配 | 无 | P4 映射后保留兼容 |
| `execution-producer.ts` | 执行断言 | Verifier/工程 | pack | 不删 |
| `claim-verification*.ts` | Runtime Claim 验证 | Verifier | pack | 不删 |
| `store.ts`（AgentStore） | journal | State 持久化 | journal | 不删 |

## 5. 执行与工程

| 文件 | 当前职责 | 新归属 | 删除条件 |
| --- | --- | --- | --- |
| `orchestrator.ts`（AgentOrchestrator） | 审批/执行/TaskGrant | Runtime（不变） | 不删 |
| `agent-manager.ts` | UtilityProcess | Runtime | 不删 |
| `agent/*` | 工具/验证 | Runtime | 不删 |
| `engineering/project.ts` / `analysis.ts` | 读盘/符号/影响 | 工程能力 | 不删 |
| `engineering/plan-review.ts` / `review.ts` | 计划/执行评审 | 评审能力 | 不删 |
| `code-index/*` | 索引/检索 | 事实提供者 | 不删 |
| `lsp/*` | TS 语言服务 | 事实提供者 | 不删 |
| `coding/team.ts` | 多 Agent 编码 | 工程协作 | 不删 |
| `execution/cli-answer-agent.ts` | 只读回答源 | Participant | 不删 |
| CLI 执行链（`agent.exec`） | 写执行 | Executor | 不删 |

## 6. 共享契约与 UI

| 文件 | 当前职责 | 新归属 | 动作 |
| --- | --- | --- | --- |
| `shared/conversation.ts` | 事件/会话契约 | 增加 collaboration 事件 | 扩展 |
| `shared/workspace.ts` | 知识/工程空间 | 与 Goal.workspace 对齐 | 保留 |
| `renderer/*` | UI | P3/P4 后改造 | 延后 |

## 7. 第一刀顺序

1. `collaboration/domain/*`（已完成：types/state）
2. `collaboration/mode.ts`（已完成：P0-04）
3. `collaboration/planner/*`：规则 DAG
4. `collaboration/scheduler/*`
5. `collaboration/runner/*`
6. `collaboration/deliver/*`
7. `conversation-runner` shadow 分支

## 8. 禁止

- 未完成本矩阵前新建 Planner/Scheduler/Runner；
- 新建第二套 Runtime/审批/Journal/TaskGrant/Verifier；
- 把旧 `strategy` 改名为 DAG 就算迁移；
- 让 `ConversationRunner` 继续持有新的调度决策。
