# ThinkFusion Unified Task Runtime

状态：实施中（P0）
基线：远程 `main` `3c949fca78f759fa27078f26e60d8e57ddae0d98`
日期：2026-11-21

## 结论

工程任务的问题不是 UI 面板不够，而是任务生命周期、事件契约和展示投影没有统一。

从本文件开始：

- `V3-FORMAL-FEATURES-PLAN.md` / `V3-FORMAL-FEATURES-DESIGN.md` 不再作为施工顺序依据；
- 旧功能编号（A-03、UI-01…）只作为能力清单复用，不机械推进；
- 工程任务以 `AgentTask` 为唯一聚合根；
- `Collaboration Engine` 负责组织协作，`AgentOrchestrator` 负责工程执行治理；
- 不新建第三套 Runtime、第二套审批、TaskGrant、Journal、Verifier、Worktree 或 Evidence Store。

## 目标架构

```text
用户任务
  → Task Lifecycle（AgentTask）
  → Collaboration Engine（参与者、计划建议、Debate/CrossCheck）
  → AgentOrchestrator（审批、Grant、工具、Worktree、Journal、Verifier）
  → TaskEvent（统一事件）
  → View Projection（主进程统一派生）
  → 任务概览 / 计划 / 进展 / 执行记录 / 交付
```

### 职责边界

| 模块 | 唯一职责 | 禁止 |
| --- | --- | --- |
| Task Lifecycle | 任务创建、轮次、状态、审批、终态 | 执行工具 |
| Collaboration Engine | 组织模型参与者和协作策略 | 另建工程执行审批 |
| Planner | 产出可审核计划 | 直接改文件 |
| AgentOrchestrator | 工程执行、权限、验证 | 创建第二套协作状态 |
| TaskEvent | 记录可观察生命周期 | Renderer 自行拼事件 |
| View Projection | 真实状态转展示数据 | 推测执行状态 |
| Deliverable | 真实执行数据形成交付 | 把模型回答当完成 |

## 生命周期

`understanding → planning → clarification → approval → executing → verifying → reviewing → completed`

异常终态：`cancelled`、`failed`、`blocked`。

部分完成必须显示为部分完成，不能包装成成功。

## 统一事件契约（P1 目标）

```ts
interface TaskEvent {
  eventId: string;
  taskId: string;
  runId: string;
  roundId?: string;
  stepId?: string;
  attemptId?: string;
  sequence: number;
  occurredAt: number;
  phase: 'understanding' | 'planning' | 'approval' | 'execution' | 'verification' | 'review' | 'delivery';
  type: string;
  payload: Record<string, unknown>;
}
```

迁移期保留旧 `AgentEvent`，通过 Adapter 逐步转换；先保证：

1. 不同任务事件不串；
2. 不同轮次流式输出不串；
3. 同一步骤 started/approval/completed/failed 关联；
4. 顺序由 sequence 决定；
5. 刷新可从持久化重建；
6. 重复事件不重复显示。

## 展示契约

| 概念 | 展示 |
| --- | --- |
| 模型内部 reasoning | 不展示原文 |
| 当前工作 | 当前阶段、正在做什么、已接收多少 |
| 模型可见回答 | 参与者意见 |
| 计划 | 目标、步骤、验收条件、审批 |
| 工具执行 | 工具、目标、参数摘要、结果、耗时、错误 |
| 最终交付 | 完成摘要、文件、Diff、测试、评审、未解决问题 |

“思考过程”不再等于 reasoning 原文；展示计划理由摘要与真实进展。

## 实施阶段

### P0 止血

- P0-01：`round.delta` 分离 reasoning/text，增加轮次/流标识，终态清理。
- P0-02：任务页按阶段展示进展，不再显示原始 reasoning 与规划 JSON。

验收：连续两轮不串；新一轮无旧内容；终态收敛；模型输出不冒充任务进度。

### P1 统一事实来源

- 任务聚合根：`taskId/runId/currentRoundId/lifecycleStatus`。
- TaskEvent Envelope + Adapter。
- 事件持久化、排序、去重、恢复。
- 主进程统一状态转换，Renderer 不决定完成/失败。

### P2 工程链路收敛

- 工程入口统一 `TaskManager → AgentOrchestrator`。
- Collaboration Engine 只产出计划建议，不另建执行链。
- 复用 Grant/Approval/Worktree/Journal/Verifier。
- 至少一个真实小仓库任务闭环。

### P3 UI 重建

概览 / 计划 / 工作者 / 进展 / 执行记录 / 最终交付 / 诊断，全部由统一 View Projection 驱动。

### P4/P5

General、Knowledge 接入同一生命周期与事件；完成并发、取消、超时、重启恢复、事件顺序与去重验收。

## 实施纪律

1. 不重建项目基线。
2. 不重写 AgentOrchestrator 既有治理。
3. 不保留两套工程任务状态源。
4. 不伪造进度或结果。
5. Renderer 不维护业务状态机。
6. 未验证不得显示为完成。
7. 不推送远程 `main`，除非用户明确授权。
