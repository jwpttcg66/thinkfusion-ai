# LT-P4 · Provider 请求接线

> 文档状态：HISTORICAL。本文仅保留历史决策/实现证据；不得作为当前实现状态、契约或验收结论。当前事实见 `docs/implementation/STATUS.md`。


状态：P4-01–P4-04 完成；入口策略见 `context/entry-policy.ts`  
阶段目标：让所有可压缩请求统一经过 Context Manager，同时不破坏入口边界。  
依赖：LT-P1、LT-P2、LT-P3  
上游：[契约](../../../spec/LONG_TASK_CONTEXT_CONTRACTS.md) · [任务书](LONG-TASK-CONTEXT-TASK-BOOK.md)

## 1. 阶段出口

- ExecutionPool / ProviderBackedSubAgent 前 prepare、后 finalize；
- Master、Collaboration、Engineering、Debate 各有策略；
- Reviewer 不获得无关内部讨论；
- Web/CLI 边界不变；
- Usage/费用可校准；
- 开关关闭零变化。

## 2. 任务

### LT-P4-01 ExecutionPool / Provider Hook

| 项 | 内容 |
| --- | --- |
| 目标 | 所有可压缩请求统一接线 |
| 依赖 | P1-02、P2-03、P3-04 |
| 接触 | `execution/execution-pool.ts`、`provider-sub-agent.ts`、`context/manager.ts` |
| 验收 | 关闭开关零变化；开启后含摘要/裁剪；requestId 贯通；AgentTask/Conversation 两类 owner 都可用 |
| 测试 | Pool 集成；`test:execution`、`test:providers` |
| 回滚 | 关闭开关 |

调用：

```text
SubAgentTask
→ ContextManager.prepare(owner: agent-task | conversation)
→ ProviderBackedSubAgent.ask/askStream
→ ContextManager.finalize
```

不能用 `taskId` 作为唯一键；General/Knowledge 的 owner 是 conversation。

不改变 `question` / `system` 的现有语义。

### LT-P4-02 入口策略

| 项 | 内容 |
| --- | --- |
| 目标 | 各入口定义上下文范围 |
| 依赖 | P4-01 |
| 接触 | `master-agent.ts`、`collaboration/runner/runner.ts`、`orchestrator.ts`、`judge/*` |
| 验收 | 策略可解释；Reviewer 隔离；Web 原话 |
| 测试 | 入口上下文快照 |
| 回滚 | 退回统一简单策略 |

策略：

| 入口 | 上下文 |
| --- | --- |
| Master | 目标、参与者、前序回答、必要记忆 |
| Collaboration | 任务目标、依赖、已完成子任务、证据 |
| Engineering | 计划、步骤、工具结果、Diff、验证 |
| Debate/Reviewer | 目标、证据、待审问题；不给全部内部思考 |
| Web | 原话，不注入 system |
| CLI | 不伪造 system |

### LT-P4-03 Usage 校准与成本

| 项 | 内容 |
| --- | --- |
| 目标 | 真实 usage 校准估算，记录压缩成本 |
| 依赖 | P1-03、P4-01 |
| 接触 | `context/estimator.ts`、`trace/*`、`task-view.ts` |
| 验收 | 未知不写 0；摘要费用可归集 |
| 测试 | usage null/有值 |
| 回滚 | 停止校准 |

记录：

- estimated vs actual；
- 压缩前后；
- 摘要模型费用；
- 溢出恢复次数；
- confidence。

### LT-P4-04 边界回归

| 项 | 内容 |
| --- | --- |
| 目标 | 锁定原话、Memory、Web/CLI、systemHash |
| 依赖 | P4-02、P4-03 |
| 接触 | `check-prompt-policy.mjs`、`check-providers.mjs`、`check-memory-*` |
| 验收 | 全部回归通过 |
| 测试 | 边界矩阵 |
| 回滚 | 关闭 Context Manager |

断言：

1. question 逐字不变；
2. Memory 只进 system；
3. CLI 无 system；
4. Web 不注入；
5. systemHash 按实际消息。

## 3. PR 切片

| PR | 内容 |
| --- | --- |
| LT-P4-A | P4-01 Pool Hook |
| LT-P4-B | P4-02 入口策略 |
| LT-P4-C | P4-03 Usage + P4-04 边界 |

## 4. 测试

```bash
cd desktop-agent-macos
npm run typecheck
npm run test:execution
npm run test:providers
npm run test:prompt-policy
npm run test:memory-inject
npm run test:context-manager
```

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 所有请求被拼历史 | 按入口策略，不统一拼接 |
| Reviewer 泄露内部讨论 | 显式上下文白名单 |
| Web 被注入 system | 边界测试 |
| 未知 usage 被写 0 | null 语义测试 |
| 开关关闭仍有变化 | 关闭路径快照测试 |

## 6. 状态清单

- [x] P4-01 Pool Hook
- [x] P4-02 入口策略
- [x] P4-03 Usage
- [x] P4-04 边界回归
- [x] 阶段回归通过（Web/CLI 不注入；Engineering Provider 规划接 system/context，question 原话不变）
