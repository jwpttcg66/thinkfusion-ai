# Phase F 实施记录：Hybrid Orchestrator

对应项目书第七章、第十五章 Phase F。日期 2026-11-04。

## 做了什么

| 文件 | 内容 |
| --- | --- |
| `src/main/collaboration/strategy.ts` | `planCollaboration()`：四种策略生成可检查的计划 |
| `src/main/collaboration/runner.ts` | 分轮分批执行、子任务独立记录、失败重试、综合 |
| `src/main/conversation-runner.ts` | `ResearchRunner` 接口：按 `config.strategy` 选执行器 |
| `src/main/agents/types.ts` / `providers/types.ts` | `context?: string[]` 结构化前序结果 |
| `ollama.ts` / `openai-compatible.ts` | context 放进 messages 的 assistant 轮次 |
| `src/main/index.ts` | `app:collaboration` 返回最近一轮的子任务记录 |
| `scripts/check-collaboration.mjs` | 11 条测试 |

## 四种策略

| 策略 | 行为 |
| --- | --- |
| `parallel` | 所有成员一轮并行，按 `maxConcurrency` 分批。**仍走原来的 `MasterAgent`**，老路径零风险 |
| `all-selected` | 所有成员一轮并行、不分批 |
| `sequential` | 每个成员一轮，后一个带前序回答 |
| `smart` | 用可解释规则选串/并：问题 >60 字或含分析类词 → 递进；否则并行。理由写进 `plan.reason` |

## 两条硬规则没有被策略破坏

1. **不减少参与成员**。四种策略的任务数都等于成员数；Smart 只改变
   「是否让后续成员看到前序结果」，不挑通道。按意图挑一个通道看着聪明，
   实际上把交叉验证变成单点答案。
2. **不改问题文本**。Sequential 的前序结果走 `SubAgentTask.context` /
   `ModelRequest.context`，由本地/云端 Provider 放进 messages 的 assistant
   轮次；`WebChannelProvider` 完全忽略它，页面收到的永远是原问题。
   没有「请参考以下回答」这类引导句。

`smart` 不上模型分类：模型判错查不出来，规则判错至少能指着那条规则改。

## 任务记录与失败恢复

每个子任务一条 `CollaborationRecord`：`taskId / agentId / stage / status /
attempts / contextCount / 耗时 / text / error`。状态变化通过
`onCollaborationRecord` 旁路推给主进程，`app:collaboration` 可查（Phase J
的时间线用）。

失败只重试一次，且绝不影响同批其他人；**不把失败成员的活转给别人**——
那是悄悄改参与名单。用户中止后未开始的任务是 `skipped`，不会伪装成失败，
也不会生成综合。只有 ≥2 条回答才生成综合，避免把单个答案说成共识。

## 验收对照（项目书 Phase F）

| 要求 | 状态 |
| --- | --- |
| 任务分配给不同 Provider | ✅ 计划按成员展开，成员来自 E 的过滤名单 |
| 并行执行多个模型任务 | ✅ parallel / all-selected |
| 串行传递前序结果 | ✅ sequential，`context` 长度实测 0/1/2 |
| 控制资源和预算 | ⚠️ 并发上限与分批已做；**Token/费用预算闸门属 Phase K/J** |
| 每个子任务独立执行记录 | ✅ `app:collaboration` + 测试覆盖 |
| 智能任务分配 | ✅ 规则版，理由可查；不上模型分类 |
| 失败恢复 | ✅ 单任务重试一次、失败隔离 |

## 测试

```
npm run test:collaboration   11 条，全绿
npm test                     253 条全绿
npm run typecheck            干净
```

钉住的反例：四种策略成员数与问题文本不变、Smart 长短问题各自的选择理由、
Sequential 的 context 为 0/1/2、失败重试一次不影响他人、彻底失败记
`unanswered`、中止后是 `skipped` 且不生成综合、单回答不生成综合、
无可用成员时报花名册里的名字。

## 没做的

- **没有真机跑 sequential**（需要至少两个可用非网页成员，本机只有一个本地
  模型且云端无 Key）。逻辑链路有测试，真机场景留到 Phase K。
- **Token / 费用预算闸门**：`usageSummary()` 已有数据，闸门在 Phase K 统一接。
- **UI 的 Hybrid 配置与时间线**（Phase J）。
