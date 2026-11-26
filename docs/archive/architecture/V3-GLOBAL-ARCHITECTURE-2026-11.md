# ThinkFusion V3 全局架构

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：设计冻结（全局一致性）  
基线：`main@6f871e2` · 2026-11-24  
任务书：[V3-GLOBAL-CONSISTENCY-TASK-BOOK.md](../implementation/global-consistency/V3-GLOBAL-CONSISTENCY-TASK-BOOK.md)<br>
状态板：[STATUS.md](../../implementation/STATUS.md)

> 本文只做全局一致性收敛，不重复各模块的详细设计。
> 产品方向见 `PRODUCT.md`，协作见 `COLLABORATION_ARCHITECTURE.md`，
> 工程见 `ENGINEERING_WORKSPACE.md`，证据见 `EVIDENCE_QUALITY.md`，
> 长任务/上下文见 `LONG_TASK_AND_CONTEXT_COMPACTION.md`。

## 1. 产品结构

ThinkFusion 保持三个工作空间：

| 空间 | 职责 | 生命周期 |
| --- | --- | --- |
| General | 日常问答、分析、比较、研究 | Conversation |
| Knowledge | 知识研究、沉淀、历史结论复用 | Conversation |
| Engineering | 项目理解、架构设计、计划执行、代码修改与验证 | AgentTask / TaskManager |

系统自动识别空间，不要求用户选择辩论、评审或研究模式。辩论、交叉验证、
反例分析、方案竞争是统一协作引擎的可选行为。

## 2. 分层

```text
用户 / 工作空间
  General · Knowledge · Engineering
        ↓
Task Lifecycle / Conversation Lifecycle
        ↓
Collaboration Engine
  Planner · Scheduler · Participants · Runner · Replanner · Debate · Synthesizer
        ↓
Existing Execution Governance
  TaskManager · AgentOrchestrator · Approval · TaskGrant · Journal · Verifier
        ↓
Context Manager（新增，LT 轨道）
  Builder · Budget · Estimator · Pruner · Summarizer · Checkpoint · Recovery
        ↓
Existing Infrastructure
  AgentStore / Conversation · EvidencePackStore · MemoryService · Provider/Adapter
```

## 3. 四种状态与所有权

| 状态 | 权威来源 | 职责 |
| --- | --- | --- |
| Task State | TaskManager / ConversationRunner | 任务或会话生命周期 |
| Execution State | AgentOrchestrator / Collaboration State | 步骤、审批、工具、副作用 |
| Session History | AgentStore / Conversation | 原始消息与事件 |
| Context State | Context Manager | 上下文版本、预算、摘要、检查点 |

任何一个状态改变不能直接推导其他状态已改变。

### 3.1 上下文所有者

```ts
type ContextOwner =
  | { ownerType: 'agent-task'; ownerId: string; taskId: string; runId: string }
  | { ownerType: 'conversation'; ownerId: string; conversationId: string; runId: string };
```

- Engineering 使用 `agent-task`；
- General/Knowledge 使用 `conversation`；
- 不为 Conversation 伪造 AgentTask；
- 检查点按 owner 隔离；
- 活动指针由 Journal 唯一持有。

## 4. 不可违反的边界

1. 不新建第三套 Agent Runtime。
2. 不新建第二套 TaskManager、Journal、审批、TaskGrant、Verifier。
3. Context Manager 不是任务调度器，不创建 DAG、不审批工具。
4. General/Knowledge 不强行转成 AgentTask。
5. Memory、Evidence、Compaction 不合并。
6. 摘要不是执行事实；不能替代事件、测试报告或 Evidence。
7. 窗口未知不静默换 Provider，不伪造窗口/Token/费用。
8. 不改变用户原始问题。
9. Web 保持原话输入；CLI 不伪造 system turn。
10. 工程可观测性保留真实事件、模型输出、工具执行记录。

## 5. V3 与 LT 两条轨道

| 轨道 | 编号 | 职责 |
| --- | --- | --- |
| V3 总体 | P0–P6 | 协作、知识、工程、证据、通道、UI、运维 |
| 长任务 | LT-P0–LT-P6 | Context Manager、压缩、检查点、恢复、UI |

- 编号不混用；
- G0–G6 是进入 LT-P0 前的全局一致性门禁；
- 现有 35 项 LT 任务继续是功能实施清单；
- V3 既有模块由 V3 计划拥有，LT 只扩展。

### 5.1 共享文件所有权

| 文件 | 主要所有权 | LT 边界 |
| --- | --- | --- |
| `task-manager.ts` | V3 任务生命周期 | 扩展暂停/中断/预算状态 |
| `orchestrator.ts` | V3 执行治理 | 接入上下文/恢复钩子 |
| `store.ts` | V3 Journal | 归档保护与检查点事务接口 |
| `task-events.ts` | 统一事件契约 | 增加 ContextEvent |
| `task-view.ts` | 视图投影 | 增加上下文展示 |
| `conversation.ts` | 会话模型 | 增加上下文指针与运行身份 |
| `conversation-runner.ts` | General/Knowledge 生命周期 | 接入 ContextManager |
| `execution-pool.ts` | 模型执行入口 | prepare/finalize |
| `provider-sub-agent.ts` | Provider 适配 | 透传上下文与真实 Usage |

同一文件只能有一个任务负责修改；其他任务依赖其接口，不平行重写。

## 6. 数据边界

| 数据 | 权威 | 用途 | 禁止 |
| --- | --- | --- | --- |
| Task/Conversation | TaskManager / ConversationRunner | 生命周期 | 由模型/摘要决定完成 |
| 执行事件 | AgentOrchestrator / Journal | 事实来源 | 伪造进度 |
| Evidence | EvidencePackStore | 代码/测试/执行证据 | 用摘要替代 |
| Memory | MemoryService | 跨会话稳定信息 | 当成本轮证据 |
| 摘要 | Context Manager | 压缩模型输入 | 当执行事实/长期记忆 |
| 归档 | Context Store | 被压缩来源的长期追溯 | 与 Journal 争权威 |

## 7. Provider 与通道边界

| 通道 | 输入 | system | 工具 | 取消 |
| --- | --- | --- | --- | --- |
| Web | 原话 | 不注入 | 无 | give-up 如实显示 |
| Local Provider | question/context/system | 支持 | 按能力 | abort |
| Cloud Provider | question/context/system | 支持 | 按能力 | abort |
| CLI | 原话/协议 | 不伪造 | CLI 自身 | 按进程 |

未知 `contextTokens`、`usage`、`cost` 保持 null；UI 显示“未提供”。

## 8. 实施顺序

```text
G0 审计 → G1 架构 → G2 上下文契约 → G3 存储协议
→ G4 V3/LT 协调 → G5 测试/状态 → G6 评审
→ LT-P0 → LT-P1..P6
```

任何 G 阶段未通过，不进入 LT-P0。

## 9. 文档权威

| 文档 | 权威范围 |
| --- | --- |
| `STATUS.md` | 唯一阶段状态 |
| `PRODUCT.md` | 产品定位 |
| 本文件 | 全局架构边界 |
| `COLLABORATION_ARCHITECTURE.md` | 协作引擎 |
| `ENGINEERING_WORKSPACE.md` | 工程空间 |
| `EVIDENCE_QUALITY.md` | 证据 |
| `LONG_TASK_AND_CONTEXT_COMPACTION.md` | 长任务/上下文 |
| `LONG_TASK_CONTEXT_CONTRACTS.md` | 上下文类型/API |
| `CONTEXT_CHECKPOINT_STORAGE.md` + ADR 0010 | 检查点存储 |
| `TASK-BOOK.md` | V3 任务 |
| `LONG-TASK-CONTEXT-TASK-BOOK.md` | LT 任务 |

历史规格（如 `DEBATE_ENGINE_TASK_V1.0.md`）标 `HISTORICAL`，不覆盖当前架构。
